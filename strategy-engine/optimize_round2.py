"""
Round 2: Test take-profit and trailing stop on the best strategies from Round 1.
Focus on reducing MDD while maintaining returns.
"""
from __future__ import annotations
import sys
import json
from pathlib import Path
from datetime import datetime

sys.path.insert(0, str(Path(__file__).parent))

from optimize_loop import load_cached_data, test_strategy, make_strategy, base_conditions


def main():
    print(f"{'='*70}")
    print(f"🔬 Round 2: Take-Profit & Trailing Stop Optimization — {datetime.now().strftime('%H:%M:%S')}")
    print(f"{'='*70}")

    data = load_cached_data(50)
    print(f"   Loaded {len(data)} stocks\n")

    # Best conditions from Round 1: base + OBV + weekly, min_cond=5
    best_conds = base_conditions() + [
        {"id": "obv", "name": "OBV趨勢", "type": "obv_trend", "params": {}},
        {"id": "weekly", "name": "週線確認", "type": "weekly_trend_confirm", "params": {}},
    ]

    base_params = {
        "ma_fast": 5, "ma_mid": 10, "ma_slow": 20, "ma_long": 60,
        "volume_multiplier": 1.5, "volume_avg_period": 5,
        "kbar_min_body_pct": 0.02,
        "macd_fast": 12, "macd_slow": 26, "macd_signal": 9,
        "kd_period": 9, "kd_smooth_k": 3, "kd_smooth_d": 3,
        "hold_days": 7, "stop_loss_pct": -0.10,
    }

    variants = []

    # Baseline (no TP/TS)
    variants.append(("baseline", {**base_params}))

    # Take-profit only
    for tp in [0.05, 0.08, 0.10, 0.12, 0.15, 0.20]:
        p = {**base_params, "take_profit_pct": tp}
        variants.append((f"TP_{int(tp*100)}%", p))

    # Trailing stop only
    for ts in [0.03, 0.04, 0.05, 0.06, 0.08]:
        p = {**base_params, "trailing_stop_pct": ts}
        variants.append((f"TS_{int(ts*100)}%", p))

    # Combined TP + TS
    for tp in [0.08, 0.10, 0.15]:
        for ts in [0.03, 0.05]:
            p = {**base_params, "take_profit_pct": tp, "trailing_stop_pct": ts}
            variants.append((f"TP{int(tp*100)}_TS{int(ts*100)}", p))

    # Also test with different hold days + TP/TS
    for hd in [5, 10]:
        p = {**base_params, "hold_days": hd, "take_profit_pct": 0.10, "trailing_stop_pct": 0.05}
        variants.append((f"H{hd}_TP10_TS5", p))

    # Test with tighter stop loss + TP
    for sl in [-0.05, -0.07]:
        p = {**base_params, "stop_loss_pct": sl, "take_profit_pct": 0.10, "trailing_stop_pct": 0.04}
        variants.append((f"SL{int(abs(sl)*100)}_TP10_TS4", p))

    results = []
    for name, params in variants:
        strategy = make_strategy(name, name, best_conds, params, 5)
        try:
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
                "val_pf": val_r["profit_factor"],
            })
            print(f"  {name:25s} | train={train_r['score']:>7.2f} val={val_r['score']:>7.2f} "
                  f"WR={val_r['win_rate']:>5.1f}% ret={val_r['annual_return']:>7.1f}% "
                  f"MDD={val_r['mdd']:>5.1f}% trades={val_r['trades']:>4d} PF={val_r['profit_factor']:.2f}")
        except Exception as e:
            print(f"  {name:25s} | ERROR: {e}")

    results.sort(key=lambda x: x["val_score"], reverse=True)

    print(f"\n{'='*70}")
    print("🏆 Top 10 by validation score:")
    print(f"{'='*70}")
    for i, r in enumerate(results[:10]):
        marker = "👑" if i == 0 else "  "
        print(f"{marker} {i+1}. {r['name']:25s} val={r['val_score']:>7.2f} "
              f"WR={r['val_wr']:>5.1f}% ret={r['val_return']:>7.1f}% MDD={r['val_mdd']:>5.1f}%")

    # Save the best as v013.json
    if results:
        best = results[0]
        best_params = None
        for name, params in variants:
            if name == best["name"]:
                best_params = params
                break
        if best_params:
            from strategies.base import StrategyConfig
            from strategies.registry import save_strategy
            s = make_strategy(
                f"OBV+週線+{best['name']}",
                "v013",
                best_conds,
                best_params,
                5,
            )
            save_strategy(s)
            print(f"\n💾 Saved best as v013: {best['name']} (score={best['val_score']:.2f})")

    return results


if __name__ == "__main__":
    main()
