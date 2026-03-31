"""
Round 2: RSI均值回归策略 v2
- Universe: 20 liquid A-share stocks
- Entry: RSI(2) < 10 AND close < lower BB(20,2) AND close > EMA(200) [trend filter]
- Exit: RSI(2) > 70 OR close > BB middle band OR 2x ATR(14) stop-loss
- Position: max 5 stocks, risk-based sizing (2% capital risk per trade)
- Costs: commission 0.025% + stamp tax 0.1% (sell) + slippage 0.1%
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
from datetime import datetime
import time
import json
import warnings
warnings.filterwarnings('ignore')

# ============================================================
# TENCENT DATA FETCHER (same as Round 1)
# ============================================================
def fetch_daily_kline(symbol, num_days=600):
    mkt = 'sh' if symbol.startswith('6') else 'sz'
    code = f"{mkt}{symbol}"
    url = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"
    params = {'param': f'{code},day,,,{num_days},qfq', '_var': 'kline_dayqfq'}
    s = requests.Session()
    s.trust_env = False
    r = s.get(url, params=params, timeout=15)
    json_str = r.text.split('=', 1)[1] if '=' in r.text else r.text
    data = json.loads(json_str)
    stock_data = data.get('data', {}).get(code, {})
    klines = stock_data.get('qfqday', stock_data.get('day', []))
    if not klines:
        raise ValueError(f"No data for {symbol}")
    rows = []
    for k in klines:
        if len(k) >= 6:
            rows.append({
                'date': pd.Timestamp(k[0]),
                'open': float(k[1]), 'close': float(k[2]),
                'high': float(k[3]), 'low': float(k[4]),
                'volume': float(k[5]),
            })
    return pd.DataFrame(rows).set_index('date').sort_index()

# ============================================================
# CONFIG
# ============================================================
STOCKS = [
    '600519', '000858', '601318', '600036', '000333',
    '601012', '600900', '000001', '601888', '600276',
    '002714', '600030', '601166', '000725', '600809',
    '002594', '601398', '600585', '002475', '603259',
]

START_DATE = '2024-01-01'
INITIAL_CAPITAL = 1_000_000
MAX_POSITIONS = 5
RISK_PER_TRADE = 0.02  # 2% of capital

# Costs
COMM = 0.00025
STAMP = 0.001
SLIP = 0.001

# Indicators
RSI_PERIOD = 2
RSI_ENTRY = 10
RSI_EXIT = 70
BB_PERIOD = 20
BB_STD = 2.0
EMA_TREND = 200  # trend filter - only long above this
ATR_PERIOD = 14
ATR_STOP_MULT = 2.0

# ============================================================
# INDICATOR CALCULATIONS
# ============================================================
def calc_rsi(series, period):
    delta = series.diff()
    gain = delta.where(delta > 0, 0.0)
    loss = -delta.where(delta < 0, 0.0)
    avg_gain = gain.ewm(com=period - 1, min_periods=period).mean()
    avg_loss = loss.ewm(com=period - 1, min_periods=period).mean()
    rs = avg_gain / avg_loss
    return 100 - (100 / (1 + rs))

def calc_indicators(df):
    df['rsi'] = calc_rsi(df['close'], RSI_PERIOD)
    df['bb_mid'] = df['close'].rolling(BB_PERIOD).mean()
    df['bb_std'] = df['close'].rolling(BB_PERIOD).std()
    df['bb_lower'] = df['bb_mid'] - BB_STD * df['bb_std']
    df['bb_upper'] = df['bb_mid'] + BB_STD * df['bb_std']
    df['ema200'] = df['close'].ewm(span=EMA_TREND, adjust=False).mean()
    # ATR
    df['tr'] = np.maximum(
        df['high'] - df['low'],
        np.maximum(abs(df['high'] - df['close'].shift(1)),
                   abs(df['low'] - df['close'].shift(1)))
    )
    df['atr'] = df['tr'].rolling(ATR_PERIOD).mean()
    return df

# ============================================================
# LOAD DATA
# ============================================================
print("Loading data...")
all_data = {}
failed = []
for i, sym in enumerate(STOCKS):
    try:
        df = fetch_daily_kline(sym, 600)
        df = calc_indicators(df)
        all_data[sym] = df
        print(f"  [{i+1}/{len(STOCKS)}] {sym}: {len(df)} rows")
    except Exception as e:
        failed.append(sym)
        print(f"  [{i+1}/{len(STOCKS)}] {sym}: FAILED - {e}")
    if i < len(STOCKS) - 1:
        time.sleep(0.3)

print(f"\nLoaded {len(all_data)}/{len(STOCKS)} stocks")

# ============================================================
# BACKTEST
# ============================================================
date_sets = [set(df.index) for df in all_data.values()]
common = sorted(set.intersection(*date_sets))
bt_start = pd.Timestamp(START_DATE)
dates = [d for d in common if d >= bt_start]
print(f"Backtest: {dates[0].date()} ~ {dates[-1].date()} ({len(dates)} days)")

cash = INITIAL_CAPITAL
positions = {}  # sym -> {shares, entry_price, stop_price}
pv_list = []
trades = []

def buy_cost(price, shares):
    n = price * shares
    return n + max(n * COMM, 5) + n * SLIP

def sell_net(price, shares):
    n = price * shares
    return n - max(n * COMM, 5) - n * STAMP - n * SLIP

for date in dates:
    # ---- EXITS ----
    to_sell = []
    for sym, pos in list(positions.items()):
        df = all_data[sym]
        if date not in df.index:
            continue
        row = df.loc[date]

        # Exit conditions
        rsi_exit = row['rsi'] > RSI_EXIT
        bb_mid_cross = row['close'] > row['bb_mid'] if pd.notna(row['bb_mid']) else False
        stop_hit = row['close'] <= pos['stop_price']

        if rsi_exit or bb_mid_cross or stop_hit:
            reason = 'RSI_EXIT' if rsi_exit else ('BB_MID' if bb_mid_cross else 'ATR_STOP')
            proceeds = sell_net(row['close'], pos['shares'])
            cost_basis = buy_cost(pos['entry_price'], pos['shares'])
            pnl = proceeds - cost_basis
            cash += proceeds
            trades.append({
                'date': date, 'symbol': sym, 'action': 'SELL',
                'price': row['close'], 'shares': pos['shares'],
                'pnl': pnl, 'reason': reason
            })
            to_sell.append(sym)

    for sym in to_sell:
        del positions[sym]

    # ---- ENTRIES ----
    if len(positions) < MAX_POSITIONS:
        cands = []
        for sym, df in all_data.items():
            if sym in positions or date not in df.index:
                continue
            row = df.loc[date]
            if pd.isna(row['rsi']) or pd.isna(row['bb_lower']) or pd.isna(row['ema200']) or pd.isna(row['atr']):
                continue

            # Entry: RSI(2) < 10 AND close < lower BB AND close > EMA200 (trend filter)
            oversold = row['rsi'] < RSI_ENTRY
            below_bb = row['close'] < row['bb_lower']
            uptrend = row['close'] > row['ema200']

            if oversold and below_bb and uptrend:
                # Score by how oversold (lower RSI = more extreme = higher priority)
                cands.append((sym, row['rsi'], row['close'], row['atr']))

        cands.sort(key=lambda x: x[1])  # lowest RSI first
        slots = MAX_POSITIONS - len(positions)

        for sym, rsi_val, price, atr_val in cands[:slots]:
            # Risk-based position sizing: risk 2% of total portfolio per trade
            total_val = cash + sum(
                all_data[s].loc[date, 'close'] * p['shares']
                for s, p in positions.items() if date in all_data[s].index
            )
            stop_price = price - ATR_STOP_MULT * atr_val
            risk_per_share = price - stop_price
            if risk_per_share <= 0:
                continue

            dollar_risk = total_val * RISK_PER_TRADE
            shares = int(dollar_risk / risk_per_share / 100) * 100  # round to lots
            if shares < 100:
                shares = 100  # minimum 1 lot

            cost = buy_cost(price, shares)
            if cost > cash:
                continue

            # Cap at 25% of portfolio
            if cost > total_val * 0.25:
                shares = int(total_val * 0.25 / price / 100) * 100
                if shares < 100:
                    continue
                cost = buy_cost(price, shares)
                if cost > cash:
                    continue

            cash -= cost
            positions[sym] = {
                'shares': shares, 'entry_price': price,
                'stop_price': stop_price
            }
            trades.append({
                'date': date, 'symbol': sym, 'action': 'BUY',
                'price': price, 'shares': shares, 'pnl': 0,
                'reason': f'RSI={rsi_val:.1f}'
            })

    # ---- PORTFOLIO VALUE ----
    pos_val = sum(
        all_data[s].loc[date, 'close'] * p['shares']
        for s, p in positions.items() if date in all_data[s].index
    )
    pv_list.append({'date': date, 'value': cash + pos_val})

# ============================================================
# METRICS
# ============================================================
pv = pd.DataFrame(pv_list).set_index('date')
pv['ret'] = pv['value'].pct_change()

days = (pv.index[-1] - pv.index[0]).days
tot_ret = pv['value'].iloc[-1] / pv['value'].iloc[0] - 1
ann_ret = (1 + tot_ret) ** (365 / days) - 1 if days > 0 else 0

pv['peak'] = pv['value'].cummax()
pv['dd'] = (pv['value'] - pv['peak']) / pv['peak']
mdd = pv['dd'].min()

rf = 0.02 / 252
ex = pv['ret'].dropna() - rf
sharpe = ex.mean() / ex.std() * np.sqrt(252) if ex.std() > 0 else 0

tdf = pd.DataFrame(trades) if trades else pd.DataFrame()
if len(tdf) > 0:
    sells = tdf[tdf['action'] == 'SELL']
    n_trades = len(sells)
    wr = len(sells[sells['pnl'] > 0]) / n_trades if n_trades > 0 else 0
    aw = sells[sells['pnl'] > 0]['pnl'].mean() if len(sells[sells['pnl'] > 0]) > 0 else 0
    al = abs(sells[sells['pnl'] <= 0]['pnl'].mean()) if len(sells[sells['pnl'] <= 0]) > 0 else 1
    plr = aw / al if al > 0 else 0

    th = 0; tc = 0
    for _, sr in sells.iterrows():
        buys = tdf[(tdf['symbol'] == sr['symbol']) & (tdf['action'] == 'BUY') & (tdf['date'] <= sr['date'])]
        if len(buys) > 0:
            th += (sr['date'] - buys.iloc[-1]['date']).days
            tc += 1
    avg_hold = th / tc if tc > 0 else 0
else:
    n_trades = wr = plr = avg_hold = 0

# ============================================================
# REPORT
# ============================================================
print("\n" + "=" * 60)
print("  Round 2: RSI均值回归策略 v2")
print("=" * 60)
print(f"  Period:           {pv.index[0].date()} ~ {pv.index[-1].date()}")
print(f"  Initial:          ¥{INITIAL_CAPITAL:,.0f}")
print(f"  Final:            ¥{pv['value'].iloc[-1]:,.0f}")
print(f"  Total Return:     {tot_ret*100:.2f}%")
print(f"  Annual Return:    {ann_ret*100:.2f}%")
print(f"  Max Drawdown:     {mdd*100:.2f}%")
print(f"  Sharpe Ratio:     {sharpe:.2f}")
print(f"  Win Rate:         {wr*100:.1f}%")
print(f"  P/L Ratio:        {plr:.2f}")
print(f"  Total Trades:     {n_trades}")
print(f"  Avg Holding:      {avg_hold:.1f} days")
print("=" * 60)

print("\n  TARGET CHECK:")
checks = [
    ('Annual Return', ann_ret, 0.15, f'{ann_ret*100:.2f}%', '> 15%'),
    ('Max Drawdown', mdd, -0.20, f'{mdd*100:.2f}%', '> -20%'),
    ('Sharpe Ratio', sharpe, 1.0, f'{sharpe:.2f}', '> 1.0'),
]
all_met = True
for name, val, target, vs, ts in checks:
    met = val > target
    all_met = all_met and met
    print(f"    {name:15s}: {vs:>10s}  (target: {ts})  [{'PASS' if met else 'FAIL'}]")

if all_met:
    print("\n  >>> ALL TARGETS MET <<<")
else:
    print("\n  >>> NOT MET — needs iteration <<<")

if len(tdf) > 0:
    print(f"\n  TRADES ({len(tdf)} entries):")
    for _, t in tdf.iterrows():
        pnl_s = f" PnL:¥{t['pnl']:+,.0f}" if t['action'] == 'SELL' else ""
        print(f"    {t['date'].date()} {t['action']:4s} {t['symbol']} @¥{t['price']:.2f} x{t['shares']:>6d}{pnl_s} [{t['reason']}]")

# ============================================================
# CHART
# ============================================================
fig, axes = plt.subplots(2, 1, figsize=(14, 8), gridspec_kw={'height_ratios': [3, 1]})
ax1 = axes[0]
ax1.plot(pv.index, pv['value'] / 10000, 'b-', lw=1.5, label='Portfolio')
ax1.axhline(y=INITIAL_CAPITAL/10000, color='gray', ls='--', alpha=0.5, label='Initial')
ax1.set_title('Round 2: RSI Mean Reversion + BB + ATR Stop (A-shares)', fontsize=14)
ax1.set_ylabel('Value (万元)')
ax1.legend()
ax1.grid(True, alpha=0.3)

ax2 = axes[1]
ax2.fill_between(pv.index, pv['dd'] * 100, 0, alpha=0.3, color='red')
ax2.set_ylabel('Drawdown (%)')
ax2.set_xlabel('Date')
ax2.grid(True, alpha=0.3)

plt.tight_layout()
out = '/Users/tzu-chienhsu/Desktop/rockstock/strategy_loop/round2_equity.png'
plt.savefig(out, dpi=150)
print(f"\nChart: {out}")
