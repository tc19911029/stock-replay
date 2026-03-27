#!/usr/bin/env python3
"""
Iteration 13+: 在 V12b 基礎上繼續
V12b: MA5↑MA20 + MA20↑ + 量1.2x + 紅K + BB%B<1.2 + MACD>0
→ 69.8% 勝率, +2.72% 均報, 2.59 盈虧比

嘗試組合 V12b 和 V12d/V12e 的優勢
"""

import os
import numpy as np
import pandas as pd
from datetime import datetime
from backtest_v5 import run_strategy, LOG_PATH
from backtest_strategy import compute_indicators, DATA_DIR


def v12b_base(stock, i):
    """V12b: MA5↑MA20 + MA20↑ + 量1.2x + 紅K + BB%B<1.2 + MACD>0"""
    r = stock.iloc[i]
    if i < 1: return False
    prev = stock.iloc[i-1]
    if not all(pd.notna([r.get('ma5'), r.get('ma20'), prev.get('ma5'), prev.get('ma20')])): return False
    if not (prev['ma5'] <= prev['ma20'] and r['ma5'] > r['ma20']): return False
    if r['ma20'] <= prev['ma20']: return False
    if not pd.notna(r.get('avg_vol5')) or r['avg_vol5'] <= 0: return False
    if r['volume'] / r['avg_vol5'] < 1.2: return False
    if r['close'] <= r['open']: return False
    if not pd.notna(r.get('bb_pctb')) or r['bb_pctb'] >= 1.2: return False
    if not pd.notna(r.get('macd_osc')) or r['macd_osc'] <= 0: return False
    return True

def v13a(stock, i):
    """V13a: V12b + 未連漲3天"""
    if not v12b_base(stock, i): return False
    if i < 3: return True
    consec = sum(1 for j in range(i-3, i) if stock.iloc[j]['close'] > stock.iloc[j]['open'])
    return consec < 3

def v13b(stock, i):
    """V13b: V12b + 量>=1.5x"""
    if not v12b_base(stock, i): return False
    r = stock.iloc[i]
    return r['volume'] / r['avg_vol5'] >= 1.5

def v13c(stock, i):
    """V13c: V12b + MA10也向上"""
    if not v12b_base(stock, i): return False
    r = stock.iloc[i]
    prev = stock.iloc[i-1]
    return pd.notna(r.get('ma10')) and pd.notna(prev.get('ma10')) and r['ma10'] > prev['ma10']

def v13d(stock, i):
    """V13d: V12b + RSI<70"""
    if not v12b_base(stock, i): return False
    r = stock.iloc[i]
    return not pd.notna(r.get('rsi14')) or r['rsi14'] < 70

def v13e(stock, i):
    """V13e: V12b + 收高位>0.7"""
    if not v12b_base(stock, i): return False
    r = stock.iloc[i]
    return pd.notna(r.get('close_pos')) and r['close_pos'] > 0.7

def v13f(stock, i):
    """V13f: V12b + BB%B 0.6-1.0（更窄範圍）"""
    if not v12b_base(stock, i): return False
    r = stock.iloc[i]
    return 0.6 <= r['bb_pctb'] <= 1.0

def v13_combo1(stock, i):
    """V13 combo1: V12b + 未連漲3天 + 收高位"""
    if not v12b_base(stock, i): return False
    r = stock.iloc[i]
    if i >= 3:
        consec = sum(1 for j in range(i-3, i) if stock.iloc[j]['close'] > stock.iloc[j]['open'])
        if consec >= 3: return False
    return pd.notna(r.get('close_pos')) and r['close_pos'] > 0.7

def v13_combo2(stock, i):
    """V13 combo2: V12b + 量1.5x + 收高位"""
    if not v12b_base(stock, i): return False
    r = stock.iloc[i]
    if r['volume'] / r['avg_vol5'] < 1.5: return False
    return pd.notna(r.get('close_pos')) and r['close_pos'] > 0.7

def v13_combo3(stock, i):
    """V13 combo3: V12b + RSI<70 + MA10↑"""
    if not v12b_base(stock, i): return False
    r = stock.iloc[i]
    prev = stock.iloc[i-1]
    if pd.notna(r.get('rsi14')) and r['rsi14'] >= 70: return False
    return pd.notna(r.get('ma10')) and pd.notna(prev.get('ma10')) and r['ma10'] > prev['ma10']


if __name__ == '__main__':
    tw_csv = os.path.join(DATA_DIR, 'tw_stocks.csv')
    df_all = pd.read_csv(tw_csv)
    df_all['date'] = pd.to_datetime(df_all['date'])

    strategies = [
        ('V12b基線', v12b_base),
        ('V13a: +未連漲3天', v13a),
        ('V13b: +量>=1.5x', v13b),
        ('V13c: +MA10↑', v13c),
        ('V13d: +RSI<70', v13d),
        ('V13e: +收高位>0.7', v13e),
        ('V13f: +BB%B 0.6-1.0', v13f),
        ('V13 combo1: +未連漲+收高位', v13_combo1),
        ('V13 combo2: +量1.5x+收高位', v13_combo2),
        ('V13 combo3: +RSI<70+MA10↑', v13_combo3),
    ]

    sl_configs = [
        {'stop_loss': -0.07, 'take_profit': 0.15, 'trailing_stop': -0.04, 'max_hold': 20, 'label': '止7盈15'},
        {'stop_loss': -0.08, 'take_profit': 0.15, 'trailing_stop': -0.04, 'max_hold': 20, 'label': '止8盈15'},
        {'stop_loss': -0.06, 'take_profit': 0.15, 'trailing_stop': -0.035, 'max_hold': 18, 'label': '止6盈15'},
    ]

    results = []
    for s_name, s_fn in strategies:
        for sl in sl_configs:
            label = f"{s_name} | {sl['label']}"
            r = run_strategy(df_all, s_fn, **{k: v for k, v in sl.items() if k != 'label'})
            r['label'] = label
            results.append(r)

    print("\n" + "=" * 95)
    print("=== V13: V12b 進階優化 ===")
    print("=" * 95)
    print(f"{'策略':<50} {'交易':>5} {'勝率':>6} {'均報':>6} {'均贏':>6} {'均虧':>6} {'盈虧':>5} {'累計':>7}")
    print("-" * 95)
    for r in sorted(results, key=lambda x: x.get('win_rate', 0), reverse=True)[:15]:
        if r.get('trades', 0) < 5: continue
        print(f"{r['label']:<50} {r['trades']:>5} {r['win_rate']:>5}% {r['avg_return']:>5}% {r.get('avg_win',0):>5}% {r.get('avg_loss',0):>5}% {r['profit_factor']:>5} {r['total_return']:>6}%")

    valid = [r for r in results if r.get('trades', 0) >= 10]
    if valid:
        best = max(valid, key=lambda x: x['win_rate'])
        print(f"\n🏆 最高勝率: {best['label']}")
        print(f"   {best['trades']}次, 勝率={best['win_rate']}%, 均報={best['avg_return']}%, 盈虧比={best['profit_factor']}")

        best2 = max(valid, key=lambda x: x.get('total_return', 0))
        if best2 != best:
            print(f"\n💰 最高累計: {best2['label']}")
            print(f"   {best2['trades']}次, 勝率={best2['win_rate']}%, 累計={best2['total_return']}%")

        with open(LOG_PATH, 'a') as f:
            f.write(f"\n## Iteration 13: V12b 進階優化 ({datetime.now().strftime('%Y-%m-%d %H:%M')})\n")
            f.write(f"- **基礎**: V12b (MA5↑MA20+MACD>0+BB%B<1.2) — 69.8%勝率\n")
            f.write(f"- **🏆最高勝率**: {best['label']}\n")
            f.write(f"  - {best['trades']}次, 勝率={best['win_rate']}%, 均報={best['avg_return']}%, 盈虧比={best['profit_factor']}\n")
            if best2 != best:
                f.write(f"- **💰最高累計**: {best2['label']}\n")
                f.write(f"  - {best2['trades']}次, 勝率={best2['win_rate']}%, 累計={best2['total_return']}%\n")
            f.write(f"\n---\n")
