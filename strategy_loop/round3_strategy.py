"""
Round 3: 增强均值回归 v3
Changes from R2:
 - Relaxed trend filter: EMA(50) instead of EMA(200)
 - Relaxed RSI entry: RSI(2) < 20 instead of < 10
 - Added RSI(14) > 35 filter (avoid deep downtrends)
 - More positions: max 8 @ 12.5% each
 - Scaled exit: 50% at BB mid, rest at BB upper or RSI(2) > 80
 - Tighter stop: 1.5x ATR
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
    url = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"
    s = requests.Session(); s.trust_env = False
    r = s.get(url, params={'param': f'{code},day,,,{n},qfq', '_var': 'k'}, timeout=15)
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

def add_indicators(df):
    df['rsi2'] = calc_rsi(df['close'], 2)
    df['rsi14'] = calc_rsi(df['close'], 14)
    df['bb_mid'] = df['close'].rolling(20).mean()
    df['bb_std'] = df['close'].rolling(20).std()
    df['bb_lo'] = df['bb_mid'] - 2 * df['bb_std']
    df['bb_hi'] = df['bb_mid'] + 2 * df['bb_std']
    df['ema50'] = df['close'].ewm(span=50, adjust=False).mean()
    tr = np.maximum(df['high'] - df['low'],
         np.maximum(abs(df['high'] - df['close'].shift(1)),
                    abs(df['low'] - df['close'].shift(1))))
    df['atr'] = tr.rolling(14).mean()
    return df

# ============================================================
# CONFIG
# ============================================================
STOCKS = [
    '600519', '000858', '601318', '600036', '000333',
    '601012', '600900', '000001', '601888', '600276',
    '002714', '600030', '601166', '000725', '600809',
    '002594', '601398', '600585', '002475', '603259',
]

CAP = 1_000_000
MAX_POS = 8
POS_PCT = 1.0 / MAX_POS  # 12.5%
RISK_PCT = 0.015  # 1.5% risk per trade
COMM = 0.00025; STAMP = 0.001; SLIP = 0.001
ATR_MULT = 1.5

print("Loading data...")
data = {}
for i, sym in enumerate(STOCKS):
    try:
        df = add_indicators(fetch_kline(sym, 600))
        data[sym] = df
        print(f"  [{i+1}/{len(STOCKS)}] {sym}: OK")
    except Exception as e:
        print(f"  [{i+1}/{len(STOCKS)}] {sym}: FAIL - {e}")
    time.sleep(0.3)

dates = sorted(set.intersection(*[set(d.index) for d in data.values()]))
dates = [d for d in dates if d >= pd.Timestamp('2024-01-01')]
print(f"Backtest: {dates[0].date()} ~ {dates[-1].date()} ({len(dates)} days)")

# ============================================================
# BACKTEST
# ============================================================
cash = CAP
# positions: sym -> {shares, entry, stop, scale_out_done, initial_shares}
positions = {}
pv_list = []
trades = []

def bcost(p, s):
    n = p * s; return n + max(n * COMM, 5) + n * SLIP

def snet(p, s):
    n = p * s; return n - max(n * COMM, 5) - n * STAMP - n * SLIP

for date in dates:
    # ---- EXITS ----
    to_sell = []
    for sym, pos in list(positions.items()):
        df = data[sym]
        if date not in df.index: continue
        r = df.loc[date]

        stop_hit = r['close'] <= pos['stop']

        # Scaled exit: first half at BB mid
        if not pos['scale_out_done']:
            bb_mid_cross = r['close'] > r['bb_mid'] if pd.notna(r['bb_mid']) else False
            rsi_exit = r['rsi2'] > 70

            if (bb_mid_cross or rsi_exit) and not stop_hit:
                # Sell 50%
                sell_shares = pos['initial_shares'] // 2
                sell_shares = (sell_shares // 100) * 100
                if sell_shares >= 100:
                    proceeds = snet(r['close'], sell_shares)
                    cost_basis = bcost(pos['entry'], sell_shares)
                    pnl = proceeds - cost_basis
                    cash += proceeds
                    pos['shares'] -= sell_shares
                    pos['scale_out_done'] = True
                    trades.append({
                        'date': date, 'symbol': sym, 'action': 'SELL',
                        'price': r['close'], 'shares': sell_shares,
                        'pnl': pnl, 'reason': 'SCALE_50%'
                    })
                continue  # Don't fully exit yet

        # Full exit conditions for remaining shares
        rsi_high = r['rsi2'] > 80
        bb_upper = r['close'] > r['bb_hi'] if pd.notna(r['bb_hi']) else False

        if stop_hit or rsi_high or bb_upper:
            reason = 'STOP' if stop_hit else ('RSI>80' if rsi_high else 'BB_UPPER')
            if pos['shares'] >= 100:
                proceeds = snet(r['close'], pos['shares'])
                cost_basis = bcost(pos['entry'], pos['shares'])
                pnl = proceeds - cost_basis
                cash += proceeds
                trades.append({
                    'date': date, 'symbol': sym, 'action': 'SELL',
                    'price': r['close'], 'shares': pos['shares'],
                    'pnl': pnl, 'reason': reason
                })
            to_sell.append(sym)

    for sym in to_sell:
        del positions[sym]

    # ---- ENTRIES ----
    if len(positions) < MAX_POS:
        cands = []
        for sym, df in data.items():
            if sym in positions or date not in df.index: continue
            r = df.loc[date]
            if pd.isna(r['rsi2']) or pd.isna(r['rsi14']) or pd.isna(r['bb_lo']) or pd.isna(r['ema50']) or pd.isna(r['atr']):
                continue

            # Entry: RSI(2) < 20 AND close < BB lower AND close > EMA50 AND RSI(14) > 35
            entry = (r['rsi2'] < 20 and
                    r['close'] < r['bb_lo'] and
                    r['close'] > r['ema50'] and
                    r['rsi14'] > 35)

            if entry:
                cands.append((sym, r['rsi2'], r['close'], r['atr']))

        cands.sort(key=lambda x: x[1])  # most oversold first
        slots = MAX_POS - len(positions)

        for sym, rsi_val, price, atr in cands[:slots]:
            total_val = cash + sum(
                data[s].loc[date, 'close'] * p['shares']
                for s, p in positions.items() if date in data[s].index
            )
            stop = price - ATR_MULT * atr
            risk_ps = price - stop
            if risk_ps <= 0: continue

            # Risk-based sizing
            dollar_risk = total_val * RISK_PCT
            shares = int(dollar_risk / risk_ps / 100) * 100
            if shares < 100: shares = 100

            # Cap at POS_PCT of portfolio
            max_alloc = total_val * POS_PCT
            if bcost(price, shares) > max_alloc:
                shares = int(max_alloc / price / 100) * 100
            if shares < 100: continue
            if bcost(price, shares) > cash: continue

            cash -= bcost(price, shares)
            positions[sym] = {
                'shares': shares, 'entry': price, 'stop': stop,
                'scale_out_done': False, 'initial_shares': shares
            }
            trades.append({
                'date': date, 'symbol': sym, 'action': 'BUY',
                'price': price, 'shares': shares, 'pnl': 0,
                'reason': f'RSI2={rsi_val:.0f}'
            })

    pv = sum(data[s].loc[date, 'close'] * p['shares']
             for s, p in positions.items() if date in data[s].index)
    pv_list.append({'date': date, 'value': cash + pv})

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

    th = tc = 0
    for _, sr in sells.iterrows():
        bs = tdf[(tdf['symbol'] == sr['symbol']) & (tdf['action'] == 'BUY') & (tdf['date'] <= sr['date'])]
        if len(bs) > 0:
            th += (sr['date'] - bs.iloc[-1]['date']).days
            tc += 1
    avg_hold = th / tc if tc > 0 else 0
else:
    nt = wr = plr = avg_hold = 0

print("\n" + "=" * 60)
print("  Round 3: 增强均值回归 v3")
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
print(f"  Trades:       {nt}")
print(f"  Avg Hold:     {avg_hold:.1f}d")
print("=" * 60)

print("\n  TARGETS:")
for nm, v, t, vs, ts in [
    ('Annual Return', ann, 0.15, f'{ann*100:.2f}%', '>15%'),
    ('Max Drawdown', mdd, -0.20, f'{mdd*100:.2f}%', '>-20%'),
    ('Sharpe Ratio', sharpe, 1.0, f'{sharpe:.2f}', '>1.0')]:
    print(f"    {nm:15s}: {vs:>10s}  ({ts})  [{'PASS' if v > t else 'FAIL'}]")

if ann > 0.15 and mdd > -0.20 and sharpe > 1.0:
    print("\n  >>> ALL TARGETS MET <<<")
else:
    print("\n  >>> NOT MET — needs iteration <<<")

# Chart
fig, axes = plt.subplots(2, 1, figsize=(14, 8), gridspec_kw={'height_ratios': [3, 1]})
axes[0].plot(pvdf.index, pvdf['value']/1e4, 'b-', lw=1.5, label='Portfolio')
axes[0].axhline(y=CAP/1e4, color='gray', ls='--', alpha=0.5, label='Initial')
axes[0].set_title('Round 3: Enhanced Mean Reversion v3', fontsize=14)
axes[0].set_ylabel('Value (万元)'); axes[0].legend(); axes[0].grid(True, alpha=0.3)
axes[1].fill_between(pvdf.index, pvdf['dd']*100, 0, alpha=0.3, color='red')
axes[1].set_ylabel('Drawdown (%)'); axes[1].set_xlabel('Date'); axes[1].grid(True, alpha=0.3)
plt.tight_layout()
out = '/Users/tzu-chienhsu/Desktop/rockstock/strategy_loop/round3_equity.png'
plt.savefig(out, dpi=150)
print(f"\nChart: {out}")
