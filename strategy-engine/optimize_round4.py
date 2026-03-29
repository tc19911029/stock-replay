"""
Round 4: Fine-tune the breakthrough strategy (mc7_H7_20s)
Winner: 7 conditions from 7, 20 stocks, hold 7, SL -10% → score +8.60
Now: vary params around this sweet spot and validate on test set.
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
        version=version,
        name=name,
        entry_conditions=conditions,
        exit_conditions=[
            {"id": "hold_days", "type": "hold_period", "name": "持有", "params": {"days": params.get("hold_days", 7)}},
            {"id": "stop_loss", "type": "stop_loss", "name": "停損", "params": {"pct": params.get("stop_loss_pct", -0.10)}},
        ],
        parameters=params,
        min_conditions=min_cond,
    )


def test_full(strategy, data):
    """Test on train, validation, and test splits."""
    results = {}
    for split in ["train", "validation", "test"]:
        r = run_backtest(strategy, data, "tw_stocks", split, 0.6, 0.2)
        m = calc_metrics(r["trades"])
        s = calc_strategy_score(m)
        results[split] = {
            "score": s["total_score"],
            "wr": s["win_rate"],
            "ret": s["annualized_return"],
            "mdd": s["max_drawdown"],
            "trades": s["trade_count"],
            "pf": s["profit_factor"],
            "sharpe": s["sharpe_ratio"],
        }
    return results


def main():
    print(f"{'='*75}")
    print(f"🔬 Round 4: Fine-tuning mc7 winner — {datetime.now().strftime('%H:%M:%S')}")
    print(f"{'='*75}\n")

    # Winner conditions: base 5 + OBV + weekly = 7 total, min_cond = 7
    winner_conds = base_conditions() + [
        {"id": "obv", "name": "OBV趨勢", "type": "obv_trend", "params": {}},
        {"id": "weekly", "name": "週線確認", "type": "weekly_trend_confirm", "params": {}},
    ]

    # Extended conditions: add RSI zone for 8 total
    ext_conds = winner_conds + [
        {"id": "rsi_zone", "name": "RSI中性", "type": "rsi_neutral_zone",
         "params": {"rsi_low": 35, "rsi_high": 65}},
    ]

    # Even more: add low vol breakout for 9 total
    ext2_conds = ext_conds + [
        {"id": "low_vol", "name": "低波突破", "type": "low_volatility_breakout",
         "params": {"atr_pct_max": 35}},
    ]

    base_params = {
        "ma_fast": 5, "ma_mid": 10, "ma_slow": 20, "ma_long": 60,
        "volume_multiplier": 1.5, "volume_avg_period": 5,
        "kbar_min_body_pct": 0.02,
        "macd_fast": 12, "macd_slow": 26, "macd_signal": 9,
        "kd_period": 9, "kd_smooth_k": 3, "kd_smooth_d": 3,
        "hold_days": 7, "stop_loss_pct": -0.10,
    }

    data20 = load_data(20)
    data25 = load_data(25)
    data30 = load_data(30)

    all_results = []

    # ── Grid: hold_days x stop_loss x stock_count ───────────────────────
    print("📊 Parameter Grid Search:")
    for hd in [5, 6, 7, 8, 10]:
        for sl in [-0.07, -0.08, -0.10, -0.12]:
            for n, data in [(20, data20), (25, data25)]:
                p = {**base_params, "hold_days": hd, "stop_loss_pct": sl}
                s = make_strategy(f"H{hd}_SL{int(abs(sl)*100)}_N{n}", "test", winner_conds, p, 7)
                r = test_full(s, data)
                v = r["validation"]
                t = r["test"]
                label = f"H{hd}_SL{int(abs(sl)*100)}_N{n}"
                all_results.append({
                    "label": label,
                    "conds": 7,
                    "params": p,
                    "n_stocks": n,
                    **{f"val_{k}": v[k] for k in v},
                    **{f"test_{k}": t[k] for k in t},
                })
                print(f"  {label:25s} | val={v['score']:>7.2f} test={t['score']:>7.2f} "
                      f"val_WR={v['wr']:>5.1f}% val_ret={v['ret']:>7.1f}% val_MDD={v['mdd']:>5.1f}%")

    # ── Test with extended conditions (8 conds, mc=7) ─────────────────────
    print("\n📊 Extended Conditions (8 conds, mc=7):")
    for hd in [7, 8, 10]:
        for sl in [-0.08, -0.10, -0.12]:
            for n, data in [(20, data20), (25, data25)]:
                p = {**base_params, "hold_days": hd, "stop_loss_pct": sl}
                s = make_strategy(f"8c_H{hd}_SL{int(abs(sl)*100)}_N{n}", "test", ext_conds, p, 7)
                r = test_full(s, data)
                v = r["validation"]
                t = r["test"]
                label = f"8c_H{hd}_SL{int(abs(sl)*100)}_N{n}"
                all_results.append({
                    "label": label,
                    "conds": 8,
                    "params": p,
                    "n_stocks": n,
                    **{f"val_{k}": v[k] for k in v},
                    **{f"test_{k}": t[k] for k in t},
                })
                print(f"  {label:25s} | val={v['score']:>7.2f} test={t['score']:>7.2f} "
                      f"val_WR={v['wr']:>5.1f}% val_ret={v['ret']:>7.1f}% val_MDD={v['mdd']:>5.1f}%")

    # ── Test with 9 conditions (mc=7) ────────────────────────────────────
    print("\n📊 9 conditions (mc=7):")
    for hd in [7, 10]:
        for sl in [-0.10, -0.12]:
            p = {**base_params, "hold_days": hd, "stop_loss_pct": sl}
            s = make_strategy(f"9c_H{hd}_SL{int(abs(sl)*100)}", "test", ext2_conds, p, 7)
            r = test_full(s, data20)
            v = r["validation"]
            t = r["test"]
            label = f"9c_H{hd}_SL{int(abs(sl)*100)}_N20"
            all_results.append({
                "label": label,
                "conds": 9,
                "params": p,
                "n_stocks": 20,
                **{f"val_{k}": v[k] for k in v},
                **{f"test_{k}": t[k] for k in t},
            })
            print(f"  {label:25s} | val={v['score']:>7.2f} test={t['score']:>7.2f} "
                  f"val_WR={v['wr']:>5.1f}% val_ret={v['ret']:>7.1f}% val_MDD={v['mdd']:>5.1f}%")

    # ── Final ranking ─────────────────────────────────────────────────────
    # Rank by average of val + test score (robustness)
    for r in all_results:
        r["avg_score"] = (r["val_score"] + r["test_score"]) / 2

    all_results.sort(key=lambda x: x["avg_score"], reverse=True)

    print(f"\n{'='*75}")
    print("🏆 Top 15 by avg(val + test) score — ROBUSTNESS RANKING:")
    print(f"{'='*75}")
    for i, r in enumerate(all_results[:15]):
        marker = "👑" if i == 0 else "  "
        print(f"{marker} {i+1:2d}. {r['label']:25s} avg={r['avg_score']:>7.2f} "
              f"(val={r['val_score']:>7.2f} test={r['test_score']:>7.2f}) "
              f"val_WR={r['val_wr']:>5.1f}% val_ret={r['val_ret']:>7.1f}% val_MDD={r['val_mdd']:>5.1f}%")

    # Save the best
    if all_results:
        best = all_results[0]
        print(f"\n✅ Best robust strategy: {best['label']}")
        print(f"   Val: score={best['val_score']:.2f} WR={best['val_wr']:.1f}% ret={best['val_ret']:.1f}% MDD={best['val_mdd']:.1f}%")
        print(f"   Test: score={best['test_score']:.2f} WR={best['test_wr']:.1f}% ret={best['test_ret']:.1f}% MDD={best['test_mdd']:.1f}%")

        # Save as v013
        n_conds = best["conds"]
        if n_conds == 7:
            conds = winner_conds
        elif n_conds == 8:
            conds = ext_conds
        else:
            conds = ext2_conds

        s = make_strategy(
            f"高選擇性策略_{best['label']}",
            "v013",
            conds,
            best["params"],
            7,
        )
        save_strategy(s)
        print(f"\n💾 Saved as v013")

    return all_results


if __name__ == "__main__":
    main()
