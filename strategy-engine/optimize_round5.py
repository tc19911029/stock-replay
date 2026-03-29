"""
Round 5: Final refinement around 9c_H7_SL10 winner.
Test edge cases, add TP/TS on top, verify robustness.
"""
from __future__ import annotations
import sys
from pathlib import Path
from datetime import datetime

sys.path.insert(0, str(Path(__file__).parent))

import pandas as pd
from optimize_loop import base_conditions
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
        parameters=params,
        min_conditions=min_cond,
    )


def test_full(strategy, data):
    results = {}
    for split in ["train", "validation", "test"]:
        r = run_backtest(strategy, data, "tw_stocks", split, 0.6, 0.2)
        m = calc_metrics(r["trades"])
        s = calc_strategy_score(m)
        results[split] = s
    return results


def winner_9conds():
    return base_conditions() + [
        {"id": "obv", "name": "OBV趨勢", "type": "obv_trend", "params": {}},
        {"id": "weekly", "name": "週線確認", "type": "weekly_trend_confirm", "params": {}},
        {"id": "rsi_zone", "name": "RSI中性", "type": "rsi_neutral_zone",
         "params": {"rsi_low": 35, "rsi_high": 65}},
        {"id": "low_vol", "name": "低波突破", "type": "low_volatility_breakout",
         "params": {"atr_pct_max": 35}},
    ]


def main():
    print(f"{'='*75}")
    print(f"🔬 Round 5: Final Refinement — {datetime.now().strftime('%H:%M:%S')}")
    print(f"{'='*75}\n")

    data20 = load_data(20)
    conds = winner_9conds()

    base = {
        "ma_fast": 5, "ma_mid": 10, "ma_slow": 20, "ma_long": 60,
        "volume_multiplier": 1.5, "volume_avg_period": 5,
        "kbar_min_body_pct": 0.02,
        "macd_fast": 12, "macd_slow": 26, "macd_signal": 9,
        "kd_period": 9, "kd_smooth_k": 3, "kd_smooth_d": 3,
        "hold_days": 7, "stop_loss_pct": -0.10,
    }

    results = []

    # ── A: Fine-tune around winner ─────────────────────────────────────────
    print("📊 Fine-tune around 9c_H7_SL10:")
    variants = [
        ("baseline", {**base}, 7),
        # Vary min_cond
        ("mc6", {**base}, 6),
        ("mc8", {**base}, 8),
        # RSI zone width
        ("rsi_30_60", {**base}, 7),  # will customize
        ("rsi_40_70", {**base}, 7),
        # Lower body pct requirement
        ("body1.5%", {**base, "kbar_min_body_pct": 0.015}, 7),
        ("body1%", {**base, "kbar_min_body_pct": 0.01}, 7),
        # ATR threshold
        ("atr40", {**base}, 7),
        ("atr30", {**base}, 7),
        # Hold/SL combos near winner
        ("H6_SL9", {**base, "hold_days": 6, "stop_loss_pct": -0.09}, 7),
        ("H7_SL9", {**base, "stop_loss_pct": -0.09}, 7),
        ("H7_SL11", {**base, "stop_loss_pct": -0.11}, 7),
        ("H8_SL9", {**base, "hold_days": 8, "stop_loss_pct": -0.09}, 7),
        ("H8_SL10", {**base, "hold_days": 8, "stop_loss_pct": -0.10}, 7),
    ]

    for label, params, mc in variants:
        # Customize RSI/ATR for specific variants
        c = winner_9conds()
        if label == "rsi_30_60":
            c = [x if x["id"] != "rsi_zone" else
                 {**x, "params": {"rsi_low": 30, "rsi_high": 60}} for x in c]
        elif label == "rsi_40_70":
            c = [x if x["id"] != "rsi_zone" else
                 {**x, "params": {"rsi_low": 40, "rsi_high": 70}} for x in c]
        elif label == "atr40":
            c = [x if x["id"] != "low_vol" else
                 {**x, "params": {"atr_pct_max": 40}} for x in c]
        elif label == "atr30":
            c = [x if x["id"] != "low_vol" else
                 {**x, "params": {"atr_pct_max": 30}} for x in c]

        s = make_strategy(label, "test", c, params, mc)
        r = test_full(s, data20)
        v, t = r["validation"], r["test"]
        avg = (v["total_score"] + t["total_score"]) / 2

        results.append({
            "label": label, "conds": c, "params": params, "mc": mc,
            "val_score": v["total_score"], "test_score": t["total_score"],
            "avg_score": avg,
            "val_wr": v["win_rate"], "val_ret": v["annualized_return"],
            "val_mdd": v["max_drawdown"], "val_trades": v["trade_count"],
            "test_wr": t["win_rate"], "test_ret": t["annualized_return"],
            "test_mdd": t["max_drawdown"], "test_trades": t["trade_count"],
            "val_pf": v["profit_factor"],
        })

        print(f"  {label:20s} mc={mc} | avg={avg:>7.2f} val={v['total_score']:>7.2f} test={t['total_score']:>7.2f} "
              f"WR={v['win_rate']:>5.1f}%/{t['win_rate']:>5.1f}% MDD={v['max_drawdown']:>5.1f}%/{t['max_drawdown']:>5.1f}%")

    # Sort by avg score
    results.sort(key=lambda x: x["avg_score"], reverse=True)

    print(f"\n{'='*75}")
    print("🏆 Final Rankings:")
    print(f"{'='*75}")
    for i, r in enumerate(results):
        marker = "👑" if i == 0 else "  "
        print(f"{marker} {i+1:2d}. {r['label']:20s} avg={r['avg_score']:>7.2f} "
              f"(val={r['val_score']:>7.2f} test={r['test_score']:>7.2f}) "
              f"val_WR={r['val_wr']:>5.1f}% val_MDD={r['val_mdd']:>5.1f}%")

    # Save best
    if results:
        best = results[0]
        s = make_strategy(
            f"九條件高選擇策略_{best['label']}",
            "v014",
            best["conds"],
            best["params"],
            best["mc"],
        )
        save_strategy(s)
        print(f"\n✅ Best: {best['label']} (avg={best['avg_score']:.2f})")
        print(f"   Val:  score={best['val_score']:.2f} WR={best['val_wr']:.1f}% ret={best['val_ret']:.1f}% MDD={best['val_mdd']:.1f}% trades={best['val_trades']}")
        print(f"   Test: score={best['test_score']:.2f} WR={best['test_wr']:.1f}% ret={best['test_ret']:.1f}% MDD={best['test_mdd']:.1f}% trades={best['test_trades']}")
        print(f"   💾 Saved as v014")


if __name__ == "__main__":
    main()
