'use client';

/**
 * V2 走圖頁 — 乾淨版
 *
 * 左側：K 線圖（大）+ 播放控制
 * 右側：3 個 tab（條件 / 交易 / 訊號）
 *
 * 移除的東西：
 * - OHLCV bar 的 MA/BB/指標切換按鈕 → 預設全開
 * - 籌碼 tab → 移到掃描頁
 * - 問老師 tab → 移除
 * - 底部回測面板 → 移到掃描頁
 * - 趨勢狀態欄 → 整合進條件 tab
 */

import { useEffect, useCallback, useState, useRef } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useReplayStore } from '@/store/replayStore';
import StockSelector from '@/components/StockSelector';
import { PageShell } from '@/components/shared';
import ReplayControls from '@/components/ReplayControls';
import TradePanel from '@/components/TradePanel';
import AccountInfo from '@/components/AccountInfo';
import RuleAlerts from '@/components/RuleAlerts';
import ProhibitionAlerts from '@/components/ProhibitionAlerts';
import WinnerPatternAlerts from '@/components/WinnerPatternAlerts';
import TradeHistory from '@/components/TradeHistory';
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

type SideTab = 'conditions' | 'trade' | 'signals';

export default function HomePage() {
  const {
    initData, visibleCandles, currentSignals, chartMarkers,
    isLoadingStock, allCandles, currentIndex,
    nextCandle, prevCandle, isPlaying, startPlay, stopPlay, metrics,
    loadStock, currentStock, sixConditions, longProhibitions,
  } = useReplayStore();

  useEffect(() => { initData(); }, [initData]);

  // Handle ?load=SYMBOL&date=YYYY-MM-DD
  const [loadError, setLoadError] = useState<string | null>(null);
  const pendingJumpRef = useRef<string | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sym = params.get('load');
    const date = params.get('date');
    if (sym) {
      setLoadError(null);
      if (date) pendingJumpRef.current = date;
      loadStock(sym, '1d', '2y').catch((e: Error) => {
        setLoadError(`載入 ${sym} 失敗：${e.message || '請稍後再試'}`);
      });
      window.history.replaceState({}, '', '/');
    } else if (allCandles.length === 0) {
      loadStock('2330', '1d', '2y').catch(() => {});
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Jump to date after load
  useEffect(() => {
    if (!pendingJumpRef.current) return;
    const unsub = useReplayStore.subscribe((state) => {
      const target = pendingJumpRef.current;
      if (!target || state.allCandles.length < 30 || state.isLoadingStock) return;
      const idx = state.allCandles.findIndex(c => c.date >= target);
      if (idx >= 0) {
        pendingJumpRef.current = null;
        setTimeout(() => useReplayStore.getState().jumpToIndex(idx), 50);
        unsub();
      }
    });
    return unsub;
  }, []);

  // Keyboard: ← → Space
  const handleKey = useCallback((e: KeyboardEvent) => {
    if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); nextCandle(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); prevCandle(); }
    else if (e.key === ' ') { e.preventDefault(); if (isPlaying) stopPlay(); else startPlay(); }
  }, [nextCandle, prevCandle, isPlaying, startPlay, stopPlay]);

  useEffect(() => {
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [handleKey]);

  const [hoverCandle, setHoverCandle] = useState<typeof allCandles[0] | null>(null);
  const [sideTab, setSideTab] = useState<SideTab>('conditions');
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const displayCandle = hoverCandle ?? allCandles[currentIndex];
  const prev = hoverCandle
    ? allCandles[allCandles.findIndex(c => c.date === hoverCandle.date) - 1]
    : allCandles[currentIndex - 1];
  const chg = displayCandle && prev ? displayCandle.close - prev.close : 0;
  const chgPct = displayCandle && prev ? (chg / prev.close) * 100 : 0;
  const isUp = chg >= 0;

  const condScore = sixConditions?.totalScore ?? 0;
  const condAlert = condScore >= 5;
  const prohibAlert = longProhibitions?.prohibited === true;

  // Stop-loss line
  const currentCandle = allCandles[currentIndex];
  const ma5StopLoss = metrics.shares > 0 ? (currentCandle?.ma5 ?? null) : null;
  const costStopLoss = metrics.shares > 0 && metrics.avgCost > 0 ? metrics.avgCost * 0.93 : null;
  const stopLossPrice = ma5StopLoss != null && costStopLoss != null
    ? Math.max(ma5StopLoss, costStopLoss)
    : (ma5StopLoss ?? costStopLoss ?? undefined);

  const SIDE_TABS: Array<{ key: SideTab; label: string; alert?: boolean }> = [
    { key: 'conditions', label: '條件', alert: condAlert },
    { key: 'trade',      label: '交易' },
    { key: 'signals',    label: '訊號', alert: prohibAlert },
  ];

  return (
    <PageShell fullViewport headerSlot={<StockSelector />}>
      <div className="flex-1 flex flex-col md:flex-row gap-2 px-3 py-2 min-h-0 overflow-hidden h-full">

        {/* Left: Chart */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0 gap-1.5">
          <div
            className={`relative flex flex-col rounded-xl border border-slate-700 overflow-hidden bg-slate-900 transition-opacity ${isLoadingStock ? 'opacity-40 pointer-events-none' : ''}`}
            style={{ height: 'min(calc(100vh - 100px), 800px)' }}
          >
            {isLoadingStock && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-900/80">
                <div className="text-center">
                  <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-2" />
                  <p className="text-sm text-slate-300">載入資料中...</p>
                </div>
              </div>
            )}

            {loadError && (
              <div className="shrink-0 flex items-center gap-2 px-3 py-2 bg-red-900/30 border-b border-red-700/50 text-xs">
                <span className="text-red-400">{loadError}</span>
                <button onClick={() => { setLoadError(null); loadStock('2330', '1d', '2y'); }}
                  className="text-sky-400 hover:text-sky-300 underline">重試</button>
              </div>
            )}

            {/* OHLCV bar — 簡化版 */}
            {displayCandle && (
              <div className="shrink-0 flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-1.5 border-b border-slate-800 text-xs font-mono">
                {currentStock && (
                  <span className="text-white font-bold font-sans">{currentStock.name}</span>
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
                {metrics.shares > 0 && (
                  <span className="ml-auto flex items-center gap-2">
                    <span className="text-slate-500">
                      均價<span className="text-yellow-400 font-bold ml-0.5">{metrics.avgCost.toFixed(2)}</span>
                    </span>
                    <span className={`font-bold ${metrics.avgCost > 0 && displayCandle.close >= metrics.avgCost ? 'text-red-400' : 'text-green-400'}`}>
                      {metrics.avgCost > 0 ? `${((displayCandle.close - metrics.avgCost) / metrics.avgCost * 100).toFixed(2)}%` : ''}
                    </span>
                  </span>
                )}
              </div>
            )}

            {/* K 線圖 */}
            <div className="shrink-0 border-b border-slate-800" style={{ height: '48%' }}>
              <ErrorBoundary>
                <CandleChart
                  candles={visibleCandles}
                  signals={currentSignals}
                  chartMarkers={chartMarkers}
                  avgCost={metrics.shares > 0 ? metrics.avgCost : undefined}
                  stopLossPrice={stopLossPrice}
                  onCrosshairMove={setHoverCandle}
                  fillContainer
                  maToggles={{ ma5: true, ma10: true, ma20: true, ma60: true }}
                  showBollinger={false}
                />
              </ErrorBoundary>
            </div>

            {/* 副圖指標 */}
            <div className="flex-1 min-h-0 overflow-hidden">
              <ErrorBoundary>
                <IndicatorCharts candles={visibleCandles} hoverCandle={hoverCandle} indicators={{ macd: true, kd: true, volume: true, rsi: false }} />
              </ErrorBoundary>
            </div>
          </div>

          {/* 播放控制 */}
          <div className="shrink-0">
            <ReplayControls />
          </div>
        </div>

        {/* Right: Sidebar — 只有 3 個 tab */}
        <div className="w-full md:w-72 shrink-0 flex flex-col min-h-0 gap-2">
          {/* Mobile toggle */}
          <button
            onClick={() => setSidebarOpen(o => !o)}
            className="md:hidden flex items-center justify-between w-full px-3 py-2 bg-slate-800 rounded-lg text-xs text-slate-300 border border-slate-700"
          >
            <span>分析面板</span>
            <span className={`transition-transform ${sidebarOpen ? 'rotate-180' : ''}`}>&#9660;</span>
          </button>

          <div className={`flex flex-col min-h-0 gap-2 ${sidebarOpen ? 'max-h-[60vh] md:max-h-none' : 'max-h-0 overflow-hidden md:max-h-none'} transition-all duration-300`}>
            {/* Tab header + 舊版連結 */}
            <div className="shrink-0 flex items-center gap-1">
              <div className="flex flex-1 rounded-lg overflow-hidden border border-slate-700 text-xs">
                {SIDE_TABS.map(t => (
                  <button key={t.key} onClick={() => setSideTab(t.key)}
                    className={`flex-1 py-1.5 font-medium transition-colors relative ${
                      sideTab === t.key ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                    } ${t.alert && sideTab !== t.key ? 'bg-green-900/40 text-green-300' : ''}`}
                  >
                    {t.label}
                    {t.alert && sideTab !== t.key && (
                      <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                    )}
                  </button>
                ))}
              </div>
              <Link href="/v1" className="text-[10px] text-slate-600 hover:text-slate-400 px-1" title="舊版走圖">
                舊版
              </Link>
            </div>

            {/* Tab content */}
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
                  <ProhibitionAlerts />
                  <WinnerPatternAlerts />
                  <RuleAlerts />
                  <TradeHistory />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </PageShell>
  );
}
