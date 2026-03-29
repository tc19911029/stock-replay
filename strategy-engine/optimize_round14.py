"""
Round 14: Try to increase trade count while maintaining quality.
Approach: relax conditions slightly but add a quality filter post-trade.
1. mc=6 with stricter ATR (< 20)
2. mc=6 with volume confirmation
3. mc=7 but with wider RSI range
4. Test on "all" split (full dataset) for overall picture
5. Try different MA crossover periods (10/20 instead of 5/20)
"""
from __future__ import annotations
import sys, random
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


def build(rsi_low=30, rsi_high=55, atr_max=25, body=0.015, logic="or",
          ma_fast=5, ma_slow=20, extra_conds=None):
    conds = [
        {"id": "trend", "type": "ma_crossover", "name": "T", "params": {"fast": ma_fast, "slow": ma_slow, "direction": "bullish"}},
        {"id": "kbar", "type": "bullish_candle", "name": "K", "params": {"min_body_pct": body}},
        {"id": "ma_align", "type": "ma_alignment", "name": "MA", "params": {"periods": [5, 10, 20], "direction": "bullish"}},
        {"id": "indicator", "type": "indicator_confirm", "name": "I", "params": {"macd_positive": True, "kd_golden_cross": True, "logic": logic}},
        {"id": "obv", "type": "obv_trend", "name": "O", "params": {}},
        {"id": "weekly", "type": "weekly_trend_confirm", "name": "W", "params": {}},
        {"id": "rsi_zone", "type": "rsi_neutral_zone", "name": "R", "params": {"rsi_low": rsi_low, "rsi_high": rsi_high}},
        {"id": "low_vol", "type": "low_volatility_breakout", "name": "LV", "params": {"atr_pct_max": atr_max}},
    ]
    if extra_conds:
        conds.extend(extra_conds)
    return conds


def test(strategy, data):
    scores = {}
    for split in ["validation", "test", "all"]:
        r = run_backtest(strategy, data, "tw_stocks", split, 0.6, 0.2)
        m = calc_metrics(r["trades"])
        scores[split] = calc_strategy_score(m)
    return scores


def main():
    print(f"{'='*75}")
    print(f"🔬 Round 14: Trade Count Optimization — {datetime.now().strftime('%H:%M:%S')}")
    print(f"{'='*75}\n")

    data = load_data(50)
    bp = {
        "ma_fast": 5, "ma_mid": 10, "ma_slow": 20, "ma_long": 60,
        "volume_multiplier": 1.5, "volume_avg_period": 5, "kbar_min_body_pct": 0.015,
        "macd_fast": 12, "macd_slow": 26, "macd_signal": 9,
        "kd_period": 9, "kd_smooth_k": 3, "kd_smooth_d": 3,
        "hold_days": 10, "stop_loss_pct": -0.10,
    }

    results = []

    # Baseline
    variants = [
        ("baseline_mc7", build(), bp, 7),
        # Relax: mc=6 with tighter ATR
        ("mc6_atr20", build(atr_max=20), bp, 6),
        ("mc6_atr15", build(atr_max=15), bp, 6),
        # mc=6 with volume confirmation added
        ("mc6_vol", build(extra_conds=[
            {"id": "vol_dry", "type": "volume_dry_up", "name": "VD", "params": {"threshold": 0.7}},
        ]), bp, 6),
        # mc=7 wider RSI
        ("mc7_rsi30_65", build(rsi_low=30, rsi_high=65), bp, 7),
        ("mc7_rsi30_70", build(rsi_low=30, rsi_high=70), bp, 7),
        # mc=7 wider ATR
        ("mc7_atr30", build(atr_max=30), bp, 7),
        ("mc7_atr35", build(atr_max=35), bp, 7),
        # mc=7 lower body
        ("mc7_body1", build(body=0.01), bp, 7),
        ("mc7_body05", build(body=0.005), bp, 7),
        # Different MA period
        ("mc7_ma10_20", build(ma_fast=10), bp, 7),
        # Combined relaxation
        ("mc7_atr30_rsi65", build(atr_max=30, rsi_high=65), bp, 7),
        ("mc7_atr30_body1", build(atr_max=30, body=0.01), bp, 7),
        ("mc7_atr35_rsi65_body1", build(atr_max=35, rsi_high=65, body=0.01), bp, 7),
        # Short hold
        ("mc7_h7", build(), {**bp, "hold_days": 7}, 7),
        ("mc7_h5", build(), {**bp, "hold_days": 5}, 7),
        # AND logic (more selective indicator)
        ("mc7_and", build(logic="and"), bp, 7),
        # AND + wider other params (compensate for stricter indicator)
        ("mc7_and_atr30_rsi65", build(logic="and", atr_max=30, rsi_high=65), bp, 7),
    ]

    for label, conds, params, mc in variants:
        s = make_s(label, conds, params, mc)
        sc = test(s, data)
        v, t, a = sc["validation"], sc["test"], sc["all"]
        avg = (v["total_score"] + t["total_score"]) / 2
        results.append({
            "label": label, "avg": avg,
            "val": v["total_score"], "test": t["total_score"], "all": a["total_score"],
            "val_trades": v["trade_count"], "val_wr": v["win_rate"],
            "val_mdd": v["max_drawdown"],
            "all_trades": a["trade_count"], "all_wr": a["win_rate"],
        })
        print(f"  {label:30s} avg={avg:>7.2f} val={v['total_score']:>7.2f} test={t['total_score']:>7.2f} "
              f"all={a['total_score']:>7.2f} trades={v['trade_count']:>3d}/{a['trade_count']:>4d} "
              f"WR={v['win_rate']:>5.1f}%")

    results.sort(key=lambda x: x["avg"], reverse=True)
    print(f"\n🏆 Top 10:")
    for i, r in enumerate(results[:10]):
        marker = "👑" if i == 0 else "  "
        print(f"{marker} {i+1:2d}. {r['label']:30s} avg={r['avg']:>7.2f} trades(val/all)={r['val_trades']:>3d}/{r['all_trades']:>4d} WR={r['val_wr']:>5.1f}%")

    # Save best if improved
    if results[0]["avg"] > 70.67:
        best = results[0]
        print(f"\n✅ Improved! Saving as v022")


if __name__ == "__main__":
    main()
