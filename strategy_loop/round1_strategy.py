"""
Round 1: 均线动量趋势策略 v1
- Universe: 20 liquid A-share stocks
- Entry: EMA20 > EMA60 golden cross + volume surge (>1.5x avg)
- Exit: EMA20 < EMA60 death cross OR 8% trailing stop
- Position: max 5 stocks, equal weight 20%
- Costs: commission 0.025% + stamp tax 0.1% (sell) + slippage 0.1%
- Data: Tencent Stock API (accessible from Taiwan)
"""

import os
for key in list(os.environ.keys()):
    if 'proxy' in key.lower():
        del os.environ[key]

import requests
import pandas as pd
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from datetime import datetime, timedelta
import time
import json
import warnings
warnings.filterwarnings('ignore')

# ============================================================
# TENCENT DAILY KLINE DATA FETCHER
# ============================================================
def fetch_daily_kline_tencent(symbol, num_days=500):
    """Fetch daily kline from Tencent qq stock API (no proxy needed)."""
    # Tencent uses sh/sz prefix
    if symbol.startswith('6'):
        mkt = 'sh'
    else:
        mkt = 'sz'
    code = f"{mkt}{symbol}"

    url = f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"
    params = {
        'param': f'{code},day,,,{num_days},qfq',
        '_var': 'kline_dayqfq',
    }
    session = requests.Session()
    session.trust_env = False
    r = session.get(url, params=params, timeout=15)
    text = r.text

    # Parse JS variable assignment: kline_dayqfq={...}
    json_str = text.split('=', 1)[1] if '=' in text else text
    data = json.loads(json_str)

    stock_data = data.get('data', {}).get(code, {})
    # Try qfqday first, then day
    klines = stock_data.get('qfqday', stock_data.get('day', []))

    if not klines:
        raise ValueError(f"No kline data for {symbol}")

    rows = []
    for k in klines:
        # Format: [date, open, close, high, low, volume, ...]
        if len(k) >= 6:
            rows.append({
                'date': pd.Timestamp(k[0]),
                'open': float(k[1]),
                'close': float(k[2]),
                'high': float(k[3]),
                'low': float(k[4]),
                'volume': float(k[5]) if len(k) > 5 else 0,
            })

    df = pd.DataFrame(rows).set_index('date').sort_index()
    return df

# ============================================================
# CONFIG
# ============================================================
STOCK_UNIVERSE = [
    '600519',  # 贵州茅台
    '000858',  # 五粮液
    '601318',  # 中国平安
    '600036',  # 招商银行
    '000333',  # 美的集团
    '601012',  # 隆基绿能
    '600900',  # 长江电力
    '000001',  # 平安银行
    '601888',  # 中国中免
    '600276',  # 恒瑞医药
    '002714',  # 牧原股份
    '600030',  # 中信证券
    '601166',  # 兴业银行
    '000725',  # 京东方A
    '600809',  # 山西汾酒
    '002594',  # 比亚迪
    '601398',  # 工商银行
    '600585',  # 海螺水泥
    '002475',  # 立讯精密
    '603259',  # 药明康德
]

START_DATE = '2024-01-01'
INITIAL_CAPITAL = 1_000_000
MAX_POSITIONS = 5
POSITION_SIZE = 1.0 / MAX_POSITIONS

# Transaction costs (A-share)
COMMISSION_RATE = 0.00025
STAMP_TAX_RATE = 0.001
SLIPPAGE_RATE = 0.001

# Strategy params
EMA_SHORT = 20
EMA_LONG = 60
VOLUME_MULT = 1.5
TRAILING_STOP_PCT = 0.08

# ============================================================
# DATA LOADING
# ============================================================
print("Loading data from Tencent API...")
all_data = {}
failed = []

for i, symbol in enumerate(STOCK_UNIVERSE):
    try:
        df = fetch_daily_kline_tencent(symbol, num_days=600)

        # Calculate indicators
        df['ema_short'] = df['close'].ewm(span=EMA_SHORT, adjust=False).mean()
        df['ema_long'] = df['close'].ewm(span=EMA_LONG, adjust=False).mean()
        df['vol_ma'] = df['volume'].rolling(window=20).mean()

        all_data[symbol] = df
        print(f"  [{i+1}/{len(STOCK_UNIVERSE)}] {symbol}: {len(df)} rows ({df.index[0].date()} ~ {df.index[-1].date()})")
    except Exception as e:
        failed.append(symbol)
        print(f"  [{i+1}/{len(STOCK_UNIVERSE)}] {symbol}: FAILED - {e}")

    if i < len(STOCK_UNIVERSE) - 1:
        time.sleep(0.3)

print(f"\nLoaded {len(all_data)} stocks, failed: {failed}")

if len(all_data) < 5:
    print("ERROR: Not enough stocks loaded. Exiting.")
    exit(1)

# ============================================================
# BACKTEST ENGINE
# ============================================================
date_sets = [set(df.index) for df in all_data.values()]
common_dates = sorted(set.intersection(*date_sets))
bt_start = pd.Timestamp(START_DATE)
trading_dates = [d for d in common_dates if d >= bt_start]
print(f"\nBacktest period: {trading_dates[0].date()} ~ {trading_dates[-1].date()}")
print(f"Trading days: {len(trading_dates)}")

cash = INITIAL_CAPITAL
positions = {}
portfolio_values = []
trade_log = []

def buy_cost(price, shares):
    notional = price * shares
    commission = max(notional * COMMISSION_RATE, 5)
    slippage = notional * SLIPPAGE_RATE
    return notional + commission + slippage

def sell_proceeds(price, shares):
    notional = price * shares
    commission = max(notional * COMMISSION_RATE, 5)
    stamp_tax = notional * STAMP_TAX_RATE
    slippage = notional * SLIPPAGE_RATE
    return notional - commission - stamp_tax - slippage

for date in trading_dates:
    # ---- Exits ----
    symbols_to_sell = []
    for sym, pos in list(positions.items()):
        df = all_data[sym]
        if date not in df.index:
            continue
        row = df.loc[date]
        pos['peak_price'] = max(pos['peak_price'], row['close'])

        ema_cross_down = row['ema_short'] < row['ema_long']
        drawdown_from_peak = (pos['peak_price'] - row['close']) / pos['peak_price']
        trailing_stop_hit = drawdown_from_peak >= TRAILING_STOP_PCT

        if ema_cross_down or trailing_stop_hit:
            symbols_to_sell.append(sym)
            reason = 'EMA_CROSS' if ema_cross_down else 'STOP'
            proceeds = sell_proceeds(row['close'], pos['shares'])
            cost_basis = buy_cost(pos['entry_price'], pos['shares'])
            pnl = proceeds - cost_basis
            cash += proceeds
            trade_log.append({
                'date': date, 'symbol': sym, 'action': 'SELL',
                'price': row['close'], 'shares': pos['shares'],
                'pnl': pnl, 'reason': reason
            })

    for sym in symbols_to_sell:
        del positions[sym]

    # ---- Entries ----
    if len(positions) < MAX_POSITIONS:
        candidates = []
        for sym, df in all_data.items():
            if sym in positions or date not in df.index:
                continue
            row = df.loc[date]
            idx = df.index.get_loc(date)
            if idx < 1:
                continue
            prev = df.iloc[idx - 1]

            golden_cross = (prev['ema_short'] <= prev['ema_long'] and
                          row['ema_short'] > row['ema_long'])
            vol_surge = (row['volume'] > VOLUME_MULT * row['vol_ma']
                        if pd.notna(row['vol_ma']) and row['vol_ma'] > 0 else False)

            if golden_cross and vol_surge:
                momentum = (row['ema_short'] - row['ema_long']) / row['ema_long']
                candidates.append((sym, momentum, row['close']))

        candidates.sort(key=lambda x: x[1], reverse=True)
        slots = MAX_POSITIONS - len(positions)

        for sym, mom, price in candidates[:slots]:
            total_val = cash + sum(
                all_data[s].loc[date, 'close'] * p['shares']
                for s, p in positions.items() if date in all_data[s].index
            )
            alloc = total_val * POSITION_SIZE
            if alloc < price * 100:
                continue
            shares = int(alloc / price / 100) * 100
            if shares == 0:
                continue
            cost = buy_cost(price, shares)
            if cost > cash:
                continue

            cash -= cost
            positions[sym] = {
                'shares': shares, 'entry_price': price, 'peak_price': price
            }
            trade_log.append({
                'date': date, 'symbol': sym, 'action': 'BUY',
                'price': price, 'shares': shares, 'pnl': 0, 'reason': 'CROSS+VOL'
            })

    # ---- Portfolio value ----
    pos_val = sum(
        all_data[s].loc[date, 'close'] * p['shares']
        for s, p in positions.items() if date in all_data[s].index
    )
    portfolio_values.append({'date': date, 'value': cash + pos_val})

# ============================================================
# METRICS
# ============================================================
pv = pd.DataFrame(portfolio_values).set_index('date')
pv['returns'] = pv['value'].pct_change()

total_days = (pv.index[-1] - pv.index[0]).days
total_return = pv['value'].iloc[-1] / pv['value'].iloc[0] - 1
annual_return = (1 + total_return) ** (365 / total_days) - 1 if total_days > 0 else 0

pv['peak'] = pv['value'].cummax()
pv['drawdown'] = (pv['value'] - pv['peak']) / pv['peak']
max_drawdown = pv['drawdown'].min()

rf_daily = 0.02 / 252
excess = pv['returns'].dropna() - rf_daily
sharpe = excess.mean() / excess.std() * np.sqrt(252) if excess.std() > 0 else 0

trades_df = pd.DataFrame(trade_log) if trade_log else pd.DataFrame()
if len(trades_df) > 0:
    sells = trades_df[trades_df['action'] == 'SELL']
    total_trades = len(sells)
    win_rate = len(sells[sells['pnl'] > 0]) / total_trades if total_trades > 0 else 0
    avg_win = sells[sells['pnl'] > 0]['pnl'].mean() if len(sells[sells['pnl'] > 0]) > 0 else 0
    avg_loss = abs(sells[sells['pnl'] <= 0]['pnl'].mean()) if len(sells[sells['pnl'] <= 0]) > 0 else 1
    pl_ratio = avg_win / avg_loss if avg_loss > 0 else 0

    total_hold = 0
    cnt = 0
    for _, sr in sells.iterrows():
        buys = trades_df[(trades_df['symbol'] == sr['symbol']) &
                         (trades_df['action'] == 'BUY') &
                         (trades_df['date'] <= sr['date'])]
        if len(buys) > 0:
            total_hold += (sr['date'] - buys.iloc[-1]['date']).days
            cnt += 1
    avg_hold = total_hold / cnt if cnt > 0 else 0
else:
    total_trades = win_rate = pl_ratio = avg_hold = 0

# ============================================================
# REPORT
# ============================================================
print("\n" + "=" * 60)
print("  Round 1: 均线动量趋势策略 v1")
print("=" * 60)
print(f"  Period:           {pv.index[0].date()} ~ {pv.index[-1].date()}")
print(f"  Initial Capital:  ¥{INITIAL_CAPITAL:,.0f}")
print(f"  Final Value:      ¥{pv['value'].iloc[-1]:,.0f}")
print(f"  Total Return:     {total_return*100:.2f}%")
print(f"  Annual Return:    {annual_return*100:.2f}%")
print(f"  Max Drawdown:     {max_drawdown*100:.2f}%")
print(f"  Sharpe Ratio:     {sharpe:.2f}")
print(f"  Win Rate:         {win_rate*100:.1f}%")
print(f"  P/L Ratio:        {pl_ratio:.2f}")
print(f"  Total Trades:     {total_trades}")
print(f"  Avg Holding Days: {avg_hold:.1f}")
print("=" * 60)

print("\n  TARGET CHECK:")
checks = [
    ('Annual Return', annual_return, 0.15, f'{annual_return*100:.2f}%', '> 15%'),
    ('Max Drawdown', max_drawdown, -0.20, f'{max_drawdown*100:.2f}%', '> -20%'),
    ('Sharpe Ratio', sharpe, 1.0, f'{sharpe:.2f}', '> 1.0'),
]
all_met = True
for name, val, target, val_s, tgt_s in checks:
    met = val > target
    all_met = all_met and met
    print(f"    {name:15s}: {val_s:>10s}  (target: {tgt_s})  [{'PASS' if met else 'FAIL'}]")

if all_met:
    print("\n  >>> ALL TARGETS MET <<<")
else:
    print("\n  >>> NOT MET — needs iteration <<<")

# Trade log
if len(trades_df) > 0:
    print(f"\n  TRADES ({len(trades_df)} total):")
    for _, t in trades_df.iterrows():
        pnl_s = f" PnL:¥{t['pnl']:+,.0f}" if t['action'] == 'SELL' else ""
        print(f"    {t['date'].date()} {t['action']:4s} {t['symbol']} @¥{t['price']:.2f} x{t['shares']:>5d}{pnl_s} [{t['reason']}]")

# ============================================================
# EQUITY CURVE
# ============================================================
fig, axes = plt.subplots(2, 1, figsize=(14, 8), gridspec_kw={'height_ratios': [3, 1]})

ax1 = axes[0]
ax1.plot(pv.index, pv['value'] / 10000, 'b-', lw=1.5, label='Portfolio')
ax1.axhline(y=INITIAL_CAPITAL/10000, color='gray', ls='--', alpha=0.5, label='Initial')
ax1.set_title('Round 1: EMA Crossover + Volume (A-shares)', fontsize=14)
ax1.set_ylabel('Value (万元)')
ax1.legend()
ax1.grid(True, alpha=0.3)

ax2 = axes[1]
ax2.fill_between(pv.index, pv['drawdown'] * 100, 0, alpha=0.3, color='red')
ax2.set_ylabel('Drawdown (%)')
ax2.set_xlabel('Date')
ax2.grid(True, alpha=0.3)

plt.tight_layout()
out_path = '/Users/tzu-chienhsu/Desktop/rockstock/strategy_loop/round1_equity.png'
plt.savefig(out_path, dpi=150)
print(f"\nEquity curve: {out_path}")
