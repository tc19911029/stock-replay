"""
Round 12: Explore fundamentally different strategy approaches.
1. Mean reversion (buy dips in uptrend)
2. Momentum breakout (new highs)
3. Volume climax reversal
4. Combined: use our best conditions but with different exit strategies
"""
from __future__ import annotations
import sys
from pathlib import Path
from datetime import datetime

sys.path.insert(0, str(Path(__file__).parent))

import pandas as pd
import numpy as np
from analysis.technical import compute_all_indicators
from backtest.metrics import calc_metrics
from evaluator import calc_strategy_score
from strategies.base import StrategyConfig

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


def custom_backtest(data, entry_fn, exit_fn, split="validation",
                    train_ratio=0.6, val_ratio=0.2, cost=0.005):
    """
    Custom backtest with arbitrary entry/exit functions.
    entry_fn(df, i) -> bool: should we enter at day i?
    exit_fn(df, i, entry_price, entry_idx) -> (bool, price): should we exit?
    """
    all_trades = []

    for symbol, df in data.items():
        if len(df) < 60:
            continue

        df_ind = compute_all_indicators(df)
        n = len(df_ind)

        if split == "train":
            df_sub = df_ind.iloc[:int(n * train_ratio)]
        elif split == "validation":
            start = int(n * train_ratio)
            end = int(n * (train_ratio + val_ratio))
            df_sub = df_ind.iloc[start:end]
        elif split == "test":
            start = int(n * (train_ratio + val_ratio))
            df_sub = df_ind.iloc[start:]
        else:
            df_sub = df_ind

        if len(df_sub) < 30:
            continue

        i = 0
        while i < len(df_sub) - 1:
            if entry_fn(df_sub, i):
                # Enter next day at open
                entry_idx = i + 1
                if entry_idx >= len(df_sub):
                    break
                entry_price = df_sub.iloc[entry_idx]["open"] * 1.001  # slippage

                # Look for exit
                for j in range(entry_idx + 1, len(df_sub)):
                    should_exit, exit_price = exit_fn(df_sub, j, entry_price, entry_idx)
                    if should_exit:
                        gross_ret = (exit_price - entry_price) / entry_price if entry_price > 0 else 0
                        net_ret = gross_ret - cost
                        all_trades.append({
                            "symbol": symbol,
                            "entry_date": str(df_sub.iloc[entry_idx]["date"])[:10],
                            "exit_date": str(df_sub.iloc[j]["date"])[:10],
                            "entry_price": round(entry_price, 4),
                            "exit_price": round(exit_price, 4),
                            "hold_days": j - entry_idx,
                            "gross_return": round(gross_ret * 100, 2),
                            "net_return": round(net_ret * 100, 2),
                            "exit_reason": "custom",
                        })
                        i = j  # skip to exit point
                        break
                else:
                    # Never exited, use last close
                    last = df_sub.iloc[-1]
                    exit_price = last["close"] * 0.999
                    gross_ret = (exit_price - entry_price) / entry_price if entry_price > 0 else 0
                    net_ret = gross_ret - cost
                    all_trades.append({
                        "symbol": symbol,
                        "entry_date": str(df_sub.iloc[entry_idx]["date"])[:10],
                        "exit_date": str(last["date"])[:10],
                        "entry_price": round(entry_price, 4),
                        "exit_price": round(exit_price, 4),
                        "hold_days": len(df_sub) - entry_idx - 1,
                        "gross_return": round(gross_ret * 100, 2),
                        "net_return": round(net_ret * 100, 2),
                        "exit_reason": "data_end",
                    })
                    break
            i += 1

    return all_trades


def test_strategy(data, entry_fn, exit_fn, label):
    """Test on val and test, return results."""
    val_trades = custom_backtest(data, entry_fn, exit_fn, "validation")
    test_trades = custom_backtest(data, entry_fn, exit_fn, "test")
    val_m = calc_metrics(val_trades)
    test_m = calc_metrics(test_trades)
    val_s = calc_strategy_score(val_m)
    test_s = calc_strategy_score(test_m)
    avg = (val_s["total_score"] + test_s["total_score"]) / 2
    return {
        "label": label,
        "avg": avg,
        "val": val_s["total_score"],
        "test": test_s["total_score"],
        "val_trades": val_s["trade_count"],
        "val_wr": val_s["win_rate"],
        "val_mdd": val_s["max_drawdown"],
    }


def main():
    print(f"{'='*75}")
    print(f"🔬 Round 12: Alternative Strategies — {datetime.now().strftime('%H:%M:%S')}")
    print(f"{'='*75}\n")

    data = load_data(50)

    results = []

    # ── Strategy 1: Low Vol Squeeze Breakout (our winner, reimplemented) ──
    def entry_lowvol(df, i):
        if i < 60:
            return False
        r = df.iloc[i]
        # ATR percentile < 25, close > MA20, MA5 > MA20, OBV > OBV_MA20
        if pd.isna(r.get("atr_pct")) or pd.isna(r.get("ma20")) or pd.isna(r.get("ma5")):
            return False
        if r["atr_pct"] > 25:
            return False
        if r["close"] <= r["ma20"]:
            return False
        if r["ma5"] <= r["ma20"]:
            return False
        # RSI not overbought
        if pd.notna(r.get("rsi14")) and r["rsi14"] > 60:
            return False
        # OBV trending up
        if pd.notna(r.get("obv")) and pd.notna(r.get("obv_ma20")):
            if r["obv"] <= r["obv_ma20"]:
                return False
        # Bullish candle
        if r["close"] <= r["open"]:
            return False
        return True

    def exit_hold10_sl10(df, i, entry_price, entry_idx):
        r = df.iloc[i]
        # Stop loss -10%
        if entry_price > 0 and (r["low"] - entry_price) / entry_price <= -0.10:
            return True, entry_price * 0.90
        # Hold 10 days
        if i - entry_idx >= 10:
            return True, r["close"] * 0.999
        return False, 0

    r = test_strategy(data, entry_lowvol, exit_hold10_sl10, "lowvol_squeeze")
    results.append(r)
    print(f"  {r['label']:30s} avg={r['avg']:>7.2f} val={r['val']:>7.2f} test={r['test']:>7.2f} "
          f"trades={r['val_trades']:>4d} WR={r['val_wr']:>5.1f}% MDD={r['val_mdd']:>5.1f}%")

    # ── Strategy 2: Mean Reversion in Uptrend ────────────────────────────
    def entry_mean_rev(df, i):
        if i < 60:
            return False
        r = df.iloc[i]
        # Uptrend: MA20 > MA60, price > MA60
        if pd.isna(r.get("ma20")) or pd.isna(r.get("ma60")):
            return False
        if r["ma20"] <= r["ma60"]:
            return False
        if r["close"] <= r["ma60"]:
            return False
        # Pullback: close below MA5 (temporary weakness)
        if pd.isna(r.get("ma5")):
            return False
        if r["close"] >= r["ma5"]:
            return False
        # RSI oversold region (30-45)
        if pd.notna(r.get("rsi14")):
            if r["rsi14"] < 25 or r["rsi14"] > 45:
                return False
        # Not too far from MA20 (within 5%)
        dist = abs(r["close"] - r["ma20"]) / r["ma20"]
        if dist > 0.05:
            return False
        return True

    def exit_hold7_sl7(df, i, entry_price, entry_idx):
        r = df.iloc[i]
        if entry_price > 0 and (r["low"] - entry_price) / entry_price <= -0.07:
            return True, entry_price * 0.93
        if i - entry_idx >= 7:
            return True, r["close"] * 0.999
        return False, 0

    r = test_strategy(data, entry_mean_rev, exit_hold7_sl7, "mean_reversion")
    results.append(r)
    print(f"  {r['label']:30s} avg={r['avg']:>7.2f} val={r['val']:>7.2f} test={r['test']:>7.2f} "
          f"trades={r['val_trades']:>4d} WR={r['val_wr']:>5.1f}% MDD={r['val_mdd']:>5.1f}%")

    # ── Strategy 3: Momentum (new 20-day high) ────────────────────────────
    def entry_momentum(df, i):
        if i < 60:
            return False
        r = df.iloc[i]
        # New 20-day high
        high_20 = df.iloc[max(0, i-20):i+1]["high"].max()
        if r["high"] < high_20:
            return False
        # Volume above average
        if pd.notna(r.get("vol_avg20")) and r["volume"] < r["vol_avg20"] * 1.2:
            return False
        # MA aligned
        if pd.isna(r.get("ma5")) or pd.isna(r.get("ma10")) or pd.isna(r.get("ma20")):
            return False
        if not (r["ma5"] > r["ma10"] > r["ma20"]):
            return False
        # MACD positive
        if pd.notna(r.get("macd_osc")) and r["macd_osc"] <= 0:
            return False
        return True

    r = test_strategy(data, entry_momentum, exit_hold7_sl7, "momentum_breakout")
    results.append(r)
    print(f"  {r['label']:30s} avg={r['avg']:>7.2f} val={r['val']:>7.2f} test={r['test']:>7.2f} "
          f"trades={r['val_trades']:>4d} WR={r['val_wr']:>5.1f}% MDD={r['val_mdd']:>5.1f}%")

    # ── Strategy 4: Low vol + mean reversion combo ────────────────────────
    def entry_lowvol_meanrev(df, i):
        if i < 60:
            return False
        r = df.iloc[i]
        # Low vol
        if pd.isna(r.get("atr_pct")) or r["atr_pct"] > 30:
            return False
        # Uptrend (MA20 rising)
        if pd.isna(r.get("ma20")):
            return False
        if i >= 5 and pd.notna(df.iloc[i-5].get("ma20")):
            if r["ma20"] <= df.iloc[i-5]["ma20"]:
                return False
        # Close near MA20 (within 2%)
        dist = abs(r["close"] - r["ma20"]) / r["ma20"]
        if dist > 0.02:
            return False
        # RSI neutral
        if pd.notna(r.get("rsi14")) and (r["rsi14"] > 60 or r["rsi14"] < 30):
            return False
        # OBV positive
        if pd.notna(r.get("obv")) and pd.notna(r.get("obv_ma20")):
            if r["obv"] <= r["obv_ma20"]:
                return False
        return True

    r = test_strategy(data, entry_lowvol_meanrev, exit_hold10_sl10, "lowvol_meanrev")
    results.append(r)
    print(f"  {r['label']:30s} avg={r['avg']:>7.2f} val={r['val']:>7.2f} test={r['test']:>7.2f} "
          f"trades={r['val_trades']:>4d} WR={r['val_wr']:>5.1f}% MDD={r['val_mdd']:>5.1f}%")

    # ── Strategy 5: Combined best (low vol + breakout + OBV + trailing stop) ──
    def exit_trailing(df, i, entry_price, entry_idx):
        r = df.iloc[i]
        # Track peak price
        peak = entry_price
        for j in range(entry_idx, i + 1):
            if df.iloc[j]["high"] > peak:
                peak = df.iloc[j]["high"]

        # Stop loss -10%
        if entry_price > 0 and (r["low"] - entry_price) / entry_price <= -0.10:
            return True, entry_price * 0.90

        # Take profit +15%
        if entry_price > 0 and (r["high"] - entry_price) / entry_price >= 0.15:
            return True, entry_price * 1.15

        # Trailing stop: 5% from peak (only if in profit)
        if peak > entry_price * 1.03:  # at least 3% profit before trailing
            if (r["low"] - peak) / peak <= -0.05:
                exit_p = max(peak * 0.95, entry_price * 0.90)
                return True, exit_p

        # Max hold 14 days
        if i - entry_idx >= 14:
            return True, r["close"] * 0.999

        return False, 0

    r = test_strategy(data, entry_lowvol, exit_trailing, "lowvol_trailing")
    results.append(r)
    print(f"  {r['label']:30s} avg={r['avg']:>7.2f} val={r['val']:>7.2f} test={r['test']:>7.2f} "
          f"trades={r['val_trades']:>4d} WR={r['val_wr']:>5.1f}% MDD={r['val_mdd']:>5.1f}%")

    # Sort and display
    results.sort(key=lambda x: x["avg"], reverse=True)
    print(f"\n🏆 Rankings:")
    for i, r in enumerate(results):
        marker = "👑" if i == 0 else "  "
        print(f"{marker} {i+1}. {r['label']:30s} avg={r['avg']:>7.2f} (val={r['val']:>7.2f} test={r['test']:>7.2f})")


if __name__ == "__main__":
    main()
