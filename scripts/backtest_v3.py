#!/usr/bin/env python3
"""
策略 V3：多重確認信號策略
在六大條件之上，嘗試各種額外篩選條件組合，找出最高勝率的組合
"""

import os
import numpy as np
import pandas as pd
from itertools import combinations
from backtest_strategy import compute_indicators, evaluate_six_conditions, compute_surge_score, DATA_DIR


def signal_passes(stock, i, filters: dict) -> bool:
    """檢查信號是否通過所有額外篩選條件"""
    r = stock.iloc[i]

    # 突破 20 日高點
    if filters.get('breakout_20d'):
        if i < 20:
            return False
        high20 = stock.iloc[i-20:i]['high'].max()
        if r['close'] <= high20:
            return False

    # 量比門檻
    min_vol = filters.get('min_vol_ratio', 1.5)
    if pd.notna(r['avg_vol5']) and r['avg_vol5'] > 0:
        if r['volume'] / r['avg_vol5'] < min_vol:
            return False

    # 連漲天數限制
    max_consec = filters.get('max_consecutive_up', 999)
    if i >= 5:
        consec = sum(1 for j in range(i-5, i) if stock.iloc[j]['close'] > stock.iloc[j]['open'])
        if consec >= max_consec:
            return False

    # RSI 上限
    max_rsi = filters.get('max_rsi', 100)
    if pd.notna(r['rsi14']) and r['rsi14'] > max_rsi:
        return False

    # KD 上限
    max_kd = filters.get('max_kd', 100)
    if pd.notna(r['kd_k']) and r['kd_k'] > max_kd:
        return False

    # 乖離上限
    max_dev = filters.get('max_deviation', 1.0)
    if pd.notna(r['ma20']) and r['ma20'] > 0:
        dev = (r['close'] - r['ma20']) / r['ma20']
        if dev > max_dev:
            return False

    # MA60 向上
    if filters.get('ma60_rising'):
        if i < 1 or not pd.notna(r.get('ma60')) or not pd.notna(stock.iloc[i-1].get('ma60')):
            return False
        if r['ma60'] <= stock.iloc[i-1]['ma60']:
            return False

    # 股價 > MA60
    if filters.get('above_ma60'):
        if not pd.notna(r.get('ma60')) or r['close'] <= r['ma60']:
            return False

    # BB%B < 上限（避免過度延伸）
    max_bb = filters.get('max_bb_pctb', 2.0)
    if pd.notna(r['bb_pctb']) and r['bb_pctb'] > max_bb:
        return False

    # MACD 柱上升
    if filters.get('macd_rising'):
        if not pd.notna(r.get('macd_slope')) or r['macd_slope'] <= 0:
            return False

    # 實體比例門檻
    min_body = filters.get('min_body_pct', 0)
    if r['body_pct'] < min_body:
        return False

    return True


def run_backtest(csv_path, market, min_score, min_surge, filters, stop_loss=-0.05, take_profit=0.10, max_hold=10):
    """執行回測"""
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

        for i in range(start_idx, len(stock) - max_hold):
            if cooldown > 0:
                cooldown -= 1
                continue

            six = evaluate_six_conditions(stock, i)
            if six['score'] < min_score:
                continue

            surge = compute_surge_score(stock, i)
            if surge['total'] < min_surge:
                continue

            if not signal_passes(stock, i, filters):
                continue

            # 隔日開盤買入（更接近實際操作）
            if i + 1 >= len(stock):
                continue
            entry_price = stock.iloc[i+1]['open']
            entry_day = i + 1

            # 持有追蹤
            exit_day = None
            exit_price = None
            exit_reason = 'max_hold'

            for h in range(1, max_hold + 1):
                hi = entry_day + h
                if hi >= len(stock):
                    break
                hday = stock.iloc[hi]
                ret = (hday['close'] - entry_price) / entry_price

                if ret <= stop_loss:
                    exit_day = hi; exit_price = hday['close']; exit_reason = 'stop_loss'; break
                if ret >= take_profit:
                    exit_day = hi; exit_price = hday['close']; exit_reason = 'take_profit'; break
                if pd.notna(hday['ma10']) and hday['close'] < hday['ma10'] * 0.97:
                    exit_day = hi; exit_price = hday['close']; exit_reason = 'break_ma10'; break

            if exit_day is None:
                exit_day = min(entry_day + max_hold, len(stock) - 1)
                exit_price = stock.iloc[exit_day]['close']

            final_return = (exit_price - entry_price) / entry_price * 100
            trades.append({
                'return_pct': round(final_return, 2),
                'exit_reason': exit_reason,
                'hold_days': exit_day - entry_day,
                'surge_grade': surge['grade'],
            })
            cooldown = 5  # 短冷卻

    if not trades:
        return {'trades': 0, 'win_rate': 0, 'avg_return': 0}

    tdf = pd.DataFrame(trades)
    win = tdf[tdf['return_pct'] > 0]
    loss = tdf[tdf['return_pct'] <= 0]

    return {
        'trades': len(tdf),
        'win_rate': round(len(win) / len(tdf) * 100, 1),
        'avg_return': round(tdf['return_pct'].mean(), 2),
        'median_return': round(tdf['return_pct'].median(), 2),
        'profit_factor': round(abs(win['return_pct'].sum()) / max(abs(loss['return_pct'].sum()), 0.01), 2),
        'avg_hold': round(tdf['hold_days'].mean(), 1),
    }


if __name__ == '__main__':
    tw_csv = os.path.join(DATA_DIR, 'tw_stocks.csv')

    # 測試各種篩選條件組合
    test_configs = [
        # 基線
        {'label': '基線: 4分', 'min_score': 4, 'min_surge': 0, 'filters': {}},

        # 加入突破確認
        {'label': '4分+突破20日高', 'min_score': 4, 'min_surge': 0,
         'filters': {'breakout_20d': True}},

        # 加入量能門檻
        {'label': '4分+量2x', 'min_score': 4, 'min_surge': 0,
         'filters': {'min_vol_ratio': 2.0}},

        # 避免追高
        {'label': '4分+RSI<70+連漲<3', 'min_score': 4, 'min_surge': 0,
         'filters': {'max_rsi': 70, 'max_consecutive_up': 3}},

        # 長期健康
        {'label': '4分+MA60向上+價>MA60', 'min_score': 4, 'min_surge': 0,
         'filters': {'ma60_rising': True, 'above_ma60': True}},

        # 綜合嚴格
        {'label': '4分+突破+量2x+RSI<75', 'min_score': 4, 'min_surge': 0,
         'filters': {'breakout_20d': True, 'min_vol_ratio': 2.0, 'max_rsi': 75}},

        # 綜合嚴格 + surge
        {'label': '4分+surge50+突破+量2x', 'min_score': 4, 'min_surge': 50,
         'filters': {'breakout_20d': True, 'min_vol_ratio': 2.0}},

        # 最嚴格
        {'label': '5分+surge50+突破+量2x+MA60↑', 'min_score': 5, 'min_surge': 50,
         'filters': {'breakout_20d': True, 'min_vol_ratio': 2.0, 'ma60_rising': True, 'above_ma60': True}},

        # MACD rising + breakout
        {'label': '4分+突破+MACD↑+MA60↑', 'min_score': 4, 'min_surge': 0,
         'filters': {'breakout_20d': True, 'macd_rising': True, 'ma60_rising': True, 'above_ma60': True}},

        # 實體大K + 突破 + 量
        {'label': '4分+突破+量2x+大K(3%)+連漲<3', 'min_score': 4, 'min_surge': 0,
         'filters': {'breakout_20d': True, 'min_vol_ratio': 2.0, 'min_body_pct': 0.03, 'max_consecutive_up': 3}},
    ]

    results = []
    for cfg in test_configs:
        r = run_backtest(tw_csv, 'TW',
                         min_score=cfg['min_score'],
                         min_surge=cfg['min_surge'],
                         filters=cfg['filters'])
        r['label'] = cfg['label']
        results.append(r)

    print("\n\n" + "="*80)
    print("=== 多重確認信號策略比較 ===")
    print("="*80)
    print(f"{'策略':<40} {'交易數':>6} {'勝率':>6} {'均報':>6} {'中位':>6} {'盈虧比':>6} {'均持天':>6}")
    print("-" * 80)
    for r in sorted(results, key=lambda x: x.get('win_rate', 0), reverse=True):
        if r.get('trades', 0) == 0:
            print(f"{r['label']:<40} {'0':>6}")
            continue
        print(f"{r['label']:<40} {r['trades']:>6} {r['win_rate']:>5}% {r['avg_return']:>5}% {r.get('median_return',0):>5}% {r['profit_factor']:>6} {r['avg_hold']:>5}d")
