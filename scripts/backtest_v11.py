#!/usr/bin/env python3
"""
Iteration 11+: 深度優化均線黃金交叉策略 (V8 基礎)
V8 是目前最佳: 60% 勝率, +1.9% 均報, 1.74 盈虧比

嘗試:
- 加入額外確認條件
- 調整止損止盈
- 加入量能/動量過濾
"""

import os
import numpy as np
import pandas as pd
from datetime import datetime
from backtest_v5 import run_strategy, LOG_PATH
from backtest_strategy import compute_indicators, DATA_DIR


def v8_base(stock, i):
    """V8 基線: MA5 剛上穿 MA20 + MA20↑ + 量增 + 紅K"""
    r = stock.iloc[i]
    if i < 1: return False
    prev = stock.iloc[i-1]
    if not all(pd.notna([r.get('ma5'), r.get('ma20'), prev.get('ma5'), prev.get('ma20')])): return False
    if not (prev['ma5'] <= prev['ma20'] and r['ma5'] > r['ma20']): return False
    if r['ma20'] <= prev['ma20']: return False
    if not pd.notna(r.get('avg_vol5')) or r['avg_vol5'] <= 0: return False
    if r['volume'] / r['avg_vol5'] < 1.2: return False
    if r['close'] <= r['open']: return False
    return True

def v11a(stock, i):
    """V11a: V8 + RSI 40-70 (避免超買超賣)"""
    if not v8_base(stock, i): return False
    r = stock.iloc[i]
    if not pd.notna(r.get('rsi14')): return False
    return 40 <= r['rsi14'] <= 70

def v11b(stock, i):
    """V11b: V8 + 價>MA60 (長期多頭確認)"""
    if not v8_base(stock, i): return False
    r = stock.iloc[i]
    return pd.notna(r.get('ma60')) and r['close'] > r['ma60']

def v11c(stock, i):
    """V11c: V8 + 量>=1.5x (更嚴格量能)"""
    if not v8_base(stock, i): return False
    r = stock.iloc[i]
    return r['volume'] / r['avg_vol5'] >= 1.5

def v11d(stock, i):
    """V11d: V8 + 實體>2% (強紅K)"""
    if not v8_base(stock, i): return False
    r = stock.iloc[i]
    body = (r['close'] - r['open']) / r['open']
    return body >= 0.02

def v11e(stock, i):
    """V11e: V8 + MACD>0 或 MACD golden cross"""
    if not v8_base(stock, i): return False
    r = stock.iloc[i]
    if pd.notna(r.get('macd_osc')) and r['macd_osc'] > 0: return True
    # MACD golden cross
    if i < 1: return False
    prev = stock.iloc[i-1]
    if pd.notna(r.get('macd_osc')) and pd.notna(prev.get('macd_osc')):
        if r['macd_osc'] > 0 and prev['macd_osc'] <= 0: return True
    return False

def v11f(stock, i):
    """V11f: V8 + RSI<70 + 價>MA60 (綜合)"""
    if not v8_base(stock, i): return False
    r = stock.iloc[i]
    if pd.notna(r.get('rsi14')) and r['rsi14'] > 70: return False
    if pd.notna(r.get('ma60')) and r['close'] <= r['ma60']: return False
    return True

def v11g(stock, i):
    """V11g: V8 + ROC20>0 (中期動量正)"""
    if not v8_base(stock, i): return False
    r = stock.iloc[i]
    return pd.notna(r.get('roc20')) and r['roc20'] > 0

def v11h(stock, i):
    """V11h: V8 + BB%B < 1.2 (不過度延伸)"""
    if not v8_base(stock, i): return False
    r = stock.iloc[i]
    return pd.notna(r.get('bb_pctb')) and r['bb_pctb'] < 1.2

def v11_best(stock, i):
    """V11 best: V8 + RSI<70 + 價>MA60 + ROC20>0"""
    if not v8_base(stock, i): return False
    r = stock.iloc[i]
    if pd.notna(r.get('rsi14')) and r['rsi14'] > 70: return False
    if pd.notna(r.get('ma60')) and r['close'] <= r['ma60']: return False
    if pd.notna(r.get('roc20')) and r['roc20'] <= 0: return False
    return True


if __name__ == '__main__':
    tw_csv = os.path.join(DATA_DIR, 'tw_stocks.csv')
    df_all = pd.read_csv(tw_csv)
    df_all['date'] = pd.to_datetime(df_all['date'])
    print(f"數據: {df_all['symbol'].nunique()} 支, {len(df_all)} 筆")

    strategies = [
        ('V8基線', v8_base),
        ('V11a: +RSI 40-70', v11a),
        ('V11b: +價>MA60', v11b),
        ('V11c: +量>=1.5x', v11c),
        ('V11d: +實體>2%', v11d),
        ('V11e: +MACD>0', v11e),
        ('V11f: +RSI<70+MA60', v11f),
        ('V11g: +ROC20>0', v11g),
        ('V11h: +BB%B<1.2', v11h),
        ('V11best: +RSI<70+MA60+ROC20>0', v11_best),
    ]

    # 用 V8 最佳配置: 止7%盈15%追4%持20天
    sl_configs = [
        {'stop_loss': -0.07, 'take_profit': 0.15, 'trailing_stop': -0.04, 'max_hold': 20},
        {'stop_loss': -0.07, 'take_profit': 0.20, 'trailing_stop': -0.05, 'max_hold': 25},
        {'stop_loss': -0.05, 'take_profit': 0.12, 'trailing_stop': -0.03, 'max_hold': 15},
    ]

    results = []
    for s_name, s_fn in strategies:
        for sl in sl_configs:
            label = f"{s_name} | 止{abs(sl['stop_loss'])*100:.0f}%盈{sl['take_profit']*100:.0f}%"
            r = run_strategy(df_all, s_fn,
                             stop_loss=sl['stop_loss'],
                             take_profit=sl['take_profit'],
                             trailing_stop=sl['trailing_stop'],
                             max_hold=sl['max_hold'])
            r['label'] = label
            results.append(r)

    # 輸出
    print("\n" + "=" * 95)
    print("=== V8 均線黃金交叉 深度優化 ===")
    print("=" * 95)
    print(f"{'策略':<45} {'交易':>5} {'勝率':>6} {'均報':>6} {'均贏':>6} {'均虧':>6} {'盈虧':>5} {'累計':>7}")
    print("-" * 95)
    for r in sorted(results, key=lambda x: x.get('win_rate', 0) * max(x.get('avg_return', 0), 0.01), reverse=True):
        if r.get('trades', 0) < 5: continue
        print(f"{r['label']:<45} {r['trades']:>5} {r['win_rate']:>5}% {r['avg_return']:>5}% {r.get('avg_win',0):>5}% {r.get('avg_loss',0):>5}% {r['profit_factor']:>5} {r['total_return']:>6}%")

    # 找最佳
    valid = [r for r in results if r.get('trades', 0) >= 15]
    if valid:
        best = max(valid, key=lambda x: x['win_rate'] * max(x['avg_return'], 0.01))
        print(f"\n🏆 最佳: {best['label']}")
        print(f"   {best['trades']}次, 勝率={best['win_rate']}%, 均報={best['avg_return']}%, 盈虧比={best['profit_factor']}, 累計={best['total_return']}%")

        # 寫入 log
        with open(LOG_PATH, 'a') as f:
            f.write(f"\n## Iteration 11: V8 深度優化 ({datetime.now().strftime('%Y-%m-%d %H:%M')})\n")
            f.write(f"- **基礎**: V8 均線黃金交叉（MA5↑MA20 + MA20↑ + 量增 + 紅K）\n")
            f.write(f"- **測試**: 10 種額外過濾 × 3 種止損配置 = 30 組合\n")
            f.write(f"- **最佳**: {best['label']}\n")
            f.write(f"  - {best['trades']}次, 勝率={best['win_rate']}%, 均報={best['avg_return']}%\n")
            f.write(f"  - 盈虧比={best['profit_factor']}, 累計={best['total_return']}%\n")

            top3 = sorted(valid, key=lambda x: x['win_rate'] * max(x['avg_return'], 0.01), reverse=True)[:3]
            f.write(f"- **Top 3**:\n")
            for i, t in enumerate(top3):
                f.write(f"  {i+1}. {t['label']}: {t['trades']}次, 勝率={t['win_rate']}%, 均報={t['avg_return']}%, 盈虧={t['profit_factor']}\n")
            f.write(f"\n---\n")

    print("\n✅ 完成")
