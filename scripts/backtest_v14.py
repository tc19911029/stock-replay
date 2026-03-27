#!/usr/bin/env python3
"""
Iteration 14: 在 V13a 基礎上繼續優化
V13a: MA5↑MA20 + MA20↑ + 量1.2x + 紅K + BB%B<1.2 + MACD>0 + 未連漲3天
→ 70.0% 勝率, +3.46% 均報, 2.92 盈虧比 (30次交易)

新嘗試方向:
1. 動態出場: MACD 轉負時出場
2. 更嚴格的進場過濾
3. 出場優化: 不同的追蹤止損啟動門檻
4. 結合多個之前有效的過濾器
5. 擴展數據到CN市場
"""

import os
import numpy as np
import pandas as pd
from datetime import datetime
from backtest_v5 import LOG_PATH
from backtest_strategy import compute_indicators, DATA_DIR


def run_strategy_v14(df_all, strategy_fn, stop_loss, take_profit, trailing_stop,
                     max_hold, cooldown_days=10, trailing_activation=0.02,
                     dynamic_exit_fn=None):
    """Enhanced backtest framework with dynamic exit support."""
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

            # Next day open buy
            entry_price = stock.iloc[i + 1]['open']
            entry_day = i + 1

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
                if trailing_stop and ret > trailing_activation and ret_peak <= trailing_stop:
                    exit_day = hi; exit_price = hd['close']; exit_reason = 'trailing'; break

                # Dynamic exit
                if dynamic_exit_fn and h >= 3:
                    if dynamic_exit_fn(stock, hi, entry_price):
                        exit_day = hi; exit_price = hd['close']; exit_reason = 'dynamic'; break

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
        return {'trades': 0, 'win_rate': 0, 'avg_return': 0, 'profit_factor': 0, 'total_return': 0}

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
        'exit_reasons': dict(tdf['exit_reason'].value_counts()),
        'avg_hold': round(tdf['hold_days'].mean(), 1),
    }


# ══════════════════════════════════════════════════════════════════════════
# V13a base (best so far)
# ══════════════════════════════════════════════════════════════════════════

def v13a_base(stock, i):
    """V13a: MA5↑MA20 + MA20↑ + 量1.2x + 紅K + BB%B<1.2 + MACD>0 + 未連漲3天"""
    r = stock.iloc[i]
    if i < 3: return False
    prev = stock.iloc[i-1]
    if not all(pd.notna([r.get('ma5'), r.get('ma20'), prev.get('ma5'), prev.get('ma20')])): return False
    if not (prev['ma5'] <= prev['ma20'] and r['ma5'] > r['ma20']): return False
    if r['ma20'] <= prev['ma20']: return False
    if not pd.notna(r.get('avg_vol5')) or r['avg_vol5'] <= 0: return False
    if r['volume'] / r['avg_vol5'] < 1.2: return False
    if r['close'] <= r['open']: return False
    if not pd.notna(r.get('bb_pctb')) or r['bb_pctb'] >= 1.2: return False
    if not pd.notna(r.get('macd_osc')) or r['macd_osc'] <= 0: return False
    consec = sum(1 for j in range(i-3, i) if stock.iloc[j]['close'] > stock.iloc[j]['open'])
    if consec >= 3: return False
    return True


# ══════════════════════════════════════════════════════════════════════════
# New entry filters
# ══════════════════════════════════════════════════════════════════════════

def v14a(stock, i):
    """V14a: V13a + 收高位>0.7 (combines best of V13a + V13e)"""
    if not v13a_base(stock, i): return False
    r = stock.iloc[i]
    return pd.notna(r.get('close_pos')) and r['close_pos'] > 0.7

def v14b(stock, i):
    """V14b: V13a + 價格在MA60之上 (macro uptrend)"""
    if not v13a_base(stock, i): return False
    r = stock.iloc[i]
    return pd.notna(r.get('ma60')) and r['close'] > r['ma60']

def v14c(stock, i):
    """V14c: V13a + 價格在MA60之上 + 收高位>0.6"""
    if not v13a_base(stock, i): return False
    r = stock.iloc[i]
    if not pd.notna(r.get('ma60')) or r['close'] <= r['ma60']: return False
    return pd.notna(r.get('close_pos')) and r['close_pos'] > 0.6

def v14d(stock, i):
    """V14d: V13a + KD金叉 or K>D"""
    if not v13a_base(stock, i): return False
    r = stock.iloc[i]
    return pd.notna(r.get('kd_k')) and pd.notna(r.get('kd_d')) and r['kd_k'] > r['kd_d']

def v14e(stock, i):
    """V14e: V13a + MACD_DIF > 0 (longer-term momentum)"""
    if not v13a_base(stock, i): return False
    r = stock.iloc[i]
    return pd.notna(r.get('macd_dif')) and r['macd_dif'] > 0

def v14f(stock, i):
    """V14f: V13a + 上影線<15% (no selling pressure)"""
    if not v13a_base(stock, i): return False
    r = stock.iloc[i]
    return pd.notna(r.get('upper_shadow')) and r['upper_shadow'] < 0.15

def v14g(stock, i):
    """V14g: V13a + 實體>1.5% (stronger candle)"""
    if not v13a_base(stock, i): return False
    r = stock.iloc[i]
    return pd.notna(r.get('body_pct')) and r['body_pct'] > 0.015

def v14h(stock, i):
    """V14h: V13a + ROC20>0 (positive 20-day momentum)"""
    if not v13a_base(stock, i): return False
    r = stock.iloc[i]
    return pd.notna(r.get('roc20')) and r['roc20'] > 0

def v14i(stock, i):
    """V14i: V13a + MA60↑ (long-term trend rising)"""
    if not v13a_base(stock, i): return False
    r = stock.iloc[i]
    if i < 1: return True
    prev = stock.iloc[i-1]
    return pd.notna(r.get('ma60')) and pd.notna(prev.get('ma60')) and r['ma60'] > prev['ma60']

def v14j(stock, i):
    """V14j: V13a + BB%B 0.5-1.0 (tighter band)"""
    if not v13a_base(stock, i): return False
    r = stock.iloc[i]
    return 0.5 <= r['bb_pctb'] <= 1.0

def v14k(stock, i):
    """V14k: V13a + 量>=1.5x + 收高位>0.6"""
    if not v13a_base(stock, i): return False
    r = stock.iloc[i]
    if r['volume'] / r['avg_vol5'] < 1.5: return False
    return pd.notna(r.get('close_pos')) and r['close_pos'] > 0.6

def v14_combo1(stock, i):
    """V14 combo1: V13a + MA60↑ + 收高位>0.6 + 上影線<20%"""
    if not v13a_base(stock, i): return False
    r = stock.iloc[i]
    if i < 1: return False
    prev = stock.iloc[i-1]
    if not pd.notna(r.get('ma60')) or not pd.notna(prev.get('ma60')): return False
    if r['ma60'] <= prev['ma60']: return False
    if not pd.notna(r.get('close_pos')) or r['close_pos'] <= 0.6: return False
    if not pd.notna(r.get('upper_shadow')) or r['upper_shadow'] >= 0.2: return False
    return True

def v14_combo2(stock, i):
    """V14 combo2: V13a + KD K>D + 收高位>0.6"""
    if not v13a_base(stock, i): return False
    r = stock.iloc[i]
    if not (pd.notna(r.get('kd_k')) and pd.notna(r.get('kd_d')) and r['kd_k'] > r['kd_d']): return False
    return pd.notna(r.get('close_pos')) and r['close_pos'] > 0.6


# ══════════════════════════════════════════════════════════════════════════
# Dynamic exit functions
# ══════════════════════════════════════════════════════════════════════════

def exit_macd_negative(stock, hi, entry_price):
    """Exit when MACD histogram turns negative (momentum loss)"""
    r = stock.iloc[hi]
    ret = (r['close'] - entry_price) / entry_price
    # Only apply if we're at profit or small loss
    if ret > -0.02 and pd.notna(r.get('macd_osc')) and r['macd_osc'] < 0:
        return True
    return False

def exit_below_ma5(stock, hi, entry_price):
    """Exit when close falls below MA5"""
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

    # Also test CN market
    cn_csv = os.path.join(DATA_DIR, 'cn_stocks.csv')
    has_cn = os.path.exists(cn_csv)
    if has_cn:
        df_cn = pd.read_csv(cn_csv)
        df_cn['date'] = pd.to_datetime(df_cn['date'])
        print(f"CN Data: {df_cn['symbol'].nunique()} stocks, {len(df_cn)} rows")

    strategies = [
        ('V13a基線', v13a_base),
        ('V14a: +收高位>0.7', v14a),
        ('V14b: +價>MA60', v14b),
        ('V14c: +價>MA60+收高>0.6', v14c),
        ('V14d: +KD K>D', v14d),
        ('V14e: +MACD_DIF>0', v14e),
        ('V14f: +上影<15%', v14f),
        ('V14g: +實體>1.5%', v14g),
        ('V14h: +ROC20>0', v14h),
        ('V14i: +MA60↑', v14i),
        ('V14j: +BB%B 0.5-1.0', v14j),
        ('V14k: +量1.5x+收高>0.6', v14k),
        ('V14 combo1: +MA60↑+收高+無影', v14_combo1),
        ('V14 combo2: +KD+收高>0.6', v14_combo2),
    ]

    sl_configs = [
        {'stop_loss': -0.07, 'take_profit': 0.15, 'trailing_stop': -0.04, 'max_hold': 20,
         'trailing_activation': 0.02, 'label': '止7盈15追4啟2%'},
        {'stop_loss': -0.07, 'take_profit': 0.15, 'trailing_stop': -0.03, 'max_hold': 20,
         'trailing_activation': 0.03, 'label': '止7盈15追3啟3%'},
        {'stop_loss': -0.06, 'take_profit': 0.12, 'trailing_stop': -0.03, 'max_hold': 15,
         'trailing_activation': 0.02, 'label': '止6盈12追3持15'},
        {'stop_loss': -0.05, 'take_profit': 0.10, 'trailing_stop': -0.025, 'max_hold': 12,
         'trailing_activation': 0.015, 'label': '止5盈10追2.5持12'},
    ]

    # Also test dynamic exit on baseline
    dynamic_exits = [
        (None, '無動態出場'),
        (exit_macd_negative, 'MACD轉負出場'),
        (exit_below_ma5, '跌破MA5出場'),
    ]

    results = []

    # Part 1: Test all entry filters with best exit config
    print("\n" + "=" * 100)
    print("Part 1: Entry filter comparison (止7盈15追4啟2%)")
    print("=" * 100)

    sl = sl_configs[0]
    for s_name, s_fn in strategies:
        label = f"{s_name} | {sl['label']}"
        r = run_strategy_v14(df_all, s_fn,
                             stop_loss=sl['stop_loss'], take_profit=sl['take_profit'],
                             trailing_stop=sl['trailing_stop'], max_hold=sl['max_hold'],
                             trailing_activation=sl['trailing_activation'])
        r['label'] = label
        results.append(r)

    # Part 2: Test dynamic exits on V13a baseline
    print("\n" + "=" * 100)
    print("Part 2: Dynamic exit tests on V13a")
    print("=" * 100)

    for exit_fn, exit_name in dynamic_exits:
        for sl in sl_configs[:2]:
            label = f"V13a+{exit_name} | {sl['label']}"
            r = run_strategy_v14(df_all, v13a_base,
                                 stop_loss=sl['stop_loss'], take_profit=sl['take_profit'],
                                 trailing_stop=sl['trailing_stop'], max_hold=sl['max_hold'],
                                 trailing_activation=sl['trailing_activation'],
                                 dynamic_exit_fn=exit_fn)
            r['label'] = label
            results.append(r)

    # Part 3: Best entry filters with all exit configs
    print("\n" + "=" * 100)
    print("Part 3: Best filters × exit configs")
    print("=" * 100)

    top_entries = [
        ('V14a: +收高位>0.7', v14a),
        ('V14c: +價>MA60+收高>0.6', v14c),
        ('V14 combo1: +MA60↑+收高+無影', v14_combo1),
        ('V14 combo2: +KD+收高>0.6', v14_combo2),
    ]

    for s_name, s_fn in top_entries:
        for sl in sl_configs:
            label = f"{s_name} | {sl['label']}"
            r = run_strategy_v14(df_all, s_fn,
                                 stop_loss=sl['stop_loss'], take_profit=sl['take_profit'],
                                 trailing_stop=sl['trailing_stop'], max_hold=sl['max_hold'],
                                 trailing_activation=sl['trailing_activation'])
            r['label'] = label
            results.append(r)

    # Print sorted results
    print("\n\n" + "=" * 110)
    print("=== ALL RESULTS (sorted by win_rate) ===")
    print("=" * 110)
    print(f"{'Strategy':<55} {'Trades':>6} {'WinR':>6} {'AvgR':>6} {'AvgW':>6} {'AvgL':>6} {'PF':>5} {'Total':>7} {'Hold':>5}")
    print("-" * 110)

    valid_results = [r for r in results if r.get('trades', 0) >= 5]
    for r in sorted(valid_results, key=lambda x: (x.get('win_rate', 0), x.get('avg_return', 0)), reverse=True)[:30]:
        print(f"{r['label']:<55} {r['trades']:>6} {r['win_rate']:>5}% {r['avg_return']:>5}% "
              f"{r.get('avg_win',0):>5}% {r.get('avg_loss',0):>5}% {r['profit_factor']:>5} "
              f"{r['total_return']:>6}% {r.get('avg_hold',''):>5}")

    # Best by win rate (min 10 trades)
    valid10 = [r for r in results if r.get('trades', 0) >= 10]
    if valid10:
        best_wr = max(valid10, key=lambda x: x['win_rate'])
        print(f"\n{'='*80}")
        print(f"BEST WIN RATE (>=10 trades): {best_wr['label']}")
        print(f"  Trades={best_wr['trades']}, WinRate={best_wr['win_rate']}%, "
              f"AvgReturn={best_wr['avg_return']}%, PF={best_wr['profit_factor']}, "
              f"Total={best_wr['total_return']}%")
        if best_wr.get('exit_reasons'):
            print(f"  Exit reasons: {best_wr['exit_reasons']}")

    # Best by score (win_rate * avg_return, min 10 trades)
    if valid10:
        best_score = max(valid10, key=lambda x: x['win_rate'] * max(x['avg_return'], 0.01))
        if best_score != best_wr:
            print(f"\nBEST SCORE (WR*AvgR, >=10 trades): {best_score['label']}")
            print(f"  Trades={best_score['trades']}, WinRate={best_score['win_rate']}%, "
                  f"AvgReturn={best_score['avg_return']}%, PF={best_score['profit_factor']}")

    # Best with min 5 trades (for high selectivity strategies)
    valid5 = [r for r in results if r.get('trades', 0) >= 5]
    if valid5:
        best5 = max(valid5, key=lambda x: x['win_rate'])
        if best5['trades'] < 10:
            print(f"\nBEST WIN RATE (>=5 trades): {best5['label']}")
            print(f"  Trades={best5['trades']}, WinRate={best5['win_rate']}%, "
                  f"AvgReturn={best5['avg_return']}%, PF={best5['profit_factor']}")

    # Write to log
    with open(LOG_PATH, 'a') as f:
        f.write(f"\n## Iteration 14: V13a 進階優化 ({datetime.now().strftime('%Y-%m-%d %H:%M')})\n")
        f.write(f"- **基礎**: V13a (MA5↑MA20+MACD>0+BB%B<1.2+未連漲3天) — 70.0%勝率, 3.46%均報\n")
        f.write(f"- **測試**: {len(strategies)} 進場策略 × {len(sl_configs)} 止損配置 + 動態出場\n")

        if valid10:
            f.write(f"- **最高勝率(>=10)**: {best_wr['label']}\n")
            f.write(f"  - {best_wr['trades']}次, 勝率={best_wr['win_rate']}%, 均報={best_wr['avg_return']}%, 盈虧比={best_wr['profit_factor']}\n")

        if valid5:
            best5 = max(valid5, key=lambda x: x['win_rate'])
            f.write(f"- **最高勝率(>=5)**: {best5['label']}\n")
            f.write(f"  - {best5['trades']}次, 勝率={best5['win_rate']}%, 均報={best5['avg_return']}%, 盈虧比={best5['profit_factor']}\n")

        # Top 5
        top5 = sorted(valid_results, key=lambda x: (x['win_rate'], x['avg_return']), reverse=True)[:5]
        f.write(f"- **Top 5**:\n")
        for idx, t in enumerate(top5):
            f.write(f"  {idx+1}. {t['label']}: {t['trades']}次, 勝率={t['win_rate']}%, 均報={t['avg_return']}%, 盈虧={t['profit_factor']}\n")
        f.write(f"\n---\n")

    print("\n✅ Results written to OPTIMIZATION_LOG.md")
