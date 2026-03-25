'use client';

import { useState } from 'react';
import { useReplayStore } from '@/store/replayStore';
import { ruleEngine } from '@/lib/rules/ruleEngine';

const INITIAL_CAPITAL = 1_000_000;
const MARKER_PRIORITY: Record<string, number> = { SELL: 4, BUY: 3, REDUCE: 2, ADD: 1, WATCH: 0 };

interface Trade {
  buyDate: string;
  buyPrice: number;
  sellDate: string | null;
  sellPrice: number | null;
  shares: number;
  pnl: number | null;
  pnlPct: number | null;
  open: boolean; // still holding
}

interface BacktestResult {
  trades: Trade[];
  totalPnL: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  finalValue: number;
  returnRate: number;
}

export default function BacktestPanel() {
  const { allCandles } = useReplayStore();

  const minDate = allCandles[0]?.date ?? '';
  const maxDate = allCandles[allCandles.length - 1]?.date ?? '';

  const [startDate, setStartDate] = useState(minDate);
  const [endDate, setEndDate]     = useState(maxDate);
  const [result, setResult]       = useState<BacktestResult | null>(null);
  const [show, setShow]           = useState(false);

  function runBacktest() {
    if (allCandles.length === 0) return;

    // Build date→index map once
    const idxMap = new Map(allCandles.map((c, i) => [c.date, i]));

    const filtered = allCandles.filter(c => c.date >= startDate && c.date <= endDate);
    if (filtered.length === 0) { setResult({ trades: [], totalPnL: 0, winCount: 0, lossCount: 0, winRate: 0, finalValue: INITIAL_CAPITAL, returnRate: 0 }); return; }

    let cash = INITIAL_CAPITAL;
    let shares = 0;
    let buyPrice = 0;
    let buyDate = '';
    const trades: Trade[] = [];

    for (const c of filtered) {
      const globalIdx = idxMap.get(c.date);
      if (globalIdx == null) continue;

      const isBullish = c.ma5 != null && c.ma20 != null && c.ma5 > c.ma20;
      const isBearish = c.ma5 != null && c.ma20 != null && c.ma5 < c.ma20;

      const signals = ruleEngine.evaluate(allCandles, globalIdx)
        .filter(s => s.type !== 'WATCH')
        .filter(s => {
          if (s.type === 'BUY' || s.type === 'ADD')    return isBullish;
          if (s.type === 'SELL' || s.type === 'REDUCE') return isBearish;
          return true;
        });

      if (signals.length === 0) continue;

      const best = signals.reduce((a, b) =>
        (MARKER_PRIORITY[b.type] ?? 0) > (MARKER_PRIORITY[a.type] ?? 0) ? b : a
      );

      if ((best.type === 'BUY' || best.type === 'ADD') && shares === 0 && cash > 0) {
        shares   = Math.floor(cash / c.close);
        buyPrice = c.close;
        buyDate  = c.date;
        cash    -= shares * c.close;
      } else if ((best.type === 'SELL' || best.type === 'REDUCE') && shares > 0) {
        const revenue = shares * c.close;
        const pnl     = revenue - shares * buyPrice;
        trades.push({ buyDate, buyPrice, sellDate: c.date, sellPrice: c.close, shares, pnl, pnlPct: (pnl / (shares * buyPrice)) * 100, open: false });
        cash  += revenue;
        shares = 0;
      }
    }

    // Still holding at period end
    if (shares > 0) {
      const lastPrice = filtered[filtered.length - 1].close;
      const pnl       = shares * lastPrice - shares * buyPrice;
      trades.push({ buyDate, buyPrice, sellDate: null, sellPrice: lastPrice, shares, pnl, pnlPct: (pnl / (shares * buyPrice)) * 100, open: true });
    }

    const closed     = trades.filter(t => !t.open);
    const wins       = closed.filter(t => (t.pnl ?? 0) > 0).length;
    const totalPnL   = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const lastClose  = filtered[filtered.length - 1]?.close ?? 0;
    const finalValue = cash + shares * lastClose;

    setResult({
      trades,
      totalPnL,
      winCount: wins,
      lossCount: closed.length - wins,
      winRate: closed.length > 0 ? (wins / closed.length) * 100 : 0,
      finalValue,
      returnRate: ((finalValue - INITIAL_CAPITAL) / INITIAL_CAPITAL) * 100,
    });
  }

  return (
    <div className="bg-slate-800/80 border border-slate-700 rounded-xl overflow-hidden">
      {/* Header toggle */}
      <button
        onClick={() => setShow(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-sm font-bold text-slate-200 hover:bg-slate-700/50 transition"
      >
        <span>📊 自動走圖分析（回測）</span>
        <span className="text-slate-400 text-xs">{show ? '▲ 收起' : '▼ 展開'}</span>
      </button>

      {show && (
        <div className="px-4 pb-4 space-y-4 border-t border-slate-700">
          {/* Inputs */}
          <div className="flex flex-wrap gap-3 pt-3 items-end">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-slate-400">起始日期</label>
              <input type="date" value={startDate} min={minDate} max={endDate}
                onChange={e => setStartDate(e.target.value)}
                className="bg-slate-700 border border-slate-600 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-slate-400">結束日期</label>
              <input type="date" value={endDate} min={startDate} max={maxDate}
                onChange={e => setEndDate(e.target.value)}
                className="bg-slate-700 border border-slate-600 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500" />
            </div>
            <button onClick={runBacktest}
              className="px-5 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-xs font-bold text-white transition">
              開始分析
            </button>
          </div>

          {/* Results */}
          {result && (
            <div className="space-y-3">
              {/* Summary cards */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {[
                  { label: '總損益', value: `${result.totalPnL >= 0 ? '+' : ''}${result.totalPnL.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`, color: result.totalPnL >= 0 ? 'text-red-400' : 'text-green-400' },
                  { label: '報酬率', value: `${result.returnRate >= 0 ? '+' : ''}${result.returnRate.toFixed(2)}%`, color: result.returnRate >= 0 ? 'text-red-400' : 'text-green-400' },
                  { label: '勝率', value: `${result.winRate.toFixed(1)}%`, color: 'text-blue-400' },
                  { label: `交易 ${result.trades.length} 筆`, value: `${result.winCount}勝 ${result.lossCount}敗`, color: 'text-slate-300' },
                ].map(({ label, value, color }) => (
                  <div key={label} className="bg-slate-900 rounded-lg p-3 text-center">
                    <div className="text-xs text-slate-400 mb-1">{label}</div>
                    <div className={`text-sm font-bold ${color}`}>{value}</div>
                  </div>
                ))}
              </div>

              {/* Trade list */}
              {result.trades.length > 0 ? (
                <div className="max-h-72 overflow-y-auto space-y-1 pr-1">
                  {result.trades.map((t, i) => (
                    <div key={i} className="grid grid-cols-[1.5rem_1fr_1fr_auto] gap-2 items-center text-xs font-mono bg-slate-900 rounded-lg px-3 py-2">
                      <span className="text-slate-500">{i + 1}</span>

                      <div>
                        <span className="text-red-400 font-bold">買 </span>
                        <span className="text-slate-300">{t.buyDate}</span>
                        <span className="text-slate-500 text-[10px] ml-1">@{t.buyPrice.toFixed(2)}</span>
                      </div>

                      <div>
                        {t.open ? (
                          <span className="text-yellow-400">持倉中 @{t.sellPrice?.toFixed(2)}</span>
                        ) : (
                          <>
                            <span className="text-green-400 font-bold">賣 </span>
                            <span className="text-slate-300">{t.sellDate}</span>
                            <span className="text-slate-500 text-[10px] ml-1">@{t.sellPrice?.toFixed(2)}</span>
                          </>
                        )}
                      </div>

                      <div className={`text-right font-bold ${(t.pnl ?? 0) >= 0 ? 'text-red-400' : 'text-green-400'}`}>
                        {(t.pnl ?? 0) >= 0 ? '+' : ''}{t.pnl?.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}
                        <span className="text-[10px] ml-1 opacity-70">({t.pnlPct?.toFixed(1)}%)</span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-slate-500 text-xs text-center py-6">此區間無符合條件的交易信號</p>
              )}

              <p className="text-[10px] text-slate-600 text-right">
                * 以收盤價成交，每次全倉進出，僅供學習參考
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
