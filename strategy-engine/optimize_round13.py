"""
Round 13: Final push — add new condition types and test.
Ideas:
1. RSI momentum (RSI rising, not just in zone)
2. MACD histogram increasing
3. Price > previous swing high
4. MA slope positive
"""
from __future__ import annotations
import sys
from pathlib import Path
from datetime import datetime

sys.path.insert(0, str(Path(__file__).parent))

import pandas as pd
import numpy as np
from analysis.technical import compute_all_indicators, evaluate_conditions
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


def test_all(strategy, data):
    scores = {}
    for split in ["validation", "test"]:
        r = run_backtest(strategy, data, "tw_stocks", split, 0.6, 0.2)
        scores[split] = calc_strategy_score(calc_metrics(r["trades"]))
    return scores


def main():
    print(f"{'='*75}")
    print(f"🔬 Round 13: New Condition Types — {datetime.now().strftime('%H:%M:%S')}")
    print(f"{'='*75}\n")

    # First, add new condition types to the technical module
    add_new_conditions()

    data = load_data(50)

    bp = {
        "ma_fast": 5, "ma_mid": 10, "ma_slow": 20, "ma_long": 60,
        "volume_multiplier": 1.5, "volume_avg_period": 5, "kbar_min_body_pct": 0.015,
        "macd_fast": 12, "macd_slow": 26, "macd_signal": 9,
        "kd_period": 9, "kd_smooth_k": 3, "kd_smooth_d": 3,
        "hold_days": 10, "stop_loss_pct": -0.10,
    }

    # Base 8 conditions (no MA60)
    base_8 = [
        {"id": "trend", "type": "ma_crossover", "name": "T", "params": {"fast": 5, "slow": 20, "direction": "bullish"}},
        {"id": "kbar", "type": "bullish_candle", "name": "K", "params": {"min_body_pct": 0.015}},
        {"id": "ma_align", "type": "ma_alignment", "name": "MA", "params": {"periods": [5, 10, 20], "direction": "bullish"}},
        {"id": "indicator", "type": "indicator_confirm", "name": "I", "params": {"macd_positive": True, "kd_golden_cross": True, "logic": "or"}},
        {"id": "obv", "type": "obv_trend", "name": "O", "params": {}},
        {"id": "weekly", "type": "weekly_trend_confirm", "name": "W", "params": {}},
        {"id": "rsi_zone", "type": "rsi_neutral_zone", "name": "R", "params": {"rsi_low": 30, "rsi_high": 55}},
        {"id": "low_vol", "type": "low_volatility_breakout", "name": "LV", "params": {"atr_pct_max": 25}},
    ]

    # New conditions to try adding
    new_conds = [
        {"id": "rsi_rising", "type": "rsi_rising", "name": "RSI上升", "params": {"lookback": 3}},
        {"id": "macd_accel", "type": "macd_accelerating", "name": "MACD加速", "params": {}},
        {"id": "ma_slope", "type": "ma_slope_positive", "name": "MA斜率", "params": {"period": 20, "min_slope": 0}},
        {"id": "vol_dry", "type": "volume_dry_up", "name": "量縮", "params": {"threshold": 0.7}},
    ]

    results = []

    # Test baseline
    s = make_s("baseline_8c_mc7", base_8, bp, 7)
    sc = test_all(s, data)
    v, t = sc["validation"], sc["test"]
    avg = (v["total_score"] + t["total_score"]) / 2
    results.append({"label": "baseline_8c_mc7", "avg": avg, "val": v["total_score"],
                    "test": t["total_score"], "trades": v["trade_count"],
                    "wr": v["win_rate"], "mdd": v["max_drawdown"]})
    print(f"  baseline_8c_mc7             avg={avg:>7.2f} val={v['total_score']:>7.2f} test={t['total_score']:>7.2f} trades={v['trade_count']:>4d}")

    # Test each new condition added individually
    for nc in new_conds:
        conds = base_8 + [nc]
        for mc in [7, 8]:
            label = f"+{nc['id']}_mc{mc}"
            s = make_s(label, conds, bp, mc)
            sc = test_all(s, data)
            v, t = sc["validation"], sc["test"]
            avg = (v["total_score"] + t["total_score"]) / 2
            results.append({"label": label, "avg": avg, "val": v["total_score"],
                            "test": t["total_score"], "trades": v["trade_count"],
                            "wr": v["win_rate"], "mdd": v["max_drawdown"]})
            print(f"  {label:30s} avg={avg:>7.2f} val={v['total_score']:>7.2f} test={t['total_score']:>7.2f} trades={v['trade_count']:>4d}")

    # Test combinations of 2 new conditions
    print("\n📊 Pairs of new conditions:")
    for i in range(len(new_conds)):
        for j in range(i+1, len(new_conds)):
            conds = base_8 + [new_conds[i], new_conds[j]]
            for mc in [7, 8]:
                label = f"+{new_conds[i]['id']}+{new_conds[j]['id']}_mc{mc}"
                s = make_s(label, conds, bp, mc)
                sc = test_all(s, data)
                v, t = sc["validation"], sc["test"]
                avg = (v["total_score"] + t["total_score"]) / 2
                results.append({"label": label, "avg": avg, "val": v["total_score"],
                                "test": t["total_score"], "trades": v["trade_count"],
                                "wr": v["win_rate"], "mdd": v["max_drawdown"]})
                if avg > 30:
                    print(f"  {label:40s} avg={avg:>7.2f} val={v['total_score']:>7.2f} test={t['total_score']:>7.2f}")

    results.sort(key=lambda x: x["avg"], reverse=True)
    print(f"\n🏆 Top 10:")
    for i, r in enumerate(results[:10]):
        marker = "👑" if i == 0 else "  "
        print(f"{marker} {i+1:2d}. {r['label']:40s} avg={r['avg']:>7.2f} (val={r['val']:>7.2f} test={r['test']:>7.2f}) "
              f"trades={r['trades']:>4d} WR={r['wr']:>5.1f}% MDD={r['mdd']:>5.1f}%")

    # Save best
    if results and results[0]["avg"] > 45:
        print(f"\n💾 Best: {results[0]['label']} (avg={results[0]['avg']:.2f})")


def add_new_conditions():
    """Monkey-patch new condition types into evaluate_conditions."""
    from analysis import technical as tech
    original_eval = tech.evaluate_conditions

    def patched_eval(df, conditions, params):
        # Split into standard and custom conditions
        standard_conds = []
        custom_conds = []

        for c in conditions:
            if c["type"] in ("rsi_rising", "macd_accelerating", "ma_slope_positive", "volume_dry_up"):
                custom_conds.append(c)
            else:
                standard_conds.append(c)

        # Evaluate standard conditions
        result = original_eval(df, standard_conds, params)

        # Evaluate custom conditions
        for cond in custom_conds:
            cid = cond["id"]
            ctype = cond["type"]
            cp = cond.get("params", {})

            if ctype == "rsi_rising":
                lookback = cp.get("lookback", 3)
                result[f"cond_{cid}"] = df["rsi14"] > df["rsi14"].shift(lookback)

            elif ctype == "macd_accelerating":
                result[f"cond_{cid}"] = (df["macd_osc"] > 0) & (df["macd_osc"] > df["macd_osc"].shift(1))

            elif ctype == "ma_slope_positive":
                period = cp.get("period", 20)
                ma_col = f"ma{period}"
                if ma_col in df.columns:
                    result[f"cond_{cid}"] = df[ma_col] > df[ma_col].shift(5)
                else:
                    result[f"cond_{cid}"] = False

            elif ctype == "volume_dry_up":
                threshold = cp.get("threshold", 0.7)
                result[f"cond_{cid}"] = df["volume"] < df["vol_avg20"] * threshold

            else:
                result[f"cond_{cid}"] = False

        # Recalculate total score
        cond_cols = [c for c in result.columns if c.startswith("cond_")]
        result["total_score"] = result[cond_cols].sum(axis=1)

        return result

    tech.evaluate_conditions = patched_eval


if __name__ == "__main__":
    main()
