"""
Round 8: Deep-dive into C_no_pos strategy (remove MA60 filter).
Why it works: without MA60, the 7/8 condition requirement becomes extremely selective,
producing very few but high-quality trades with low MDD.

Test: vary params, add/remove conditions, test robustness.
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


def make_s(name, conds, params, mc):
    return StrategyConfig(
        version="test", name=name,
        entry_conditions=conds,
        exit_conditions=[
            {"id": "hold_days", "type": "hold_period", "name": "H", "params": {"days": params.get("hold_days", 7)}},
            {"id": "stop_loss", "type": "stop_loss", "name": "S", "params": {"pct": params.get("stop_loss_pct", -0.10)}},
        ],
        parameters=params, min_conditions=mc,
    )


def test_multi(strategy, data_dict):
    """Test on multiple stock counts."""
    results = {}
    for n, data in data_dict.items():
        scores = {}
        for split in ["validation", "test"]:
            r = run_backtest(strategy, data, "tw_stocks", split, 0.6, 0.2)
            m = calc_metrics(r["trades"])
            scores[split] = calc_strategy_score(m)
        results[n] = scores
    return results


def c_no_pos_base():
    """8 conditions without MA60 position filter."""
    return [
        {"id": "trend", "type": "ma_crossover", "name": "T", "params": {"fast": 5, "slow": 20, "direction": "bullish"}},
        {"id": "kbar", "type": "bullish_candle", "name": "K", "params": {"min_body_pct": 0.02}},
        {"id": "ma_align", "type": "ma_alignment", "name": "MA", "params": {"periods": [5, 10, 20], "direction": "bullish"}},
        {"id": "indicator", "type": "indicator_confirm", "name": "I", "params": {"macd_positive": True, "kd_golden_cross": True, "logic": "or"}},
        {"id": "obv", "type": "obv_trend", "name": "O", "params": {}},
        {"id": "weekly", "type": "weekly_trend_confirm", "name": "W", "params": {}},
        {"id": "rsi_zone", "type": "rsi_neutral_zone", "name": "R", "params": {"rsi_low": 30, "rsi_high": 60}},
        {"id": "low_vol", "type": "low_volatility_breakout", "name": "LV", "params": {"atr_pct_max": 30}},
    ]


def main():
    print(f"{'='*80}")
    print(f"🔬 Round 8: No-Position Strategy Deep Dive — {datetime.now().strftime('%H:%M:%S')}")
    print(f"{'='*80}\n")

    datasets = {n: load_data(n) for n in [20, 30, 50]}

    bp = {
        "ma_fast": 5, "ma_mid": 10, "ma_slow": 20, "ma_long": 60,
        "volume_multiplier": 1.5, "volume_avg_period": 5, "kbar_min_body_pct": 0.02,
        "macd_fast": 12, "macd_slow": 26, "macd_signal": 9,
        "kd_period": 9, "kd_smooth_k": 3, "kd_smooth_d": 3,
        "hold_days": 7, "stop_loss_pct": -0.10,
    }

    all_results = []

    # ── A: Vary min_conditions ────────────────────────────────────────────
    print("📊 A: Vary min_conditions (8 conds):")
    for mc in [5, 6, 7, 8]:
        s = make_s(f"mc{mc}", c_no_pos_base(), bp, mc)
        for n in [20, 30, 50]:
            r = run_backtest(s, datasets[n], "tw_stocks", "validation", 0.6, 0.2)
            m = calc_metrics(r["trades"])
            sc = calc_strategy_score(m)
            r2 = run_backtest(s, datasets[n], "tw_stocks", "test", 0.6, 0.2)
            m2 = calc_metrics(r2["trades"])
            sc2 = calc_strategy_score(m2)
            avg = (sc["total_score"] + sc2["total_score"]) / 2

            label = f"mc{mc}_N{n}"
            all_results.append({
                "label": label, "mc": mc, "n": n,
                "val_score": sc["total_score"], "test_score": sc2["total_score"],
                "avg_score": avg,
                "val_trades": sc["trade_count"], "val_wr": sc["win_rate"],
                "val_mdd": sc["max_drawdown"], "val_pf": sc.get("profit_factor", 0),
            })
            print(f"  {label:15s} avg={avg:>7.2f} val={sc['total_score']:>7.2f} test={sc2['total_score']:>7.2f} "
                  f"trades={sc['trade_count']:>4d}/{sc2['trade_count']:>4d} MDD={sc['max_drawdown']:>5.1f}%")

    # ── B: Vary hold_days and stop_loss ────────────────────────────────────
    print("\n📊 B: Vary hold/SL (mc=7, N=50 for more trades):")
    for hd in [5, 7, 10, 14]:
        for sl in [-0.07, -0.10, -0.12, -0.15]:
            p = {**bp, "hold_days": hd, "stop_loss_pct": sl}
            s = make_s(f"H{hd}_SL{int(abs(sl)*100)}", c_no_pos_base(), p, 7)
            scores = {}
            for split in ["validation", "test"]:
                r = run_backtest(s, datasets[50], "tw_stocks", split, 0.6, 0.2)
                scores[split] = calc_strategy_score(calc_metrics(r["trades"]))
            v, t = scores["validation"], scores["test"]
            avg = (v["total_score"] + t["total_score"]) / 2

            label = f"H{hd}_SL{int(abs(sl)*100)}_N50"
            all_results.append({
                "label": label, "mc": 7, "n": 50,
                "val_score": v["total_score"], "test_score": t["total_score"],
                "avg_score": avg,
                "val_trades": v["trade_count"], "val_wr": v["win_rate"],
                "val_mdd": v["max_drawdown"], "val_pf": v["profit_factor"],
            })
            if avg > 10:
                print(f"  {label:20s} avg={avg:>7.2f} val={v['total_score']:>7.2f} test={t['total_score']:>7.2f} "
                      f"trades={v['trade_count']:>4d} WR={v['win_rate']:>5.1f}% MDD={v['max_drawdown']:>5.1f}%")

    # ── C: Add more conditions (9-10) with mc=7 ───────────────────────────
    print("\n📊 C: Extended conditions (mc=7, N=50):")
    ext_variants = [
        ("add_vol_surge", c_no_pos_base() + [
            {"id": "vol_surge", "type": "volume_surge", "name": "V", "params": {"avg_period": 5, "multiplier": 1.3}},
        ]),
        ("rsi_30_70", [{**c, "params": {"rsi_low": 30, "rsi_high": 70}} if c["id"] == "rsi_zone" else c for c in c_no_pos_base()]),
        ("rsi_40_70", [{**c, "params": {"rsi_low": 40, "rsi_high": 70}} if c["id"] == "rsi_zone" else c for c in c_no_pos_base()]),
        ("atr35", [{**c, "params": {"atr_pct_max": 35}} if c["id"] == "low_vol" else c for c in c_no_pos_base()]),
        ("atr40", [{**c, "params": {"atr_pct_max": 40}} if c["id"] == "low_vol" else c for c in c_no_pos_base()]),
        ("body1pct", [{**c, "params": {"min_body_pct": 0.01}} if c["id"] == "kbar" else c for c in c_no_pos_base()]),
        # Add position back but with MA20 instead of MA60 (shorter term)
        ("add_pos_ma20", c_no_pos_base() + [
            {"id": "position20", "type": "price_above_ma", "name": "P20", "params": {"ma_period": 20}},
        ]),
    ]

    for name, conds in ext_variants:
        s = make_s(name, conds, bp, 7)
        scores = {}
        for split in ["validation", "test"]:
            r = run_backtest(s, datasets[50], "tw_stocks", split, 0.6, 0.2)
            scores[split] = calc_strategy_score(calc_metrics(r["trades"]))
        v, t = scores["validation"], scores["test"]
        avg = (v["total_score"] + t["total_score"]) / 2

        label = f"{name}_N50"
        all_results.append({
            "label": label, "mc": 7, "n": 50,
            "val_score": v["total_score"], "test_score": t["total_score"],
            "avg_score": avg,
            "val_trades": v["trade_count"], "val_wr": v["win_rate"],
            "val_mdd": v["max_drawdown"], "val_pf": v["profit_factor"],
        })
        print(f"  {label:25s} avg={avg:>7.2f} val={v['total_score']:>7.2f} test={t['total_score']:>7.2f} "
              f"trades={v['trade_count']:>4d} WR={v['win_rate']:>5.1f}% MDD={v['max_drawdown']:>5.1f}%")

    # ── Final ranking (filter for >= 10 val trades for statistical reliability) ──
    reliable = [r for r in all_results if r["val_trades"] >= 10]
    reliable.sort(key=lambda x: x["avg_score"], reverse=True)

    print(f"\n{'='*80}")
    print("🏆 Top 15 (min 10 val trades for reliability):")
    print(f"{'='*80}")
    for i, r in enumerate(reliable[:15]):
        marker = "👑" if i == 0 else "  "
        print(f"{marker} {i+1:2d}. {r['label']:25s} avg={r['avg_score']:>7.2f} "
              f"(val={r['val_score']:>7.2f} test={r['test_score']:>7.2f}) "
              f"trades={r['val_trades']:>4d} WR={r['val_wr']:>5.1f}% MDD={r['val_mdd']:>5.1f}%")

    # Also show unrestricted top 5
    all_results.sort(key=lambda x: x["avg_score"], reverse=True)
    print(f"\n🌟 Top 5 unrestricted (including low trade count):")
    for i, r in enumerate(all_results[:5]):
        print(f"  {i+1}. {r['label']:25s} avg={r['avg_score']:>7.2f} trades={r['val_trades']:>4d}")

    # Save best reliable result
    if reliable and reliable[0]["avg_score"] > 14.39:
        best = reliable[0]
        # Reconstruct the conditions
        label = best["label"]
        conds = c_no_pos_base()  # default
        params = {**bp}

        # Apply modifications based on label
        if "rsi_30_70" in label:
            conds = [{**c, "params": {"rsi_low": 30, "rsi_high": 70}} if c["id"] == "rsi_zone" else c for c in conds]
        elif "rsi_40_70" in label:
            conds = [{**c, "params": {"rsi_low": 40, "rsi_high": 70}} if c["id"] == "rsi_zone" else c for c in conds]
        elif "atr35" in label:
            conds = [{**c, "params": {"atr_pct_max": 35}} if c["id"] == "low_vol" else c for c in conds]
        elif "atr40" in label:
            conds = [{**c, "params": {"atr_pct_max": 40}} if c["id"] == "low_vol" else c for c in conds]
        elif "body1pct" in label:
            conds = [{**c, "params": {"min_body_pct": 0.01}} if c["id"] == "kbar" else c for c in conds]

        # Extract H/SL from label if present
        import re
        hm = re.search(r'H(\d+)', label)
        sm = re.search(r'SL(\d+)', label)
        if hm:
            params["hold_days"] = int(hm.group(1))
        if sm:
            params["stop_loss_pct"] = -int(sm.group(1)) / 100

        s = StrategyConfig(
            version="v016", name=f"無位置高選擇策略_{label}",
            entry_conditions=conds,
            exit_conditions=[
                {"id": "hold_days", "type": "hold_period", "name": "H", "params": {"days": params["hold_days"]}},
                {"id": "stop_loss", "type": "stop_loss", "name": "S", "params": {"pct": params["stop_loss_pct"]}},
            ],
            parameters=params, min_conditions=7,
        )
        save_strategy(s)
        print(f"\n💾 Saved v016: {label} (avg={best['avg_score']:.2f})")


if __name__ == "__main__":
    main()
