"""
Round 6: Combine best tweaks and final validation.
Best so far: rsi_30_60 + atr30 both improved. Try combining.
Also try rsi_40_70 (most balanced).
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
from evaluator import calc_strategy_score, format_score_report
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


def conds_rsi30_60_atr30():
    return base_conditions() + [
        {"id": "obv", "name": "OBV趨勢", "type": "obv_trend", "params": {}},
        {"id": "weekly", "name": "週線確認", "type": "weekly_trend_confirm", "params": {}},
        {"id": "rsi_zone", "name": "RSI中性", "type": "rsi_neutral_zone",
         "params": {"rsi_low": 30, "rsi_high": 60}},
        {"id": "low_vol", "name": "低波突破", "type": "low_volatility_breakout",
         "params": {"atr_pct_max": 30}},
    ]


def conds_rsi40_70():
    return base_conditions() + [
        {"id": "obv", "name": "OBV趨勢", "type": "obv_trend", "params": {}},
        {"id": "weekly", "name": "週線確認", "type": "weekly_trend_confirm", "params": {}},
        {"id": "rsi_zone", "name": "RSI中性", "type": "rsi_neutral_zone",
         "params": {"rsi_low": 40, "rsi_high": 70}},
        {"id": "low_vol", "name": "低波突破", "type": "low_volatility_breakout",
         "params": {"atr_pct_max": 35}},
    ]


def main():
    print(f"{'='*75}")
    print(f"🔬 Round 6: Final Combination Tests — {datetime.now().strftime('%H:%M:%S')}")
    print(f"{'='*75}\n")

    data20 = load_data(20)

    base = {
        "ma_fast": 5, "ma_mid": 10, "ma_slow": 20, "ma_long": 60,
        "volume_multiplier": 1.5, "volume_avg_period": 5,
        "kbar_min_body_pct": 0.02,
        "macd_fast": 12, "macd_slow": 26, "macd_signal": 9,
        "kd_period": 9, "kd_smooth_k": 3, "kd_smooth_d": 3,
        "hold_days": 7, "stop_loss_pct": -0.10,
    }

    variants = [
        # Combo 1: RSI 30-60, ATR 30 (both best tweaks)
        ("rsi30_60_atr30", conds_rsi30_60_atr30(), {**base}, 7),
        # Combo 2: RSI 40-70
        ("rsi40_70", conds_rsi40_70(), {**base}, 7),
        # Combo 3: RSI 30-60, ATR 30 + slightly tighter SL
        ("combo_SL9", conds_rsi30_60_atr30(), {**base, "stop_loss_pct": -0.09}, 7),
        # Combo 4: RSI 30-60, ATR 30 + SL 11
        ("combo_SL11", conds_rsi30_60_atr30(), {**base, "stop_loss_pct": -0.11}, 7),
        # Combo 5: RSI 35-65, ATR 30 (slight tighten RSI)
        ("rsi35_65_atr30", base_conditions() + [
            {"id": "obv", "name": "OBV趨勢", "type": "obv_trend", "params": {}},
            {"id": "weekly", "name": "週線確認", "type": "weekly_trend_confirm", "params": {}},
            {"id": "rsi_zone", "name": "RSI", "type": "rsi_neutral_zone",
             "params": {"rsi_low": 35, "rsi_high": 65}},
            {"id": "low_vol", "name": "低波突破", "type": "low_volatility_breakout",
             "params": {"atr_pct_max": 30}},
        ], {**base}, 7),
        # Combo 6: RSI 30-60, ATR 25 (even tighter vol filter)
        ("rsi30_60_atr25", base_conditions() + [
            {"id": "obv", "name": "OBV趨勢", "type": "obv_trend", "params": {}},
            {"id": "weekly", "name": "週線確認", "type": "weekly_trend_confirm", "params": {}},
            {"id": "rsi_zone", "name": "RSI", "type": "rsi_neutral_zone",
             "params": {"rsi_low": 30, "rsi_high": 60}},
            {"id": "low_vol", "name": "低波突破", "type": "low_volatility_breakout",
             "params": {"atr_pct_max": 25}},
        ], {**base}, 7),
    ]

    results = []
    for label, conds, params, mc in variants:
        s = make_strategy(label, "test", conds, params, mc)
        scores = {}
        for split in ["train", "validation", "test"]:
            r = run_backtest(s, data20, "tw_stocks", split, 0.6, 0.2)
            m = calc_metrics(r["trades"])
            scores[split] = calc_strategy_score(m)

        v, t, tr = scores["validation"], scores["test"], scores["train"]
        avg = (v["total_score"] + t["total_score"]) / 2

        results.append({
            "label": label, "conds": conds, "params": params, "mc": mc,
            "train_score": tr["total_score"],
            "val_score": v["total_score"], "test_score": t["total_score"],
            "avg_score": avg,
            "val_wr": v["win_rate"], "val_ret": v["annualized_return"],
            "val_mdd": v["max_drawdown"], "val_trades": v["trade_count"],
            "val_pf": v["profit_factor"], "val_sharpe": v["sharpe_ratio"],
            "test_wr": t["win_rate"], "test_ret": t["annualized_return"],
            "test_mdd": t["max_drawdown"], "test_trades": t["trade_count"],
        })

        print(f"  {label:25s} | train={tr['total_score']:>7.2f} val={v['total_score']:>7.2f} test={t['total_score']:>7.2f} avg={avg:>7.2f}")
        print(f"  {'':25s} | val: WR={v['win_rate']:>5.1f}% ret={v['annualized_return']:>7.1f}% MDD={v['max_drawdown']:>5.1f}% trades={v['trade_count']:>4d} PF={v['profit_factor']:.2f}")
        print(f"  {'':25s} | test: WR={t['win_rate']:>5.1f}% ret={t['annualized_return']:>7.1f}% MDD={t['max_drawdown']:>5.1f}% trades={t['trade_count']:>4d}")

    results.sort(key=lambda x: x["avg_score"], reverse=True)

    print(f"\n{'='*75}")
    print("🏆 FINAL RANKING:")
    print(f"{'='*75}")
    for i, r in enumerate(results):
        marker = "👑" if i == 0 else "  "
        print(f"{marker} {i+1}. {r['label']:25s} avg={r['avg_score']:>7.2f} "
              f"(val={r['val_score']:>7.2f} test={r['test_score']:>7.2f}) "
              f"val_PF={r['val_pf']:.2f}")

    # Save top 2 as v014 and v015
    for i, r in enumerate(results[:2]):
        ver = f"v{14+i:03d}"
        s = make_strategy(
            f"高選擇九條件策略_{r['label']}",
            ver,
            r["conds"],
            r["params"],
            r["mc"],
        )
        save_strategy(s)


if __name__ == "__main__":
    main()
