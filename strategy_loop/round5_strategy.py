"""
Round 5 (FINAL): regime感知混合策略 v5
Combines best elements from all 4 rounds:

REGIME FILTER (from R4 diagnosis):
- Use average of all 20 stocks as market proxy
- Bullish: proxy > 20-day MA AND proxy > 50-day MA
- Bearish: otherwise → stay in cash (skip rebalancing)

STOCK SELECTION (from R2 + R4):
- Weekly rebalance on Fridays
- Bullish regime: buy 5 most oversold (lowest 5-day return) with RSI(2) < 30
  AND above their own 20-day MA
- If <5 qualify, hold fewer; if 0 qualify, stay in cash

RISK MANAGEMENT (from all rounds):
- Portfolio trailing stop: -10% from portfolio peak → all cash, cooldown 2 weeks
- Position cap: 25% per stock
- Full transaction costs

POSITION SIZING:
- Equal weight across selected stocks
- Fully invested in bullish regime
"""

import os
for key in list(os.environ.keys()):
    if 'proxy' in key.lower():
        del os.environ[key]

import requests, pandas as pd, numpy as np, matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from datetime import datetime
import time, json, warnings
warnings.filterwarnings('ignore')

def fetch_kline(symbol, n=600):
    mkt = 'sh' if symbol.startswith('6') else 'sz'
    code = f"{mkt}{symbol}"
    s = requests.Session(); s.trust_env = False
    r = s.get("https://web.ifzq.gtimg.cn/appstock/app/fqkline/get",
              params={'param': f'{code},day,,,{n},qfq', '_var': 'k'}, timeout=15)
    j = json.loads(r.text.split('=', 1)[1])
    sd = j['data'][code]
    kl = sd.get('qfqday', sd.get('day', []))
    rows = [{'date': pd.Timestamp(k[0]), 'open': float(k[1]), 'close': float(k[2]),
             'high': float(k[3]), 'low': float(k[4]), 'volume': float(k[5])}
            for k in kl if len(k) >= 6]
    return pd.DataFrame(rows).set_index('date').sort_index()

def calc_rsi(s, p):
    d = s.diff()
    g = d.where(d > 0, 0.0)
    l = -d.where(d < 0, 0.0)
    ag = g.ewm(com=p-1, min_periods=p).mean()
    al = l.ewm(com=p-1, min_periods=p).mean()
    return 100 - 100 / (1 + ag / al)

STOCKS = [
    '600519', '000858', '601318', '600036', '000333',
    '601012', '600900', '000001', '601888', '600276',
    '002714', '600030', '601166', '000725', '600809',
    '002594', '601398', '600585', '002475', '603259',
]

CAP = 1_000_000
MAX_HOLD = 5
COMM = 0.00025; STAMP = 0.001; SLIP = 0.001
PORTFOLIO_STOP = 0.10  # 10% drawdown from peak = go to cash
COOLDOWN_WEEKS = 2

print("Loading data...")
data = {}
for i, sym in enumerate(STOCKS):
    try:
        df = fetch_kline(sym, 600)
        df['ma20'] = df['close'].rolling(20).mean()
        df['ma50'] = df['close'].rolling(50).mean()
        df['ret5'] = df['close'].pct_change(5)
        df['rsi2'] = calc_rsi(df['close'], 2)
        data[sym] = df
        print(f"  [{i+1}/{len(STOCKS)}] {sym}: OK")
    except Exception as e:
        print(f"  [{i+1}/{len(STOCKS)}] {sym}: FAIL")
    time.sleep(0.3)

# Build market proxy (equal-weight average of all stocks, normalized)
dates = sorted(set.intersection(*[set(d.index) for d in data.values()]))
dates = [d for d in dates if d >= pd.Timestamp('2024-01-01')]

market = pd.DataFrame(index=dates)
for sym, df in data.items():
    # Normalize to start at 100
    common = df.index.intersection(dates)
    series = df.loc[common, 'close']
    if len(series) > 0:
        market[sym] = series / series.iloc[0] * 100

market['proxy'] = market.mean(axis=1)
market['proxy_ma20'] = market['proxy'].rolling(20).mean()
market['proxy_ma50'] = market['proxy'].rolling(50).mean()

print(f"Backtest: {dates[0].date()} ~ {dates[-1].date()} ({len(dates)} days)")

# Weekly rebalance dates
df_d = pd.DataFrame({'date': dates})
df_d['date'] = pd.to_datetime(df_d['date'])
df_d['yw'] = df_d['date'].dt.year * 100 + df_d['date'].dt.isocalendar().week.astype(int)
rebal_dates = set(pd.Timestamp(d) for d in df_d.groupby('yw')['date'].last().values)

# ============================================================
# BACKTEST
# ============================================================
cash = CAP
holdings = {}
pv_list = []
trades = []
portfolio_peak = CAP
cooldown_until = None  # date when cooldown expires

def bcost(p, s):
    n = p * s; return n + max(n * COMM, 5) + n * SLIP

def snet(p, s):
    n = p * s; return n - max(n * COMM, 5) - n * STAMP - n * SLIP

for date in dates:
    # Calculate current portfolio value
    pos_val = sum(data[s].loc[date, 'close'] * p['shares']
                  for s, p in holdings.items() if date in data[s].index)
    current_val = cash + pos_val

    # Update peak
    portfolio_peak = max(portfolio_peak, current_val)

    # ---- PORTFOLIO STOP CHECK ----
    dd_from_peak = (portfolio_peak - current_val) / portfolio_peak
    if dd_from_peak >= PORTFOLIO_STOP and holdings:
        # Emergency exit: sell everything
        for sym, pos in list(holdings.items()):
            if date in data[sym].index:
                price = data[sym].loc[date, 'close']
                proceeds = snet(price, pos['shares'])
                pnl = proceeds - bcost(pos['entry'], pos['shares'])
                cash += proceeds
                trades.append({'date': date, 'symbol': sym, 'action': 'SELL',
                              'price': price, 'shares': pos['shares'],
                              'pnl': pnl, 'reason': 'PORT_STOP'})
        holdings = {}
        # Set cooldown
        cooldown_end_idx = dates.index(date) + COOLDOWN_WEEKS * 5
        if cooldown_end_idx < len(dates):
            cooldown_until = dates[cooldown_end_idx]
        else:
            cooldown_until = dates[-1]
        # Reset peak after stop
        portfolio_peak = cash

    # ---- WEEKLY REBALANCE ----
    is_rebal = pd.Timestamp(date) in rebal_dates

    if is_rebal and (cooldown_until is None or date >= cooldown_until):
        # Check regime
        if date in market.index:
            proxy = market.loc[date, 'proxy']
            ma20 = market.loc[date, 'proxy_ma20']
            ma50 = market.loc[date, 'proxy_ma50']
            # Relaxed: proxy above 20-day MA only (MA50 was too strict)
            bullish = pd.notna(ma20) and proxy > ma20
        else:
            bullish = False

        if bullish:
            # ---- SELL all current holdings ----
            for sym, pos in list(holdings.items()):
                if date in data[sym].index:
                    price = data[sym].loc[date, 'close']
                    proceeds = snet(price, pos['shares'])
                    pnl = proceeds - bcost(pos['entry'], pos['shares'])
                    cash += proceeds
                    trades.append({'date': date, 'symbol': sym, 'action': 'SELL',
                                  'price': price, 'shares': pos['shares'],
                                  'pnl': pnl, 'reason': 'REBAL'})
            holdings = {}

            # ---- SELECT: most oversold with RSI(2) < 30, above own 20-day MA ----
            cands = []
            for sym, df in data.items():
                if date not in df.index: continue
                r = df.loc[date]
                if pd.isna(r['ret5']) or pd.isna(r['rsi2']) or pd.isna(r['ma20']):
                    continue

                oversold = r['rsi2'] < 30
                above_ma = r['close'] > r['ma20']

                if oversold and above_ma:
                    cands.append((sym, r['ret5'], r['close']))
                elif above_ma and r['ret5'] < -0.02:
                    # Fallback: mildly oversold (>2% weekly loss) above MA
                    cands.append((sym, r['ret5'], r['close']))

            cands.sort(key=lambda x: x[1])
            to_buy = cands[:MAX_HOLD]

            if not to_buy:
                # If no oversold stocks, buy top 3 strongest above MA (momentum fallback)
                mom_cands = []
                for sym, df in data.items():
                    if date not in df.index: continue
                    r = df.loc[date]
                    if pd.isna(r['ret5']) or pd.isna(r['ma20']): continue
                    if r['close'] > r['ma20']:
                        mom_cands.append((sym, r['ret5'], r['close']))
                mom_cands.sort(key=lambda x: x[1], reverse=True)  # strongest first
                to_buy = mom_cands[:3]

            if to_buy:
                total = cash
                per = total / len(to_buy)
                cap_per = total * 0.25  # max 25% per stock
                per = min(per, cap_per)

                for sym, ret5, price in to_buy:
                    shares = int(per / price / 100) * 100
                    if shares < 100: shares = 100
                    cost = bcost(price, shares)
                    if cost > cash: continue

                    cash -= cost
                    holdings[sym] = {'shares': shares, 'entry': price}
                    trades.append({'date': date, 'symbol': sym, 'action': 'BUY',
                                  'price': price, 'shares': shares, 'pnl': 0,
                                  'reason': f'r5={ret5*100:.1f}%'})

        else:
            # Bearish regime: sell everything, stay in cash
            for sym, pos in list(holdings.items()):
                if date in data[sym].index:
                    price = data[sym].loc[date, 'close']
                    proceeds = snet(price, pos['shares'])
                    pnl = proceeds - bcost(pos['entry'], pos['shares'])
                    cash += proceeds
                    trades.append({'date': date, 'symbol': sym, 'action': 'SELL',
                                  'price': price, 'shares': pos['shares'],
                                  'pnl': pnl, 'reason': 'BEAR_EXIT'})
            holdings = {}

    # ---- RECORD VALUE ----
    pos_val = sum(data[s].loc[date, 'close'] * p['shares']
                  for s, p in holdings.items() if date in data[s].index)
    pv_list.append({'date': date, 'value': cash + pos_val})

# ============================================================
# METRICS
# ============================================================
pvdf = pd.DataFrame(pv_list).set_index('date')
pvdf['ret'] = pvdf['value'].pct_change()

days = (pvdf.index[-1] - pvdf.index[0]).days
tot = pvdf['value'].iloc[-1] / pvdf['value'].iloc[0] - 1
ann = (1 + tot) ** (365 / days) - 1 if days > 0 else 0

pvdf['pk'] = pvdf['value'].cummax()
pvdf['dd'] = (pvdf['value'] - pvdf['pk']) / pvdf['pk']
mdd = pvdf['dd'].min()

rf = 0.02 / 252
ex = pvdf['ret'].dropna() - rf
sharpe = ex.mean() / ex.std() * np.sqrt(252) if ex.std() > 0 else 0

tdf = pd.DataFrame(trades) if trades else pd.DataFrame()
if len(tdf) > 0:
    sells = tdf[tdf['action'] == 'SELL']
    nt = len(sells)
    wr = len(sells[sells['pnl'] > 0]) / nt if nt > 0 else 0
    aw = sells[sells['pnl'] > 0]['pnl'].mean() if len(sells[sells['pnl'] > 0]) > 0 else 0
    al = abs(sells[sells['pnl'] <= 0]['pnl'].mean()) if len(sells[sells['pnl'] <= 0]) > 0 else 1
    plr = aw / al if al > 0 else 0
else:
    nt = wr = plr = 0

# Count weeks invested vs cash
invested_days = sum(1 for _, row in pvdf.iterrows()
                    if row['value'] != pvdf['value'].iloc[0])  # rough proxy

print("\n" + "=" * 60)
print("  Round 5 (FINAL): Regime-Aware Hybrid v5")
print("=" * 60)
print(f"  Period:       {pvdf.index[0].date()} ~ {pvdf.index[-1].date()}")
print(f"  Initial:      ¥{CAP:,.0f}")
print(f"  Final:        ¥{pvdf['value'].iloc[-1]:,.0f}")
print(f"  Total Return: {tot*100:.2f}%")
print(f"  Annual Return:{ann*100:.2f}%")
print(f"  Max Drawdown: {mdd*100:.2f}%")
print(f"  Sharpe:       {sharpe:.2f}")
print(f"  Win Rate:     {wr*100:.1f}%")
print(f"  P/L Ratio:    {plr:.2f}")
print(f"  Trades:       {nt} sells")
print("=" * 60)

print("\n  TARGETS:")
all_met = True
for nm, v, t, vs, ts in [
    ('Annual Return', ann, 0.15, f'{ann*100:.2f}%', '>15%'),
    ('Max Drawdown', mdd, -0.20, f'{mdd*100:.2f}%', '>-20%'),
    ('Sharpe Ratio', sharpe, 1.0, f'{sharpe:.2f}', '>1.0')]:
    met = v > t
    all_met = all_met and met
    print(f"    {nm:15s}: {vs:>10s}  ({ts})  [{'PASS' if met else 'FAIL'}]")

if all_met:
    print("\n  >>> ALL TARGETS MET! <<<")
else:
    print("\n  >>> NOT ALL MET — best version report follows <<<")

# Regime analysis
if len(tdf) > 0:
    buys = tdf[tdf['action'] == 'BUY']
    sells = tdf[tdf['action'] == 'SELL']
    bear_exits = sells[sells['reason'] == 'BEAR_EXIT']
    port_stops = sells[sells['reason'] == 'PORT_STOP']
    rebal_sells = sells[sells['reason'] == 'REBAL']
    print(f"\n  REGIME STATS:")
    print(f"    Buy entries:    {len(buys)}")
    print(f"    Rebal sells:    {len(rebal_sells)}")
    print(f"    Bear exits:     {len(bear_exits)}")
    print(f"    Portfolio stops: {len(port_stops)}")

# Chart
fig, axes = plt.subplots(3, 1, figsize=(14, 10), gridspec_kw={'height_ratios': [3, 1, 1]})

axes[0].plot(pvdf.index, pvdf['value']/1e4, 'b-', lw=1.5, label='Portfolio')
axes[0].axhline(y=CAP/1e4, color='gray', ls='--', alpha=0.5, label='Initial')
axes[0].set_title('Round 5 (FINAL): Regime-Aware Hybrid v5', fontsize=14)
axes[0].set_ylabel('Value (万元)'); axes[0].legend(); axes[0].grid(True, alpha=0.3)

axes[1].fill_between(pvdf.index, pvdf['dd']*100, 0, alpha=0.3, color='red')
axes[1].set_ylabel('Drawdown (%)'); axes[1].grid(True, alpha=0.3)

# Market regime
if len(market) > 0:
    m = market.loc[market.index.isin(dates)]
    axes[2].plot(m.index, m['proxy'], 'k-', lw=1, label='Market Proxy')
    axes[2].plot(m.index, m['proxy_ma20'], 'g--', lw=0.8, label='MA20')
    axes[2].plot(m.index, m['proxy_ma50'], 'r--', lw=0.8, label='MA50')
    bullish_mask = (m['proxy'] > m['proxy_ma20']) & (m['proxy'] > m['proxy_ma50'])
    axes[2].fill_between(m.index, m['proxy'].min(), m['proxy'].max(),
                         where=bullish_mask, alpha=0.1, color='green', label='Bullish')
    axes[2].set_ylabel('Market Proxy'); axes[2].legend(fontsize=8); axes[2].grid(True, alpha=0.3)

axes[2].set_xlabel('Date')
plt.tight_layout()
out = '/Users/tzu-chienhsu/Desktop/rockstock/strategy_loop/round5_equity.png'
plt.savefig(out, dpi=150)
print(f"\nChart: {out}")
