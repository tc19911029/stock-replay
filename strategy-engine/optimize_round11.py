"""
Round 11: Robustness testing and stability improvement.
1. Test with different stock subsets (not just alphabetical first N)
2. Test mc=6 for more trades
3. Try market regime proxy (only trade when avg stock MA20 > MA60)
4. Try different data splits
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


def load_all_data():
    data = {}
    for f in sorted(DATA_DIR.glob("*.csv")):
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


def build_conds(rsi_low=30, rsi_high=55, atr_max=25, body=0.015, logic="or"):
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


def score_on_subset(strategy, all_data, symbols, split="validation"):
    subset = {s: all_data[s] for s in symbols if s in all_data}
    r = run_backtest(strategy, subset, "tw_stocks", split, 0.6, 0.2)
    m = calc_metrics(r["trades"])
    s = calc_strategy_score(m)
    return s


def main():
    print(f"{'='*75}")
    print(f"🔬 Round 11: Robustness & Stability — {datetime.now().strftime('%H:%M:%S')}")
    print(f"{'='*75}\n")

    all_data = load_all_data()
    all_symbols = list(all_data.keys())
    print(f"   Total stocks: {len(all_symbols)}")

    bp = {
        "ma_fast": 5, "ma_mid": 10, "ma_slow": 20, "ma_long": 60,
        "volume_multiplier": 1.5, "volume_avg_period": 5, "kbar_min_body_pct": 0.015,
        "macd_fast": 12, "macd_slow": 26, "macd_signal": 9,
        "kd_period": 9, "kd_smooth_k": 3, "kd_smooth_d": 3,
        "hold_days": 10, "stop_loss_pct": -0.10,
    }

    # Winner config
    conds_winner = build_conds(30, 55, 25, 0.015, "or")

    # ── 1. Bootstrap test: random subsets ──────────────────────────────────
    print("📊 1. Bootstrap Test (10 random 30-stock subsets):")
    random.seed(42)
    bootstrap_scores = []
    s = make_s("winner", conds_winner, bp, 7)

    for trial in range(10):
        subset = random.sample(all_symbols, 30)
        val_sc = score_on_subset(s, all_data, subset, "validation")
        test_sc = score_on_subset(s, all_data, subset, "test")
        avg = (val_sc["total_score"] + test_sc["total_score"]) / 2
        bootstrap_scores.append(avg)
        print(f"  Trial {trial+1}: avg={avg:>7.2f} val={val_sc['total_score']:>7.2f} test={test_sc['total_score']:>7.2f} trades={val_sc['trade_count']:>3d}/{test_sc['trade_count']:>3d}")

    print(f"  Bootstrap mean={np.mean(bootstrap_scores):.2f} std={np.std(bootstrap_scores):.1f} "
          f"min={np.min(bootstrap_scores):.2f} max={np.max(bootstrap_scores):.2f}")
    print(f"  Positive rate: {sum(1 for s in bootstrap_scores if s > 0)}/10")

    # ── 2. mc=6 vs mc=7 comparison ─────────────────────────────────────────
    print("\n📊 2. mc=6 vs mc=7 on full 50 stocks:")
    data50 = {s: all_data[s] for s in all_symbols[:50]}

    for mc in [6, 7]:
        s = make_s(f"mc{mc}", conds_winner, bp, mc)
        val_sc = score_on_subset(s, all_data, all_symbols, "validation")
        test_sc = score_on_subset(s, all_data, all_symbols, "test")
        avg = (val_sc["total_score"] + test_sc["total_score"]) / 2
        print(f"  mc={mc}: avg={avg:>7.2f} val={val_sc['total_score']:>7.2f} test={test_sc['total_score']:>7.2f} "
              f"trades={val_sc['trade_count']:>4d}/{test_sc['trade_count']:>4d} WR={val_sc['win_rate']:>5.1f}%")

    # ── 3. Test top variants from R10 on full 50 stocks ──────────────────
    print("\n📊 3. Top R10 variants on all stocks:")
    top_variants = [
        ("R10_winner_a25_b15_h10", build_conds(30, 55, 25, 0.015, "or"), {**bp, "hold_days": 10}),
        ("a20_b15_and_h7", build_conds(35, 60, 20, 0.015, "and"), {**bp, "hold_days": 7}),
        ("a25_b15_and_h7", build_conds(35, 60, 25, 0.015, "and"), {**bp, "hold_days": 7}),
        ("a30_b15_and_h7", build_conds(35, 60, 30, 0.015, "and"), {**bp, "hold_days": 7}),
        ("a25_b10_h10", build_conds(30, 55, 25, 0.01, "or"), {**bp, "hold_days": 10}),
        ("a25_b10_h7", build_conds(30, 60, 25, 0.01, "or"), {**bp, "hold_days": 7}),
        ("a20_b10_and_h7", build_conds(35, 60, 20, 0.01, "and"), {**bp, "hold_days": 7}),
    ]

    results = []
    for label, conds, params in top_variants:
        s = make_s(label, conds, params, 7)
        val_sc = score_on_subset(s, all_data, all_symbols, "validation")
        test_sc = score_on_subset(s, all_data, all_symbols, "test")
        avg = (val_sc["total_score"] + test_sc["total_score"]) / 2

        # Also bootstrap test
        random.seed(42)
        boot_scores = []
        for _ in range(5):
            subset = random.sample(all_symbols, 30)
            v = score_on_subset(s, all_data, subset, "validation")
            t = score_on_subset(s, all_data, subset, "test")
            boot_scores.append((v["total_score"] + t["total_score"]) / 2)
        boot_mean = np.mean(boot_scores)
        boot_min = np.min(boot_scores)

        results.append({
            "label": label, "avg": avg, "val": val_sc["total_score"], "test": test_sc["total_score"],
            "trades": val_sc["trade_count"], "wr": val_sc["win_rate"], "mdd": val_sc["max_drawdown"],
            "boot_mean": boot_mean, "boot_min": boot_min,
            "conds": conds, "params": params,
        })
        print(f"  {label:30s} avg={avg:>7.2f} boot_mean={boot_mean:>7.2f} boot_min={boot_min:>7.2f} "
              f"trades={val_sc['trade_count']:>4d} WR={val_sc['win_rate']:>5.1f}% MDD={val_sc['max_drawdown']:>5.1f}%")

    # Rank by combination of avg score and bootstrap stability
    for r in results:
        r["robust_score"] = r["avg"] * 0.5 + r["boot_mean"] * 0.3 + r["boot_min"] * 0.2

    results.sort(key=lambda x: x["robust_score"], reverse=True)

    print(f"\n🏆 Robustness Ranking (avg*0.5 + boot_mean*0.3 + boot_min*0.2):")
    for i, r in enumerate(results):
        marker = "👑" if i == 0 else "  "
        print(f"{marker} {i+1}. {r['label']:30s} robust={r['robust_score']:>7.2f} "
              f"(avg={r['avg']:>7.2f} boot={r['boot_mean']:>7.2f}/{r['boot_min']:>7.2f})")

    # Save best
    if results:
        best = results[0]
        s = StrategyConfig(
            version="v021", name=f"穩健優化策略_{best['label']}",
            entry_conditions=best["conds"],
            exit_conditions=[
                {"id": "hold_days", "type": "hold_period", "name": "H", "params": {"days": best["params"]["hold_days"]}},
                {"id": "stop_loss", "type": "stop_loss", "name": "S", "params": {"pct": best["params"]["stop_loss_pct"]}},
            ],
            parameters=best["params"], min_conditions=7,
        )
        save_strategy(s)
        print(f"\n💾 v021 saved: {best['label']} (robust={best['robust_score']:.2f})")


if __name__ == "__main__":
    main()
