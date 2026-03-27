#!/usr/bin/env python3
"""
策略 V4：趨勢跟蹤策略
核心思路：
- 接受低勝率（~55%），但讓獲利 >> 虧損
- 用移動止損鎖住利潤
- 持有期拉長到 20 天，利用趨勢延續性
- 追蹤止損：從峰值回落 N% 則出場
"""

import os
import numpy as np
import pandas as pd
from backtest_strategy import compute_indicators, evaluate_six_conditions, compute_surge_score, DATA_DIR


def backtest_trend_follow(csv_path, market, min_score=4, min_surge=0,
                          initial_stop=-0.05,     # 初始止損
                          trailing_stop=-0.03,    # 追蹤止損（從峰值回落）
                          max_hold=20,
                          extra_filters=None):
    """趨勢跟蹤回測"""
    df = pd.read_csv(csv_path)
    df['date'] = pd.to_datetime(df['date'])
    symbols = df['symbol'].unique()

    trades = []
    for sym in symbols:
        stock = df[df['symbol'] == sym].sort_values('date').reset_index(drop=True)
        if len(stock) < 80:
            continue
        stock = compute_indicators(stock)

        start_idx = max(60, len(stock) - 250)
        cooldown = 0

        for i in range(start_idx, len(stock) - max_hold - 1):
            if cooldown > 0:
                cooldown -= 1
                continue

            six = evaluate_six_conditions(stock, i)
            if six['score'] < min_score:
                continue

            surge = compute_surge_score(stock, i)
            if surge['total'] < min_surge:
                continue

            # 額外篩選
            r = stock.iloc[i]
            if extra_filters:
                skip = False
                if extra_filters.get('above_ma60') and (not pd.notna(r.get('ma60')) or r['close'] <= r['ma60']):
                    skip = True
                if extra_filters.get('roc60_positive') and (not pd.notna(r.get('roc60')) or r['roc60'] <= 0):
                    skip = True
                if extra_filters.get('max_rsi') and pd.notna(r['rsi14']) and r['rsi14'] > extra_filters['max_rsi']:
                    skip = True
                if skip:
                    continue

            # 隔日開盤買入
            entry_price = stock.iloc[i+1]['open']
            entry_day = i + 1

            # 追蹤止損
            peak_price = entry_price
            exit_day = None
            exit_price = None
            exit_reason = 'max_hold'

            for h in range(1, max_hold + 1):
                hi = entry_day + h
                if hi >= len(stock):
                    break
                hday = stock.iloc[hi]

                # 更新峰值
                if hday['high'] > peak_price:
                    peak_price = hday['high']

                ret_from_entry = (hday['close'] - entry_price) / entry_price
                ret_from_peak = (hday['close'] - peak_price) / peak_price

                # 初始止損（從買入價）
                if ret_from_entry <= initial_stop:
                    exit_day = hi; exit_price = hday['close']; exit_reason = 'initial_stop'; break

                # 追蹤止損（從峰值回落）— 只有在已獲利時啟用
                if ret_from_entry > 0.02 and ret_from_peak <= trailing_stop:
                    exit_day = hi; exit_price = hday['close']; exit_reason = 'trailing_stop'; break

            if exit_day is None:
                exit_day = min(entry_day + max_hold, len(stock) - 1)
                exit_price = stock.iloc[exit_day]['close']

            final_return = (exit_price - entry_price) / entry_price * 100
            trades.append({
                'symbol': sym,
                'return_pct': round(final_return, 2),
                'exit_reason': exit_reason,
                'hold_days': exit_day - entry_day,
                'surge_grade': surge['grade'],
                'six_score': six['score'],
            })
            cooldown = 10

    if not trades:
        return {'trades': 0}

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
        'expectancy': round(tdf['return_pct'].mean() * len(tdf), 2),
        'exits': tdf['exit_reason'].value_counts().to_dict(),
    }


if __name__ == '__main__':
    tw_csv = os.path.join(DATA_DIR, 'tw_stocks.csv')

    configs = [
        # 趨勢跟蹤基線
        {'label': '趨勢跟蹤: 止損5%追蹤3%', 'min_score': 4, 'min_surge': 0,
         'initial_stop': -0.05, 'trailing_stop': -0.03, 'max_hold': 20, 'filters': None},

        # 寬止損
        {'label': '趨勢跟蹤: 止損8%追蹤4%', 'min_score': 4, 'min_surge': 0,
         'initial_stop': -0.08, 'trailing_stop': -0.04, 'max_hold': 20, 'filters': None},

        # 緊止損 + 長持有
        {'label': '趨勢跟蹤: 止損3%追蹤2%持30天', 'min_score': 4, 'min_surge': 0,
         'initial_stop': -0.03, 'trailing_stop': -0.02, 'max_hold': 30, 'filters': None},

        # 趨勢跟蹤 + 品質篩選
        {'label': '趨勢+MA60↑+ROC60>0', 'min_score': 4, 'min_surge': 0,
         'initial_stop': -0.05, 'trailing_stop': -0.03, 'max_hold': 20,
         'filters': {'above_ma60': True, 'roc60_positive': True}},

        # 趨勢 + surge
        {'label': '趨勢+surge50+MA60↑', 'min_score': 4, 'min_surge': 50,
         'initial_stop': -0.05, 'trailing_stop': -0.03, 'max_hold': 20,
         'filters': {'above_ma60': True}},

        # 精選高分 + 寬止損
        {'label': '5分+surge50+止損8%追蹤4%', 'min_score': 5, 'min_surge': 50,
         'initial_stop': -0.08, 'trailing_stop': -0.04, 'max_hold': 20, 'filters': None},

        # RSI 過濾 + 趨勢
        {'label': '4分+RSI<75+MA60↑+止損5%追蹤3%', 'min_score': 4, 'min_surge': 0,
         'initial_stop': -0.05, 'trailing_stop': -0.03, 'max_hold': 20,
         'filters': {'above_ma60': True, 'max_rsi': 75}},
    ]

    results = []
    for cfg in configs:
        r = backtest_trend_follow(
            tw_csv, 'TW',
            min_score=cfg['min_score'],
            min_surge=cfg['min_surge'],
            initial_stop=cfg['initial_stop'],
            trailing_stop=cfg['trailing_stop'],
            max_hold=cfg['max_hold'],
            extra_filters=cfg['filters'],
        )
        r['label'] = cfg['label']
        results.append(r)

    print("\n\n" + "="*90)
    print("=== 趨勢跟蹤策略比較 ===")
    print("="*90)
    print(f"{'策略':<40} {'交易':>5} {'勝率':>6} {'均報':>6} {'均贏':>6} {'均虧':>6} {'盈虧比':>6} {'期望值':>7}")
    print("-" * 90)
    for r in sorted(results, key=lambda x: x.get('avg_return', -99), reverse=True):
        if r.get('trades', 0) == 0:
            print(f"{r['label']:<40} {'0':>5}")
            continue
        print(f"{r['label']:<40} {r['trades']:>5} {r['win_rate']:>5}% {r['avg_return']:>5}% {r.get('avg_win',0):>5}% {r.get('avg_loss',0):>5}% {r['profit_factor']:>6} {r.get('expectancy',0):>6}%")
