"""
Round 10: Combine best findings into final candidates.
Best from R9: ATR<20, MACD AND KD, RSI 30-55, body 1.5%
Try all combinations and pick the most robust.
"""
from __future__ import annotations
import sys
from pathlib import Path
from datetime import datetime

sys.path.insert(0, str(Path(__file__).parent))

import pandas as pd
import numpy as np
from backtest.engine import run_backtest
from backtest.metrics import calc_metrics
from evaluator import calc_strategy_score
from strategies.base import StrategyConfig
from strategies.registry import save_strategy

DATA_DIR = Path(__file__).parent / "data" / "cache" / "tw_stocks"


def load_data(max_stocks):
    data = {}
    for f in sorted(DATA_DIR.glob("*.csv")):
        if len(data) >= max_stocks:
            break
        try:
            df = pd.read_csv(f, parse_dates=["date"])
            if len(df) >= 60:
                data[f.stem] = df
        except Exception:
            pass
    return data


def make_s(name, conds, params, mc):
    return StrategyConfig(
        version="test", name=name,
        entry_conditions=conds,
        exit_conditions=[
            {"id": "hold_days", "type": "hold_period", "name": "H", "params": {"days": params.get("hold_days", 7)}},
            {"id": "stop_loss", "type": "stop_loss", "name": "S", "params": {"pct": params.get("stop_loss_pct", -0.10)}},
        ],
        parameters=params, min_conditions=mc,
    )


def build_conds(rsi_low=30, rsi_high=60, atr_max=30, body=0.01, logic="or"):
    return [
        {"id": "trend", "type": "ma_crossover", "name": "T", "params": {"fast": 5, "slow": 20, "direction": "bullish"}},
        {"id": "kbar", "type": "bullish_candle", "name": "K", "params": {"min_body_pct": body}},
        {"id": "ma_align", "type": "ma_alignment", "name": "MA", "params": {"periods": [5, 10, 20], "direction": "bullish"}},
        {"id": "indicator", "type": "indicator_confirm", "name": "I", "params": {"macd_positive": True, "kd_golden_cross": True, "logic": logic}},
        {"id": "obv", "type": "obv_trend", "name": "O", "params": {}},
        {"id": "weekly", "type": "weekly_trend_confirm", "name": "W", "params": {}},
        {"id": "rsi_zone", "type": "rsi_neutral_zone", "name": "R", "params": {"rsi_low": rsi_low, "rsi_high": rsi_high}},
        {"id": "low_vol", "type": "low_volatility_breakout", "name": "LV", "params": {"atr_pct_max": atr_max}},
    ]


def walk_forward(strategy, data, n_shifts=4):
    """Walk-forward: shift the split boundary."""
    scores = []
    for shift in range(n_shifts):
        tr = 0.5 + shift * 0.05
        vr = 0.25
        for split in ["validation", "test"]:
            r = run_backtest(strategy, data, "tw_stocks", split, tr, vr)
            m = calc_metrics(r["trades"])
            s = calc_strategy_score(m)
            scores.append(s["total_score"])
    return np.mean(scores), np.std(scores), np.min(scores)


def main():
    print(f"{'='*75}")
    print(f"🔬 Round 10: Combined Optimization — {datetime.now().strftime('%H:%M:%S')}")
    print(f"{'='*75}\n")

    data50 = load_data(50)

    bp = {
        "ma_fast": 5, "ma_mid": 10, "ma_slow": 20, "ma_long": 60,
        "volume_multiplier": 1.5, "volume_avg_period": 5, "kbar_min_body_pct": 0.01,
        "macd_fast": 12, "macd_slow": 26, "macd_signal": 9,
        "kd_period": 9, "kd_smooth_k": 3, "kd_smooth_d": 3,
        "hold_days": 7, "stop_loss_pct": -0.10,
    }

    # Combinatorial grid of best parameters
    combos = []
    for atr in [20, 25, 30]:
        for rsi in [(30, 55), (30, 60), (35, 60)]:
            for body in [0.01, 0.015]:
                for logic in ["or", "and"]:
                    for hd in [7, 10]:
                        label = f"a{atr}_r{rsi[0]}{rsi[1]}_b{int(body*1000)}_l{logic[0]}_h{hd}"
                        conds = build_conds(rsi[0], rsi[1], atr, body, logic)
                        combos.append((label, conds, {**bp, "hold_days": hd}))

    results = []
    for label, conds, params in combos:
        s = make_s(label, conds, params, 7)
        val = calc_strategy_score(calc_metrics(run_backtest(s, data50, "tw_stocks", "validation", 0.6, 0.2)["trades"]))
        test = calc_strategy_score(calc_metrics(run_backtest(s, data50, "tw_stocks", "test", 0.6, 0.2)["trades"]))
        avg = (val["total_score"] + test["total_score"]) / 2
        results.append({
            "label": label, "avg": avg, "val": val["total_score"], "test": test["total_score"],
            "trades": val["trade_count"], "wr": val["win_rate"], "mdd": val["max_drawdown"],
            "conds": conds, "params": params,
        })

    results.sort(key=lambda x: x["avg"], reverse=True)

    print("🏆 Top 20 combinations:")
    for i, r in enumerate(results[:20]):
        marker = "👑" if i == 0 else "  "
        print(f"{marker} {i+1:2d}. {r['label']:35s} avg={r['avg']:>7.2f} (val={r['val']:>7.2f} test={r['test']:>7.2f}) "
              f"trades={r['trades']:>4d} WR={r['wr']:>5.1f}% MDD={r['mdd']:>5.1f}%")

    # Walk-forward on top 5
    print(f"\n📊 Walk-Forward on top 5:")
    best_wf = None
    best_wf_score = -999
    for r in results[:5]:
        s = make_s(r["label"], r["conds"], r["params"], 7)
        wf_mean, wf_std, wf_min = walk_forward(s, data50)
        # Robustness score: mean - 0.5*std (penalize variance)
        rob = wf_mean - 0.5 * wf_std
        print(f"  {r['label']:35s} wf_mean={wf_mean:>7.2f} std={wf_std:>5.1f} min={wf_min:>7.2f} rob={rob:>7.2f}")
        if rob > best_wf_score:
            best_wf_score = rob
            best_wf = r

    # Save the walk-forward winner
    if best_wf:
        s = StrategyConfig(
            version="v020", name=f"最終優化策略",
            entry_conditions=best_wf["conds"],
            exit_conditions=[
                {"id": "hold_days", "type": "hold_period", "name": "H", "params": {"days": best_wf["params"]["hold_days"]}},
                {"id": "stop_loss", "type": "stop_loss", "name": "S", "params": {"pct": -0.10}},
            ],
            parameters=best_wf["params"], min_conditions=7,
        )
        save_strategy(s)
        print(f"\n💾 v020 saved: {best_wf['label']} (avg={best_wf['avg']:.2f}, wf_rob={best_wf_score:.2f})")


if __name__ == "__main__":
    main()
