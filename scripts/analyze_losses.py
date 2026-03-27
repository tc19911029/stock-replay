#!/usr/bin/env python3
"""分析虧損交易的共同模式"""

import os
import numpy as np
import pandas as pd
from backtest_strategy import compute_indicators, evaluate_six_conditions, compute_surge_score, DATA_DIR

tw_csv = os.path.join(DATA_DIR, 'tw_stocks.csv')
df = pd.read_csv(tw_csv)
df['date'] = pd.to_datetime(df['date'])
symbols = df['symbol'].unique()

wins = []
losses = []

for sym in symbols:
    stock = df[df['symbol'] == sym].sort_values('date').reset_index(drop=True)
    if len(stock) < 80:
        continue
    stock = compute_indicators(stock)

    start_idx = max(60, len(stock) - 250)
    for i in range(start_idx, len(stock) - 5):
        six = evaluate_six_conditions(stock, i)
        if six['score'] < 5:
            continue
        surge = compute_surge_score(stock, i)
        if surge['total'] < 50:
            continue

        r = stock.iloc[i]
        entry = r['close']
        d5_return = (stock.iloc[i+5]['close'] - entry) / entry * 100 if i+5 < len(stock) else None
        if d5_return is None:
            continue

        record = {
            'symbol': sym,
            'date': r['date'],
            'entry': entry,
            'd5_return': d5_return,
            'rsi14': r['rsi14'],
            'body_pct': r['body_pct'],
            'vol_ratio': r['volume'] / r['avg_vol5'] if r['avg_vol5'] > 0 else 0,
            'deviation': (r['close'] - r['ma20']) / r['ma20'] if pd.notna(r['ma20']) and r['ma20'] > 0 else 0,
            'bb_pctb': r['bb_pctb'],
            'kd_k': r['kd_k'],
            'roc10': r['roc10'],
            'surge_score': surge['total'],
            'close_pos': r['close_pos'],
            'upper_shadow': r['upper_shadow'],
            # 前一日是否也是大漲日
            'prev_day_up': (stock.iloc[i-1]['close'] > stock.iloc[i-1]['open'] and
                           stock.iloc[i-1]['body_pct'] > 0.02) if i > 0 else False,
            # 連續漲幾天
            'consecutive_up': sum(1 for j in range(max(0,i-5), i) if stock.iloc[j]['close'] > stock.iloc[j]['open']),
        }

        if d5_return > 0:
            wins.append(record)
        else:
            losses.append(record)

wins_df = pd.DataFrame(wins)
losses_df = pd.DataFrame(losses)

print(f"勝: {len(wins_df)} 筆, 敗: {len(losses_df)} 筆")
print(f"勝率: {len(wins_df)/(len(wins_df)+len(losses_df))*100:.1f}%")

print("\n=== 虧損 vs 獲利交易特徵比較 ===")
cols = ['rsi14', 'body_pct', 'vol_ratio', 'deviation', 'bb_pctb', 'kd_k', 'roc10', 'close_pos', 'upper_shadow', 'consecutive_up', 'surge_score']
for col in cols:
    w_mean = wins_df[col].mean() if col in wins_df and len(wins_df) > 0 else 0
    l_mean = losses_df[col].mean() if col in losses_df and len(losses_df) > 0 else 0
    print(f"  {col:<20}: 勝={w_mean:.3f}  敗={l_mean:.3f}  差={w_mean-l_mean:.3f}")

print("\n=== 虧損交易的高頻特徵 ===")
if len(losses_df) > 0:
    print(f"  RSI > 70 (超買):     {(losses_df['rsi14'] > 70).mean()*100:.1f}%")
    print(f"  乖離 > 10%:          {(losses_df['deviation'] > 0.10).mean()*100:.1f}%")
    print(f"  BB%B > 1 (超出上軌): {(losses_df['bb_pctb'] > 1.0).mean()*100:.1f}%")
    print(f"  KD > 80:             {(losses_df['kd_k'] > 80).mean()*100:.1f}%")
    print(f"  前日也大漲:          {losses_df['prev_day_up'].mean()*100:.1f}%")
    print(f"  連漲 >= 4 天:        {(losses_df['consecutive_up'] >= 4).mean()*100:.1f}%")
    print(f"  上影線 > 15%:        {(losses_df['upper_shadow'] > 0.15).mean()*100:.1f}%")
    print(f"  ROC10 > 15%:         {(losses_df['roc10'] > 15).mean()*100:.1f}%")

print("\n=== 獲利交易的高頻特徵 ===")
if len(wins_df) > 0:
    print(f"  RSI 40-60 (理想):    {((wins_df['rsi14'] >= 40) & (wins_df['rsi14'] <= 60)).mean()*100:.1f}%")
    print(f"  乖離 < 5%:           {(wins_df['deviation'] < 0.05).mean()*100:.1f}%")
    print(f"  連漲 < 3 天:         {(wins_df['consecutive_up'] < 3).mean()*100:.1f}%")
