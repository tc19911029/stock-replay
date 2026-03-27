#!/usr/bin/env python3
"""
策略 V2：回調買入策略
核心改變：不在信號日買入，而是等回調到支撐位再買

邏輯：
1. 掃描到六大條件 ≥ 4 的「候選股」
2. 等待回調：未來5天內股價回測到 MA5 或昨日低點附近（-2%以內）
3. 在回調日收盤買入
4. 止損：跌破 MA10 或虧損 > 5%
5. 止盈：獲利 > 10% 或持有 20 天
"""

import os
import numpy as np
import pandas as pd
from backtest_strategy import compute_indicators, evaluate_six_conditions, compute_surge_score, DATA_DIR


def backtest_pullback(csv_path: str, market: str,
                      min_score: int = 4,
                      min_surge: int = 0,
                      pullback_pct: float = -0.02,  # 回調幅度門檻
                      stop_loss: float = -0.05,      # 止損
                      take_profit: float = 0.10,     # 止盈
                      max_hold: int = 20,            # 最大持有天數
                      wait_days: int = 5,            # 等待回調的天數
                      ) -> dict:
    """回調買入回測"""
    print(f"\n{'='*60}")
    print(f"回調買入策略 | {market} | minScore={min_score} minSurge={min_surge}")
    print(f"回調門檻={pullback_pct*100}% 止損={stop_loss*100}% 止盈={take_profit*100}%")
    print(f"{'='*60}")

    df = pd.read_csv(csv_path)
    df['date'] = pd.to_datetime(df['date'])
    symbols = df['symbol'].unique()

    all_trades = []

    for sym in symbols:
        stock = df[df['symbol'] == sym].sort_values('date').reset_index(drop=True)
        if len(stock) < 80:
            continue
        stock = compute_indicators(stock)

        start_idx = max(60, len(stock) - 250)
        cooldown = 0  # 冷卻期，避免同一波段重複進場

        for i in range(start_idx, len(stock) - max_hold - wait_days):
            if cooldown > 0:
                cooldown -= 1
                continue

            six = evaluate_six_conditions(stock, i)
            if six['score'] < min_score:
                continue

            surge = compute_surge_score(stock, i)
            if surge['total'] < min_surge:
                continue

            signal_close = stock.iloc[i]['close']

            # === 策略A: 等待回調 ===
            entry_day = None
            entry_price = None
            for w in range(1, wait_days + 1):
                wi = i + w
                if wi >= len(stock):
                    break
                day = stock.iloc[wi]
                # 回調條件：日內低點觸及信號日收盤 * (1 + pullback_pct)
                # 且收盤仍站在 MA10 之上（不是真的崩盤）
                pullback_target = signal_close * (1 + pullback_pct)
                if day['low'] <= pullback_target:
                    # 以 pullback_target 或收盤（取較低者）作為進場價
                    entry_price = min(pullback_target, day['close'])
                    if pd.notna(day['ma10']) and entry_price >= day['ma10'] * 0.98:
                        entry_day = wi
                        break

            if entry_day is None:
                continue

            # === 持有期間追蹤 ===
            exit_day = None
            exit_price = None
            exit_reason = 'max_hold'

            for h in range(1, max_hold + 1):
                hi = entry_day + h
                if hi >= len(stock):
                    break
                hday = stock.iloc[hi]
                ret = (hday['close'] - entry_price) / entry_price

                # 止損
                if ret <= stop_loss:
                    exit_day = hi
                    exit_price = hday['close']
                    exit_reason = 'stop_loss'
                    break

                # 止盈
                if ret >= take_profit:
                    exit_day = hi
                    exit_price = hday['close']
                    exit_reason = 'take_profit'
                    break

                # 跌破 MA10 止損
                if pd.notna(hday['ma10']) and hday['close'] < hday['ma10'] * 0.98:
                    exit_day = hi
                    exit_price = hday['close']
                    exit_reason = 'break_ma10'
                    break

            if exit_day is None:
                # 到期出場
                exit_day = min(entry_day + max_hold, len(stock) - 1)
                exit_price = stock.iloc[exit_day]['close']

            final_return = (exit_price - entry_price) / entry_price * 100

            all_trades.append({
                'symbol': sym,
                'signal_date': stock.iloc[i]['date'].strftime('%Y-%m-%d'),
                'entry_date': stock.iloc[entry_day]['date'].strftime('%Y-%m-%d'),
                'exit_date': stock.iloc[exit_day]['date'].strftime('%Y-%m-%d'),
                'entry_price': round(entry_price, 2),
                'exit_price': round(exit_price, 2),
                'return_pct': round(final_return, 2),
                'hold_days': exit_day - entry_day,
                'exit_reason': exit_reason,
                'six_score': six['score'],
                'surge_score': surge['total'],
                'surge_grade': surge['grade'],
            })

            cooldown = max_hold  # 冷卻期

    trades_df = pd.DataFrame(all_trades)
    if len(trades_df) == 0:
        print("⚠ 無交易")
        return {'trades': 0}

    win = trades_df[trades_df['return_pct'] > 0]
    loss = trades_df[trades_df['return_pct'] <= 0]

    stats = {
        'total_trades': len(trades_df),
        'win_rate': round(len(win) / len(trades_df) * 100, 1),
        'avg_return': round(trades_df['return_pct'].mean(), 2),
        'median_return': round(trades_df['return_pct'].median(), 2),
        'avg_win': round(win['return_pct'].mean(), 2) if len(win) > 0 else 0,
        'avg_loss': round(loss['return_pct'].mean(), 2) if len(loss) > 0 else 0,
        'max_win': round(trades_df['return_pct'].max(), 2),
        'max_loss': round(trades_df['return_pct'].min(), 2),
        'avg_hold_days': round(trades_df['hold_days'].mean(), 1),
        'profit_factor': round(abs(win['return_pct'].sum()) / abs(loss['return_pct'].sum()), 2) if len(loss) > 0 and loss['return_pct'].sum() != 0 else float('inf'),
    }

    # 出場原因統計
    exit_counts = trades_df['exit_reason'].value_counts().to_dict()

    print(f"\n📊 回調買入策略結果 ({market})")
    print(f"  交易次數: {stats['total_trades']}")
    print(f"  勝率:     {stats['win_rate']}%")
    print(f"  平均報酬: {stats['avg_return']}%")
    print(f"  中位報酬: {stats['median_return']}%")
    print(f"  平均獲利: {stats['avg_win']}%  平均虧損: {stats['avg_loss']}%")
    print(f"  最大獲利: {stats['max_win']}%  最大虧損: {stats['max_loss']}%")
    print(f"  盈虧比:   {stats['profit_factor']}")
    print(f"  平均持有: {stats['avg_hold_days']} 天")
    print(f"  出場原因: {exit_counts}")

    # 按 surge grade 分析
    print(f"\n  按飆股等級:")
    for g in ['S', 'A', 'B', 'C', 'D']:
        gt = trades_df[trades_df['surge_grade'] == g]
        if len(gt) >= 2:
            print(f"    {g}: {len(gt)}次, 勝率={len(gt[gt['return_pct']>0])/len(gt)*100:.0f}%, 均報={gt['return_pct'].mean():.2f}%")

    return stats


if __name__ == '__main__':
    tw_csv = os.path.join(DATA_DIR, 'tw_stocks.csv')

    configs = [
        # 策略A: 回調買入，寬鬆
        {'min_score': 4, 'min_surge': 0, 'pullback_pct': -0.02, 'stop_loss': -0.05, 'take_profit': 0.10, 'label': 'A: 4分 回調-2%'},
        # 策略B: 回調買入，精選
        {'min_score': 5, 'min_surge': 50, 'pullback_pct': -0.02, 'stop_loss': -0.05, 'take_profit': 0.10, 'label': 'B: 5分+surge50 回調-2%'},
        # 策略C: 更深回調
        {'min_score': 4, 'min_surge': 0, 'pullback_pct': -0.03, 'stop_loss': -0.05, 'take_profit': 0.10, 'label': 'C: 4分 回調-3%'},
        # 策略D: 嚴格止損
        {'min_score': 4, 'min_surge': 0, 'pullback_pct': -0.02, 'stop_loss': -0.03, 'take_profit': 0.08, 'label': 'D: 4分 止損-3%'},
        # 策略E: 寬止盈
        {'min_score': 4, 'min_surge': 0, 'pullback_pct': -0.02, 'stop_loss': -0.05, 'take_profit': 0.15, 'label': 'E: 4分 止盈15%'},
        # 策略F: 突破日直接買（對照組）
        {'min_score': 5, 'min_surge': 50, 'pullback_pct': 0.0, 'stop_loss': -0.05, 'take_profit': 0.10, 'label': 'F: 5分+surge50 突破當日買'},
    ]

    print("\n" + "="*70)
    print("=== 回調買入策略比較 ===")
    print("="*70)

    results = []
    for cfg in configs:
        r = backtest_pullback(
            tw_csv, 'TW',
            min_score=cfg['min_score'],
            min_surge=cfg['min_surge'],
            pullback_pct=cfg['pullback_pct'],
            stop_loss=cfg['stop_loss'],
            take_profit=cfg['take_profit'],
        )
        r['label'] = cfg['label']
        results.append(r)

    print("\n\n" + "="*70)
    print("=== 策略比較總表 ===")
    print("="*70)
    print(f"{'策略':<30} {'交易數':>6} {'勝率':>6} {'均報':>6} {'盈虧比':>6} {'均持天':>6}")
    print("-" * 70)
    for r in results:
        if r.get('total_trades', 0) == 0:
            print(f"{r['label']:<30} {'0':>6}")
            continue
        print(f"{r['label']:<30} {r['total_trades']:>6} {r['win_rate']:>5}% {r['avg_return']:>5}% {r['profit_factor']:>6} {r['avg_hold_days']:>5}d")
