"""
Round 3: Reduce MDD through quality filtering
Key strategies:
1. Higher min_conditions (more selective)
2. Fewer stocks (top liquid names only)
3. Market regime proxy filter
4. Score-weighted position sizing sim
"""
from __future__ import annotations
import sys
import json
from pathlib import Path
from datetime import datetime

sys.path.insert(0, str(Path(__file__).parent))

import pandas as pd
import numpy as np
from optimize_loop import load_cached_data, test_strategy, make_strategy, base_conditions
from backtest.engine import run_backtest
from backtest.metrics import calc_metrics
from evaluator import calc_strategy_score
from strategies.base import StrategyConfig

DATA_DIR = Path(__file__).parent / "data" / "cache" / "tw_stocks"


def best_conditions():
    """Best from Round 1: base + OBV + weekly"""
    return base_conditions() + [
        {"id": "obv", "name": "OBV趨勢", "type": "obv_trend", "params": {}},
        {"id": "weekly", "name": "週線確認", "type": "weekly_trend_confirm", "params": {}},
    ]


def test_with_stock_count(conditions, params, min_cond, stock_count, label=""):
    """Test a strategy variant with specific stock count."""
    data = {}
    for f in sorted(DATA_DIR.glob("*.csv")):
        if len(data) >= stock_count:
            break
        try:
            df = pd.read_csv(f, parse_dates=["date"])
            if len(df) >= 60:
                data[f.stem] = df
        except Exception:
            pass

    strategy = make_strategy(label or f"test_{stock_count}", "test", conditions, params, min_cond)

    train_r = run_backtest(strategy, data, "tw_stocks", "train", 0.6, 0.2)
    val_r = run_backtest(strategy, data, "tw_stocks", "validation", 0.6, 0.2)

    train_m = calc_metrics(train_r["trades"])
    val_m = calc_metrics(val_r["trades"])
    train_s = calc_strategy_score(train_m)
    val_s = calc_strategy_score(val_m)

    return {
        "label": label,
        "train_score": train_s["total_score"],
        "val_score": val_s["total_score"],
        "val_wr": val_s["win_rate"],
        "val_return": val_s["annualized_return"],
        "val_mdd": val_s["max_drawdown"],
        "val_trades": val_s["trade_count"],
        "val_pf": val_s["profit_factor"],
        "val_sharpe": val_s["sharpe_ratio"],
    }


def main():
    print(f"{'='*70}")
    print(f"🔬 Round 3: Quality Filtering & Stock Selection — {datetime.now().strftime('%H:%M:%S')}")
    print(f"{'='*70}\n")

    base_params = {
        "ma_fast": 5, "ma_mid": 10, "ma_slow": 20, "ma_long": 60,
        "volume_multiplier": 1.5, "volume_avg_period": 5,
        "kbar_min_body_pct": 0.02,
        "macd_fast": 12, "macd_slow": 26, "macd_signal": 9,
        "kd_period": 9, "kd_smooth_k": 3, "kd_smooth_d": 3,
        "hold_days": 7, "stop_loss_pct": -0.10,
    }

    results = []

    # ── Test 1: Vary stock count ──────────────────────────────────────────
    print("📊 Test 1: Stock count impact")
    for n in [10, 15, 20, 30, 50]:
        r = test_with_stock_count(best_conditions(), base_params, 5, n, f"stocks_{n}")
        results.append(r)
        print(f"  {r['label']:30s} | val={r['val_score']:>7.2f} WR={r['val_wr']:>5.1f}% "
              f"ret={r['val_return']:>7.1f}% MDD={r['val_mdd']:>5.1f}% trades={r['val_trades']:>4d}")

    # ── Test 2: Higher min_conditions with full 50 stocks ─────────────────
    print("\n📊 Test 2: Higher selectivity (min_conditions)")
    all_conds = base_conditions() + [
        {"id": "obv", "name": "OBV趨勢", "type": "obv_trend", "params": {}},
        {"id": "weekly", "name": "週線確認", "type": "weekly_trend_confirm", "params": {}},
        {"id": "rsi_zone", "name": "RSI中性", "type": "rsi_neutral_zone",
         "params": {"rsi_low": 35, "rsi_high": 65}},
    ]
    for mc in [5, 6, 7]:
        r = test_with_stock_count(all_conds, base_params, mc, 50, f"min_cond_{mc}_8conds")
        results.append(r)
        print(f"  {r['label']:30s} | val={r['val_score']:>7.2f} WR={r['val_wr']:>5.1f}% "
              f"ret={r['val_return']:>7.1f}% MDD={r['val_mdd']:>5.1f}% trades={r['val_trades']:>4d}")

    # ── Test 3: Best conditions with fewer stocks + optimal params ────────
    print("\n📊 Test 3: Combined optimization")
    param_combos = [
        ("H7_SL10_20s", {**base_params, "hold_days": 7, "stop_loss_pct": -0.10}, 5, 20),
        ("H5_SL7_20s", {**base_params, "hold_days": 5, "stop_loss_pct": -0.07}, 5, 20),
        ("H7_SL7_20s", {**base_params, "hold_days": 7, "stop_loss_pct": -0.07}, 5, 20),
        ("H10_SL12_20s", {**base_params, "hold_days": 10, "stop_loss_pct": -0.12}, 5, 20),
        ("H7_SL10_15s", {**base_params, "hold_days": 7, "stop_loss_pct": -0.10}, 5, 15),
        ("H7_SL10_10s", {**base_params, "hold_days": 7, "stop_loss_pct": -0.10}, 5, 10),
        # Higher selectivity with fewer stocks
        ("mc6_H7_20s", {**base_params}, 6, 20),
        ("mc6_H7_15s", {**base_params}, 6, 15),
        ("mc7_H7_20s", {**base_params}, 7, 20),
        # All conditions, high selectivity, fewer stocks
        ("8c_mc6_20s", {**base_params}, 6, 20),
        ("8c_mc7_20s", {**base_params}, 7, 20),
    ]

    for label, params, mc, n in param_combos:
        conds = all_conds if label.startswith("8c") else best_conditions()
        r = test_with_stock_count(conds, params, mc, n, label)
        results.append(r)
        print(f"  {r['label']:30s} | val={r['val_score']:>7.2f} WR={r['val_wr']:>5.1f}% "
              f"ret={r['val_return']:>7.1f}% MDD={r['val_mdd']:>5.1f}% trades={r['val_trades']:>4d}")

    # ── Test 4: Try completely different approach — fewer conditions, stricter ──
    print("\n📊 Test 4: Minimalist strategies")
    minimal_conds = [
        {"id": "trend", "name": "趨勢", "type": "ma_crossover",
         "params": {"fast": 5, "slow": 20, "direction": "bullish"}},
        {"id": "position", "name": "位置", "type": "price_above_ma",
         "params": {"ma_period": 60}},
        {"id": "obv", "name": "OBV趨勢", "type": "obv_trend", "params": {}},
        {"id": "weekly", "name": "週線確認", "type": "weekly_trend_confirm", "params": {}},
    ]

    for label, params, mc, n in [
        ("minimal_mc4_10s", {**base_params}, 4, 10),
        ("minimal_mc4_15s", {**base_params}, 4, 15),
        ("minimal_mc3_20s", {**base_params}, 3, 20),
        ("minimal_mc4_20s", {**base_params}, 4, 20),
    ]:
        r = test_with_stock_count(minimal_conds, params, mc, n, label)
        results.append(r)
        print(f"  {r['label']:30s} | val={r['val_score']:>7.2f} WR={r['val_wr']:>5.1f}% "
              f"ret={r['val_return']:>7.1f}% MDD={r['val_mdd']:>5.1f}% trades={r['val_trades']:>4d}")

    # Sort and show final results
    results.sort(key=lambda x: x["val_score"], reverse=True)

    print(f"\n{'='*70}")
    print("🏆 Top 15 by validation score:")
    print(f"{'='*70}")
    for i, r in enumerate(results[:15]):
        marker = "👑" if i == 0 else "  "
        print(f"{marker} {i+1:2d}. {r['label']:30s} val={r['val_score']:>7.2f} "
              f"WR={r['val_wr']:>5.1f}% ret={r['val_return']:>7.1f}% MDD={r['val_mdd']:>5.1f}% "
              f"trades={r['val_trades']:>4d} PF={r['val_pf']:.2f}")


if __name__ == "__main__":
    main()
