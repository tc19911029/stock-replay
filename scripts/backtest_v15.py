#!/usr/bin/env python3
"""
Iteration 15: Combine best entry filters with MA5 dynamic exit

Best from V14:
- V13a + MA5 exit: 80.0% WR, 2.93% avg (30 trades)
- V14e (MACD_DIF>0): 78.6% WR, 4.86% avg (14 trades)
- V14g (body>1.5%): 71.4% WR, 4.14% avg (21 trades)
- V14f (upper shadow<15%): 78.6% WR, 2.86% avg (14 trades)

Goal: 80% WR + 5% avg return
Strategy: Combine MA5 exit with entry filters that boost avg return
"""

import os
import numpy as np
import pandas as pd
from datetime import datetime
from backtest_v14 import run_strategy_v14, v13a_base, exit_below_ma5, exit_macd_negative
from backtest_v5 import LOG_PATH
from backtest_strategy import compute_indicators, DATA_DIR


# ══════════════════════════════════════════════════════════════════════════
# New entry filters (combining best from V14)
# ══════════════════════════════════════════════════════════════════════════

def v15a(stock, i):
    """V15a: V13a + MACD_DIF>0 (best avg return filter)"""
    if not v13a_base(stock, i): return False
    r = stock.iloc[i]
    return pd.notna(r.get('macd_dif')) and r['macd_dif'] > 0

def v15b(stock, i):
    """V15b: V13a + 實體>1.5%"""
    if not v13a_base(stock, i): return False
    r = stock.iloc[i]
    return pd.notna(r.get('body_pct')) and r['body_pct'] > 0.015

def v15c(stock, i):
    """V15c: V13a + 上影<15%"""
    if not v13a_base(stock, i): return False
    r = stock.iloc[i]
    return pd.notna(r.get('upper_shadow')) and r['upper_shadow'] < 0.15

def v15d(stock, i):
    """V15d: V13a + MACD_DIF>0 + 實體>1.5%"""
    if not v13a_base(stock, i): return False
    r = stock.iloc[i]
    if not pd.notna(r.get('macd_dif')) or r['macd_dif'] <= 0: return False
    return pd.notna(r.get('body_pct')) and r['body_pct'] > 0.015

def v15e(stock, i):
    """V15e: V13a + 上影<15% + 實體>1.5%"""
    if not v13a_base(stock, i): return False
    r = stock.iloc[i]
    if not pd.notna(r.get('upper_shadow')) or r['upper_shadow'] >= 0.15: return False
    return pd.notna(r.get('body_pct')) and r['body_pct'] > 0.015

def v15f(stock, i):
    """V15f: V13a + 價>MA60 + 實體>1.5%"""
    if not v13a_base(stock, i): return False
    r = stock.iloc[i]
    if not pd.notna(r.get('ma60')) or r['close'] <= r['ma60']: return False
    return pd.notna(r.get('body_pct')) and r['body_pct'] > 0.015

def v15g(stock, i):
    """V15g: V13a + MACD_DIF>0 + 上影<20%"""
    if not v13a_base(stock, i): return False
    r = stock.iloc[i]
    if not pd.notna(r.get('macd_dif')) or r['macd_dif'] <= 0: return False
    return pd.notna(r.get('upper_shadow')) and r['upper_shadow'] < 0.20

def v15h(stock, i):
    """V15h: V13a + 價>MA60"""
    if not v13a_base(stock, i): return False
    r = stock.iloc[i]
    return pd.notna(r.get('ma60')) and r['close'] > r['ma60']

def v15i(stock, i):
    """V15i: V13a + 量>=1.5x"""
    if not v13a_base(stock, i): return False
    r = stock.iloc[i]
    return r['volume'] / r['avg_vol5'] >= 1.5

def v15j(stock, i):
    """V15j: V13a + RSI 40-65 (moderate, not overbought)"""
    if not v13a_base(stock, i): return False
    r = stock.iloc[i]
    return pd.notna(r.get('rsi14')) and 40 <= r['rsi14'] <= 65

def v15k(stock, i):
    """V15k: V13a + ROC10 > 3% (recent momentum)"""
    if not v13a_base(stock, i): return False
    r = stock.iloc[i]
    return pd.notna(r.get('roc10')) and r['roc10'] > 3


# ══════════════════════════════════════════════════════════════════════════
# Enhanced dynamic exits
# ══════════════════════════════════════════════════════════════════════════

def exit_ma5_strict(stock, hi, entry_price):
    """Exit when close < MA5 AND it's a red candle (stronger signal)"""
    r = stock.iloc[hi]
    ret = (r['close'] - entry_price) / entry_price
    if ret > -0.03 and pd.notna(r.get('ma5')) and r['close'] < r['ma5'] and r['close'] < r['open']:
        return True
    return False

def exit_ma5_or_macd(stock, hi, entry_price):
    """Exit when close < MA5 OR MACD turns negative (earliest warning)"""
    r = stock.iloc[hi]
    ret = (r['close'] - entry_price) / entry_price
    if ret > -0.02:
        if pd.notna(r.get('ma5')) and r['close'] < r['ma5']:
            return True
        if pd.notna(r.get('macd_osc')) and r['macd_osc'] < 0 and ret > 0:
            return True
    return False

def exit_ma5_gentle(stock, hi, entry_price):
    """Exit when close < MA5 only if in profit"""
    r = stock.iloc[hi]
    ret = (r['close'] - entry_price) / entry_price
    if ret > 0 and pd.notna(r.get('ma5')) and r['close'] < r['ma5']:
        return True
    return False


if __name__ == '__main__':
    tw_csv = os.path.join(DATA_DIR, 'tw_stocks.csv')
    df_all = pd.read_csv(tw_csv)
    df_all['date'] = pd.to_datetime(df_all['date'])
    print(f"Data: {df_all['symbol'].nunique()} stocks, {len(df_all)} rows")

    strategies = [
        ('V13a基線', v13a_base),
        ('V15a: +MACD_DIF>0', v15a),
        ('V15b: +實體>1.5%', v15b),
        ('V15c: +上影<15%', v15c),
        ('V15d: +DIF>0+實體>1.5%', v15d),
        ('V15e: +上影<15%+實體>1.5%', v15e),
        ('V15f: +MA60+實體>1.5%', v15f),
        ('V15g: +DIF>0+上影<20%', v15g),
        ('V15h: +價>MA60', v15h),
        ('V15i: +量>=1.5x', v15i),
        ('V15j: +RSI 40-65', v15j),
        ('V15k: +ROC10>3%', v15k),
    ]

    exit_configs = [
        (exit_below_ma5, '跌破MA5'),
        (exit_ma5_strict, '紅K跌破MA5'),
        (exit_ma5_or_macd, 'MA5或MACD負'),
        (exit_ma5_gentle, '獲利跌破MA5'),
        (None, '無動態'),
    ]

    sl_configs = [
        {'stop_loss': -0.07, 'take_profit': 0.15, 'trailing_stop': -0.04, 'max_hold': 20,
         'trailing_activation': 0.02, 'label': '止7盈15'},
        {'stop_loss': -0.07, 'take_profit': 0.20, 'trailing_stop': -0.04, 'max_hold': 20,
         'trailing_activation': 0.02, 'label': '止7盈20'},
        {'stop_loss': -0.06, 'take_profit': 0.15, 'trailing_stop': -0.035, 'max_hold': 15,
         'trailing_activation': 0.02, 'label': '止6盈15持15'},
        {'stop_loss': -0.08, 'take_profit': 0.20, 'trailing_stop': -0.05, 'max_hold': 25,
         'trailing_activation': 0.03, 'label': '止8盈20持25'},
    ]

    results = []

    # Part 1: All entry filters with MA5 exit + best SL config
    print("\n" + "=" * 100)
    print("Part 1: All entries × MA5 exit × 止7盈15")
    print("=" * 100)

    sl = sl_configs[0]
    for s_name, s_fn in strategies:
        label = f"{s_name}+MA5exit | {sl['label']}"
        r = run_strategy_v14(df_all, s_fn,
                             stop_loss=sl['stop_loss'], take_profit=sl['take_profit'],
                             trailing_stop=sl['trailing_stop'], max_hold=sl['max_hold'],
                             trailing_activation=sl['trailing_activation'],
                             dynamic_exit_fn=exit_below_ma5)
        r['label'] = label
        results.append(r)

    # Part 2: Best entries × all exit types × best SL
    print("\n" + "=" * 100)
    print("Part 2: Best entries × exit variants")
    print("=" * 100)

    best_entries = [
        ('V13a基線', v13a_base),
        ('V15a: +MACD_DIF>0', v15a),
        ('V15b: +實體>1.5%', v15b),
        ('V15g: +DIF>0+上影<20%', v15g),
    ]

    for s_name, s_fn in best_entries:
        for exit_fn, exit_name in exit_configs:
            for sl in sl_configs:
                label = f"{s_name}+{exit_name} | {sl['label']}"
                r = run_strategy_v14(df_all, s_fn,
                                     stop_loss=sl['stop_loss'], take_profit=sl['take_profit'],
                                     trailing_stop=sl['trailing_stop'], max_hold=sl['max_hold'],
                                     trailing_activation=sl['trailing_activation'],
                                     dynamic_exit_fn=exit_fn)
                r['label'] = label
                results.append(r)

    # Print sorted
    print("\n\n" + "=" * 115)
    print("=== ALL RESULTS (sorted by win_rate, then avg_return) ===")
    print("=" * 115)
    print(f"{'Strategy':<60} {'Trades':>6} {'WinR':>6} {'AvgR':>6} {'AvgW':>6} {'AvgL':>6} {'PF':>5} {'Total':>7} {'Hold':>5}")
    print("-" * 115)

    valid_results = [r for r in results if r.get('trades', 0) >= 5]
    # Deduplicate by label
    seen = set()
    unique_results = []
    for r in valid_results:
        if r['label'] not in seen:
            seen.add(r['label'])
            unique_results.append(r)

    for r in sorted(unique_results, key=lambda x: (x.get('win_rate', 0), x.get('avg_return', 0)), reverse=True)[:35]:
        print(f"{r['label']:<60} {r['trades']:>6} {r['win_rate']:>5}% {r['avg_return']:>5}% "
              f"{r.get('avg_win',0):>5}% {r.get('avg_loss',0):>5}% {r['profit_factor']:>5} "
              f"{r['total_return']:>6}% {r.get('avg_hold',''):>5}")

    # Best results
    valid10 = [r for r in unique_results if r.get('trades', 0) >= 10]
    valid5 = [r for r in unique_results if r.get('trades', 0) >= 5]

    print(f"\n{'='*80}")
    if valid10:
        best_wr10 = max(valid10, key=lambda x: (x['win_rate'], x['avg_return']))
        print(f"BEST WR (>=10 trades): {best_wr10['label']}")
        print(f"  Trades={best_wr10['trades']}, WR={best_wr10['win_rate']}%, AvgR={best_wr10['avg_return']}%, PF={best_wr10['profit_factor']}")
        if best_wr10.get('exit_reasons'):
            print(f"  Exits: {best_wr10['exit_reasons']}")

    if valid5:
        best_wr5 = max(valid5, key=lambda x: (x['win_rate'], x['avg_return']))
        if best_wr5['trades'] < 10:
            print(f"BEST WR (>=5 trades): {best_wr5['label']}")
            print(f"  Trades={best_wr5['trades']}, WR={best_wr5['win_rate']}%, AvgR={best_wr5['avg_return']}%, PF={best_wr5['profit_factor']}")

    # Find best that meets both targets
    target_met = [r for r in unique_results if r.get('win_rate', 0) >= 80 and r.get('avg_return', 0) >= 5]
    if target_met:
        print(f"\n*** TARGET MET (WR>=80%, AvgR>=5%) ***")
        for r in sorted(target_met, key=lambda x: x['trades'], reverse=True):
            print(f"  {r['label']}: {r['trades']} trades, WR={r['win_rate']}%, AvgR={r['avg_return']}%")

    # Write to log
    with open(LOG_PATH, 'a') as f:
        f.write(f"\n## Iteration 15: MA5動態出場 + 進場優化 ({datetime.now().strftime('%Y-%m-%d %H:%M')})\n")
        f.write(f"- **基礎**: V13a + 跌破MA5出場 — 80.0%勝率, 2.93%均報\n")
        f.write(f"- **測試**: {len(strategies)} 進場 × {len(exit_configs)} 出場 × {len(sl_configs)} 止損\n")

        top5 = sorted(unique_results, key=lambda x: (x['win_rate'], x['avg_return']), reverse=True)[:5]
        f.write(f"- **Top 5**:\n")
        for idx, t in enumerate(top5):
            f.write(f"  {idx+1}. {t['label']}: {t['trades']}次, 勝率={t['win_rate']}%, 均報={t['avg_return']}%, 盈虧={t['profit_factor']}\n")

        if target_met:
            f.write(f"\n### TARGET MET!\n")
            for r in target_met:
                f.write(f"- {r['label']}: {r['trades']}次, WR={r['win_rate']}%, AvgR={r['avg_return']}%\n")

        f.write(f"\n---\n")

    print("\n✅ Results written to OPTIMIZATION_LOG.md")
