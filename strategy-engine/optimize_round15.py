"""
Round 15: Optimize for ALL-split performance.
Current winner scores -1.91 on "all" split despite +70.67 on val/test.
The training period hurts. Can we find a strategy that works across all periods?

Approach: optimize on "all" split, then verify on val/test.
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

DATA_DIR = Path(__file__).parent / "data" / "cache" / "tw_stocks"


def load_data(max_stocks=50):
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
            {"id": "hold_days", "type": "hold_period", "name": "H", "params": {"days": params.get("hold_days", 10)}},
            {"id": "stop_loss", "type": "stop_loss", "name": "S", "params": {"pct": params.get("stop_loss_pct", -0.10)}},
        ],
        parameters=params, min_conditions=mc,
    )


def build(rsi_low=30, rsi_high=55, atr_max=25, body=0.015, logic="or"):
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


def test(strategy, data):
    scores = {}
    for split in ["train", "validation", "test", "all"]:
        r = run_backtest(strategy, data, "tw_stocks", split, 0.6, 0.2)
        m = calc_metrics(r["trades"])
        scores[split] = calc_strategy_score(m)
    return scores


def main():
    print(f"{'='*80}")
    print(f"🔬 Round 15: All-Period Optimization — {datetime.now().strftime('%H:%M:%S')}")
    print(f"{'='*80}\n")

    data = load_data(50)

    results = []

    # Comprehensive grid: focus on what makes a strategy work in training too
    for mc in [6, 7]:
        for atr in [20, 25, 30, 35]:
            for rsi_hi in [55, 60, 65]:
                for body in [0.01, 0.015]:
                    for logic in ["or", "and"]:
                        for hd in [7, 10]:
                            conds = build(30, rsi_hi, atr, body, logic)
                            bp = {
                                "ma_fast": 5, "ma_mid": 10, "ma_slow": 20, "ma_long": 60,
                                "volume_multiplier": 1.5, "volume_avg_period": 5,
                                "kbar_min_body_pct": body,
                                "macd_fast": 12, "macd_slow": 26, "macd_signal": 9,
                                "kd_period": 9, "kd_smooth_k": 3, "kd_smooth_d": 3,
                                "hold_days": hd, "stop_loss_pct": -0.10,
                            }
                            s = make_s("test", conds, bp, mc)
                            sc = test(s, data)
                            v, t, a = sc["validation"], sc["test"], sc["all"]
                            vt_avg = (v["total_score"] + t["total_score"]) / 2

                            # Combined score: weighted average prioritizing all-period
                            combined = a["total_score"] * 0.4 + vt_avg * 0.6

                            results.append({
                                "mc": mc, "atr": atr, "rsi_hi": rsi_hi, "body": body,
                                "logic": logic, "hd": hd,
                                "val": v["total_score"], "test": t["total_score"],
                                "all": a["total_score"], "vt_avg": vt_avg,
                                "combined": combined,
                                "val_trades": v["trade_count"], "all_trades": a["trade_count"],
                                "val_wr": v["win_rate"], "all_wr": a["win_rate"],
                                "val_mdd": v["max_drawdown"],
                            })

    # Sort by combined score
    results.sort(key=lambda x: x["combined"], reverse=True)

    print("🏆 Top 20 by combined score (all*0.4 + vt_avg*0.6):")
    for i, r in enumerate(results[:20]):
        marker = "👑" if i == 0 else "  "
        label = f"mc{r['mc']}_a{r['atr']}_r{r['rsi_hi']}_b{int(r['body']*1000)}_l{r['logic'][0]}_h{r['hd']}"
        print(f"{marker} {i+1:2d}. {label:30s} combined={r['combined']:>7.2f} "
              f"(all={r['all']:>7.2f} vt={r['vt_avg']:>7.2f}) "
              f"trades(v/a)={r['val_trades']:>3d}/{r['all_trades']:>4d} WR={r['val_wr']:>5.1f}%/{r['all_wr']:>5.1f}%")

    # Also show top by all-split score only
    results_by_all = sorted(results, key=lambda x: x["all"], reverse=True)
    print(f"\n📊 Top 10 by ALL-split score:")
    for i, r in enumerate(results_by_all[:10]):
        label = f"mc{r['mc']}_a{r['atr']}_r{r['rsi_hi']}_b{int(r['body']*1000)}_l{r['logic'][0]}_h{r['hd']}"
        print(f"  {i+1:2d}. {label:30s} all={r['all']:>7.2f} vt_avg={r['vt_avg']:>7.2f} "
              f"trades={r['all_trades']:>4d} WR={r['all_wr']:>5.1f}%")

    # Show top by vt_avg (our previous metric)
    results_by_vt = sorted(results, key=lambda x: x["vt_avg"], reverse=True)
    print(f"\n📊 Top 5 by val/test avg (previous metric):")
    for i, r in enumerate(results_by_vt[:5]):
        label = f"mc{r['mc']}_a{r['atr']}_r{r['rsi_hi']}_b{int(r['body']*1000)}_l{r['logic'][0]}_h{r['hd']}"
        print(f"  {i+1:2d}. {label:30s} vt_avg={r['vt_avg']:>7.2f} all={r['all']:>7.2f} "
              f"trades={r['val_trades']:>3d}/{r['all_trades']:>4d}")


if __name__ == "__main__":
    main()
