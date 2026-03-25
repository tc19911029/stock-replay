'use client';

import { useEffect, useCallback, useState } from 'react';
import dynamic from 'next/dynamic';
import { useReplayStore } from '@/store/replayStore';
import StockSelector from '@/components/StockSelector';
import ReplayControls from '@/components/ReplayControls';
import TradePanel from '@/components/TradePanel';
import AccountInfo from '@/components/AccountInfo';
import RuleAlerts from '@/components/RuleAlerts';
import TradeHistory from '@/components/TradeHistory';
import BacktestPanel from '@/components/BacktestPanel';

const CandleChart = dynamic(() => import('@/components/CandleChart'), {
  ssr: false,
  loading: () => (
    <div className="w-full bg-slate-900 flex items-center justify-center" style={{ height: 420 }}>
      <span className="text-slate-500 text-sm animate-pulse">載入K線圖中...</span>
    </div>
  ),
});

const IndicatorCharts = dynamic(() => import('@/components/IndicatorCharts'), { ssr: false });

const INTERVAL_LABEL: Record<string, string> = { '1d': '日線', '1wk': '週線', '1mo': '月線' };

export default function HomePage() {
  const {
    initData, visibleCandles, currentSignals, chartMarkers,
    currentStock, currentInterval, isLoadingStock, allCandles, currentIndex,
    nextCandle, prevCandle, isPlaying, startPlay, stopPlay, metrics,
  } = useReplayStore();

  useEffect(() => { initData(); }, [initData]);

  // Keyboard shortcuts
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

  const [hoverCandle, setHoverCandle] = useState<typeof allCandles[0] | null>(null);

  // Show hover candle when crosshair moves, fall back to current candle
  const displayCandle = hoverCandle ?? allCandles[currentIndex];
  const current = allCandles[currentIndex];
  const prev    = hoverCandle
    ? allCandles[allCandles.findIndex(c => c.date === hoverCandle.date) - 1]
    : allCandles[currentIndex - 1];
  const chg     = displayCandle && prev ? displayCandle.close - prev.close : 0;
  const chgPct  = displayCandle && prev ? (chg / prev.close) * 100 : 0;
  const isUp    = chg >= 0;

  return (
    <div className="min-h-screen bg-[#0b1120] text-white">
      {/* ── Header ───────────────────────────────────────────────────────── */}
      <header className="border-b border-slate-800 px-4 py-2.5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-base font-bold text-white">📈 K線走圖練習器</span>
          {currentStock && (
            <span className="text-sm text-yellow-400 font-mono font-bold">
              {currentStock.name}（{currentStock.ticker}）
            </span>
          )}
          {currentInterval && (
            <span className="text-xs px-2 py-0.5 bg-slate-700 rounded text-slate-300">
              {INTERVAL_LABEL[currentInterval] ?? currentInterval}
            </span>
          )}
        </div>
        <p className="text-xs text-slate-500 hidden sm:block">← → Space 鍵盤操作</p>
      </header>

      <div className="p-3 space-y-3">

        {/* ── Row 1: Stock Selector ─────────────────────────────────────── */}
        <StockSelector />

        {/* ── Row 2: Chart area ─────────────────────────────────────────── */}
        <div className={`relative transition-opacity ${isLoadingStock ? 'opacity-40 pointer-events-none' : ''}`}>
          {isLoadingStock && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-900/80 rounded-xl">
              <div className="text-center">
                <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-2" />
                <p className="text-sm text-slate-300">載入資料中...</p>
              </div>
            </div>
          )}

          <div className="bg-slate-900 rounded-t-xl border border-b-0 border-slate-700 overflow-hidden">
            {/* OHLCV info bar — 仿 WantGoo 顯示在圖表正上方 */}
            {displayCandle && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 border-b border-slate-800 text-xs font-mono">
                <span className={`text-slate-400 ${hoverCandle ? 'text-blue-400' : ''}`}>{displayCandle.date}</span>
                <span className={`text-base font-bold ${isUp ? 'text-red-400' : 'text-green-400'}`}>
                  {displayCandle.close.toFixed(2)}
                </span>
                <span className={`font-bold ${isUp ? 'text-red-400' : 'text-green-400'}`}>
                  {isUp ? '▲' : '▼'} {Math.abs(chg).toFixed(2)} ({Math.abs(chgPct).toFixed(2)}%)
                </span>
                <span className="text-slate-400">開 <span className="text-white">{displayCandle.open.toFixed(2)}</span></span>
                <span className="text-slate-400">高 <span className="text-red-400">{displayCandle.high.toFixed(2)}</span></span>
                <span className="text-slate-400">低 <span className="text-green-400">{displayCandle.low.toFixed(2)}</span></span>
                <span className="text-slate-400">量 <span className="text-slate-300">{(displayCandle.volume / 1000).toFixed(0)}K</span></span>
                {metrics.shares > 0 && (
                  <span className="text-slate-400 ml-auto">
                    均價 <span className="text-yellow-400 font-bold">{metrics.avgCost.toFixed(2)}</span>
                  </span>
                )}
              </div>
            )}
            <CandleChart
              candles={visibleCandles}
              signals={currentSignals}
              chartMarkers={chartMarkers}
              avgCost={metrics.shares > 0 ? metrics.avgCost : undefined}
              onCrosshairMove={setHoverCandle}
              height={400}
            />
          </div>
          <IndicatorCharts candles={visibleCandles} hoverCandle={hoverCandle} />
        </div>

        {/* ── Row 3: Controls + Trade + Account ────────────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <ReplayControls />
          <TradePanel />
          <AccountInfo />
        </div>

        {/* ── Row 4: Rule Alerts + Trade History ───────────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <RuleAlerts />
          <TradeHistory />
        </div>

        {/* ── Row 5: Backtest ───────────────────────────────────────────── */}
        <BacktestPanel />

      </div>

      <footer className="border-t border-slate-800 px-4 py-3 text-center text-xs text-slate-600">
        本工具僅供學習練習，不構成投資建議。股市有風險，投資需謹慎。
      </footer>
    </div>
  );
}
