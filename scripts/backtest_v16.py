#!/usr/bin/env python3
"""
Iteration 16: Push average return above 5% while keeping WR > 80%

Best from V15:
- V15a (MACD_DIF>0 + MA5 exit): 85.7% WR, 3.86% avg (14 trades)
- V15f (MA60+body>1.5% + MA5 exit): 82.4% WR, 4.41% avg (17 trades)
- V15j (RSI 40-65 + MA5 exit): 84.0% WR, 3.20% avg (25 trades)
- V15b (body>1.5% + MA5 exit): 81.0% WR, 3.97% avg (21 trades)

Key insight: MA5 exit cuts avg hold to ~8 days but also cuts winners early.
Strategy: Use a smarter MA5 exit that gives winners more room while cutting losers.

Ideas:
1. Only apply MA5 exit in first N days, then switch to trailing stop
2. Use MA5 exit but with a "grace period" (2 consecutive closes below MA5)
3. Wider trailing stop for strong entries
4. Exit on MA5 only if MACD also weakening
5. Don't exit on MA5 if big profit (>5%) - let trailing handle it
"""

import os
import numpy as np
import pandas as pd
from datetime import datetime
from backtest_v5 import LOG_PATH
from backtest_strategy import compute_indicators, DATA_DIR


def run_strategy_v16(df_all, strategy_fn, stop_loss, take_profit, trailing_stop,
                     max_hold, cooldown_days=10, trailing_activation=0.02,
                     dynamic_exit_fn=None):
    """Enhanced backtest with smarter dynamic exit."""
    symbols = df_all['symbol'].unique()
    trades = []

    for sym in symbols:
        stock = df_all[df_all['symbol'] == sym].sort_values('date').reset_index(drop=True)
        if len(stock) < 80:
            continue
        stock = compute_indicators(stock)

        start_idx = max(60, len(stock) - 250)
        cooldown = 0

        for i in range(start_idx, len(stock) - max_hold - 1):
            if cooldown > 0:
                cooldown -= 1
                continue

            if not strategy_fn(stock, i):
                continue

            entry_price = stock.iloc[i + 1]['open']
            entry_day = i + 1

            peak = entry_price
            exit_day = None
            exit_price = None
            exit_reason = 'max_hold'

            for h in range(1, max_hold + 1):
                hi = entry_day + h
                if hi >= len(stock):
                    break
                hd = stock.iloc[hi]
                if hd['high'] > peak:
                    peak = hd['high']

                ret = (hd['close'] - entry_price) / entry_price
                ret_peak = (hd['close'] - peak) / peak

                if ret <= stop_loss:
                    exit_day = hi; exit_price = hd['close']; exit_reason = 'stop_loss'; break
                if ret >= take_profit:
                    exit_day = hi; exit_price = hd['close']; exit_reason = 'take_profit'; break
                if trailing_stop and ret > trailing_activation and ret_peak <= trailing_stop:
                    exit_day = hi; exit_price = hd['close']; exit_reason = 'trailing'; break

                # Dynamic exit with context
                if dynamic_exit_fn and h >= 3:
                    if dynamic_exit_fn(stock, hi, entry_price, h, peak):
                        exit_day = hi; exit_price = hd['close']; exit_reason = 'dynamic'; break

            if exit_day is None:
                exit_day = min(entry_day + max_hold, len(stock) - 1)
                exit_price = stock.iloc[exit_day]['close']

            trades.append({
                'return_pct': round((exit_price - entry_price) / entry_price * 100, 2),
                'exit_reason': exit_reason,
                'hold_days': exit_day - entry_day,
            })
            cooldown = cooldown_days

    if not trades:
        return {'trades': 0, 'win_rate': 0, 'avg_return': 0, 'profit_factor': 0, 'total_return': 0}

    tdf = pd.DataFrame(trades)
    win = tdf[tdf['return_pct'] > 0]
    loss = tdf[tdf['return_pct'] <= 0]

    return {
        'trades': len(tdf),
        'win_rate': round(len(win) / len(tdf) * 100, 1),
        'avg_return': round(tdf['return_pct'].mean(), 2),
        'median_return': round(tdf['return_pct'].median(), 2),
        'avg_win': round(win['return_pct'].mean(), 2) if len(win) > 0 else 0,
        'avg_loss': round(loss['return_pct'].mean(), 2) if len(loss) > 0 else 0,
        'profit_factor': round(abs(win['return_pct'].sum()) / max(abs(loss['return_pct'].sum()), 0.01), 2),
        'total_return': round(tdf['return_pct'].sum(), 1),
        'exit_reasons': dict(tdf['exit_reason'].value_counts()),
        'avg_hold': round(tdf['hold_days'].mean(), 1),
    }


# ══════════════════════════════════════════════════════════════════════════
# Entry strategies (best from V15)
# ══════════════════════════════════════════════════════════════════════════

def v13a_base(stock, i):
    """V13a base"""
    r = stock.iloc[i]
    if i < 3: return False
    prev = stock.iloc[i-1]
    if not all(pd.notna([r.get('ma5'), r.get('ma20'), prev.get('ma5'), prev.get('ma20')])): return False
    if not (prev['ma5'] <= prev['ma20'] and r['ma5'] > r['ma20']): return False
    if r['ma20'] <= prev['ma20']: return False
    if not pd.notna(r.get('avg_vol5')) or r['avg_vol5'] <= 0: return False
    if r['volume'] / r['avg_vol5'] < 1.2: return False
    if r['close'] <= r['open']: return False
    if not pd.notna(r.get('bb_pctb')) or r['bb_pctb'] >= 1.2: return False
    if not pd.notna(r.get('macd_osc')) or r['macd_osc'] <= 0: return False
    consec = sum(1 for j in range(i-3, i) if stock.iloc[j]['close'] > stock.iloc[j]['open'])
    if consec >= 3: return False
    return True

def v15a(stock, i):
    """V15a: V13a + MACD_DIF>0"""
    if not v13a_base(stock, i): return False
    r = stock.iloc[i]
    return pd.notna(r.get('macd_dif')) and r['macd_dif'] > 0

def v15b(stock, i):
    """V15b: V13a + body>1.5%"""
    if not v13a_base(stock, i): return False
    r = stock.iloc[i]
    return pd.notna(r.get('body_pct')) and r['body_pct'] > 0.015

def v15f(stock, i):
    """V15f: V13a + MA60 + body>1.5%"""
    if not v13a_base(stock, i): return False
    r = stock.iloc[i]
    if not pd.notna(r.get('ma60')) or r['close'] <= r['ma60']: return False
    return pd.notna(r.get('body_pct')) and r['body_pct'] > 0.015

def v15j(stock, i):
    """V15j: V13a + RSI 40-65"""
    if not v13a_base(stock, i): return False
    r = stock.iloc[i]
    return pd.notna(r.get('rsi14')) and 40 <= r['rsi14'] <= 65

def v16a(stock, i):
    """V16a: V13a + MACD_DIF>0 + body>1%"""
    if not v13a_base(stock, i): return False
    r = stock.iloc[i]
    if not pd.notna(r.get('macd_dif')) or r['macd_dif'] <= 0: return False
    return pd.notna(r.get('body_pct')) and r['body_pct'] > 0.01

def v16b(stock, i):
    """V16b: V13a + RSI 40-65 + body>1.5%"""
    if not v13a_base(stock, i): return False
    r = stock.iloc[i]
    if not pd.notna(r.get('rsi14')) or not (40 <= r['rsi14'] <= 65): return False
    return pd.notna(r.get('body_pct')) and r['body_pct'] > 0.015

def v16c(stock, i):
    """V16c: V13a + MACD_DIF>0 + RSI<65"""
    if not v13a_base(stock, i): return False
    r = stock.iloc[i]
    if not pd.notna(r.get('macd_dif')) or r['macd_dif'] <= 0: return False
    return pd.notna(r.get('rsi14')) and r['rsi14'] < 65

def v16d(stock, i):
    """V16d: V13a + MA60 above + RSI 40-65"""
    if not v13a_base(stock, i): return False
    r = stock.iloc[i]
    if not pd.notna(r.get('ma60')) or r['close'] <= r['ma60']: return False
    return pd.notna(r.get('rsi14')) and 40 <= r['rsi14'] <= 65


# ══════════════════════════════════════════════════════════════════════════
# Smart dynamic exits
# ══════════════════════════════════════════════════════════════════════════

def exit_ma5_basic(stock, hi, entry_price, hold_days, peak):
    """Basic MA5 exit (original)"""
    r = stock.iloc[hi]
    ret = (r['close'] - entry_price) / entry_price
    if ret > -0.02 and pd.notna(r.get('ma5')) and r['close'] < r['ma5']:
        return True
    return False

def exit_ma5_let_winners_run(stock, hi, entry_price, hold_days, peak):
    """MA5 exit but let big winners run (only exit if gain < 8%)"""
    r = stock.iloc[hi]
    ret = (r['close'] - entry_price) / entry_price
    if ret > -0.02 and ret < 0.08 and pd.notna(r.get('ma5')) and r['close'] < r['ma5']:
        return True
    return False

def exit_ma5_with_grace(stock, hi, entry_price, hold_days, peak):
    """MA5 exit only after 2 consecutive closes below MA5"""
    r = stock.iloc[hi]
    ret = (r['close'] - entry_price) / entry_price
    if ret > -0.03 and hi >= 1:
        prev = stock.iloc[hi-1]
        if (pd.notna(r.get('ma5')) and r['close'] < r['ma5'] and
            pd.notna(prev.get('ma5')) and prev['close'] < prev['ma5']):
            return True
    return False

def exit_ma5_early_only(stock, hi, entry_price, hold_days, peak):
    """MA5 exit only in first 8 days, then let trailing stop handle"""
    if hold_days > 8:
        return False
    r = stock.iloc[hi]
    ret = (r['close'] - entry_price) / entry_price
    if ret > -0.02 and pd.notna(r.get('ma5')) and r['close'] < r['ma5']:
        return True
    return False

def exit_ma5_or_red_k(stock, hi, entry_price, hold_days, peak):
    """MA5 exit only if also a red candle (stronger sell signal)"""
    r = stock.iloc[hi]
    ret = (r['close'] - entry_price) / entry_price
    if ret > -0.03 and pd.notna(r.get('ma5')) and r['close'] < r['ma5'] and r['close'] < r['open']:
        return True
    return False

def exit_adaptive(stock, hi, entry_price, hold_days, peak):
    """Adaptive exit: MA5 for losers, trailing for winners"""
    r = stock.iloc[hi]
    ret = (r['close'] - entry_price) / entry_price
    # For positions in loss or small gain: exit on MA5 break
    if ret < 0.03 and pd.notna(r.get('ma5')) and r['close'] < r['ma5']:
        return True
    # For positions with moderate gain (3-10%): exit on red K below MA5
    if 0.03 <= ret < 0.10 and pd.notna(r.get('ma5')) and r['close'] < r['ma5'] and r['close'] < r['open']:
        return True
    # For big winners (>10%): don't use MA5 exit, let trailing stop handle
    return False

def exit_ma10(stock, hi, entry_price, hold_days, peak):
    """Exit when close falls below MA10 (gives more room than MA5)"""
    r = stock.iloc[hi]
    ret = (r['close'] - entry_price) / entry_price
    if ret > -0.02 and pd.notna(r.get('ma10')) and r['close'] < r['ma10']:
        return True
    return False


if __name__ == '__main__':
    tw_csv = os.path.join(DATA_DIR, 'tw_stocks.csv')
    df_all = pd.read_csv(tw_csv)
    df_all['date'] = pd.to_datetime(df_all['date'])
    print(f"Data: {df_all['symbol'].nunique()} stocks, {len(df_all)} rows")

    entries = [
        ('V13a', v13a_base),
        ('V15a(DIF>0)', v15a),
        ('V15b(body>1.5%)', v15b),
        ('V15f(MA60+body)', v15f),
        ('V15j(RSI40-65)', v15j),
        ('V16a(DIF>0+body>1%)', v16a),
        ('V16b(RSI+body)', v16b),
        ('V16c(DIF>0+RSI<65)', v16c),
        ('V16d(MA60+RSI)', v16d),
    ]

    exits = [
        (exit_ma5_basic, 'MA5基本'),
        (exit_ma5_let_winners_run, 'MA5讓利跑'),
        (exit_ma5_with_grace, 'MA5寬容'),
        (exit_ma5_early_only, 'MA5前8天'),
        (exit_ma5_or_red_k, 'MA5紅K'),
        (exit_adaptive, '自適應'),
        (exit_ma10, 'MA10出場'),
        (None, '無動態'),
    ]

    sl_configs = [
        {'stop_loss': -0.07, 'take_profit': 0.15, 'trailing_stop': -0.04, 'max_hold': 20,
         'trailing_activation': 0.02, 'label': '止7盈15'},
        {'stop_loss': -0.07, 'take_profit': 0.20, 'trailing_stop': -0.04, 'max_hold': 25,
         'trailing_activation': 0.02, 'label': '止7盈20持25'},
        {'stop_loss': -0.07, 'take_profit': 0.25, 'trailing_stop': -0.05, 'max_hold': 30,
         'trailing_activation': 0.03, 'label': '止7盈25持30'},
        {'stop_loss': -0.08, 'take_profit': 0.20, 'trailing_stop': -0.05, 'max_hold': 25,
         'trailing_activation': 0.03, 'label': '止8盈20持25'},
    ]

    results = []

    # Full grid search on most promising combinations
    for s_name, s_fn in entries:
        for exit_fn, exit_name in exits:
            for sl in sl_configs:
                label = f"{s_name}+{exit_name} | {sl['label']}"
                r = run_strategy_v16(df_all, s_fn,
                                     stop_loss=sl['stop_loss'], take_profit=sl['take_profit'],
                                     trailing_stop=sl['trailing_stop'], max_hold=sl['max_hold'],
                                     trailing_activation=sl['trailing_activation'],
                                     dynamic_exit_fn=exit_fn)
                r['label'] = label
                results.append(r)

    # Deduplicate
    seen = set()
    unique_results = []
    for r in results:
        if r['label'] not in seen:
            seen.add(r['label'])
            unique_results.append(r)

    # Print results
    print("\n\n" + "=" * 120)
    print("=== ALL RESULTS (sorted by win_rate, then avg_return) ===")
    print("=" * 120)
    print(f"{'Strategy':<65} {'Tr':>4} {'WR':>6} {'AvgR':>6} {'AvgW':>6} {'AvgL':>6} {'PF':>5} {'Tot':>7} {'Hld':>4}")
    print("-" * 120)

    valid = [r for r in unique_results if r.get('trades', 0) >= 5]
    for r in sorted(valid, key=lambda x: (x.get('win_rate', 0), x.get('avg_return', 0)), reverse=True)[:40]:
        print(f"{r['label']:<65} {r['trades']:>4} {r['win_rate']:>5}% {r['avg_return']:>5}% "
              f"{r.get('avg_win',0):>5}% {r.get('avg_loss',0):>5}% {r['profit_factor']:>5} "
              f"{r['total_return']:>6}% {r.get('avg_hold',''):>4}")

    # Target analysis
    target_met = [r for r in valid if r.get('win_rate', 0) >= 80 and r.get('avg_return', 0) >= 5]
    near_target = [r for r in valid if r.get('win_rate', 0) >= 78 and r.get('avg_return', 0) >= 4]

    print(f"\n{'='*80}")
    if target_met:
        print(f"\n*** TARGET MET: WR>=80% AND AvgR>=5% ***")
        for r in sorted(target_met, key=lambda x: x['trades'], reverse=True):
            print(f"  {r['label']}")
            print(f"    Trades={r['trades']}, WR={r['win_rate']}%, AvgR={r['avg_return']}%, PF={r['profit_factor']}, Total={r['total_return']}%")
            if r.get('exit_reasons'):
                print(f"    Exits: {r['exit_reasons']}")
    else:
        print("\n--- No strategy met both WR>=80% and AvgR>=5% ---")

    if near_target:
        print(f"\nNear target (WR>=78%, AvgR>=4%):")
        for r in sorted(near_target, key=lambda x: (x['win_rate'] + x['avg_return']*10), reverse=True)[:10]:
            print(f"  {r['label']}: {r['trades']}tr, WR={r['win_rate']}%, AvgR={r['avg_return']}%")

    # Best by different criteria
    valid10 = [r for r in valid if r['trades'] >= 10]
    if valid10:
        best = max(valid10, key=lambda x: x['win_rate'] * 2 + x['avg_return'])
        print(f"\nBest composite (>=10 trades): {best['label']}")
        print(f"  {best['trades']}tr, WR={best['win_rate']}%, AvgR={best['avg_return']}%, PF={best['profit_factor']}")

    # Write log
    with open(LOG_PATH, 'a') as f:
        f.write(f"\n## Iteration 16: 智慧出場優化 ({datetime.now().strftime('%Y-%m-%d %H:%M')})\n")
        f.write(f"- **基礎**: V15a (MACD_DIF>0+MA5出場) — 85.7%勝率, 3.86%均報\n")
        f.write(f"- **測試**: {len(entries)} 進場 × {len(exits)} 出場 × {len(sl_configs)} 止損 = {len(entries)*len(exits)*len(sl_configs)} 組合\n")

        top5 = sorted(valid, key=lambda x: (x['win_rate'], x['avg_return']), reverse=True)[:5]
        f.write(f"- **Top 5**:\n")
        for idx, t in enumerate(top5):
            f.write(f"  {idx+1}. {t['label']}: {t['trades']}次, 勝率={t['win_rate']}%, 均報={t['avg_return']}%, 盈虧={t['profit_factor']}\n")

        if target_met:
            f.write(f"\n### TARGET MET (WR>=80%, AvgR>=5%):\n")
            for r in target_met:
                f.write(f"- {r['label']}: {r['trades']}次, WR={r['win_rate']}%, AvgR={r['avg_return']}%, PF={r['profit_factor']}\n")
        elif near_target:
            f.write(f"\n### Near target (WR>=78%, AvgR>=4%):\n")
            for r in sorted(near_target, key=lambda x: x['trades'], reverse=True)[:5]:
                f.write(f"- {r['label']}: {r['trades']}次, WR={r['win_rate']}%, AvgR={r['avg_return']}%\n")

        f.write(f"\n---\n")

    print("\n✅ Results written to OPTIMIZATION_LOG.md")
