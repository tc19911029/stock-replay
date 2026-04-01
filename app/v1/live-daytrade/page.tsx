'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useDaytradeStore } from '@/store/daytradeStore';
import type { IntradayTimeframe } from '@/lib/daytrade/types';
import { PositionCalculator, TradeJournal } from '@/features/daytrade';
import { MultiTFPanel } from '@/components/daytrade/MultiTFPanel';
import { TradeAccountPanel } from '@/components/daytrade/TradeAccountPanel';
import { SignalListPanel } from '@/components/daytrade/SignalListPanel';
import { ValidationPanel } from '@/components/daytrade/ValidationPanel';
import { EODReportPanel } from '@/components/daytrade/EODReportPanel';
import { SignalBacktestPanel } from '@/components/daytrade/SignalBacktestPanel';
import { StrategyOptimizerPanel } from '@/components/daytrade/StrategyOptimizerPanel';
import { IntradayChartFull } from '@/components/daytrade/IntradayChartFull';

// ═══════════════════════════════════════════════════════════════════════════════
// Stock List (same as main page StockSelector)
// ═══════════════════════════════════════════════════════════════════════════════

const DEFAULT_QUICK_STOCKS = [
  { symbol: '2330', name: '台積電' }, { symbol: '2317', name: '鴻海' },
  { symbol: '2454', name: '聯發科' }, { symbol: '2308', name: '台達電' },
  { symbol: '6770', name: '力積電' }, { symbol: '3008', name: '大立光' },
  { symbol: '2382', name: '廣達' },   { symbol: '2881', name: '富邦金' },
  { symbol: '2882', name: '國泰金' }, { symbol: '2412', name: '中華電' },
  { symbol: '2357', name: '華碩' },   { symbol: '2303', name: '聯電' },
  { symbol: '2886', name: '兆豐金' }, { symbol: '2891', name: '中信金' },
  { symbol: '2884', name: '玉山金' }, { symbol: '3034', name: '聯詠' },
  { symbol: '2345', name: '智邦' },   { symbol: '2618', name: '長榮航' },
  { symbol: '2609', name: '陽明' },   { symbol: '2615', name: '萬海' },
  { symbol: '2603', name: '長榮' },   { symbol: '3443', name: '創意' },
  { symbol: '6669', name: '緯穎' },   { symbol: '3037', name: '欣興' },
  { symbol: '2002', name: '中鋼' },   { symbol: '1301', name: '台塑' },
];

const STOCK_NAME_MAP = new Map(DEFAULT_QUICK_STOCKS.map(s => [s.symbol, s.name]));

function loadCustomStocks(): typeof DEFAULT_QUICK_STOCKS {
  if (typeof window === 'undefined') return DEFAULT_QUICK_STOCKS;
  try {
    const saved = localStorage.getItem('daytrade_quick_stocks');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {}
  return DEFAULT_QUICK_STOCKS;
}

function saveCustomStocks(stocks: typeof DEFAULT_QUICK_STOCKS) {
  try { localStorage.setItem('daytrade_quick_stocks', JSON.stringify(stocks)); } catch {}
}

// ═══════════════════════════════════════════════════════════════════════════════
// Side Tabs
// ═══════════════════════════════════════════════════════════════════════════════

const SIDE_TABS = [
  { key: 'mtf',      label: '多週期' },
  { key: 'trade',    label: '交易/帳戶' },
  { key: 'signals',  label: '訊號' },
  { key: 'validate', label: '驗證' },
  { key: 'eod',      label: '結算' },
  { key: 'sigbt',    label: '訊號回測' },
  { key: 'optim',    label: '策略優化' },
  { key: 'posjnl',  label: '倉位/日誌' },
] as const;

type SideTabKey = typeof SIDE_TABS[number]['key'];

// ═══════════════════════════════════════════════════════════════════════════════
// Main Page
// ═══════════════════════════════════════════════════════════════════════════════

export default function LiveDaytradePage() {
  const {
    symbol, setSymbol, date, setDate,
    selectedTimeframe, setTimeframe,
    stockName: storeStockName,
    latestPrice, openPrice, highPrice, lowPrice, dayVolume,
    displayCandles,
    isLoading, error, loadData,
    currentSignals, mtfState, hoverCandle,
    todayOnly, setTodayOnly,
    autoRefresh, toggleAutoRefresh,
    viewMode, setViewMode, newSignalAlert, clearAlert,
    autoTrade, setAutoTrade, generateEODReport,
    lastUpdateTime,
    isReplaying, replayIndex, replaySpeed,
    startReplay, stopReplay, nextBar, setReplaySpeed,
  } = useDaytradeStore();

  const [sideTab, setSideTab] = useState<SideTabKey>('mtf');
  const [input, setInput] = useState(symbol);
  const [showDrop, setShowDrop] = useState(false);
  const dropRef = useRef<HTMLDivElement>(null);
  const [quickStocks, setQuickStocks] = useState(DEFAULT_QUICK_STOCKS);
  const [addStockInput, setAddStockInput] = useState('');

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => { setQuickStocks(loadCustomStocks()); }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    loadData();
    if (viewMode === 'live' && !autoRefresh) {
      toggleAutoRefresh();
    }
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) setShowDrop(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleLoad = (sym?: string) => {
    const s = sym ?? input;
    setSymbol(s);
    setInput(s);
    setShowDrop(false);
    setTimeout(() => loadData(), 50);
  };

  const filteredStocks = input.length > 0
    ? quickStocks.filter(s => s.symbol.includes(input.toUpperCase()) || s.name.includes(input))
    : quickStocks;

  const stockName = storeStockName || STOCK_NAME_MAP.get(symbol) || '';
  const displayC = hoverCandle ?? displayCandles[displayCandles.length - 1];
  const dispPrice = displayC?.close ?? latestPrice;
  const dispOpen  = displayC?.open ?? openPrice;
  const dispHigh  = displayC?.high ?? highPrice;
  const dispLow   = displayC?.low ?? lowPrice;
  const dispVol   = displayC?.volume ?? dayVolume;
  const dispTime  = displayC?.time ?? '';
  const dispChange = dispPrice - openPrice;
  const dispChangePct = openPrice > 0 ? (dispChange / openPrice) * 100 : 0;
  const isUp = dispChange >= 0;

  const tfGroups = [
    { label: '分鐘', items: ['1m','3m','5m','15m','30m','60m'] as IntradayTimeframe[] },
    { label: '日週月', items: ['1d','1wk','1mo'] as IntradayTimeframe[] },
  ];
  const total = displayCandles.length;
  const pct = total > 0 ? Math.round(((replayIndex + 1) / total) * 100) : 0;

  const latestBuySell = currentSignals.filter(s => s.type === 'BUY' || s.type === 'SELL').slice(-1)[0];

  useEffect(() => {
    if (newSignalAlert) {
      const t = setTimeout(() => clearAlert(), 5000);
      return () => clearTimeout(t);
    }
  }, [newSignalAlert]);

  return (
    <div className="h-screen flex flex-col bg-slate-950 text-white overflow-hidden">

      {/* ── Header ── */}
      <header className="shrink-0 border-b border-slate-800 bg-slate-950 px-3 py-1.5 flex items-center gap-2 min-w-0">
        <span className="text-sm font-bold text-violet-400 whitespace-nowrap shrink-0">⚡ 當沖助手</span>
        <span className="text-[9px] bg-amber-600 text-white px-1.5 py-0.5 rounded-full font-bold animate-pulse shrink-0">BETA</span>

        {/* Stock selector with dropdown */}
        <div ref={dropRef} className="relative shrink-0">
          <div className="flex items-center bg-slate-700 rounded border border-slate-600 focus-within:border-sky-500 overflow-hidden">
            <input
              type="text"
              value={input}
              onChange={e => { setInput(e.target.value); setShowDrop(true); }}
              onFocus={() => setShowDrop(true)}
              onKeyDown={e => { if (e.key === 'Enter' && input.trim()) handleLoad(input.trim()); }}
              placeholder="代號/名稱"
              className="w-28 bg-transparent px-2 py-1 text-xs text-white font-mono font-bold focus:outline-none"
            />
            {stockName && !showDrop && (
              <span className="text-[10px] text-slate-400 pr-2 truncate max-w-[60px]">{stockName}</span>
            )}
          </div>
          {showDrop && (
            <div className="absolute top-full left-0 mt-1 w-52 bg-slate-700 border border-slate-600 rounded shadow-xl z-50 max-h-60 overflow-y-auto">
              {filteredStocks.map(s => (
                <div key={s.symbol} className="flex items-center hover:bg-slate-600 group">
                  <button
                    onClick={() => handleLoad(s.symbol)}
                    className="flex-1 text-left px-2 py-1.5 text-xs flex gap-2 items-center">
                    <span className="font-mono text-yellow-400 w-10 shrink-0">{s.symbol}</span>
                    <span className="text-slate-300 truncate">{s.name}</span>
                  </button>
                  {!DEFAULT_QUICK_STOCKS.some(d => d.symbol === s.symbol) && (
                    <button onClick={() => {
                      const next = quickStocks.filter(q => q.symbol !== s.symbol);
                      setQuickStocks(next); saveCustomStocks(next);
                    }} className="opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-300 px-1.5 text-[10px]" title="移除">✕</button>
                  )}
                </div>
              ))}
              {/* 新增自訂股票 */}
              <div className="border-t border-slate-600 p-1.5 flex gap-1">
                <input type="text" placeholder="新增代號" value={addStockInput}
                  onChange={e => setAddStockInput(e.target.value.toUpperCase())}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && addStockInput.trim()) {
                      const sym = addStockInput.trim();
                      if (!quickStocks.some(s => s.symbol === sym)) {
                        const next = [...quickStocks, { symbol: sym, name: sym }];
                        setQuickStocks(next); saveCustomStocks(next);
                      }
                      setAddStockInput('');
                    }
                  }}
                  className="flex-1 bg-slate-800 border border-slate-600 rounded px-1.5 py-0.5 text-[10px] text-white outline-none focus:border-sky-500 w-16" />
                <button onClick={() => {
                  const sym = addStockInput.trim();
                  if (sym && !quickStocks.some(s => s.symbol === sym)) {
                    const next = [...quickStocks, { symbol: sym, name: sym }];
                    setQuickStocks(next); saveCustomStocks(next);
                  }
                  setAddStockInput('');
                }} className="text-[10px] bg-sky-700 hover:bg-sky-600 text-white px-2 py-0.5 rounded">+</button>
              </div>
            </div>
          )}
        </div>

        <input type="date" className="bg-slate-800 border border-slate-700 rounded px-1.5 py-1 text-xs text-white focus:border-sky-500 outline-none"
          value={date} onChange={e => setDate(e.target.value)} />
        <button onClick={() => handleLoad()} disabled={isLoading}
          className="bg-sky-600 hover:bg-sky-500 disabled:bg-slate-700 text-white text-xs px-3 py-1 rounded font-bold">
          {isLoading ? '...' : '載入'}
        </button>

        {/* Timeframe switcher */}
        <span className="w-px h-4 bg-slate-700 mx-1" />
        {tfGroups.map((g, gi) => (
          <span key={gi} className="flex items-center gap-0.5">
            {gi > 0 && <span className="text-slate-700 mx-0.5">|</span>}
            {g.items.map(tf => {
              const labels: Record<string, string> = { '1d': '日', '1wk': '週', '1mo': '月' };
              return (
                <button key={tf} onClick={() => setTimeframe(tf)}
                  className={`text-[10px] px-1.5 py-0.5 rounded font-bold transition ${
                    selectedTimeframe === tf ? 'bg-sky-600 text-white' : 'text-slate-500 hover:text-white'
                  }`}>
                  {labels[tf] ?? tf}
                </button>
              );
            })}
          </span>
        ))}

        {/* Today only + Auto refresh */}
        <span className="w-px h-4 bg-slate-700 mx-1" />
        <button onClick={() => setTodayOnly(!todayOnly)}
          className={`text-[10px] px-2 py-1 rounded font-bold ${
            todayOnly ? 'bg-sky-700 text-white' : 'bg-slate-800 text-slate-500'
          }`}>
          {todayOnly ? '今日' : '多日'}
        </button>
        <button onClick={toggleAutoRefresh}
          className={`text-[10px] px-2 py-1 rounded font-bold flex items-center gap-1 ${
            autoRefresh ? 'bg-red-600 text-white animate-pulse' : 'bg-slate-800 text-slate-500 hover:text-white'
          }`}>
          <span className={`w-1.5 h-1.5 rounded-full ${autoRefresh ? 'bg-white' : 'bg-slate-600'}`} />
          {autoRefresh ? '自動刷新中' : '自動刷新'}
        </button>

        {/* Nav */}
        <nav className="flex items-center gap-0.5 ml-auto shrink-0">
          <Link href="/" className="text-[11px] px-2 py-1 rounded text-slate-400 hover:bg-slate-700 hover:text-white transition">走圖</Link>
          <Link href="/scan" className="text-[11px] px-2 py-1 rounded text-slate-400 hover:bg-slate-700 hover:text-white transition">掃描選股</Link>
          <span className="text-[10px] font-bold text-violet-500 border border-violet-700/60 bg-violet-900/30 px-2 py-1 rounded cursor-default select-none">當沖</span>
        </nav>
      </header>

      {/* ── OHLCV Bar ── */}
      {latestPrice > 0 && (
        <div className="shrink-0 flex items-center gap-x-3 gap-y-0.5 px-3 py-1 border-b border-slate-800 text-xs font-mono flex-wrap">
          {stockName && <span className="text-white font-bold font-sans mr-1">{stockName}</span>}
          <span className={hoverCandle ? 'text-blue-400' : 'text-slate-400'}>
            {hoverCandle ? dispTime.split('T')[1]?.slice(0,5) ?? symbol : symbol}
          </span>
          <span className={`text-sm font-bold ${isUp ? 'text-red-400' : 'text-green-400'}`}>{dispPrice.toFixed(2)}</span>
          <span className={`font-bold ${isUp ? 'text-red-400' : 'text-green-400'}`}>
            {isUp ? '▲' : '▼'}{Math.abs(dispChange).toFixed(2)} ({isUp ? '+' : ''}{dispChangePct.toFixed(2)}%)
          </span>
          <span className="text-slate-500">開<span className="text-white ml-0.5">{dispOpen.toFixed(2)}</span></span>
          <span className="text-slate-500">高<span className="text-red-400 ml-0.5">{dispHigh.toFixed(2)}</span></span>
          <span className="text-slate-500">低<span className="text-green-400 ml-0.5">{dispLow.toFixed(2)}</span></span>
          <span className="text-slate-500">量<span className="text-slate-300 ml-0.5">{dispVol > 1000 ? `${(dispVol/1000).toFixed(0)}K` : dispVol}</span></span>
          <span className="text-slate-500 ml-1">MA5 <span className="text-amber-400">{displayC?.ma5?.toFixed(2) ?? '—'}</span></span>
          <span className="text-slate-500">MA20 <span className="text-cyan-400">{displayC?.ma20?.toFixed(2) ?? '—'}</span></span>
          <span className="text-slate-500">VWAP <span className="text-indigo-400">{displayC?.vwap?.toFixed(2) ?? '—'}</span></span>

          {/* MTF badge */}
          {mtfState && (
            <span className={`ml-auto px-2 py-0.5 rounded text-[10px] font-bold ${
              mtfState.overallBias === 'bullish' ? 'bg-red-900/50 text-red-300' :
              mtfState.overallBias === 'bearish' ? 'bg-green-900/50 text-green-300' :
              'bg-yellow-900/50 text-yellow-300'
            }`}>
              {mtfState.overallBias === 'bullish' ? '偏多' : mtfState.overallBias === 'bearish' ? '偏空' : '中性'}
              {' '}{mtfState.confluenceScore}
            </span>
          )}

          {/* Latest signal alert */}
          {latestBuySell && (
            <span className={`px-2 py-0.5 rounded text-[10px] font-bold animate-pulse ${
              latestBuySell.type === 'BUY' ? 'bg-red-800 text-white' : 'bg-green-800 text-white'
            }`}>
              {latestBuySell.type === 'BUY' ? '🔴 買進訊號' : '🟢 賣出訊號'} {latestBuySell.label}
            </span>
          )}
        </div>
      )}

      {error && <div className="shrink-0 mx-3 mt-1 bg-red-900/30 border border-red-700 text-red-300 text-xs rounded p-2">{error}</div>}

      {/* ── Main ── */}
      <div className="flex-1 flex gap-2 px-3 py-2 min-h-0 overflow-hidden">

        {/* Left: Charts */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0 gap-1.5">
          <div className="relative flex flex-col rounded-xl border border-slate-700 overflow-hidden bg-slate-900"
            style={{ height: 'calc(100vh - 150px)' }}>
            {isLoading && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-900/80">
                <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              </div>
            )}
            <IntradayChartFull />
          </div>

          {/* Bottom bar: Live status or Replay controls */}
          <div className="shrink-0 bg-slate-800/60 rounded-lg border border-slate-700 px-2 py-1 flex items-center gap-2">

            {/* Mode toggle */}
            <div className="flex rounded overflow-hidden border border-slate-600 mr-1">
              <button onClick={() => setViewMode('live')}
                className={`text-[10px] px-2 py-1 font-bold ${viewMode === 'live' ? 'bg-red-600 text-white' : 'bg-slate-800 text-slate-500'}`}>
                即時
              </button>
              <button onClick={() => setViewMode('replay')}
                className={`text-[10px] px-2 py-1 font-bold ${viewMode === 'replay' ? 'bg-sky-600 text-white' : 'bg-slate-800 text-slate-500'}`}>
                回放
              </button>
            </div>

            {viewMode === 'live' ? (
              <>
                <span className={`w-2 h-2 rounded-full ${autoRefresh ? 'bg-red-500 animate-pulse' : 'bg-slate-600'}`} />
                <span className="text-[10px] text-slate-400">
                  {autoRefresh ? '即時監控中' : '已暫停'} {lastUpdateTime && `· 更新 ${lastUpdateTime}`}
                </span>
                <span className="text-[10px] text-slate-500">K棒 {total} 根</span>

                <span className="w-px h-3 bg-slate-700 mx-1" />
                <button onClick={() => setAutoTrade(!autoTrade)}
                  className={`text-[10px] px-2 py-0.5 rounded font-bold ${
                    autoTrade ? 'bg-violet-600 text-white' : 'bg-slate-800 text-slate-500 hover:text-white'
                  }`}>
                  {autoTrade ? '自動交易 ON' : '自動交易'}
                </button>

                <button onClick={generateEODReport}
                  className="text-[10px] px-2 py-0.5 rounded bg-amber-700 text-amber-100 hover:bg-amber-600 font-bold ml-auto">
                  盤後結算
                </button>
              </>
            ) : (
              <>
                <button onClick={isReplaying ? stopReplay : startReplay}
                  className={`text-xs px-2 py-1 rounded font-medium ${isReplaying ? 'bg-orange-600 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'}`}>
                  {isReplaying ? '⏸ 暫停' : '▶ 播放'}
                </button>
                <button onClick={nextBar} disabled={isReplaying}
                  className="text-xs px-2 py-1 rounded bg-slate-700 text-slate-300 hover:bg-slate-600 disabled:opacity-40">▶|</button>
                <div className="flex-1 bg-slate-900 rounded-full h-1.5">
                  <div className="bg-sky-500 h-full rounded-full transition-all" style={{ width: `${pct}%` }} />
                </div>
                <span className="text-[10px] text-slate-500 w-14 text-right">{replayIndex+1}/{total}</span>
                {['慢','1x','快','極速'].map((label, i) => {
                  const speeds = [1000, 500, 200, 50];
                  return (
                    <button key={label} onClick={() => setReplaySpeed(speeds[i])}
                      className={`text-[10px] px-1.5 py-0.5 rounded ${replaySpeed === speeds[i] ? 'bg-sky-600 text-white' : 'text-slate-500 hover:text-white'}`}>
                      {label}
                    </button>
                  );
                })}
              </>
            )}
          </div>
        </div>

        {/* Right: Sidebar */}
        <div className="w-72 shrink-0 flex flex-col min-h-0 gap-2">
          {/* Tab switcher */}
          <div className="shrink-0 flex rounded-lg overflow-hidden border border-slate-700 text-xs">
            {SIDE_TABS.map(t => (
              <button key={t.key} onClick={() => setSideTab(t.key)}
                className={`flex-1 py-1.5 font-medium transition-colors ${
                  sideTab === t.key ? 'bg-violet-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                }`}>
                {t.label}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="flex-1 min-h-0 overflow-y-auto pr-0.5">
            {sideTab === 'mtf' && <MultiTFPanel />}
            {sideTab === 'trade' && <TradeAccountPanel />}
            {sideTab === 'signals' && <SignalListPanel />}
            {sideTab === 'validate' && <ValidationPanel />}
            {sideTab === 'eod' && <EODReportPanel />}
            {sideTab === 'sigbt' && <SignalBacktestPanel symbol={symbol} />}
            {sideTab === 'optim' && <StrategyOptimizerPanel symbol={symbol} />}
            {sideTab === 'posjnl' && (
              <div className="space-y-4 p-1">
                <PositionCalculator />
                <TradeJournal />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Signal Alert Toast */}
      {newSignalAlert && (
        <div className={`fixed bottom-6 right-6 z-50 px-4 py-3 rounded-xl shadow-2xl border animate-bounce ${
          newSignalAlert.type === 'BUY' ? 'bg-red-900/95 border-red-600 text-red-100' : 'bg-green-900/95 border-green-600 text-green-100'
        }`}>
          <div className="flex items-center gap-2">
            <span className="text-2xl">{newSignalAlert.type === 'BUY' ? '🔴' : '🟢'}</span>
            <div>
              <div className="font-bold text-sm">{newSignalAlert.type === 'BUY' ? '買進訊號' : '賣出訊號'} — {newSignalAlert.label}</div>
              <div className="text-xs opacity-80">{newSignalAlert.reason}</div>
              <div className="text-xs opacity-60">分數 {newSignalAlert.score} · {newSignalAlert.triggeredAt.split('T')[1]?.slice(0,5)}</div>
            </div>
            <button onClick={clearAlert} className="text-white/50 hover:text-white ml-2">✕</button>
          </div>
        </div>
      )}
    </div>
  );
}
