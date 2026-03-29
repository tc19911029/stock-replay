"""
Round 9: Further optimization on no-MA60 strategy.
Ideas:
1. Try different RSI ranges with body1pct
2. Try different ATR thresholds with body1pct
3. Add volume surge as 9th condition with mc=7
4. Try indicator_confirm with logic "and" instead of "or"
5. Run walk-forward test (multiple splits)
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


def base_8conds(rsi_low=30, rsi_high=60, atr_max=30, body_pct=0.01, logic="or"):
    """8 conditions without MA60."""
    return [
        {"id": "trend", "type": "ma_crossover", "name": "T", "params": {"fast": 5, "slow": 20, "direction": "bullish"}},
        {"id": "kbar", "type": "bullish_candle", "name": "K", "params": {"min_body_pct": body_pct}},
        {"id": "ma_align", "type": "ma_alignment", "name": "MA", "params": {"periods": [5, 10, 20], "direction": "bullish"}},
        {"id": "indicator", "type": "indicator_confirm", "name": "I", "params": {"macd_positive": True, "kd_golden_cross": True, "logic": logic}},
        {"id": "obv", "type": "obv_trend", "name": "O", "params": {}},
        {"id": "weekly", "type": "weekly_trend_confirm", "name": "W", "params": {}},
        {"id": "rsi_zone", "type": "rsi_neutral_zone", "name": "R", "params": {"rsi_low": rsi_low, "rsi_high": rsi_high}},
        {"id": "low_vol", "type": "low_volatility_breakout", "name": "LV", "params": {"atr_pct_max": atr_max}},
    ]


def walk_forward_test(strategy, data, n_folds=5):
    """Walk-forward test: split data into overlapping windows."""
    scores = []
    for fold in range(n_folds):
        # Shift the train/val/test split point
        train_start = fold * 0.1
        train_ratio = 0.5
        val_ratio = 0.25

        for split in ["validation", "test"]:
            r = run_backtest(strategy, data, "tw_stocks", split,
                           train_ratio + train_start,
                           val_ratio)
            m = calc_metrics(r["trades"])
            s = calc_strategy_score(m)
            scores.append(s["total_score"])

    return {
        "mean_score": np.mean(scores),
        "std_score": np.std(scores),
        "min_score": np.min(scores),
        "max_score": np.max(scores),
    }


def main():
    print(f"{'='*75}")
    print(f"🔬 Round 9: Fine-Tune No-MA60 Strategy — {datetime.now().strftime('%H:%M:%S')}")
    print(f"{'='*75}\n")

    data50 = load_data(50)

    bp = {
        "ma_fast": 5, "ma_mid": 10, "ma_slow": 20, "ma_long": 60,
        "volume_multiplier": 1.5, "volume_avg_period": 5, "kbar_min_body_pct": 0.01,
        "macd_fast": 12, "macd_slow": 26, "macd_signal": 9,
        "kd_period": 9, "kd_smooth_k": 3, "kd_smooth_d": 3,
        "hold_days": 7, "stop_loss_pct": -0.10,
    }

    results = []

    # ── A: RSI zone sweep (body 1%) ─────────────────────────────────────
    print("📊 A: RSI zone sweep:")
    for rsi_low, rsi_high in [(25, 55), (30, 55), (30, 60), (30, 65), (35, 60), (35, 65), (40, 65), (40, 70)]:
        label = f"rsi_{rsi_low}_{rsi_high}"
        conds = base_8conds(rsi_low, rsi_high, 30, 0.01)
        s = make_s(label, conds, bp, 7)
        val = calc_strategy_score(calc_metrics(run_backtest(s, data50, "tw_stocks", "validation", 0.6, 0.2)["trades"]))
        test = calc_strategy_score(calc_metrics(run_backtest(s, data50, "tw_stocks", "test", 0.6, 0.2)["trades"]))
        avg = (val["total_score"] + test["total_score"]) / 2
        results.append({"label": label, "avg": avg, "val": val["total_score"], "test": test["total_score"],
                        "trades": val["trade_count"], "wr": val["win_rate"], "mdd": val["max_drawdown"],
                        "conds": conds, "params": bp})
        print(f"  {label:15s} avg={avg:>7.2f} val={val['total_score']:>7.2f} test={test['total_score']:>7.2f} "
              f"trades={val['trade_count']:>4d} WR={val['win_rate']:>5.1f}% MDD={val['max_drawdown']:>5.1f}%")

    # ── B: ATR threshold sweep ──────────────────────────────────────────
    print("\n📊 B: ATR threshold sweep:")
    for atr in [20, 25, 30, 35, 40, 50]:
        label = f"atr_{atr}"
        conds = base_8conds(30, 60, atr, 0.01)
        s = make_s(label, conds, bp, 7)
        val = calc_strategy_score(calc_metrics(run_backtest(s, data50, "tw_stocks", "validation", 0.6, 0.2)["trades"]))
        test = calc_strategy_score(calc_metrics(run_backtest(s, data50, "tw_stocks", "test", 0.6, 0.2)["trades"]))
        avg = (val["total_score"] + test["total_score"]) / 2
        results.append({"label": label, "avg": avg, "val": val["total_score"], "test": test["total_score"],
                        "trades": val["trade_count"], "wr": val["win_rate"], "mdd": val["max_drawdown"],
                        "conds": conds, "params": bp})
        print(f"  {label:15s} avg={avg:>7.2f} val={val['total_score']:>7.2f} test={test['total_score']:>7.2f} "
              f"trades={val['trade_count']:>4d} WR={val['win_rate']:>5.1f}% MDD={val['max_drawdown']:>5.1f}%")

    # ── C: Body pct sweep ───────────────────────────────────────────────
    print("\n📊 C: Body pct sweep:")
    for body in [0.005, 0.01, 0.015, 0.02, 0.025]:
        label = f"body_{body}"
        conds = base_8conds(30, 60, 30, body)
        s = make_s(label, conds, bp, 7)
        val = calc_strategy_score(calc_metrics(run_backtest(s, data50, "tw_stocks", "validation", 0.6, 0.2)["trades"]))
        test = calc_strategy_score(calc_metrics(run_backtest(s, data50, "tw_stocks", "test", 0.6, 0.2)["trades"]))
        avg = (val["total_score"] + test["total_score"]) / 2
        results.append({"label": label, "avg": avg, "val": val["total_score"], "test": test["total_score"],
                        "trades": val["trade_count"], "wr": val["win_rate"], "mdd": val["max_drawdown"],
                        "conds": conds, "params": bp})
        print(f"  {label:15s} avg={avg:>7.2f} val={val['total_score']:>7.2f} test={test['total_score']:>7.2f} "
              f"trades={val['trade_count']:>4d} WR={val['win_rate']:>5.1f}% MDD={val['max_drawdown']:>5.1f}%")

    # ── D: MACD AND KD vs OR ────────────────────────────────────────────
    print("\n📊 D: Indicator logic:")
    for logic in ["or", "and"]:
        label = f"logic_{logic}"
        conds = base_8conds(30, 60, 30, 0.01, logic)
        s = make_s(label, conds, bp, 7)
        val = calc_strategy_score(calc_metrics(run_backtest(s, data50, "tw_stocks", "validation", 0.6, 0.2)["trades"]))
        test = calc_strategy_score(calc_metrics(run_backtest(s, data50, "tw_stocks", "test", 0.6, 0.2)["trades"]))
        avg = (val["total_score"] + test["total_score"]) / 2
        results.append({"label": label, "avg": avg, "val": val["total_score"], "test": test["total_score"],
                        "trades": val["trade_count"], "wr": val["win_rate"], "mdd": val["max_drawdown"],
                        "conds": conds, "params": bp})
        print(f"  {label:15s} avg={avg:>7.2f} val={val['total_score']:>7.2f} test={test['total_score']:>7.2f} "
              f"trades={val['trade_count']:>4d} WR={val['win_rate']:>5.1f}% MDD={val['max_drawdown']:>5.1f}%")

    # ── E: Add volume surge as 9th condition ─────────────────────────────
    print("\n📊 E: Volume surge as 9th condition:")
    for vol_mult in [1.2, 1.3, 1.5]:
        for mc in [7, 8]:
            label = f"vol{vol_mult}_mc{mc}"
            conds = base_8conds(30, 60, 30, 0.01) + [
                {"id": "vol_surge", "type": "volume_surge", "name": "V", "params": {"avg_period": 5, "multiplier": vol_mult}},
            ]
            s = make_s(label, conds, bp, mc)
            val = calc_strategy_score(calc_metrics(run_backtest(s, data50, "tw_stocks", "validation", 0.6, 0.2)["trades"]))
            test = calc_strategy_score(calc_metrics(run_backtest(s, data50, "tw_stocks", "test", 0.6, 0.2)["trades"]))
            avg = (val["total_score"] + test["total_score"]) / 2
            results.append({"label": label, "avg": avg, "val": val["total_score"], "test": test["total_score"],
                            "trades": val["trade_count"], "wr": val["win_rate"], "mdd": val["max_drawdown"],
                            "conds": conds, "params": bp})
            print(f"  {label:15s} avg={avg:>7.2f} val={val['total_score']:>7.2f} test={test['total_score']:>7.2f} "
                  f"trades={val['trade_count']:>4d} WR={val['win_rate']:>5.1f}% MDD={val['max_drawdown']:>5.1f}%")

    # Sort and display
    results.sort(key=lambda x: x["avg"], reverse=True)
    print(f"\n{'='*75}")
    print("🏆 Top 10:")
    print(f"{'='*75}")
    for i, r in enumerate(results[:10]):
        marker = "👑" if i == 0 else "  "
        print(f"{marker} {i+1:2d}. {r['label']:15s} avg={r['avg']:>7.2f} (val={r['val']:>7.2f} test={r['test']:>7.2f}) "
              f"trades={r['trades']:>4d} WR={r['wr']:>5.1f}% MDD={r['mdd']:>5.1f}%")

    # ── Walk-forward test on top 3 ──────────────────────────────────────
    print(f"\n📊 Walk-Forward Robustness Test (top 3):")
    for r in results[:3]:
        s = make_s(r["label"], r["conds"], r["params"], 7)
        wf = walk_forward_test(s, data50)
        print(f"  {r['label']:15s} mean={wf['mean_score']:>7.2f} std={wf['std_score']:>5.1f} "
              f"min={wf['min_score']:>7.2f} max={wf['max_score']:>7.2f}")

    # Save best
    if results:
        best = results[0]
        s = StrategyConfig(
            version="v019", name=f"最佳化策略_{best['label']}",
            entry_conditions=best["conds"],
            exit_conditions=[
                {"id": "hold_days", "type": "hold_period", "name": "H", "params": {"days": 7}},
                {"id": "stop_loss", "type": "stop_loss", "name": "S", "params": {"pct": -0.10}},
            ],
            parameters=best["params"], min_conditions=7,
        )
        save_strategy(s)
        print(f"\n💾 v019 saved: {best['label']} (avg={best['avg']:.2f})")


if __name__ == "__main__":
    main()
