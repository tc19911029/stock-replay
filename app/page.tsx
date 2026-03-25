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

const CandleChart = dynamic(() => import('@/components/CandleChart'), {
  ssr: false,
  loading: () => (
    <div className="w-full bg-slate-900 flex items-center justify-center" style={{ height: 460 }}>
      <span className="text-slate-500 text-sm animate-pulse">載入K線圖中...</span>
    </div>
  ),
});

const IndicatorCharts = dynamic(() => import('@/components/IndicatorCharts'), { ssr: false });

const INTERVAL_LABEL: Record<string, string> = { '1d': '日線', '1wk': '週線', '1mo': '月線' };

type SideTab = 'conditions' | 'trade' | 'account' | 'signals';

export default function HomePage() {
  const {
    initData, visibleCandles, currentSignals, chartMarkers,
    currentStock, currentInterval, isLoadingStock, allCandles, currentIndex,
    nextCandle, prevCandle, isPlaying, startPlay, stopPlay, metrics,
  } = useReplayStore();

  useEffect(() => { initData(); }, [initData]);

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
  const [sideTab, setSideTab] = useState<SideTab>('conditions');

  const displayCandle = hoverCandle ?? allCandles[currentIndex];
  const prev = hoverCandle
    ? allCandles[allCandles.findIndex(c => c.date === hoverCandle.date) - 1]
    : allCandles[currentIndex - 1];
  const chg    = displayCandle && prev ? displayCandle.close - prev.close : 0;
  const chgPct = displayCandle && prev ? (chg / prev.close) * 100 : 0;
  const isUp   = chg >= 0;

  const SIDE_TABS: Array<{ key: SideTab; label: string }> = [
    { key: 'conditions', label: '六大條件' },
    { key: 'trade',      label: '交易' },
    { key: 'account',    label: '帳戶' },
    { key: 'signals',    label: '訊號' },
  ];

  return (
    <div className="h-screen flex flex-col bg-[#0b1120] text-white overflow-hidden">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header className="shrink-0 border-b border-slate-800 px-3 py-2 flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-bold text-white whitespace-nowrap">📈 走圖練習器</span>
          {currentStock && (
            <span className="text-sm text-yellow-400 font-mono font-bold truncate">
              {currentStock.name}（{currentStock.ticker}）
            </span>
          )}
          {currentInterval && (
            <span className="text-xs px-1.5 py-0.5 bg-slate-700 rounded text-slate-300 shrink-0">
              {INTERVAL_LABEL[currentInterval] ?? currentInterval}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Link href="/scanner" className="text-xs px-2.5 py-1 bg-blue-600/80 hover:bg-blue-500 rounded text-white font-medium transition">
            🔍 掃描
          </Link>
          <span className="text-xs text-slate-600 hidden md:block">← → Space</span>
        </div>
      </header>

      {/* ── Stock Selector ─────────────────────────────────────────────── */}
      <div className="shrink-0 px-3 pt-2">
        <StockSelector />
      </div>

      {/* ── Main: Chart (left) + Sidebar (right) ───────────────────────── */}
      <div className="flex-1 flex gap-2 px-3 py-2 min-h-0 overflow-hidden">

        {/* ── Left: Chart column ────────────────────────────────────────── */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0 gap-1.5">

          {/* Chart wrapper — fixed height proportional to viewport */}
          <div
            className={`relative flex flex-col rounded-xl border border-slate-700 overflow-hidden bg-slate-900 transition-opacity ${isLoadingStock ? 'opacity-40 pointer-events-none' : ''}`}
            style={{ height: 'calc(100vh - 148px)' }}
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
                {metrics.shares > 0 && (
                  <span className="ml-auto text-slate-500">
                    均價<span className="text-yellow-400 font-bold ml-0.5">{metrics.avgCost.toFixed(2)}</span>
                  </span>
                )}
              </div>
            )}

            {/* K-line chart — 55% of chart area */}
            <div className="shrink-0 border-b border-slate-800" style={{ height: '55%' }}>
              <CandleChart
                candles={visibleCandles}
                signals={currentSignals}
                chartMarkers={chartMarkers}
                avgCost={metrics.shares > 0 ? metrics.avgCost : undefined}
                onCrosshairMove={setHoverCandle}
                fillContainer
              />
            </div>

            {/* Indicator charts — remaining 45% */}
            <div className="flex-1 min-h-0 overflow-hidden">
              <IndicatorCharts candles={visibleCandles} hoverCandle={hoverCandle} />
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

        {/* ── Right: Sidebar ────────────────────────────────────────────── */}
        <div className="w-72 shrink-0 flex flex-col min-h-0 gap-2">

          {/* Tab switcher */}
          <div className="shrink-0 flex rounded-lg overflow-hidden border border-slate-700 text-xs">
            {SIDE_TABS.map(t => (
              <button
                key={t.key}
                onClick={() => setSideTab(t.key)}
                className={`flex-1 py-1.5 font-medium transition-colors ${
                  sideTab === t.key
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Tab content — scrollable */}
          <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-0.5">
            {sideTab === 'conditions' && <SixConditionsPanel />}
            {sideTab === 'trade'      && <TradePanel />}
            {sideTab === 'account'    && <AccountInfo />}
            {sideTab === 'signals'    && (
              <div className="space-y-2">
                <RuleAlerts />
                <TradeHistory />
              </div>
            )}
          </div>
        </div>

      </div>

      {/* ── Bottom: Backtest + Chat (collapsible) ──────────────────────── */}
      <div className="shrink-0 px-3 pb-3 space-y-2 max-h-[40vh] overflow-y-auto">
        <BacktestPanel />
        <AnalysisChat />
      </div>

    </div>
  );
}
