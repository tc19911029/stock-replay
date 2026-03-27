#!/usr/bin/env python3
"""
選股策略回測框架

讀取本地 CSV 數據，對每支股票的每個交易日計算信號，
符合條件則模擬進場，追蹤 5 日、10 日、20 日回報。
"""

import os
import sys
import json
import numpy as np
import pandas as pd
from datetime import datetime

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data')

# ══════════════════════════════════════════════════════════════════════════════
# 技術指標計算
# ══════════════════════════════════════════════════════════════════════════════

def compute_indicators(df: pd.DataFrame) -> pd.DataFrame:
    """計算所有技術指標"""
    d = df.copy()
    c = d['close']

    # 均線
    d['ma5']  = c.rolling(5).mean()
    d['ma10'] = c.rolling(10).mean()
    d['ma20'] = c.rolling(20).mean()
    d['ma60'] = c.rolling(60).mean()

    # 成交量均線
    d['avg_vol5']  = d['volume'].rolling(5).mean()
    d['avg_vol20'] = d['volume'].rolling(20).mean()

    # RSI(14)
    delta = c.diff()
    gain = delta.clip(lower=0)
    loss = (-delta).clip(lower=0)
    avg_gain = gain.ewm(alpha=1/14, min_periods=14).mean()
    avg_loss = loss.ewm(alpha=1/14, min_periods=14).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    d['rsi14'] = 100 - (100 / (1 + rs))

    # MACD (12, 26, 9)
    ema12 = c.ewm(span=12).mean()
    ema26 = c.ewm(span=26).mean()
    d['macd_dif'] = ema12 - ema26
    d['macd_signal'] = d['macd_dif'].ewm(span=9).mean()
    d['macd_osc'] = d['macd_dif'] - d['macd_signal']

    # KD (9, 3, 3)
    low9  = d['low'].rolling(9).min()
    high9 = d['high'].rolling(9).max()
    rsv = ((c - low9) / (high9 - low9).replace(0, np.nan)) * 100
    d['kd_k'] = rsv.ewm(alpha=1/3, min_periods=1).mean()
    d['kd_d'] = d['kd_k'].ewm(alpha=1/3, min_periods=1).mean()

    # ATR(14)
    tr1 = d['high'] - d['low']
    tr2 = (d['high'] - c.shift(1)).abs()
    tr3 = (d['low'] - c.shift(1)).abs()
    tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)
    d['atr14'] = tr.rolling(14).mean()

    # Bollinger Bands (20, 2)
    std20 = c.rolling(20).std()
    d['bb_upper'] = d['ma20'] + 2 * std20
    d['bb_lower'] = d['ma20'] - 2 * std20
    d['bb_bandwidth'] = (d['bb_upper'] - d['bb_lower']) / d['ma20'].replace(0, np.nan)
    d['bb_pctb'] = (c - d['bb_lower']) / (d['bb_upper'] - d['bb_lower']).replace(0, np.nan)

    # ROC
    d['roc10'] = c.pct_change(10) * 100
    d['roc20'] = c.pct_change(20) * 100
    d['roc60'] = c.pct_change(60) * 100

    # MACD slope (3-bar)
    d['macd_slope'] = (d['macd_osc'] - d['macd_osc'].shift(3)) / 3

    # 20日高點/低點
    d['high20'] = d['high'].rolling(20).max()
    d['high60'] = d['high'].rolling(60).max()
    d['range20_pct'] = (d['high'].rolling(20).max() - d['low'].rolling(20).min()) / d['low'].rolling(20).min()

    # MA slopes
    d['ma5_slope']  = d['ma5'] - d['ma5'].shift(1)
    d['ma10_slope'] = d['ma10'] - d['ma10'].shift(1)
    d['ma20_slope'] = d['ma20'] - d['ma20'].shift(1)

    # Body/range ratio
    body = (d['close'] - d['open']).abs()
    day_range = d['high'] - d['low']
    d['body_pct'] = body / d['open'].replace(0, np.nan)
    d['close_pos'] = (d['close'] - d['low']) / day_range.replace(0, np.nan)
    d['upper_shadow'] = (d['high'] - d['close']) / day_range.replace(0, np.nan)
    d['is_red'] = d['close'] > d['open']

    return d


# ══════════════════════════════════════════════════════════════════════════════
# 六大條件 + 飆股潛力分
# ══════════════════════════════════════════════════════════════════════════════

def evaluate_six_conditions(d: pd.DataFrame, i: int) -> dict:
    """評估六大條件，回傳 dict"""
    r = d.iloc[i]
    prev = d.iloc[i-1] if i > 0 else r

    # ① 趨勢
    trend_pass = (r['ma5'] > r['ma20']) if pd.notna(r['ma5']) and pd.notna(r['ma20']) else False

    # ② 位置 (乖離 < 12%)
    dev = (r['close'] - r['ma20']) / r['ma20'] if pd.notna(r['ma20']) and r['ma20'] > 0 else 0
    position_pass = 0 <= dev < 0.12

    # ③ K棒 (紅K, 實體 >= 2%, 收在上半段)
    kbar_pass = r['is_red'] and r['body_pct'] >= 0.02 and r['close_pos'] >= 0.5 and r['upper_shadow'] < 0.2

    # ④ 均線多排
    ma_pass = (r['ma5'] > r['ma10'] > r['ma20']) if all(pd.notna([r['ma5'], r['ma10'], r['ma20']])) else False
    ma_pass = ma_pass and r['close'] >= r['ma5'] and r['ma5_slope'] > 0

    # ⑤ 量能
    vol_ratio = r['volume'] / r['avg_vol5'] if pd.notna(r['avg_vol5']) and r['avg_vol5'] > 0 else 0
    volume_pass = vol_ratio >= 1.5

    # ⑥ 指標
    macd_bull = pd.notna(r['macd_osc']) and r['macd_osc'] > 0
    kd_bull = pd.notna(r['kd_k']) and pd.notna(r['kd_d']) and r['kd_k'] > r['kd_d'] and 20 <= r['kd_k'] <= 85
    indicator_pass = macd_bull or kd_bull

    conditions = [trend_pass, position_pass, kbar_pass, ma_pass, volume_pass, indicator_pass]
    score = sum(conditions)

    return {
        'score': score,
        'trend': trend_pass, 'position': position_pass, 'kbar': kbar_pass,
        'ma': ma_pass, 'volume': volume_pass, 'indicator': indicator_pass,
        'vol_ratio': vol_ratio, 'dev': dev,
    }


def compute_surge_score(d: pd.DataFrame, i: int) -> dict:
    """計算飆股潛力分 (0-100)"""
    r = d.iloc[i]
    scores = {}

    # 動能加速 (18%)
    momentum = 0
    if pd.notna(r['rsi14']) and 45 <= r['rsi14'] <= 70:
        momentum += 25
    if i >= 3 and pd.notna(r['rsi14']) and pd.notna(d.iloc[i-3]['rsi14']):
        if r['rsi14'] - d.iloc[i-3]['rsi14'] > 5: momentum += 20
    if pd.notna(r['roc10']) and pd.notna(r['roc20']) and r['roc10'] > 0 and r['roc10'] > r['roc20']:
        momentum += 25
    if pd.notna(r['macd_slope']) and r['macd_slope'] > 0:
        momentum += 20
    scores['momentum'] = min(100, momentum)

    # 波動擴張 (12%)
    volatility = 0
    if pd.notna(r['bb_bandwidth']) and i >= 20:
        avg_bw = d.iloc[i-20:i]['bb_bandwidth'].mean()
        if pd.notna(avg_bw) and avg_bw > 0 and r['bb_bandwidth'] > avg_bw * 1.3:
            volatility += 40
    if pd.notna(r['bb_pctb']) and r['bb_pctb'] > 0.8:
        volatility += 30
    scores['volatility'] = min(100, volatility)

    # 量能攀升 (15%)
    volume = 0
    if pd.notna(r['avg_vol5']) and pd.notna(r['avg_vol20']) and r['avg_vol20'] > 0:
        if r['avg_vol5'] / r['avg_vol20'] > 1.5: volume += 30
        elif r['avg_vol5'] / r['avg_vol20'] > 1.2: volume += 20
    if pd.notna(r['avg_vol5']) and r['avg_vol5'] > 0:
        today_ratio = r['volume'] / r['avg_vol5']
        if today_ratio > 3: volume += 30
        elif today_ratio > 2: volume += 25
        elif today_ratio > 1.5: volume += 15
    if i >= 3 and d.iloc[i]['volume'] > d.iloc[i-1]['volume'] > d.iloc[i-2]['volume']:
        volume += 20
    scores['volume'] = min(100, volume)

    # 突破型態 (15%)
    breakout = 0
    if pd.notna(r.get('high20')) and r['close'] > r['high20']:
        breakout += 30
    if pd.notna(r.get('high60')) and r['close'] > r['high60']:
        breakout += 20
    if pd.notna(r.get('range20_pct')) and r['range20_pct'] < 0.15 and breakout > 0:
        breakout += 25
    scores['breakout'] = min(100, breakout)

    # 趨勢品質 (15%)
    trend_q = 0
    if all(pd.notna([r['ma5'], r['ma10'], r['ma20']])):
        if r['ma5'] > r['ma10'] > r['ma20']:
            trend_q += 30
            if pd.notna(r.get('ma60')) and r['ma20'] > r['ma60']:
                trend_q += 10
    if r['ma5_slope'] > 0 and r['ma10_slope'] > 0 and r['ma20_slope'] > 0:
        trend_q += 30
    scores['trendQuality'] = min(100, trend_q)

    # 價格位置 (5%)
    dev = (r['close'] - r['ma20']) / r['ma20'] if pd.notna(r['ma20']) and r['ma20'] > 0 else 0.5
    if 0 <= dev < 0.10: scores['pricePosition'] = 100
    elif 0.10 <= dev < 0.15: scores['pricePosition'] = 50
    else: scores['pricePosition'] = 0

    # K棒力道 (5%)
    kbar = 0
    if r['is_red'] and r['body_pct'] >= 0.05: kbar += 50
    elif r['is_red'] and r['body_pct'] >= 0.03: kbar += 35
    if pd.notna(r['close_pos']) and r['close_pos'] >= 0.8: kbar += 30
    if pd.notna(r['upper_shadow']) and r['upper_shadow'] < 0.1: kbar += 20
    scores['kbarStrength'] = min(100, kbar)

    # 指標共振 (5%)
    confluence = 0
    macd_bull = pd.notna(r['macd_osc']) and r['macd_osc'] > 0
    kd_bull = pd.notna(r['kd_k']) and pd.notna(r['kd_d']) and r['kd_k'] > r['kd_d']
    if macd_bull and kd_bull: confluence = 50
    elif macd_bull: confluence = 25
    scores['indicatorConfluence'] = confluence

    # 長期品質 (10%)
    lt = 0
    if pd.notna(r.get('roc60')):
        if r['roc60'] > 20: lt += 40
        elif r['roc60'] > 5: lt += 30
        elif r['roc60'] > 0: lt += 15
    if pd.notna(r.get('ma60')) and r['close'] > r['ma60']: lt += 30
    if pd.notna(r.get('ma60')) and i > 0 and pd.notna(d.iloc[i-1].get('ma60')):
        if r['ma60'] > d.iloc[i-1]['ma60']: lt += 30
    scores['longTermQuality'] = min(100, lt)

    weights = {
        'momentum': 0.18, 'volatility': 0.12, 'volume': 0.15,
        'breakout': 0.15, 'trendQuality': 0.15, 'pricePosition': 0.05,
        'kbarStrength': 0.05, 'indicatorConfluence': 0.05, 'longTermQuality': 0.10,
    }

    total = sum(scores[k] * weights[k] for k in weights)
    grade = 'S' if total >= 80 else 'A' if total >= 65 else 'B' if total >= 50 else 'C' if total >= 35 else 'D'

    return {'total': round(total), 'grade': grade, 'components': scores}


# ══════════════════════════════════════════════════════════════════════════════
# 回測引擎
# ══════════════════════════════════════════════════════════════════════════════

def backtest(csv_path: str, market: str, min_score: int = 4, min_surge: int = 0) -> dict:
    """對單一市場 CSV 進行回測"""
    print(f"\n{'='*60}")
    print(f"回測 {market} 市場 | 最低條件分={min_score} | 最低飆股分={min_surge}")
    print(f"{'='*60}")

    df = pd.read_csv(csv_path)
    df['date'] = pd.to_datetime(df['date'])
    symbols = df['symbol'].unique()
    print(f"股票數量: {len(symbols)}")

    all_signals = []

    for sym in symbols:
        stock = df[df['symbol'] == sym].sort_values('date').reset_index(drop=True)
        if len(stock) < 80:  # 需要至少 80 天數據
            continue

        stock = compute_indicators(stock)

        # 掃描最近 1 年的交易日
        start_idx = max(60, len(stock) - 250)
        for i in range(start_idx, len(stock) - 20):  # 保留 20 天 forward data
            six = evaluate_six_conditions(stock, i)
            if six['score'] < min_score:
                continue

            surge = compute_surge_score(stock, i)
            if surge['total'] < min_surge:
                continue

            # 計算 forward returns
            entry = stock.iloc[i]['close']
            d1  = (stock.iloc[i+1]['close'] - entry) / entry * 100 if i+1 < len(stock) else None
            d5  = (stock.iloc[i+5]['close'] - entry) / entry * 100 if i+5 < len(stock) else None
            d10 = (stock.iloc[i+10]['close'] - entry) / entry * 100 if i+10 < len(stock) else None
            d20 = (stock.iloc[i+20]['close'] - entry) / entry * 100 if i+20 < len(stock) else None

            # Max gain/loss in 20 days
            future = stock.iloc[i+1:i+21]['close'].values
            max_gain = ((future.max() - entry) / entry * 100) if len(future) > 0 else 0
            max_loss = ((future.min() - entry) / entry * 100) if len(future) > 0 else 0

            all_signals.append({
                'date': stock.iloc[i]['date'].strftime('%Y-%m-%d'),
                'symbol': sym,
                'market': market,
                'price': entry,
                'six_score': six['score'],
                'surge_score': surge['total'],
                'surge_grade': surge['grade'],
                'vol_ratio': round(six['vol_ratio'], 2),
                'deviation': round(six['dev'] * 100, 2),
                'd1': round(d1, 2) if d1 else None,
                'd5': round(d5, 2) if d5 else None,
                'd10': round(d10, 2) if d10 else None,
                'd20': round(d20, 2) if d20 else None,
                'max_gain_20': round(max_gain, 2),
                'max_loss_20': round(max_loss, 2),
            })

    signals_df = pd.DataFrame(all_signals)
    if len(signals_df) == 0:
        print("⚠ 無信號產生")
        return {'signals': 0}

    # 統計
    valid_d5 = signals_df[signals_df['d5'].notna()]
    valid_d20 = signals_df[signals_df['d20'].notna()]

    stats = {
        'market': market,
        'total_signals': len(signals_df),
        'unique_stocks': signals_df['symbol'].nunique(),
        'min_score': min_score,
        'min_surge': min_surge,
    }

    if len(valid_d5) > 0:
        stats['win_rate_d5'] = round((valid_d5['d5'] > 0).mean() * 100, 1)
        stats['avg_d5'] = round(valid_d5['d5'].mean(), 2)
        stats['median_d5'] = round(valid_d5['d5'].median(), 2)

    if len(valid_d20) > 0:
        stats['win_rate_d20'] = round((valid_d20['d20'] > 0).mean() * 100, 1)
        stats['avg_d20'] = round(valid_d20['d20'].mean(), 2)
        stats['median_d20'] = round(valid_d20['d20'].median(), 2)
        stats['avg_max_gain_20'] = round(valid_d20['max_gain_20'].mean(), 2)
        stats['avg_max_loss_20'] = round(valid_d20['max_loss_20'].mean(), 2)

    # 按等級分析
    grade_stats = {}
    for grade in ['S', 'A', 'B', 'C', 'D']:
        g = valid_d5[valid_d5['surge_grade'] == grade]
        if len(g) >= 3:
            g20 = valid_d20[valid_d20['surge_grade'] == grade]
            grade_stats[grade] = {
                'count': len(g),
                'win_d5': round((g['d5'] > 0).mean() * 100, 1),
                'avg_d5': round(g['d5'].mean(), 2),
                'win_d20': round((g20['d20'] > 0).mean() * 100, 1) if len(g20) > 0 else None,
                'avg_d20': round(g20['d20'].mean(), 2) if len(g20) > 0 else None,
            }
    stats['by_grade'] = grade_stats

    # 打印結果
    print(f"\n📊 回測結果 ({market})")
    print(f"  信號總數: {stats['total_signals']}")
    print(f"  涉及股票: {stats['unique_stocks']}")
    if 'win_rate_d5' in stats:
        print(f"  5日勝率:  {stats['win_rate_d5']}%")
        print(f"  5日平均:  {stats['avg_d5']}%")
    if 'win_rate_d20' in stats:
        print(f"  20日勝率: {stats['win_rate_d20']}%")
        print(f"  20日平均: {stats['avg_d20']}%")

    print(f"\n  按飆股等級:")
    for g, v in sorted(grade_stats.items()):
        print(f"    {g}級: {v['count']}次, 5日勝率={v['win_d5']}%, 5日均報={v['avg_d5']}%, 20日勝率={v.get('win_d20', 'N/A')}%, 20日均報={v.get('avg_d20', 'N/A')}%")

    return stats


if __name__ == '__main__':
    cn_csv = os.path.join(DATA_DIR, 'cn_stocks.csv')
    tw_csv = os.path.join(DATA_DIR, 'tw_stocks.csv')

    results = {}

    # 迭代1: 嘗試不同門檻組合
    print("\n" + "="*70)
    print("=== 迭代測試：不同門檻組合 ===")
    print("="*70)

    configs = [
        {'min_score': 4, 'min_surge': 0, 'label': '基線(4分,無surge門檻)'},
        {'min_score': 4, 'min_surge': 50, 'label': '4分+surge≥50'},
        {'min_score': 4, 'min_surge': 60, 'label': '4分+surge≥60'},
        {'min_score': 5, 'min_surge': 0, 'label': '5分(無surge門檻)'},
        {'min_score': 5, 'min_surge': 50, 'label': '5分+surge≥50'},
        {'min_score': 5, 'min_surge': 60, 'label': '5分+surge≥60'},
        {'min_score': 6, 'min_surge': 0, 'label': '6分(無surge門檻)'},
    ]

    tw_results = []
    for cfg in configs:
        r = backtest(tw_csv, 'TW', min_score=cfg['min_score'], min_surge=cfg['min_surge'])
        r['label'] = cfg['label']
        tw_results.append(r)

    # 比較表
    print("\n\n" + "="*70)
    print("=== 門檻組合比較 ===")
    print("="*70)
    print(f"{'配置':<25} {'信號數':>8} {'5日勝率':>8} {'5日均報':>8} {'20日勝率':>8} {'20日均報':>8}")
    print("-" * 70)
    for r in tw_results:
        if r.get('total_signals', 0) == 0:
            print(f"{r['label']:<25} {'0':>8}")
            continue
        print(f"{r['label']:<25} {r.get('total_signals',0):>8} {r.get('win_rate_d5','N/A'):>7}% {r.get('avg_d5','N/A'):>7}% {r.get('win_rate_d20','N/A'):>7}% {r.get('avg_d20','N/A'):>7}%")

    results['comparison'] = tw_results

    # 存結果
    with open(os.path.join(DATA_DIR, 'backtest_results.json'), 'w') as f:
        json.dump(results, f, indent=2, ensure_ascii=False)

    print("\n\n✅ 回測完成，結果已存至 data/backtest_results.json")
