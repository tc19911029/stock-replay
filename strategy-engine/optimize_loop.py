"""
Focused optimization loop — Round 21+
Tests multiple strategy improvements rapidly.
"""
from __future__ import annotations
import sys
import json
import copy
from pathlib import Path
from datetime import datetime

sys.path.insert(0, str(Path(__file__).parent))

import pandas as pd
from analysis.technical import compute_all_indicators, evaluate_conditions
from backtest.engine import run_backtest, _default_cost
from backtest.metrics import calc_metrics
from evaluator import calc_strategy_score, format_score_report
from strategies.base import StrategyConfig
from strategies.registry import load_strategy, save_strategy, next_version

DATA_DIR = Path(__file__).parent / "data" / "cache" / "tw_stocks"


def load_cached_data(max_stocks: int = 50) -> dict[str, pd.DataFrame]:
    """Load all cached CSV data."""
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


def test_strategy(strategy: StrategyConfig, data: dict, split: str = "validation",
                  train_ratio: float = 0.6, val_ratio: float = 0.2) -> dict:
    """Run backtest and return score details."""
    result = run_backtest(strategy, data, "tw_stocks", split, train_ratio, val_ratio)
    metrics = result["stats"]
    score = calc_strategy_score(metrics)
    return {
        "score": score["total_score"],
        "annual_return": score["annualized_return"],
        "win_rate": score["win_rate"],
        "mdd": score["max_drawdown"],
        "trades": score["trade_count"],
        "sharpe": score["sharpe_ratio"],
        "profit_factor": score["profit_factor"],
        "details": score,
    }


def make_strategy(name: str, version: str, conditions: list, params: dict, min_cond: int) -> StrategyConfig:
    """Build a StrategyConfig from scratch."""
    return StrategyConfig(
        version=version,
        name=name,
        entry_conditions=conditions,
        exit_conditions=[
            {"id": "hold_days", "name": "持有天數", "type": "hold_period", "params": {"days": params.get("hold_days", 7)}},
            {"id": "stop_loss", "name": "停損", "type": "stop_loss", "params": {"pct": params.get("stop_loss_pct", -0.10)}},
        ],
        parameters=params,
        min_conditions=min_cond,
    )


# ── Strategy Variants to Test ──────────────────────────────────────────────

def base_conditions():
    """Core conditions from v012 + grid search best params."""
    return [
        {"id": "trend", "name": "趨勢", "type": "ma_crossover",
         "params": {"fast": 5, "slow": 20, "direction": "bullish"}},
        {"id": "position", "name": "位置", "type": "price_above_ma",
         "params": {"ma_period": 60}},
        {"id": "kbar", "name": "K棒", "type": "bullish_candle",
         "params": {"min_body_pct": 0.02}},
        {"id": "ma_align", "name": "均線多排", "type": "ma_alignment",
         "params": {"periods": [5, 10, 20], "direction": "bullish"}},
        {"id": "indicator", "name": "指標", "type": "indicator_confirm",
         "params": {"macd_positive": True, "kd_golden_cross": True, "logic": "or"}},
    ]


def strategy_variants():
    """Generate multiple strategy variants to test."""
    variants = []

    base_params = {
        "ma_fast": 5, "ma_mid": 10, "ma_slow": 20, "ma_long": 60,
        "volume_multiplier": 1.5, "volume_avg_period": 5,
        "kbar_min_body_pct": 0.02,
        "macd_fast": 12, "macd_slow": 26, "macd_signal": 9,
        "kd_period": 9, "kd_smooth_k": 3, "kd_smooth_d": 3,
        "hold_days": 7, "stop_loss_pct": -0.10,
    }

    # V1: Baseline (v012 + grid search best)
    variants.append(("v012_baseline", base_conditions(), base_params, 4))

    # V2: Add OBV trend condition
    conds = base_conditions() + [
        {"id": "obv", "name": "OBV趨勢", "type": "obv_trend", "params": {}},
    ]
    variants.append(("v013_obv", conds, base_params, 4))

    # V3: Add weekly trend
    conds = base_conditions() + [
        {"id": "weekly", "name": "週線確認", "type": "weekly_trend_confirm", "params": {}},
    ]
    variants.append(("v014_weekly", conds, base_params, 4))

    # V4: OBV + weekly, min_cond=5
    conds = base_conditions() + [
        {"id": "obv", "name": "OBV趨勢", "type": "obv_trend", "params": {}},
        {"id": "weekly", "name": "週線確認", "type": "weekly_trend_confirm", "params": {}},
    ]
    variants.append(("v015_obv_weekly_5", conds, base_params, 5))

    # V5: RSI neutral zone (avoid overbought)
    conds = base_conditions() + [
        {"id": "rsi_zone", "name": "RSI中性", "type": "rsi_neutral_zone",
         "params": {"rsi_low": 35, "rsi_high": 65}},
    ]
    variants.append(("v016_rsi_zone", conds, base_params, 4))

    # V6: Low vol breakout (squeeze play)
    conds = base_conditions() + [
        {"id": "low_vol", "name": "低波動突破", "type": "low_volatility_breakout",
         "params": {"atr_pct_max": 35}},
    ]
    variants.append(("v017_lowvol", conds, base_params, 4))

    # V7: Shorter hold (5 days), tighter stop (-0.07)
    p = {**base_params, "hold_days": 5, "stop_loss_pct": -0.07}
    variants.append(("v018_short", base_conditions(), p, 4))

    # V8: Longer hold (10 days), wider stop (-0.12), fewer min_cond (3)
    p = {**base_params, "hold_days": 10, "stop_loss_pct": -0.12}
    variants.append(("v019_long", base_conditions(), p, 3))

    # V9: All conditions, min_cond=5 (high quality signals only)
    conds = base_conditions() + [
        {"id": "obv", "name": "OBV趨勢", "type": "obv_trend", "params": {}},
        {"id": "weekly", "name": "週線確認", "type": "weekly_trend_confirm", "params": {}},
        {"id": "rsi_zone", "name": "RSI中性", "type": "rsi_neutral_zone",
         "params": {"rsi_low": 35, "rsi_high": 65}},
    ]
    variants.append(("v020_full_5", conds, {**base_params}, 5))

    # V10: All conditions, min_cond=6 (ultra selective)
    variants.append(("v021_full_6", conds, {**base_params}, 6))

    # V11: Remove kbar (body pct), add OBV — less restrictive entry
    conds = [c for c in base_conditions() if c["id"] != "kbar"] + [
        {"id": "obv", "name": "OBV趨勢", "type": "obv_trend", "params": {}},
    ]
    variants.append(("v022_no_kbar_obv", conds, base_params, 4))

    # V12: Pullback buy — remove kbar, add RSI low, min_cond=3
    conds = [c for c in base_conditions() if c["id"] != "kbar"] + [
        {"id": "rsi_zone", "name": "RSI回檔", "type": "rsi_neutral_zone",
         "params": {"rsi_low": 30, "rsi_high": 55}},
    ]
    p = {**base_params, "hold_days": 8, "stop_loss_pct": -0.08}
    variants.append(("v023_pullback", conds, p, 3))

    # V13: Trend following — only trend + position + weekly + OBV, min=3
    conds = [
        {"id": "trend", "name": "趨勢", "type": "ma_crossover",
         "params": {"fast": 5, "slow": 20, "direction": "bullish"}},
        {"id": "position", "name": "位置", "type": "price_above_ma",
         "params": {"ma_period": 60}},
        {"id": "weekly", "name": "週線確認", "type": "weekly_trend_confirm", "params": {}},
        {"id": "obv", "name": "OBV趨勢", "type": "obv_trend", "params": {}},
    ]
    p = {**base_params, "hold_days": 10, "stop_loss_pct": -0.12}
    variants.append(("v024_trend_follow", conds, p, 3))

    # V14: Momentum — MA align + indicator + OBV, shorter hold
    conds = [
        {"id": "ma_align", "name": "均線多排", "type": "ma_alignment",
         "params": {"periods": [5, 10, 20], "direction": "bullish"}},
        {"id": "indicator", "name": "指標", "type": "indicator_confirm",
         "params": {"macd_positive": True, "kd_golden_cross": True, "logic": "and"}},
        {"id": "obv", "name": "OBV趨勢", "type": "obv_trend", "params": {}},
        {"id": "weekly", "name": "週線確認", "type": "weekly_trend_confirm", "params": {}},
    ]
    p = {**base_params, "hold_days": 5, "stop_loss_pct": -0.08}
    variants.append(("v025_momentum", conds, p, 3))

    return variants


def main():
    print(f"{'='*60}")
    print(f"🔬 Strategy Optimization Loop — {datetime.now().strftime('%H:%M:%S')}")
    print(f"{'='*60}")

    # Load data
    print("\n📊 Loading cached data...")
    data = load_cached_data(50)
    print(f"   Loaded {len(data)} stocks")

    # Test all variants
    variants = strategy_variants()
    results = []

    for name, conditions, params, min_cond in variants:
        strategy = make_strategy(name, name, conditions, params, min_cond)
        try:
            # Test on both train and validation
            train_r = test_strategy(strategy, data, "train")
            val_r = test_strategy(strategy, data, "validation")

            results.append({
                "name": name,
                "train_score": train_r["score"],
                "val_score": val_r["score"],
                "val_wr": val_r["win_rate"],
                "val_return": val_r["annual_return"],
                "val_mdd": val_r["mdd"],
                "val_trades": val_r["trades"],
                "val_sharpe": val_r["sharpe"],
                "val_pf": val_r["profit_factor"],
                "overfit": train_r["score"] - val_r["score"],
            })

            print(f"  {name:30s} | train={train_r['score']:>7.2f} val={val_r['score']:>7.2f} "
                  f"WR={val_r['win_rate']:>5.1f}% ret={val_r['annual_return']:>7.1f}% "
                  f"MDD={val_r['mdd']:>5.1f}% trades={val_r['trades']:>4d} PF={val_r['profit_factor']:.2f}")

        except Exception as e:
            print(f"  {name:30s} | ERROR: {e}")
            import traceback
            traceback.print_exc()

    # Sort by validation score
    results.sort(key=lambda x: x["val_score"], reverse=True)

    print(f"\n{'='*60}")
    print("🏆 Results ranked by validation score:")
    print(f"{'='*60}")
    for i, r in enumerate(results):
        marker = "👑" if i == 0 else "  "
        print(f"{marker} {i+1}. {r['name']:30s} val={r['val_score']:>7.2f} "
              f"(train={r['train_score']:>7.2f}, overfit={r['overfit']:>+.1f})")

    # Save best if it improves
    if results:
        best = results[0]
        print(f"\n✅ Best: {best['name']} (val_score={best['val_score']:.2f})")
        print(f"   WR={best['val_wr']:.1f}% Return={best['val_return']:.1f}% "
              f"MDD={best['val_mdd']:.1f}% Trades={best['val_trades']} "
              f"Sharpe={best['val_sharpe']:.3f} PF={best['val_pf']:.2f}")

    return results


if __name__ == "__main__":
    main()
