'use client';

import { useEffect, useCallback, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useReplayStore } from '@/store/replayStore';
import StockSelector from '@/components/StockSelector';
import ReplayControls from '@/components/ReplayControls';
import TradePanel from '@/components/TradePanel';
import AccountInfo from '@/components/AccountInfo';
import RuleAlerts from '@/components/RuleAlerts';
import TradeHistory from '@/components/TradeHistory';
import BacktestPanel from '@/components/BacktestPanel';
import AnalysisChat from '@/components/AnalysisChat';
import TrendStateBar from '@/components/TrendStateBar';
import SixConditionsPanel from '@/components/SixConditionsPanel';
import { ErrorBoundary } from '@/components/ErrorBoundary';

const CandleChart = dynamic(() => import('@/components/CandleChart'), {
  ssr: false,
  loading: () => (
    <div className="w-full bg-slate-900 flex items-center justify-center" style={{ height: 460 }}>
      <span className="text-slate-500 text-sm animate-pulse">載入K線圖中...</span>
    </div>
  ),
});

const IndicatorCharts = dynamic(() => import('@/components/IndicatorCharts'), { ssr: false });

type SideTab = 'conditions' | 'trade' | 'signals' | 'chat';

export default function HomePage() {
  const {
    initData, visibleCandles, currentSignals, chartMarkers,
    isLoadingStock, allCandles, currentIndex,
    nextCandle, prevCandle, isPlaying, startPlay, stopPlay, metrics,
    loadStock, currentStock,
  } = useReplayStore();

  useEffect(() => { initData(); }, [initData]);

  // Handle ?load=SYMBOL from scanner page, or auto-load 2330 on first visit
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sym = params.get('load');
    if (sym) {
      loadStock(sym, '1d', '2y');
      window.history.replaceState({}, '', '/');
    } else if (allCandles.length === 0) {
      loadStock('2330', '1d', '2y');
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleKey = useCallback((e: KeyboardEvent) => {
    if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); nextCandle(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); prevCandle(); }
    else if (e.key === ' ') { e.preventDefault(); isPlaying ? stopPlay() : startPlay(); }
  }, [nextCandle, prevCandle, isPlaying, startPlay, stopPlay]);

  useEffect(() => {
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [handleKey]);

  const { sixConditions } = useReplayStore();
  const [hoverCandle, setHoverCandle] = useState<typeof allCandles[0] | null>(null);
  const [sideTab, setSideTab] = useState<SideTab>('conditions');
  const [showMarkers, setShowMarkers] = useState(true);

  const displayCandle = hoverCandle ?? allCandles[currentIndex];
  const prev = hoverCandle
    ? allCandles[allCandles.findIndex(c => c.date === hoverCandle.date) - 1]
    : allCandles[currentIndex - 1];
  const chg    = displayCandle && prev ? displayCandle.close - prev.close : 0;
  const chgPct = displayCandle && prev ? (chg / prev.close) * 100 : 0;
  const isUp   = chg >= 0;

  const condScore = sixConditions?.totalScore ?? 0;
  const condAlert = condScore >= 5;

  // Stop-loss price line on chart (when holding)
  const currentCandle = allCandles[currentIndex];
  const ma5StopLoss  = metrics.shares > 0 ? (currentCandle?.ma5 ?? null) : null;
  const costStopLoss = metrics.shares > 0 && metrics.avgCost > 0 ? metrics.avgCost * 0.93 : null;
  const stopLossPrice = ma5StopLoss != null && costStopLoss != null
    ? Math.max(ma5StopLoss, costStopLoss)
    : (ma5StopLoss ?? costStopLoss ?? undefined);

  const SIDE_TABS: Array<{ key: SideTab; label: string; alert?: boolean }> = [
    { key: 'conditions', label: '六大條件', alert: condAlert },
    { key: 'trade',      label: '交易/帳戶' },
    { key: 'signals',    label: '訊號' },
    { key: 'chat',       label: '問老師' },
  ];

  return (
    <div className="h-screen flex flex-col bg-[#0b1120] text-white overflow-hidden">

      {/* ── Header ── */}
      <header className="shrink-0 border-b border-slate-800 bg-slate-950 px-3 py-1.5 flex items-center gap-2 min-w-0">
        {/* Left: Logo / Title */}
        <span className="text-sm font-bold text-sky-400 whitespace-nowrap shrink-0 hidden sm:block">📈 K線走圖</span>
        <span className="text-sm font-bold text-sky-400 whitespace-nowrap shrink-0 sm:hidden">📈</span>

        {/* Stock Selector */}
        <StockSelector />

        {/* Center/Right: Nav links */}
        <nav className="flex items-center gap-0.5 shrink-0 ml-auto">
          {/* Primary nav */}
          <div className="flex items-center gap-0.5">
            <span className="text-[10px] font-bold text-sky-500 border border-sky-700/60 bg-sky-900/30 px-2 py-1 rounded cursor-default select-none whitespace-nowrap">
              走圖
            </span>
            <Link href="/scan"       title="批量掃描台股/陸股，找出符合六大條件的個股並回測績效" className="text-[11px] px-2 py-1 rounded text-slate-300 hover:bg-slate-700 hover:text-white font-medium transition whitespace-nowrap">掃描選股</Link>
            <Link href="/live-daytrade" title="多時間框架即時訊號，適合當沖交易者" className="text-[11px] px-2 py-1 rounded bg-violet-900/50 text-violet-300 hover:bg-violet-700 hover:text-white font-medium transition whitespace-nowrap border border-violet-700/50">當沖 <span className="text-[8px] bg-amber-600 text-white px-1 rounded-full">β</span></Link>
            <Link href="/report"     title="查看歷次掃描的績效統計報表，匯出CSV" className="text-[11px] px-2 py-1 rounded text-slate-300 hover:bg-slate-700 hover:text-white font-medium transition whitespace-nowrap hidden md:block">報表</Link>
            <Link href="/strategies" title="調整六大條件門檻，管理多個策略版本" className="text-[11px] px-2 py-1 rounded text-slate-300 hover:bg-slate-700 hover:text-white font-medium transition whitespace-nowrap hidden md:block">策略</Link>
            <Link href="/disclaimer" className="text-[11px] px-2 py-1 rounded text-slate-500 hover:bg-slate-700 hover:text-white font-medium transition whitespace-nowrap hidden md:block">免責</Link>
          </div>

          {/* Divider */}
          <span className="w-px h-4 bg-slate-700 mx-1 shrink-0 hidden sm:block" />

          {/* Secondary nav */}
          <div className="flex items-center gap-0.5">
            <Link href="/watchlist"  className="text-[11px] px-2 py-1 rounded text-slate-400 hover:bg-slate-700 hover:text-slate-200 transition whitespace-nowrap hidden sm:block" title="自選股">⭐ 自選</Link>
            <Link href="/portfolio"  className="text-[11px] px-2 py-1 rounded text-slate-400 hover:bg-slate-700 hover:text-slate-200 transition whitespace-nowrap hidden sm:block" title="持倉">💼</Link>
            <Link href="/settings"   className="text-[11px] px-2 py-1 rounded text-slate-400 hover:bg-slate-700 hover:text-slate-200 transition whitespace-nowrap" title="設定">⚙</Link>
          </div>

          <span className="text-[10px] text-slate-600 hidden lg:block ml-1.5 whitespace-nowrap">← → Space</span>
        </nav>
      </header>

      {/* ── Main ── */}
      <div className="flex-1 flex flex-col md:flex-row gap-2 px-3 py-2 min-h-0 overflow-hidden">

        {/* Left: Chart */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0 gap-1.5">
          <div
            className={`relative flex flex-col rounded-xl border border-slate-700 overflow-hidden bg-slate-900 transition-opacity ${isLoadingStock ? 'opacity-40 pointer-events-none' : ''}`}
            style={{ height: 'calc(100vh - 100px)' }}
          >
            {isLoadingStock && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-900/80">
                <div className="text-center">
                  <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-2" />
                  <p className="text-sm text-slate-300">載入資料中...</p>
                </div>
              </div>
            )}

            {/* OHLCV bar */}
            {displayCandle && (
              <div className="shrink-0 flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-1.5 border-b border-slate-800 text-xs font-mono">
                {currentStock && (
                <span className="text-white font-bold font-sans mr-1">{currentStock.name}</span>
              )}
              <span className={hoverCandle ? 'text-blue-400' : 'text-slate-400'}>{displayCandle.date}</span>
                <span className={`text-sm font-bold ${isUp ? 'text-red-400' : 'text-green-400'}`}>
                  {displayCandle.close.toFixed(2)}
                </span>
                <span className={`font-bold ${isUp ? 'text-red-400' : 'text-green-400'}`}>
                  {isUp ? '▲' : '▼'}{Math.abs(chg).toFixed(2)} ({Math.abs(chgPct).toFixed(2)}%)
                </span>
                <span className="text-slate-500">開<span className="text-white ml-0.5">{displayCandle.open.toFixed(2)}</span></span>
                <span className="text-slate-500">高<span className="text-red-400 ml-0.5">{displayCandle.high.toFixed(2)}</span></span>
                <span className="text-slate-500">低<span className="text-green-400 ml-0.5">{displayCandle.low.toFixed(2)}</span></span>
                <span className="text-slate-500">量<span className="text-slate-300 ml-0.5">{(displayCandle.volume / 1000).toFixed(0)}K</span></span>
                <button
                  onClick={() => setShowMarkers(v => !v)}
                  className={`ml-auto shrink-0 px-2 py-0.5 rounded text-[10px] font-medium transition ${
                    showMarkers ? 'bg-blue-600/60 text-blue-200' : 'bg-slate-700 text-slate-500'
                  }`}
                  title="顯示/隱藏買賣訊號標記"
                >
                  {showMarkers ? '訊號 ●' : '訊號 ○'}
                </button>
                {metrics.shares > 0 && displayCandle && (() => {
                  const unrealizedPct = metrics.avgCost > 0
                    ? ((displayCandle.close - metrics.avgCost) / metrics.avgCost) * 100
                    : 0;
                  const pnlPos = unrealizedPct >= 0;
                  return (
                    <span className="ml-auto flex items-center gap-2">
                      <span className="text-slate-500">
                        均價<span className="text-yellow-400 font-bold ml-0.5">{metrics.avgCost.toFixed(2)}</span>
                      </span>
                      <span className={`font-bold text-xs ${pnlPos ? 'text-red-400' : 'text-green-400'}`}>
                        {pnlPos ? '+' : ''}{unrealizedPct.toFixed(2)}%
                      </span>
                    </span>
                  );
                })()}
              </div>
            )}

            <div className="shrink-0 border-b border-slate-800" style={{ height: '48%' }}>
              <ErrorBoundary>
                <CandleChart
                  candles={visibleCandles}
                  signals={currentSignals}
                  chartMarkers={showMarkers ? chartMarkers : []}
                  avgCost={metrics.shares > 0 ? metrics.avgCost : undefined}
                  stopLossPrice={stopLossPrice}
                  onCrosshairMove={setHoverCandle}
                  fillContainer
                />
              </ErrorBoundary>
            </div>
            <div className="flex-1 min-h-0 overflow-hidden">
              <ErrorBoundary>
                <IndicatorCharts candles={visibleCandles} hoverCandle={hoverCandle} />
              </ErrorBoundary>
            </div>
          </div>

          {/* Trend bar + Replay controls */}
          <div className="shrink-0 space-y-1">
            <div className="bg-slate-800/60 rounded-lg border border-slate-700 px-2 py-1">
              <TrendStateBar />
            </div>
            <ReplayControls />
          </div>
        </div>

        {/* Right: Sidebar */}
        <div className="w-full md:w-72 shrink-0 flex flex-col min-h-0 gap-2 max-h-[40vh] md:max-h-none">
          {/* Tab switcher */}
          <div className="shrink-0 flex rounded-lg overflow-hidden border border-slate-700 text-xs">
            {SIDE_TABS.map(t => (
              <button key={t.key} onClick={() => setSideTab(t.key)}
                className={`flex-1 py-1.5 font-medium transition-colors relative ${
                  sideTab === t.key ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                } ${t.alert && sideTab !== t.key ? 'bg-green-900/40 text-green-300' : ''}`}>
                {t.label}
                {t.alert && sideTab !== t.key && (
                  <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                )}
              </button>
            ))}
          </div>

          {/* Tab content */}
          {sideTab === 'chat' ? (
            <div className="flex-1 min-h-0">
              <AnalysisChat sidebar />
            </div>
          ) : (
            <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-0.5">
              {sideTab === 'conditions' && <SixConditionsPanel />}
              {sideTab === 'trade' && (
                <>
                  <AccountInfo />
                  <TradePanel />
                </>
              )}
              {sideTab === 'signals' && (
                <div className="space-y-2">
                  <RuleAlerts />
                  <TradeHistory />
                </div>
              )}
            </div>
          )}
        </div>

      </div>

      {/* ── Bottom: Backtest (collapsible) ── */}
      <div className="shrink-0 px-3 pb-3 max-h-[40vh] overflow-y-auto">
        <BacktestPanel />
      </div>

    </div>
  );
}
