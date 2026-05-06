'use client';

import { useState, useEffect } from 'react';
import { useReplayStore } from '@/store/replayStore';
import { maxBuyShares } from '@/lib/engines/tradeEngine';
import { formatSharesAsLots, marketFromSymbol } from '@/lib/utils/shareUnits';

type Mode = 'percent' | 'shares' | 'amount';
type Confirm = { action: 'buy' | 'sell'; shares: number; price: number } | null;

export default function TradePanel() {
  const { allCandles, currentIndex, metrics, buy, sell, sixConditions, currentStock } = useReplayStore();
  const tradeMarket = marketFromSymbol(currentStock?.ticker ?? '');
  const [input,   setInput]   = useState('');
  const [mode,    setMode]    = useState<Mode>('percent');
  const [mounted, setMounted] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => setMounted(true), []);
  /* eslint-enable react-hooks/set-state-in-effect */

  const currentCandle = allCandles[currentIndex];
  const prevCandle    = allCandles[currentIndex - 1];
  const currentPrice  = currentCandle?.close ?? 0;
  const maxBuy = maxBuyShares(metrics.cash, currentPrice);

  const ma5StopLoss  = currentCandle?.ma5 ?? null;
  const costStopLoss = metrics.avgCost > 0 ? +(metrics.avgCost * 0.93).toFixed(2) : null;
  const stopLossPrice = ma5StopLoss != null && costStopLoss != null
    ? Math.max(ma5StopLoss, costStopLoss)
    : (ma5StopLoss ?? costStopLoss);

  const isBlackK = currentCandle && currentCandle.close < currentCandle.open;
  const brokeMA5 = isBlackK && prevCandle && prevCandle.ma5 != null && currentCandle!.ma5 != null
    && prevCandle.close >= prevCandle.ma5 && currentCandle!.close < currentCandle!.ma5;
  const showStopLossWarn = metrics.shares > 0 && brokeMA5;

  const inputNum = parseFloat(input) || 0;
  const estimatedSharesFromAmount = currentPrice > 0 ? Math.floor(inputNum / currentPrice) : 0;
  const estimatedCostFromShares   = inputNum * currentPrice;

  // ── Fee estimate（與 lib/backtest/CostModel.ts 一致；依 tradeMarket 切 TW/CN 費率）──
  function calcCommission(shares: number, price: number, isBuy: boolean) {
    const amount = shares * price;
    if (tradeMarket === 'CN') {
      // CN: 佣金 0.031%（含過戶費 0.001%×2 折算，最低 5）+ 賣出印花稅 0.05%（2023.8 後）
      const fee = Math.max(5, Math.round(amount * 0.00031));
      const tax = isBuy ? 0 : Math.round(amount * 0.0005);
      return fee + tax;
    }
    // TW: 手續費 0.1425%（最低 20）+ 賣出證交稅 0.3%
    const fee = Math.max(20, Math.round(amount * 0.001425));
    const tax = isBuy ? 0 : Math.round(amount * 0.003);
    return fee + tax;
  }

  // ── Confirm helpers ──────────────────────────────────────────────────────
  function requestConfirm(action: 'buy' | 'sell', shares: number) {
    if (shares <= 0) return;
    setConfirm({ action, shares, price: currentPrice });
  }

  function executeConfirmed() {
    if (!confirm) return;
    if (confirm.action === 'buy')  buy(confirm.shares);
    else                            sell(confirm.shares);
    setConfirm(null);
    setInput('');
  }

  // Percent-mode handlers go through confirm too
  function handleBuyPct(p: number) {
    const budget = metrics.cash * p;
    const shares = currentPrice > 0 ? Math.floor(budget / currentPrice) : 0;
    requestConfirm('buy', shares);
  }
  function handleSellPct(p: number) {
    const shares = Math.floor(metrics.shares * p);
    requestConfirm('sell', shares);
  }

  function handleBuy() {
    if (mode === 'shares')      requestConfirm('buy', parseInt(input, 10) || 0);
    else if (mode === 'amount') requestConfirm('buy', estimatedSharesFromAmount);
  }
  function handleSell() {
    if (mode === 'shares')      requestConfirm('sell', parseInt(input, 10) || 0);
    else if (mode === 'amount') requestConfirm('sell', estimatedSharesFromAmount);
  }

  const MODES: { key: Mode; label: string }[] = [
    { key: 'percent', label: '倉位 %' },
    { key: 'shares',  label: '股數' },
    { key: 'amount',  label: '金額' },
  ];

  return (
    <div className="bg-secondary/80 border border-border rounded-xl p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-bold text-foreground">交易操作
            <span className="ml-2 text-[9px] font-normal text-muted-foreground/60 tracking-wide" title="鍵盤快捷鍵：B=全倉買入  S=賣出半倉  Q=全部出場">
              [B買 S半賣 Q全出]
            </span>
          </h2>
          {metrics.cash > 0 && (
            <p className="text-xs text-muted-foreground mt-0.5">
              現金 <span className="text-foreground font-mono">${metrics.cash.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
              {metrics.shares > 0 && (
                <span className="ml-2">· 持股 <span className="text-yellow-400 font-mono">{formatSharesAsLots(metrics.shares, tradeMarket)}</span></span>
              )}
            </p>
          )}
        </div>
        <div className="text-right">
          <span className="text-xs text-muted-foreground">現價</span>
          <span className="ml-1.5 text-base font-mono font-bold text-yellow-400">
            {currentPrice > 0 ? currentPrice.toFixed(2) : '—'}
          </span>
        </div>
      </div>

      {/* Mode toggle */}
      <div className="flex rounded-lg overflow-hidden border border-border text-xs">
        {MODES.map(m => (
          <button key={m.key} onClick={() => { setMode(m.key); setConfirm(null); }}
            className={`flex-1 py-1.5 font-medium transition-colors ${
              mode === m.key ? 'bg-blue-600 text-foreground' : 'bg-muted text-muted-foreground hover:bg-muted'
            }`}>
            {m.label}
          </button>
        ))}
      </div>

      {/* ── Confirm dialog ── */}
      {confirm && (
        <div className="rounded-lg border border-blue-500 bg-blue-900/30 p-3 space-y-2">
          <p className="text-xs text-blue-200 font-semibold">
            確認{confirm.action === 'buy' ? '買入' : '賣出'}？
          </p>
          <div className="text-xs font-mono text-foreground/80 space-y-0.5">
            <div className="flex justify-between">
              <span className="text-muted-foreground">股數</span>
              <span>{confirm.shares.toLocaleString()} 股</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">價格</span>
              <span>${confirm.price.toFixed(2)}</span>
            </div>
            <div className="flex justify-between font-bold">
              <span className="text-muted-foreground">金額</span>
              <span className={confirm.action === 'buy' ? 'text-bull-light' : 'text-bear-light'}>
                {confirm.action === 'buy' ? '-' : '+'}${(confirm.shares * confirm.price).toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </span>
            </div>
            <div className="flex justify-between text-muted-foreground">
              <span>手續費{confirm.action === 'sell' ? '+證交稅' : ''}</span>
              <span className="text-orange-300 font-mono">
                -${calcCommission(confirm.shares, confirm.price, confirm.action === 'buy').toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </span>
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={executeConfirmed}
              className={`flex-1 py-1.5 rounded text-xs font-bold transition ${
                confirm.action === 'buy' ? 'bg-red-600 hover:bg-red-500' : 'bg-green-700 hover:bg-green-600'
              }`}>
              確認{confirm.action === 'buy' ? '買入' : '賣出'}
            </button>
            <button onClick={() => setConfirm(null)}
              className="flex-1 py-1.5 rounded bg-secondary hover:bg-muted text-xs text-foreground/80 transition">
              取消
            </button>
          </div>
        </div>
      )}

      {/* ── Percent mode ── */}
      {!confirm && mode === 'percent' && (
        <>
          <div>
            <p className="text-xs text-muted-foreground mb-1.5">買入（現金比例）</p>
            <div className="grid grid-cols-4 gap-1.5">
              {[0.25, 0.5, 0.75, 1].map(p => {
                const amt = metrics.cash * p;
                const amtLabel = amt >= 10000 ? `${(amt / 10000).toFixed(0)}萬` : amt > 0 ? `${(amt / 1000).toFixed(0)}K` : '';
                return (
                  <button key={p} onClick={() => handleBuyPct(p)}
                    disabled={mounted && (metrics.cash <= 0 || currentPrice <= 0)}
                    className="py-1.5 rounded-lg bg-red-700 hover:bg-red-600 active:bg-red-500 disabled:opacity-30 transition flex flex-col items-center gap-0">
                    <span className="text-xs font-bold">{p * 100}%</span>
                    {amtLabel && <span className="text-[9px] opacity-70">${amtLabel}</span>}
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-1.5">賣出（持倉比例）</p>
            <div className="grid grid-cols-4 gap-1.5">
              {[0.25, 0.5, 0.75, 1].map(p => {
                const sellShares = Math.floor(metrics.shares * p);
                const sellAmt = sellShares * currentPrice;
                const amtLabel = sellAmt >= 10000 ? `${(sellAmt / 10000).toFixed(0)}萬` : sellAmt > 0 ? `${(sellAmt / 1000).toFixed(0)}K` : '';
                return (
                  <button key={p} onClick={() => handleSellPct(p)}
                    disabled={metrics.shares <= 0}
                    className="py-1.5 rounded-lg bg-green-700 hover:bg-green-600 active:bg-green-500 disabled:opacity-30 transition flex flex-col items-center gap-0">
                    <span className="text-xs font-bold">{p * 100}%</span>
                    {amtLabel && <span className="text-[9px] opacity-70">${amtLabel}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}

      {/* ── Shares mode ── */}
      {!confirm && mode === 'shares' && (
        <>
          <div>
            <p className="text-xs text-muted-foreground mb-1.5">
              可買最多 <span className="text-foreground font-mono">{maxBuy.toLocaleString()}</span> 股
            </p>
            <input type="number" value={input} onChange={e => setInput(e.target.value)}
              placeholder="輸入股數"
              className="w-full bg-muted rounded-lg px-3 py-2 text-sm text-foreground border border-border focus:border-blue-500 focus:outline-none" />
            {inputNum > 0 && currentPrice > 0 && (
              <p className="text-xs text-muted-foreground mt-1">
                預估金額 ≈ <span className="text-foreground/80">${estimatedCostFromShares.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
              </p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button onClick={handleBuy} disabled={mounted && (metrics.cash <= 0 || currentPrice <= 0)}
              className="py-2.5 rounded-lg bg-red-700 hover:bg-red-600 disabled:opacity-30 text-sm font-bold transition">買入</button>
            <button onClick={handleSell} disabled={metrics.shares <= 0}
              className="py-2.5 rounded-lg bg-green-700 hover:bg-green-600 disabled:opacity-30 text-sm font-bold transition">賣出</button>
          </div>
        </>
      )}

      {/* ── Amount mode ── */}
      {!confirm && mode === 'amount' && (
        <>
          <div>
            <p className="text-xs text-muted-foreground mb-1.5">
              現金餘額 <span className="text-foreground font-mono">${metrics.cash.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
            </p>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
              <input type="number" value={input} onChange={e => setInput(e.target.value)}
                placeholder="輸入金額（例：50000）"
                className="w-full bg-muted rounded-lg pl-7 pr-3 py-2 text-sm text-foreground border border-border focus:border-blue-500 focus:outline-none" />
            </div>
            {inputNum > 0 && currentPrice > 0 && (
              <p className="text-xs text-muted-foreground mt-1">
                可買約 <span className="text-foreground/80 font-mono">{estimatedSharesFromAmount.toLocaleString()}</span> 股
              </p>
            )}
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            {[50000, 100000, 200000, 500000].map(amt => (
              <button key={amt} onClick={() => setInput(String(amt))}
                className="py-1.5 rounded-lg bg-secondary hover:bg-muted text-xs text-foreground/80 transition">
                {amt >= 10000 ? `${amt / 10000}萬` : amt}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button onClick={handleBuy} disabled={mounted && (metrics.cash <= 0 || estimatedSharesFromAmount <= 0)}
              className="py-2.5 rounded-lg bg-red-700 hover:bg-red-600 disabled:opacity-30 text-sm font-bold transition">買入</button>
            <button onClick={handleSell} disabled={metrics.shares <= 0 || estimatedSharesFromAmount <= 0}
              className="py-2.5 rounded-lg bg-green-700 hover:bg-green-600 disabled:opacity-30 text-sm font-bold transition">賣出</button>
          </div>
        </>
      )}

      {/* ── Six Conditions ── */}
      {sixConditions && (
        <div className="rounded-lg bg-muted/40 border border-border px-3 py-2 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-foreground/80">策略條件</span>
            <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${
              sixConditions.totalScore >= 5 ? 'bg-amber-500/20 text-amber-400' :
              sixConditions.totalScore >= 4 ? 'bg-emerald-500/20 text-emerald-400' :
              sixConditions.totalScore >= 3 ? 'bg-sky-500/20 text-sky-400' :
              'bg-secondary text-muted-foreground'
            }`}>
              {sixConditions.totalScore}/6
            </span>
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
            {([
              { label: '趨勢',   ok: sixConditions.trend.pass },
              { label: '位置',   ok: sixConditions.position.pass },
              { label: 'K棒',   ok: sixConditions.kbar.pass },
              { label: '均線',   ok: sixConditions.ma.pass },
              { label: '量能',   ok: sixConditions.volume.pass },
              { label: '指標',   ok: sixConditions.indicator.pass },
            ] as { label: string; ok: boolean }[]).map(({ label, ok }) => (
              <div key={label} className="flex items-center gap-1">
                <span className={ok ? 'text-emerald-400' : 'text-muted-foreground/60'}>{ok ? '✓' : '✗'}</span>
                <span className={ok ? 'text-foreground/80' : 'text-muted-foreground/60'}>{label}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Stop-loss info (when holding) ── */}
      {metrics.shares > 0 && stopLossPrice != null && (
        <div className={`rounded-lg px-3 py-2 text-xs space-y-0.5 ${showStopLossWarn ? 'bg-red-900/60 border border-red-600' : 'bg-muted/60'}`}>
          {showStopLossWarn && (
            <p className="text-red-400 font-bold">⚠ 黑K跌破MA5，考慮停損！</p>
          )}
          <div className="flex justify-between text-muted-foreground">
            <span>建議停損</span>
            <span className="text-red-300 font-mono font-bold">${stopLossPrice.toFixed(2)}</span>
          </div>
          {ma5StopLoss != null && <div className="flex justify-between text-muted-foreground"><span>MA5</span><span className="font-mono">${ma5StopLoss.toFixed(2)}</span></div>}
          {costStopLoss != null && <div className="flex justify-between text-muted-foreground"><span>成本 -7%</span><span className="font-mono">${costStopLoss.toFixed(2)}</span></div>}
        </div>
      )}

      <p className="text-xs text-muted-foreground/60 text-center">以收盤價成交，含手續費與稅</p>
    </div>
  );
}
