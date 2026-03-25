'use client';

import { useState } from 'react';
import { useReplayStore } from '@/store/replayStore';
import { ruleEngine } from '@/lib/rules/ruleEngine';

const MARKER_PRIORITY: Record<string, number> = { SELL: 4, BUY: 3, REDUCE: 2, ADD: 1, WATCH: 0 };

const POSITION_OPTIONS = [
  { label: '全倉', pct: 1.0 },
  { label: '半倉', pct: 0.5 },
  { label: '三成', pct: 0.3 },
];

interface Trade {
  buyDate: string;
  buyPrice: number;
  buyLabel: string;
  buyDescription: string;
  buyReason: string;
  sellDate: string | null;
  sellPrice: number | null;
  sellLabel: string | null;
  sellDescription: string | null;
  sellReason: string | null;
  shares: number;
  invested: number;
  pnl: number | null;
  pnlPct: number | null;
  open: boolean;
}

interface BacktestResult {
  trades: Trade[];
  initialCapital: number;
  totalPnL: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  finalValue: number;
  returnRate: number;
  maxDrawdown: number;   // % from peak
  avgHoldDays: number;
}

function parseYMD(dateStr: string): number {
  return new Date(dateStr).getTime();
}

function TradeCard({ trade: t, index: i, fmt }: { trade: Trade; index: number; fmt: (n: number) => string }) {
  const [expanded, setExpanded] = useState(false);
  const pnlPos = (t.pnl ?? 0) >= 0;

  return (
    <div className="bg-slate-900 rounded-lg overflow-hidden">
      {/* Summary row — always visible */}
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-slate-800/60 transition text-left"
      >
        <span className="text-slate-600 text-xs w-4 shrink-0">{i + 1}</span>
        <div className="flex-1 min-w-0 text-xs font-mono">
          <span className="text-red-400 font-bold">買 </span>
          <span className="text-slate-300">{t.buyDate}</span>
          <span className="text-slate-500 mx-1">@{t.buyPrice.toFixed(2)}</span>
          {!t.open && (
            <>
              <span className="text-slate-600 mx-1">→</span>
              <span className="text-green-400 font-bold">賣 </span>
              <span className="text-slate-300">{t.sellDate}</span>
              <span className="text-slate-500 mx-1">@{t.sellPrice?.toFixed(2)}</span>
            </>
          )}
          {t.open && <span className="text-yellow-400 ml-2">持倉中</span>}
        </div>
        <div className={`text-xs font-bold shrink-0 ${pnlPos ? 'text-red-400' : 'text-green-400'}`}>
          {pnlPos ? '+' : ''}{fmt(t.pnl ?? 0)}
          <span className="text-[10px] ml-1 opacity-70">({t.pnlPct?.toFixed(1)}%)</span>
        </div>
        <span className="text-slate-600 text-[10px] shrink-0">{expanded ? '▲' : '▼'}</span>
      </button>

      {/* Detail — expanded */}
      {expanded && (
        <div className="px-3 pb-3 space-y-2 border-t border-slate-800 pt-2 text-xs">
          {/* Buy detail */}
          <div className="space-y-0.5">
            <div className="flex flex-wrap gap-x-3 text-slate-400 font-mono">
              <span className="text-red-400 font-bold">買進</span>
              <span>{t.buyDate} @{t.buyPrice.toFixed(2)}</span>
              <span>{t.shares.toLocaleString()} 股</span>
              <span>投入 {fmt(t.invested)} 元</span>
            </div>
            <div className="text-amber-300 font-semibold">▶ {t.buyLabel}</div>
            <div className="text-slate-400 leading-relaxed">{t.buyDescription}</div>
            {t.buyReason && (
              <div className="text-slate-500 leading-relaxed whitespace-pre-line border-l-2 border-amber-900/50 pl-2 mt-1">
                {t.buyReason}
              </div>
            )}
          </div>

          {/* Sell detail */}
          {!t.open && (
            <div className="space-y-0.5 border-t border-slate-800 pt-2">
              <div className="flex flex-wrap gap-x-3 text-slate-400 font-mono">
                <span className="text-green-400 font-bold">賣出</span>
                <span>{t.sellDate} @{t.sellPrice?.toFixed(2)}</span>
                <span className={pnlPos ? 'text-red-400' : 'text-green-400'}>
                  損益 {pnlPos ? '+' : ''}{fmt(t.pnl ?? 0)} ({t.pnlPct?.toFixed(1)}%)
                </span>
              </div>
              {t.sellLabel && <div className="text-teal-300 font-semibold">▶ {t.sellLabel}</div>}
              {t.sellDescription && <div className="text-slate-400 leading-relaxed">{t.sellDescription}</div>}
              {t.sellReason && (
                <div className="text-slate-500 leading-relaxed whitespace-pre-line border-l-2 border-teal-900/50 pl-2 mt-1">
                  {t.sellReason}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function BacktestPanel() {
  const { allCandles } = useReplayStore();

  const minDate = allCandles[0]?.date ?? '';
  const maxDate = allCandles[allCandles.length - 1]?.date ?? '';

  const [startDate,    setStartDate]    = useState(minDate);
  const [endDate,      setEndDate]      = useState(maxDate);
  const [capitalInput, setCapitalInput] = useState('1000000');
  const [positionPct,  setPositionPct]  = useState(1.0);
  const [result,       setResult]       = useState<BacktestResult | null>(null);
  const [show,         setShow]         = useState(false);
  const [mode,         setMode]         = useState<'composite' | 'signal'>('composite');

  function runBacktest() {
    if (allCandles.length === 0) return;

    const initialCapital = Math.max(10_000, Number(capitalInput.replace(/,/g, '')) || 1_000_000);

    const idxMap  = new Map(allCandles.map((c, i) => [c.date, i]));
    const filtered = allCandles.filter(c => c.date >= startDate && c.date <= endDate);
    if (filtered.length === 0) {
      setResult({ trades: [], initialCapital, totalPnL: 0, winCount: 0, lossCount: 0, winRate: 0, finalValue: initialCapital, returnRate: 0, maxDrawdown: 0, avgHoldDays: 0 });
      return;
    }

    let cash     = initialCapital;
    let shares   = 0;
    let buyPrice       = 0;
    let buyDate        = '';
    let buyLabel       = '';
    let buyDescription = '';
    let buyReason      = '';
    const trades: Trade[] = [];

    // For max drawdown
    let peak = initialCapital;
    let maxDrawdown = 0;

    for (let fi = 0; fi < filtered.length; fi++) {
      const c = filtered[fi];
      const globalIdx = idxMap.get(c.date);
      if (globalIdx == null) continue;

      // Update equity peak / drawdown
      const equity = cash + shares * c.close;
      if (equity > peak) peak = equity;
      const dd = (peak - equity) / peak * 100;
      if (dd > maxDrawdown) maxDrawdown = dd;

      if (mode === 'composite') {
        // ── 朱老師複合進場條件 ──────────────────────────────────────────
        // Buy: 長紅K(body>2%) + MA多頭排列(MA5>MA10>MA20) + 量增(>1.3x均量)
        const bodyPct = c.open > 0 ? Math.abs(c.close - c.open) / c.open : 0;
        const isLongRed = c.close > c.open && bodyPct >= 0.02;
        const bullishMA = c.ma5 != null && c.ma10 != null && c.ma20 != null
          && c.ma5 > c.ma10 && c.ma10 > c.ma20;
        const volIncrease = c.avgVol5 != null && c.avgVol5 > 0 && c.volume >= c.avgVol5 * 1.3;
        const canBuy = isLongRed && bullishMA && volIncrease;

        // Sell: 黑K + 收盤跌破MA5（由上方穿越至下方）
        const prevC = fi > 0 ? filtered[fi - 1] : null;
        const isBlackK = c.close < c.open;
        const breaksMA5 = prevC != null && prevC.ma5 != null && c.ma5 != null
          && prevC.close >= prevC.ma5 && c.close < c.ma5;
        const canSell = isBlackK && breaksMA5;

        if (canBuy && shares === 0 && cash > 0) {
          const budget = cash * positionPct;
          shares = Math.floor(budget / c.close);
          buyPrice = c.close;
          buyDate  = c.date;
          buyLabel = '複合條件買入（長紅K+MA多排+量增）';
          buyDescription = `長紅K實體${(bodyPct * 100).toFixed(1)}%，MA5(${c.ma5?.toFixed(2)})>MA10(${c.ma10?.toFixed(2)})>MA20(${c.ma20?.toFixed(2)})，量 ${c.volume} vs 均量 ${c.avgVol5}`;
          buyReason = '【朱老師SOP】三條件同時滿足：①長紅K棒突破 ②MA多頭排列 ③量能放大';
          cash -= shares * c.close;
        } else if (canSell && shares > 0) {
          const revenue  = shares * c.close;
          const invested = shares * buyPrice;
          const pnl      = revenue - invested;
          trades.push({
            buyDate, buyPrice, buyLabel, buyDescription, buyReason,
            sellDate: c.date, sellPrice: c.close,
            sellLabel: '停損出場（黑K破MA5）',
            sellDescription: `黑K收盤 ${c.close} 跌破MA5 ${c.ma5}`,
            sellReason: '【朱老師停損SOP】黑K棒收盤跌破5日均線，立即停損出場。',
            shares, invested, pnl,
            pnlPct: (pnl / invested) * 100,
            open: false,
          });
          cash  += revenue;
          shares = 0;
        }
      } else {
        // ── 原信號驅動模式 ───────────────────────────────────────────────
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
          const budget   = cash * positionPct;
          shares         = Math.floor(budget / c.close);
          buyPrice       = c.close;
          buyDate        = c.date;
          buyLabel       = best.label;
          buyDescription = best.description;
          buyReason      = best.reason;
          cash          -= shares * c.close;
        } else if ((best.type === 'SELL' || best.type === 'REDUCE') && shares > 0) {
          const revenue  = shares * c.close;
          const invested = shares * buyPrice;
          const pnl      = revenue - invested;
          trades.push({
            buyDate, buyPrice, buyLabel, buyDescription, buyReason,
            sellDate: c.date, sellPrice: c.close,
            sellLabel: best.label, sellDescription: best.description, sellReason: best.reason,
            shares, invested, pnl,
            pnlPct: (pnl / invested) * 100,
            open: false,
          });
          cash  += revenue;
          shares = 0;
        }
      }
    }

    // Open position at period end
    if (shares > 0) {
      const lastPrice = filtered[filtered.length - 1].close;
      const invested  = shares * buyPrice;
      const pnl       = shares * lastPrice - invested;
      trades.push({
        buyDate, buyPrice, buyLabel, buyDescription, buyReason,
        sellDate: null, sellPrice: lastPrice,
        sellLabel: null, sellDescription: null, sellReason: null,
        shares, invested, pnl,
        pnlPct: (pnl / invested) * 100,
        open: true,
      });
    }

    const closed  = trades.filter(t => !t.open);
    const wins    = closed.filter(t => (t.pnl ?? 0) > 0).length;
    const totalPnL = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const lastClose = filtered[filtered.length - 1]?.close ?? 0;
    const finalValue = cash + shares * lastClose;

    // Average hold duration (days) for closed trades
    const holdDays = closed
      .filter(t => t.sellDate)
      .map(t => Math.round((parseYMD(t.sellDate!) - parseYMD(t.buyDate)) / 86400000));
    const avgHoldDays = holdDays.length > 0 ? holdDays.reduce((a, b) => a + b, 0) / holdDays.length : 0;

    setResult({
      trades, initialCapital,
      totalPnL,
      winCount: wins,
      lossCount: closed.length - wins,
      winRate: closed.length > 0 ? (wins / closed.length) * 100 : 0,
      finalValue,
      returnRate: ((finalValue - initialCapital) / initialCapital) * 100,
      maxDrawdown,
      avgHoldDays,
    });
  }

  const fmt = (n: number) => n.toLocaleString('zh-TW', { maximumFractionDigits: 0 });

  return (
    <div className="bg-slate-800/80 border border-slate-700 rounded-xl overflow-hidden">
      <button
        onClick={() => setShow(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-sm font-bold text-slate-200 hover:bg-slate-700/50 transition"
      >
        <span>📊 自動走圖分析（回測）</span>
        <span className="text-slate-400 text-xs">{show ? '▲ 收起' : '▼ 展開'}</span>
      </button>

      {show && (
        <div className="px-4 pb-1 border-b border-slate-700 flex gap-2">
          <span className="text-xs text-slate-400 self-center">回測模式：</span>
          <button
            onClick={() => setMode('composite')}
            className={`px-3 py-1 rounded text-xs font-medium transition ${mode === 'composite' ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-400 hover:bg-slate-600'}`}
          >
            朱老師複合條件
          </button>
          <button
            onClick={() => setMode('signal')}
            className={`px-3 py-1 rounded text-xs font-medium transition ${mode === 'signal' ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-400 hover:bg-slate-600'}`}
          >
            信號驅動
          </button>
        </div>
      )}

      {show && (
        <div className="px-4 pb-4 space-y-4 border-t border-slate-700">

          {/* ── Settings ── */}
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
            <div className="flex flex-col gap-1">
              <label className="text-xs text-slate-400">初始資金（元）</label>
              <input type="text" value={capitalInput}
                onChange={e => setCapitalInput(e.target.value)}
                placeholder="1000000"
                className="bg-slate-700 border border-slate-600 rounded-lg px-2 py-1.5 text-xs text-white w-32 focus:outline-none focus:border-blue-500" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-slate-400">每次倉位</label>
              <div className="flex gap-1">
                {POSITION_OPTIONS.map(opt => (
                  <button key={opt.label} onClick={() => setPositionPct(opt.pct)}
                    className={`px-2 py-1.5 rounded-lg text-xs font-medium transition ${positionPct === opt.pct ? 'bg-blue-600 text-white' : 'bg-slate-700 hover:bg-slate-600 text-slate-400'}`}>
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            <button onClick={runBacktest}
              className="px-5 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-xs font-bold text-white transition">
              開始分析
            </button>
          </div>

          {/* ── Results ── */}
          {result && (
            <div className="space-y-3">

              {/* Summary cards */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {[
                  {
                    label: '總損益',
                    value: `${result.totalPnL >= 0 ? '+' : ''}${fmt(result.totalPnL)}`,
                    sub: `初始 ${fmt(result.initialCapital)}`,
                    color: result.totalPnL >= 0 ? 'text-red-400' : 'text-green-400',
                  },
                  {
                    label: '報酬率',
                    value: `${result.returnRate >= 0 ? '+' : ''}${result.returnRate.toFixed(2)}%`,
                    sub: `最終 ${fmt(result.finalValue)}`,
                    color: result.returnRate >= 0 ? 'text-red-400' : 'text-green-400',
                  },
                  {
                    label: `${result.winCount}勝 ${result.lossCount}敗`,
                    value: `勝率 ${result.winRate.toFixed(1)}%`,
                    sub: `共 ${result.trades.length} 筆`,
                    color: 'text-blue-400',
                  },
                  {
                    label: '最大回撤',
                    value: `-${result.maxDrawdown.toFixed(1)}%`,
                    sub: `平均持倉 ${result.avgHoldDays.toFixed(0)} 天`,
                    color: 'text-orange-400',
                  },
                ].map(({ label, value, sub, color }) => (
                  <div key={label} className="bg-slate-900 rounded-lg p-3 text-center">
                    <div className="text-xs text-slate-400 mb-1">{label}</div>
                    <div className={`text-sm font-bold ${color}`}>{value}</div>
                    <div className="text-[10px] text-slate-500 mt-0.5">{sub}</div>
                  </div>
                ))}
              </div>

              {/* Trade list */}
              {result.trades.length > 0 ? (
                <div className="max-h-[32rem] overflow-y-auto space-y-2 pr-1">
                  {result.trades.map((t, i) => (
                    <TradeCard key={i} trade={t} index={i} fmt={fmt} />
                  ))}
                </div>
              ) : (
                <p className="text-slate-500 text-xs text-center py-6">此區間無符合條件的交易信號</p>
              )}

              <p className="text-[10px] text-slate-600 text-right">
                * 以收盤價成交，不含手續費，僅供學習參考
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
