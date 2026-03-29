"""
Round 7: Explore alternative condition combinations and edge cases.
Try: removing kbar condition (too restrictive?), different MA periods,
MACD+KD "and" instead of "or", longer MA for position filter.
"""
from __future__ import annotations
import sys
from pathlib import Path
from datetime import datetime

sys.path.insert(0, str(Path(__file__).parent))

import pandas as pd
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


def make_strategy(name, version, conditions, params, min_cond):
    return StrategyConfig(
        version=version, name=name,
        entry_conditions=conditions,
        exit_conditions=[
            {"id": "hold_days", "type": "hold_period", "name": "持有", "params": {"days": params.get("hold_days", 7)}},
            {"id": "stop_loss", "type": "stop_loss", "name": "停損", "params": {"pct": params.get("stop_loss_pct", -0.10)}},
        ],
        parameters=params, min_conditions=min_cond,
    )


def test_all_splits(strategy, data):
    scores = {}
    for split in ["train", "validation", "test"]:
        r = run_backtest(strategy, data, "tw_stocks", split, 0.6, 0.2)
        m = calc_metrics(r["trades"])
        scores[split] = calc_strategy_score(m)
    return scores


def main():
    print(f"{'='*75}")
    print(f"🔬 Round 7: Alternative Combinations — {datetime.now().strftime('%H:%M:%S')}")
    print(f"{'='*75}\n")

    data20 = load_data(20)
    bp = {
        "ma_fast": 5, "ma_mid": 10, "ma_slow": 20, "ma_long": 60,
        "volume_multiplier": 1.5, "volume_avg_period": 5,
        "kbar_min_body_pct": 0.02,
        "macd_fast": 12, "macd_slow": 26, "macd_signal": 9,
        "kd_period": 9, "kd_smooth_k": 3, "kd_smooth_d": 3,
        "hold_days": 7, "stop_loss_pct": -0.10,
    }

    # Current winner for reference
    winner_conds = [
        {"id": "trend", "type": "ma_crossover", "name": "趨勢", "params": {"fast": 5, "slow": 20, "direction": "bullish"}},
        {"id": "position", "type": "price_above_ma", "name": "位置", "params": {"ma_period": 60}},
        {"id": "kbar", "type": "bullish_candle", "name": "K棒", "params": {"min_body_pct": 0.02}},
        {"id": "ma_align", "type": "ma_alignment", "name": "均線", "params": {"periods": [5, 10, 20], "direction": "bullish"}},
        {"id": "indicator", "type": "indicator_confirm", "name": "指標", "params": {"macd_positive": True, "kd_golden_cross": True, "logic": "or"}},
        {"id": "obv", "type": "obv_trend", "name": "OBV", "params": {}},
        {"id": "weekly", "type": "weekly_trend_confirm", "name": "週線", "params": {}},
        {"id": "rsi_zone", "type": "rsi_neutral_zone", "name": "RSI", "params": {"rsi_low": 30, "rsi_high": 60}},
        {"id": "low_vol", "type": "low_volatility_breakout", "name": "低波", "params": {"atr_pct_max": 30}},
    ]

    variants = []

    # A: Current winner baseline
    variants.append(("A_winner_9c_mc7", winner_conds, bp, 7))

    # B: Remove kbar, keep 8 conds mc=6 (kbar might be too restrictive)
    no_kbar = [c for c in winner_conds if c["id"] != "kbar"]
    variants.append(("B_no_kbar_8c_mc6", no_kbar, bp, 6))
    variants.append(("B_no_kbar_8c_mc7", no_kbar, bp, 7))

    # C: Remove position (MA60), keep rest mc=7
    no_pos = [c for c in winner_conds if c["id"] != "position"]
    variants.append(("C_no_pos_8c_mc7", no_pos, bp, 7))

    # D: MACD AND KD (both must confirm) instead of OR
    and_ind = [{**c, "params": {**c["params"], "logic": "and"}} if c["id"] == "indicator" else c for c in winner_conds]
    variants.append(("D_macd_and_kd_mc7", and_ind, bp, 7))

    # E: Volume surge added (10 conds, mc=7)
    vol_conds = winner_conds + [
        {"id": "vol_surge", "type": "volume_surge", "name": "量增", "params": {"avg_period": 5, "multiplier": 1.3}},
    ]
    variants.append(("E_vol_surge_10c_mc7", vol_conds, bp, 7))
    variants.append(("E_vol_surge_10c_mc8", vol_conds, bp, 8))

    # F: RSI 25-55 (more aggressive — buy deeper pullbacks)
    rsi_deep = [{**c, "params": {"rsi_low": 25, "rsi_high": 55}} if c["id"] == "rsi_zone" else c for c in winner_conds]
    variants.append(("F_rsi25_55_mc7", rsi_deep, bp, 7))

    # G: RSI 30-70 (wider — more permissive)
    rsi_wide = [{**c, "params": {"rsi_low": 30, "rsi_high": 70}} if c["id"] == "rsi_zone" else c for c in winner_conds]
    variants.append(("G_rsi30_70_mc7", rsi_wide, bp, 7))

    # H: ATR 20 (very tight vol filter)
    atr20 = [{**c, "params": {"atr_pct_max": 20}} if c["id"] == "low_vol" else c for c in winner_conds]
    variants.append(("H_atr20_mc7", atr20, bp, 7))

    # I: Body pct 1% instead of 2%
    body1 = [{**c, "params": {"min_body_pct": 0.01}} if c["id"] == "kbar" else c for c in winner_conds]
    variants.append(("I_body1pct_mc7", body1, bp, 7))

    # J: MA crossover 10/20 instead of 5/20 (smoother)
    ma10_20 = [{**c, "params": {"fast": 10, "slow": 20, "direction": "bullish"}} if c["id"] == "trend" else c for c in winner_conds]
    variants.append(("J_ma10_20_mc7", ma10_20, bp, 7))

    results = []
    for label, conds, params, mc in variants:
        s = make_strategy(label, "test", conds, params, mc)
        scores = test_all_splits(s, data20)
        v, t = scores["validation"], scores["test"]
        avg = (v["total_score"] + t["total_score"]) / 2

        results.append({
            "label": label, "conds": conds, "params": params, "mc": mc,
            "val_score": v["total_score"], "test_score": t["total_score"], "avg_score": avg,
            "val_wr": v["win_rate"], "val_ret": v["annualized_return"],
            "val_mdd": v["max_drawdown"], "val_trades": v["trade_count"],
            "val_pf": v["profit_factor"],
        })
        print(f"  {label:30s} | avg={avg:>7.2f} val={v['total_score']:>7.2f} test={t['total_score']:>7.2f} "
              f"WR={v['win_rate']:>5.1f}% ret={v['annualized_return']:>7.1f}% MDD={v['max_drawdown']:>5.1f}% "
              f"trades={v['trade_count']:>4d} PF={v['profit_factor']:.2f}")

    results.sort(key=lambda x: x["avg_score"], reverse=True)
    print(f"\n🏆 Rankings:")
    for i, r in enumerate(results):
        marker = "👑" if i == 0 else "  "
        print(f"{marker} {i+1:2d}. {r['label']:30s} avg={r['avg_score']:>7.2f} "
              f"(val={r['val_score']:>7.2f} test={r['test_score']:>7.2f})")

    # Save best if it improves over v014 (avg=14.39)
    if results and results[0]["avg_score"] > 14.39:
        best = results[0]
        s = make_strategy(f"優化策略_{best['label']}", "v016", best["conds"], best["params"], best["mc"])
        save_strategy(s)
        print(f"\n💾 Saved as v016 (avg={best['avg_score']:.2f} > 14.39)")
    else:
        print(f"\n⏸ No improvement over v014 (avg=14.39)")

    return results


if __name__ == "__main__":
    main()
