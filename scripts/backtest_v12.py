#!/usr/bin/env python3
"""
Iteration 12+: 在 V11h 基礎上繼續微調
V11h: MA5↑MA20 + MA20↑ + 量1.2x + 紅K + BB%B<1.2 | 止7%盈15%追4%持20天
→ 66.1% 勝率, +2.84% 均報, 2.43 盈虧比

這次嘗試:
- 更精細的 BB%B 門檻
- 加入 MACD 方向確認
- 調整止損止盈
- 加入持有期動態出場
"""

import os
import numpy as np
import pandas as pd
from datetime import datetime
from backtest_v5 import run_strategy, LOG_PATH
from backtest_strategy import compute_indicators, DATA_DIR


def v11h_base(stock, i):
    """V11h: MA5↑MA20 + MA20↑ + 量1.2x + 紅K + BB%B<1.2"""
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
    return True

def v12a(stock, i):
    """V12a: V11h + BB%B 0.5-1.0 (更嚴格的理想區間)"""
    if not v11h_base(stock, i): return False
    r = stock.iloc[i]
    return 0.5 <= r['bb_pctb'] <= 1.0

def v12b(stock, i):
    """V12b: V11h + MACD柱正 or 轉正"""
    if not v11h_base(stock, i): return False
    r = stock.iloc[i]
    return pd.notna(r.get('macd_osc')) and r['macd_osc'] > 0

def v12c(stock, i):
    """V12c: V11h + MA10也向上"""
    if not v11h_base(stock, i): return False
    r = stock.iloc[i]
    prev = stock.iloc[i-1]
    return pd.notna(r.get('ma10')) and pd.notna(prev.get('ma10')) and r['ma10'] > prev['ma10']

def v12d(stock, i):
    """V12d: V11h + 前3天未連漲（避免追高第N棒）"""
    if not v11h_base(stock, i): return False
    if i < 3: return True
    consec = sum(1 for j in range(i-3, i) if stock.iloc[j]['close'] > stock.iloc[j]['open'])
    return consec < 3

def v12e(stock, i):
    """V12e: V11h + 量>=1.5x (更嚴格量能)"""
    if not v11h_base(stock, i): return False
    r = stock.iloc[i]
    return r['volume'] / r['avg_vol5'] >= 1.5

def v12f(stock, i):
    """V12f: V11h + MACD正 + MA10↑"""
    if not v11h_base(stock, i): return False
    r = stock.iloc[i]
    prev = stock.iloc[i-1]
    if not pd.notna(r.get('macd_osc')) or r['macd_osc'] <= 0: return False
    if not pd.notna(r.get('ma10')) or not pd.notna(prev.get('ma10')): return False
    return r['ma10'] > prev['ma10']

def v12g(stock, i):
    """V12g: V11h + ATR擴張 (今日ATR > 5日平均ATR)"""
    if not v11h_base(stock, i): return False
    r = stock.iloc[i]
    if i < 5 or not pd.notna(r.get('atr14')): return False
    avg_atr = np.mean([stock.iloc[j].get('atr14', 0) for j in range(i-5, i) if pd.notna(stock.iloc[j].get('atr14'))])
    return avg_atr > 0 and r['atr14'] > avg_atr

def v12h(stock, i):
    """V12h: V11h + 收盤在日高附近（收盤位置>0.7）"""
    if not v11h_base(stock, i): return False
    r = stock.iloc[i]
    return pd.notna(r.get('close_pos')) and r['close_pos'] > 0.7


if __name__ == '__main__':
    tw_csv = os.path.join(DATA_DIR, 'tw_stocks.csv')
    df_all = pd.read_csv(tw_csv)
    df_all['date'] = pd.to_datetime(df_all['date'])

    strategies = [
        ('V11h基線', v11h_base),
        ('V12a: BB%B 0.5-1.0', v12a),
        ('V12b: +MACD正', v12b),
        ('V12c: +MA10↑', v12c),
        ('V12d: +未連漲3天', v12d),
        ('V12e: +量>=1.5x', v12e),
        ('V12f: +MACD正+MA10↑', v12f),
        ('V12g: +ATR擴張', v12g),
        ('V12h: +收高位(>0.7)', v12h),
    ]

    sl_configs = [
        {'stop_loss': -0.07, 'take_profit': 0.15, 'trailing_stop': -0.04, 'max_hold': 20, 'label': '止7盈15'},
        {'stop_loss': -0.06, 'take_profit': 0.12, 'trailing_stop': -0.035, 'max_hold': 15, 'label': '止6盈12'},
        {'stop_loss': -0.07, 'take_profit': 0.20, 'trailing_stop': -0.05, 'max_hold': 25, 'label': '止7盈20'},
        {'stop_loss': -0.08, 'take_profit': 0.15, 'trailing_stop': -0.04, 'max_hold': 20, 'label': '止8盈15'},
    ]

    results = []
    for s_name, s_fn in strategies:
        for sl in sl_configs:
            label = f"{s_name} | {sl['label']}"
            r = run_strategy(df_all, s_fn, **{k: v for k, v in sl.items() if k != 'label'})
            r['label'] = label
            results.append(r)

    print("\n" + "=" * 95)
    print("=== V12: V11h 深度微調 ===")
    print("=" * 95)
    print(f"{'策略':<45} {'交易':>5} {'勝率':>6} {'均報':>6} {'均贏':>6} {'均虧':>6} {'盈虧':>5} {'累計':>7}")
    print("-" * 95)
    for r in sorted(results, key=lambda x: x.get('win_rate', 0) * max(x.get('avg_return', 0.01), 0.01), reverse=True)[:15]:
        if r.get('trades', 0) < 5: continue
        print(f"{r['label']:<45} {r['trades']:>5} {r['win_rate']:>5}% {r['avg_return']:>5}% {r.get('avg_win',0):>5}% {r.get('avg_loss',0):>5}% {r['profit_factor']:>5} {r['total_return']:>6}%")

    valid = [r for r in results if r.get('trades', 0) >= 10]
    if valid:
        best = max(valid, key=lambda x: x['win_rate'] * max(x['avg_return'], 0.01))
        print(f"\n🏆 最佳: {best['label']}")
        print(f"   {best['trades']}次, 勝率={best['win_rate']}%, 均報={best['avg_return']}%, 盈虧比={best['profit_factor']}, 累計={best['total_return']}%")

        with open(LOG_PATH, 'a') as f:
            f.write(f"\n## Iteration 12: V11h 深度微調 ({datetime.now().strftime('%Y-%m-%d %H:%M')})\n")
            f.write(f"- **基礎**: V11h (MA5↑MA20 + BB%B<1.2) — 66.1%勝率, 2.84%均報\n")
            f.write(f"- **測試**: 9策略 × 4止損 = 36組合\n")
            f.write(f"- **🏆最佳**: {best['label']}\n")
            f.write(f"  - {best['trades']}次, 勝率={best['win_rate']}%, 均報={best['avg_return']}%\n")
            f.write(f"  - 盈虧比={best['profit_factor']}, 累計={best['total_return']}%\n")
            top3 = sorted(valid, key=lambda x: x['win_rate'] * max(x['avg_return'], 0.01), reverse=True)[:3]
            f.write(f"- **Top 3**:\n")
            for i, t in enumerate(top3):
                f.write(f"  {i+1}. {t['label']}: {t['trades']}次, 勝率={t['win_rate']}%, 均報={t['avg_return']}%\n")
            f.write(f"\n---\n")
