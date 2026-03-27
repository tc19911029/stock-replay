#!/usr/bin/env python3
"""
策略 V5-V10：持續迭代優化框架

核心思路轉變：
- 不再用六大條件（追突破 ~50% 勝率）
- 改用「動量+突破+量能」三重確認
- 重點是找到正確的「指標組合 + 止損止盈」配置

每輪迭代自動記錄到 OPTIMIZATION_LOG.md
"""

import os
import sys
import json
import numpy as np
import pandas as pd
from datetime import datetime
from backtest_strategy import compute_indicators, DATA_DIR

PROJ_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOG_PATH = os.path.join(PROJ_DIR, 'OPTIMIZATION_LOG.md')


def run_strategy(df_all, strategy_fn, stop_loss, take_profit, trailing_stop, max_hold, cooldown_days=10):
    """通用回測框架"""
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

            # 隔日開盤買入
            entry_price = stock.iloc[i + 1]['open']
            entry_day = i + 1

            # 追蹤止損
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
                if trailing_stop and ret > 0.02 and ret_peak <= trailing_stop:
                    exit_day = hi; exit_price = hd['close']; exit_reason = 'trailing'; break

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
        return {'trades': 0, 'win_rate': 0, 'avg_return': 0, 'profit_factor': 0}

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
    }


# ══════════════════════════════════════════════════════════════════════════════
# 策略定義
# ══════════════════════════════════════════════════════════════════════════════

def strategy_baseline(stock, i):
    """基線：六大條件 >= 4"""
    from backtest_strategy import evaluate_six_conditions
    six = evaluate_six_conditions(stock, i)
    return six['score'] >= 4

def strategy_momentum_breakout(stock, i):
    """V5: 動量突破 — ROC20>10% + 突破20日高 + 量>1.5x + MA20↑"""
    r = stock.iloc[i]
    if not all(pd.notna([r.get('roc20'), r.get('ma20'), r.get('avg_vol5'), r.get('high20')])):
        return False
    if r['roc20'] <= 10: return False                   # 20日動量 > 10%
    if r['close'] <= r.get('high20', 999999): return False  # 突破20日高
    if r['avg_vol5'] <= 0 or r['volume'] / r['avg_vol5'] < 1.5: return False  # 量增
    if i < 1 or not pd.notna(stock.iloc[i-1].get('ma20')): return False
    if r['ma20'] <= stock.iloc[i-1]['ma20']: return False  # MA20 向上
    if r['close'] <= r.get('ma20', 0): return False        # 價 > MA20
    return True

def strategy_rsi_reversal(stock, i):
    """V6: RSI 低位反轉 — RSI從<35回升到>40 + 價>MA10 + 量增"""
    r = stock.iloc[i]
    if i < 3: return False
    if not pd.notna(r.get('rsi14')): return False
    prev_rsi = stock.iloc[i-3].get('rsi14')
    if not pd.notna(prev_rsi): return False
    if not (prev_rsi < 35 and r['rsi14'] > 40): return False  # RSI 從超賣區回升
    if not pd.notna(r.get('ma10')) or r['close'] < r['ma10']: return False  # 價>MA10
    if not pd.notna(r.get('avg_vol5')) or r['avg_vol5'] <= 0: return False
    if r['volume'] / r['avg_vol5'] < 1.2: return False  # 量增
    return True

def strategy_bb_squeeze(stock, i):
    """V7: BB壓縮突破 — 帶寬低點後突破上軌 + 量增"""
    r = stock.iloc[i]
    if i < 20 or not pd.notna(r.get('bb_bandwidth')): return False
    # 近20天帶寬最低
    bws = [stock.iloc[j].get('bb_bandwidth') for j in range(i-20, i) if pd.notna(stock.iloc[j].get('bb_bandwidth'))]
    if len(bws) < 10: return False
    min_bw = min(bws)
    # 近5天內曾達到20天帶寬低點（壓縮期）
    recent_squeeze = any(stock.iloc[j].get('bb_bandwidth', 999) <= min_bw * 1.1 for j in range(max(0,i-5), i))
    if not recent_squeeze: return False
    # 今天突破上軌
    if not pd.notna(r.get('bb_upper')) or r['close'] <= r['bb_upper']: return False
    # 量增
    if not pd.notna(r.get('avg_vol5')) or r['avg_vol5'] <= 0: return False
    if r['volume'] / r['avg_vol5'] < 1.3: return False
    return True

def strategy_ma_golden_cross(stock, i):
    """V8: 均線黃金交叉 — MA5 剛上穿 MA20 + MA20向上 + 量增"""
    r = stock.iloc[i]
    if i < 1: return False
    prev = stock.iloc[i-1]
    if not all(pd.notna([r.get('ma5'), r.get('ma20'), prev.get('ma5'), prev.get('ma20')])): return False
    # MA5 剛上穿 MA20
    if not (prev['ma5'] <= prev['ma20'] and r['ma5'] > r['ma20']): return False
    # MA20 向上
    if r['ma20'] <= prev['ma20']: return False
    # 量增
    if not pd.notna(r.get('avg_vol5')) or r['avg_vol5'] <= 0: return False
    if r['volume'] / r['avg_vol5'] < 1.2: return False
    # 紅K
    if r['close'] <= r['open']: return False
    return True

def strategy_volume_explosion(stock, i):
    """V9: 爆量突破 — 量>3x均量 + 大紅K(>3%) + 突破前高 + RSI<75"""
    r = stock.iloc[i]
    if not all(pd.notna([r.get('avg_vol5'), r.get('rsi14')])): return False
    if r['avg_vol5'] <= 0: return False
    if r['volume'] / r['avg_vol5'] < 3.0: return False  # 3倍量
    if r['close'] <= r['open']: return False  # 紅K
    body = (r['close'] - r['open']) / r['open']
    if body < 0.03: return False  # 實體 > 3%
    if r['rsi14'] > 75: return False  # 不超買
    # 突破5日高
    if i < 5: return False
    high5 = max(stock.iloc[j]['high'] for j in range(i-5, i))
    if r['close'] <= high5: return False
    return True

def strategy_combined_best(stock, i):
    """V10: 綜合最佳 — 結合前幾輪最有效的元素"""
    r = stock.iloc[i]
    if i < 20: return False
    # 必要：MA20向上 + 價>MA20
    if not pd.notna(r.get('ma20')) or r['close'] <= r['ma20']: return False
    if i < 1 or not pd.notna(stock.iloc[i-1].get('ma20')): return False
    if r['ma20'] <= stock.iloc[i-1]['ma20']: return False
    # 必要：紅K
    if r['close'] <= r['open']: return False
    # 必要：量增 ≥ 1.5x
    if not pd.notna(r.get('avg_vol5')) or r['avg_vol5'] <= 0: return False
    if r['volume'] / r['avg_vol5'] < 1.5: return False
    # 至少一個額外確認（突破 OR BB%B>0.8 OR RSI回升）
    extra = 0
    if pd.notna(r.get('high20')) and r['close'] > r['high20']: extra += 1
    if pd.notna(r.get('bb_pctb')) and r['bb_pctb'] > 0.8: extra += 1
    if pd.notna(r.get('rsi14')) and 45 <= r['rsi14'] <= 70: extra += 1
    if pd.notna(r.get('roc20')) and r['roc20'] > 5: extra += 1
    return extra >= 2


# ══════════════════════════════════════════════════════════════════════════════
# 主程序：自動迭代
# ══════════════════════════════════════════════════════════════════════════════

if __name__ == '__main__':
    tw_csv = os.path.join(DATA_DIR, 'tw_stocks.csv')
    if not os.path.exists(tw_csv):
        print("❌ 找不到 tw_stocks.csv"); sys.exit(1)

    df_all = pd.read_csv(tw_csv)
    df_all['date'] = pd.to_datetime(df_all['date'])
    print(f"數據: {df_all['symbol'].nunique()} 支股票, {len(df_all)} 筆")

    strategies = [
        ('V5: 動量突破(ROC20>10%+突破+量)', strategy_momentum_breakout),
        ('V6: RSI低位反轉(RSI<35→>40)', strategy_rsi_reversal),
        ('V7: BB壓縮突破', strategy_bb_squeeze),
        ('V8: 均線黃金交叉(MA5↑MA20)', strategy_ma_golden_cross),
        ('V9: 爆量突破(3x量+大紅K)', strategy_volume_explosion),
        ('V10: 綜合最佳(MA20↑+量+2確認)', strategy_combined_best),
    ]

    # 止損止盈配置也要測試
    sl_configs = [
        {'stop_loss': -0.05, 'take_profit': 0.10, 'trailing_stop': -0.03, 'max_hold': 10, 'label': '止5%盈10%追3%持10天'},
        {'stop_loss': -0.07, 'take_profit': 0.15, 'trailing_stop': -0.04, 'max_hold': 20, 'label': '止7%盈15%追4%持20天'},
        {'stop_loss': -0.05, 'take_profit': 0.20, 'trailing_stop': -0.05, 'max_hold': 30, 'label': '止5%盈20%追5%持30天'},
    ]

    best_result = None
    best_label = ''
    all_results = []

    for s_name, s_fn in strategies:
        for sl in sl_configs:
            label = f"{s_name} | {sl['label']}"
            print(f"\n{'='*60}")
            print(f"  {label}")
            print(f"{'='*60}")

            r = run_strategy(df_all, s_fn,
                             stop_loss=sl['stop_loss'],
                             take_profit=sl['take_profit'],
                             trailing_stop=sl['trailing_stop'],
                             max_hold=sl['max_hold'])
            r['label'] = label
            all_results.append(r)

            if r['trades'] > 0:
                print(f"  交易: {r['trades']}, 勝率: {r['win_rate']}%, 均報: {r['avg_return']}%, 盈虧比: {r['profit_factor']}, 累計: {r['total_return']}%")
            else:
                print(f"  無交易")

            # 追蹤最佳（以 win_rate * avg_return 為綜合指標，同時要求至少 20 筆交易）
            if r['trades'] >= 20:
                score = r['win_rate'] * max(r['avg_return'], 0.01)
                if best_result is None or score > best_result.get('_score', 0):
                    r['_score'] = score
                    best_result = r
                    best_label = label

    # 排序輸出
    print("\n\n" + "=" * 100)
    print("=== 全部策略比較（按勝率排序）===")
    print("=" * 100)
    print(f"{'策略':<55} {'交易':>5} {'勝率':>6} {'均報':>6} {'均贏':>6} {'均虧':>6} {'盈虧':>5} {'累計':>7}")
    print("-" * 100)
    for r in sorted(all_results, key=lambda x: x.get('win_rate', 0), reverse=True):
        if r.get('trades', 0) == 0:
            continue
        print(f"{r['label']:<55} {r['trades']:>5} {r['win_rate']:>5}% {r['avg_return']:>5}% {r.get('avg_win',0):>5}% {r.get('avg_loss',0):>5}% {r['profit_factor']:>5} {r['total_return']:>6}%")

    if best_result:
        print(f"\n🏆 最佳策略: {best_label}")
        print(f"   勝率: {best_result['win_rate']}%, 均報: {best_result['avg_return']}%, 盈虧比: {best_result['profit_factor']}")

    # 寫入 log
    with open(LOG_PATH, 'a') as f:
        f.write(f"\n## Iteration 5-10: 全新策略搜索 ({datetime.now().strftime('%Y-%m-%d %H:%M')})\n")
        f.write(f"- **測試**: 6 種策略 × 3 種止損配置 = 18 種組合\n")
        f.write(f"- **策略類型**:\n")
        f.write(f"  - V5: 動量突破（ROC20>10% + 突破20日高 + 量增 + MA20↑）\n")
        f.write(f"  - V6: RSI低位反轉（RSI從<35回升到>40 + 價>MA10 + 量增）\n")
        f.write(f"  - V7: BB壓縮突破（帶寬低點後突破上軌 + 量增）\n")
        f.write(f"  - V8: 均線黃金交叉（MA5剛上穿MA20 + MA20↑ + 量增 + 紅K）\n")
        f.write(f"  - V9: 爆量突破（3x量 + 大紅K>3% + 突破前高 + RSI<75）\n")
        f.write(f"  - V10: 綜合最佳（MA20↑ + 量1.5x + 至少2個額外確認）\n")
        f.write(f"- **止損配置**: 止5%盈10%追3%持10天 / 止7%盈15%追4%持20天 / 止5%盈20%追5%持30天\n\n")

        f.write(f"### 前5名結果\n")
        top5 = sorted([r for r in all_results if r.get('trades', 0) >= 10],
                       key=lambda x: x.get('win_rate', 0), reverse=True)[:5]
        for i, r in enumerate(top5):
            f.write(f"{i+1}. **{r['label']}**: {r['trades']}次, 勝率={r['win_rate']}%, 均報={r['avg_return']}%, 盈虧比={r['profit_factor']}\n")

        if best_result:
            f.write(f"\n### 🏆 最佳策略\n")
            f.write(f"- {best_label}\n")
            f.write(f"- 勝率: {best_result['win_rate']}%, 均報: {best_result['avg_return']}%, 盈虧比: {best_result['profit_factor']}\n")
            f.write(f"- 累計報酬: {best_result['total_return']}%\n")

        f.write(f"\n---\n")

    print("\n✅ 結果已寫入 OPTIMIZATION_LOG.md")
