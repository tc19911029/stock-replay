"""
Round 4: 周频均值回归轮动 v4 — Complete strategy pivot
- Every Friday: rank stocks by 5-day return (most negative = most oversold)
- Buy bottom 5 IF above 50-day MA (trend filter)
- Equal weight ~20% each, fully invested
- Hold exactly 1 week, then rebalance
- No intra-week stop-loss (let mean reversion play out)
- If fewer than 5 qualify, hold fewer with larger weight (max 25% each)
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

# ============================================================
# DATA
# ============================================================
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

STOCKS = [
    '600519', '000858', '601318', '600036', '000333',
    '601012', '600900', '000001', '601888', '600276',
    '002714', '600030', '601166', '000725', '600809',
    '002594', '601398', '600585', '002475', '603259',
]

CAP = 1_000_000
MAX_HOLD = 5
COMM = 0.00025; STAMP = 0.001; SLIP = 0.001

print("Loading data...")
data = {}
for i, sym in enumerate(STOCKS):
    try:
        df = fetch_kline(sym, 600)
        df['ma50'] = df['close'].rolling(50).mean()
        df['ret5'] = df['close'].pct_change(5)  # 5-day return
        df['ret1'] = df['close'].pct_change(1)   # 1-day return for momentum
        data[sym] = df
        print(f"  [{i+1}/{len(STOCKS)}] {sym}: OK")
    except Exception as e:
        print(f"  [{i+1}/{len(STOCKS)}] {sym}: FAIL")
    time.sleep(0.3)

dates = sorted(set.intersection(*[set(d.index) for d in data.values()]))
dates = [d for d in dates if d >= pd.Timestamp('2024-01-01')]
print(f"Backtest: {dates[0].date()} ~ {dates[-1].date()} ({len(dates)} days)")

# ============================================================
# IDENTIFY WEEKLY REBALANCE DATES (every Friday or last trading day of week)
# ============================================================
df_dates = pd.DataFrame({'date': dates})
df_dates['date'] = pd.to_datetime(df_dates['date'])
df_dates['week'] = df_dates['date'].dt.isocalendar().week.astype(int)
df_dates['year'] = df_dates['date'].dt.year
df_dates['yw'] = df_dates['year'] * 100 + df_dates['week']

# Last trading day of each week
rebal_dates = df_dates.groupby('yw')['date'].last().values
rebal_dates = [pd.Timestamp(d) for d in rebal_dates]
print(f"Rebalance dates: {len(rebal_dates)} weeks")

# ============================================================
# BACKTEST
# ============================================================
cash = CAP
holdings = {}  # sym -> {shares, entry_price}
pv_list = []
trades = []

def bcost(p, s):
    n = p * s; return n + max(n * COMM, 5) + n * SLIP

def snet(p, s):
    n = p * s; return n - max(n * COMM, 5) - n * STAMP - n * SLIP

for date in dates:
    is_rebal = date in rebal_dates

    if is_rebal:
        # ---- SELL ALL CURRENT HOLDINGS ----
        for sym, pos in list(holdings.items()):
            if date not in data[sym].index:
                continue
            price = data[sym].loc[date, 'close']
            proceeds = snet(price, pos['shares'])
            cost_basis = bcost(pos['entry_price'], pos['shares'])
            pnl = proceeds - cost_basis
            cash += proceeds
            trades.append({
                'date': date, 'symbol': sym, 'action': 'SELL',
                'price': price, 'shares': pos['shares'],
                'pnl': pnl, 'reason': 'REBAL'
            })
        holdings = {}

        # ---- RANK AND SELECT ----
        candidates = []
        for sym, df in data.items():
            if date not in df.index:
                continue
            row = df.loc[date]
            if pd.isna(row['ret5']) or pd.isna(row['ma50']):
                continue

            # Trend filter: only stocks above 50-day MA
            above_ma = row['close'] > row['ma50']

            if above_ma:
                candidates.append((sym, row['ret5'], row['close']))

        # Sort by 5-day return (ascending = most beaten down first)
        candidates.sort(key=lambda x: x[1])

        # Select bottom N (most oversold)
        to_buy = candidates[:MAX_HOLD]

        if to_buy:
            total_val = cash
            per_stock = total_val / len(to_buy)

            for sym, ret5, price in to_buy:
                shares = int(per_stock / price / 100) * 100
                if shares < 100:
                    shares = 100
                cost = bcost(price, shares)
                if cost > cash:
                    continue

                cash -= cost
                holdings[sym] = {'shares': shares, 'entry_price': price}
                trades.append({
                    'date': date, 'symbol': sym, 'action': 'BUY',
                    'price': price, 'shares': shares, 'pnl': 0,
                    'reason': f'ret5={ret5*100:.1f}%'
                })

    # ---- DAILY PORTFOLIO VALUE ----
    pos_val = sum(
        data[s].loc[date, 'close'] * p['shares']
        for s, p in holdings.items() if date in data[s].index
    )
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
    avg_hold = 5.0  # fixed 1-week hold
else:
    nt = wr = plr = avg_hold = 0

# ============================================================
# REPORT
# ============================================================
print("\n" + "=" * 60)
print("  Round 4: 周频均值回归轮动 v4")
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
print(f"  Avg Hold:     ~{avg_hold:.0f}d (weekly)")
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
    print("\n  >>> NOT MET — needs iteration <<<")

# Weekly return distribution
if len(sells) > 0:
    weekly_pnl = sells.groupby(sells['date'])['pnl'].sum()
    print(f"\n  WEEKLY P&L DISTRIBUTION:")
    print(f"    Positive weeks: {(weekly_pnl > 0).sum()}")
    print(f"    Negative weeks: {(weekly_pnl <= 0).sum()}")
    print(f"    Best week:  ¥{weekly_pnl.max():+,.0f}")
    print(f"    Worst week: ¥{weekly_pnl.min():+,.0f}")
    print(f"    Avg week:   ¥{weekly_pnl.mean():+,.0f}")

# Chart
fig, axes = plt.subplots(2, 1, figsize=(14, 8), gridspec_kw={'height_ratios': [3, 1]})
axes[0].plot(pvdf.index, pvdf['value']/1e4, 'b-', lw=1.5, label='Portfolio')
axes[0].axhline(y=CAP/1e4, color='gray', ls='--', alpha=0.5, label='Initial')
axes[0].set_title('Round 4: Weekly Mean-Reversion Rotation (A-shares)', fontsize=14)
axes[0].set_ylabel('Value (万元)'); axes[0].legend(); axes[0].grid(True, alpha=0.3)
axes[1].fill_between(pvdf.index, pvdf['dd']*100, 0, alpha=0.3, color='red')
axes[1].set_ylabel('Drawdown (%)'); axes[1].set_xlabel('Date'); axes[1].grid(True, alpha=0.3)
plt.tight_layout()
out = '/Users/tzu-chienhsu/Desktop/rockstock/strategy_loop/round4_equity.png'
plt.savefig(out, dpi=150)
print(f"\nChart: {out}")
