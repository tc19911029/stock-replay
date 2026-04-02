'use client';

/**
 * V2 走圖頁 — 乾淨版
 *
 * 左側：K 線圖（大）+ 播放控制
 * 右側：2 個 tab（條件 / 訊號）
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
import { useReplayStore } from '@/store/replayStore';
import StockSelector from '@/components/StockSelector';
import { PageShell } from '@/components/shared';
import ReplayControls from '@/components/ReplayControls';
import RuleAlerts from '@/components/RuleAlerts';
import ProhibitionAlerts from '@/components/ProhibitionAlerts';
import WinnerPatternAlerts from '@/components/WinnerPatternAlerts';
import SixConditionsPanel from '@/components/SixConditionsPanel';
import ChipDetailPanel from '@/components/ChipDetailPanel';
import AnalysisChat from '@/components/AnalysisChat';
import TrendStateBar from '@/components/TrendStateBar';
import { ErrorBoundary, SectionBoundary } from '@/components/ErrorBoundary';
import BottomPanel from '@/components/BottomPanel';
import { useSettingsStore } from '@/store/settingsStore';

const CandleChart = dynamic(() => import('@/components/CandleChart'), {
  ssr: false,
  loading: () => (
    <div className="w-full bg-card flex items-center justify-center" style={{ height: 460 }}>
      <span className="text-muted-foreground text-sm animate-pulse">載入K線圖中...</span>
    </div>
  ),
});

const IndicatorCharts = dynamic(() => import('@/components/IndicatorCharts'), { ssr: false });

type SideTab = 'conditions' | 'signals' | 'chip' | 'chat';

export default function HomePage() {
  const {
    initData, visibleCandles, currentSignals, chartMarkers,
    isLoadingStock, allCandles, currentIndex,
    nextCandle, prevCandle, isPlaying, startPlay, stopPlay, metrics,
    loadStock, currentStock, sixConditions, longProhibitions,
    signalStrengthMin, setSignalStrengthMin,
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

  // Keyboard: ← → Space B S Q
  const handleKey = useCallback((e: KeyboardEvent) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName)) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); nextCandle(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); prevCandle(); }
    else if (e.key === ' ') { e.preventDefault(); if (isPlaying) stopPlay(); else startPlay(); }
    // P2-6: 買賣快捷鍵
    else if (e.key === 'b' || e.key === 'B') {
      e.preventDefault();
      useReplayStore.getState().buyPercent(100); // 全倉買入
    } else if (e.key === 's' || e.key === 'S') {
      e.preventDefault();
      useReplayStore.getState().sellPercent(50); // 賣出半倉
    } else if (e.key === 'q' || e.key === 'Q') {
      e.preventDefault();
      const { metrics } = useReplayStore.getState();
      if (metrics.shares > 0) useReplayStore.getState().sell(metrics.shares); // 全出
    }
  }, [nextCandle, prevCandle, isPlaying, startPlay, stopPlay]);

  useEffect(() => {
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [handleKey]);

  const [hoverCandle, setHoverCandle] = useState<typeof allCandles[0] | null>(null);
  const [sideTab, setSideTab] = useState<SideTab>('conditions');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [showMarkers, setShowMarkers] = useState(true);
  const [maToggles, setMaToggles] = useState({ ma5: true, ma10: true, ma20: true, ma60: true });
  const [showBollinger, setShowBollinger] = useState(false);
  const [indicators, setIndicators] = useState({ macd: true, kd: true, volume: true, rsi: false });

  // P1-5: 可拖拽分隔條 — K 線圖 vs 副圖指標
  // 預設 0.48，mount 後再從 localStorage 讀取，避免 SSR hydration mismatch
  const [chartSplit, setChartSplit] = useState(0.48);
  useEffect(() => {
    const saved = localStorage.getItem('chartSplit');
    if (saved) setChartSplit(parseFloat(saved));
  }, []);
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const splitDraggingRef = useRef(false);

  const startSplitDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    splitDraggingRef.current = true;

    const handleMove = (me: MouseEvent) => {
      if (!splitDraggingRef.current || !chartContainerRef.current) return;
      const rect = chartContainerRef.current.getBoundingClientRect();
      const newSplit = Math.min(Math.max((me.clientY - rect.top) / rect.height, 0.2), 0.8);
      setChartSplit(newSplit);
      localStorage.setItem('chartSplit', String(newSplit));
    };

    const handleUp = () => {
      splitDraggingRef.current = false;
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  }, []);

  const displayCandle = hoverCandle ?? allCandles[currentIndex];
  const prev = hoverCandle
    ? allCandles[allCandles.findIndex(c => c.date === hoverCandle.date) - 1]
    : allCandles[currentIndex - 1];
  const chg = displayCandle && prev ? displayCandle.close - prev.close : 0;
  const chgPct = displayCandle && prev ? (chg / prev.close) * 100 : 0;
  const isUp = chg >= 0;

  const stopLossPct = useSettingsStore(s => s.stopLossPercent);
  const condScore = sixConditions?.totalScore ?? 0;
  const condAlert = condScore >= 5;
  const prohibAlert = longProhibitions?.prohibited === true;

  // Stop-loss line
  const currentCandle = allCandles[currentIndex];
  const ma5StopLoss = metrics.shares > 0 ? (currentCandle?.ma5 ?? null) : null;
  const costStopLoss = metrics.shares > 0 && metrics.avgCost > 0 ? metrics.avgCost * (1 - stopLossPct / 100) : null;
  const stopLossPrice = ma5StopLoss != null && costStopLoss != null
    ? Math.max(ma5StopLoss, costStopLoss)
    : (ma5StopLoss ?? costStopLoss ?? undefined);

  const currentDate = allCandles[currentIndex]?.date;

  const SIDE_TABS: Array<{ key: SideTab; label: string; alert?: boolean }> = [
    { key: 'conditions', label: '條件', alert: condAlert },
    { key: 'signals',    label: '訊號', alert: prohibAlert },
    { key: 'chip',       label: '籌碼' },
    { key: 'chat',       label: '問老師' },
  ];

  return (
    <PageShell fullViewport headerSlot={<StockSelector />}>
      <div className="flex-1 flex flex-col md:flex-row gap-2 px-3 py-2 min-h-0 overflow-hidden h-full">

        {/* Left: Chart */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0 gap-1.5">
          <div
            ref={chartContainerRef}
            className={`relative flex flex-col rounded-xl border border-border overflow-hidden bg-card transition-opacity ${isLoadingStock ? 'opacity-40 pointer-events-none' : ''}`}
            style={{ height: 'min(calc(100vh - 100px), 800px)' }}
          >
            {isLoadingStock && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-card/90">
                <div className="w-3/4 max-w-md space-y-2 mb-4">
                  {/* Skeleton chart lines */}
                  <div className="flex items-end gap-[2px] h-24 justify-center">
                    {Array.from({ length: 30 }).map((_, i) => (
                      <div key={i} className="w-1.5 bg-muted/60 rounded-sm animate-pulse"
                        style={{ height: `${20 + Math.sin(i * 0.4) * 40 + Math.random() * 20}%`, animationDelay: `${i * 30}ms` }} />
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-5 h-5 border-2 border-sky-500 border-t-transparent rounded-full animate-spin" />
                  <p className="text-sm text-muted-foreground">載入資料中...</p>
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

            {/* OHLCV bar + 指標切換列 */}
            {displayCandle && (
              <div className="shrink-0 flex flex-wrap items-center gap-x-2 sm:gap-x-3 gap-y-0.5 px-2 sm:px-3 py-1 sm:py-1.5 border-b border-border text-[10px] sm:text-xs font-mono">
                {currentStock && (
                  <span className="text-foreground font-bold font-sans mr-1">{currentStock.name}</span>
                )}
                <span className={hoverCandle ? 'text-blue-400' : 'text-muted-foreground'}>{displayCandle.date}</span>
                <span className={`text-sm font-bold ${isUp ? 'text-bull' : 'text-bear'}`}>
                  {displayCandle.close.toFixed(2)}
                </span>
                <span className={`font-bold ${isUp ? 'text-bull' : 'text-bear'}`}>
                  {isUp ? '▲' : '▼'}{Math.abs(chg).toFixed(2)} ({Math.abs(chgPct).toFixed(2)}%)
                </span>
                <span className="text-muted-foreground">開<span className="text-foreground ml-0.5">{displayCandle.open.toFixed(2)}</span></span>
                <span className="text-muted-foreground">高<span className="text-bull ml-0.5">{displayCandle.high.toFixed(2)}</span></span>
                <span className="text-muted-foreground">低<span className="text-bear ml-0.5">{displayCandle.low.toFixed(2)}</span></span>
                <span className="text-muted-foreground">量<span className="text-foreground/80 ml-0.5">{(displayCandle.volume / 1000).toFixed(0)}K</span></span>
                {/* 工具列：均線開關 + 指標選擇 + 訊號 */}
                <div className="ml-auto flex items-center gap-1 shrink-0 flex-wrap">
                  {([
                    { key: 'ma5' as const, label: 'MA5', color: 'bg-yellow-600' },
                    { key: 'ma10' as const, label: 'MA10', color: 'bg-pink-600' },
                    { key: 'ma20' as const, label: 'MA20', color: 'bg-blue-600' },
                    { key: 'ma60' as const, label: 'MA60', color: 'bg-purple-600' },
                  ]).map(({ key, label, color }) => (
                    <button key={key}
                      onClick={() => setMaToggles(p => ({ ...p, [key]: !p[key] }))}
                      className={`px-1.5 py-0.5 rounded text-[9px] font-medium transition ${
                        maToggles[key] ? `${color}/70 text-foreground` : 'bg-secondary text-muted-foreground/60'
                      }`}
                      title={`顯示/隱藏 ${label}`}
                    >{label}</button>
                  ))}
                  <span className="w-px h-3 bg-border mx-0.5" />
                  <button
                    onClick={() => setShowBollinger(v => !v)}
                    className={`px-1.5 py-0.5 rounded text-[9px] font-medium transition ${
                      showBollinger ? 'bg-emerald-700/60 text-emerald-200' : 'bg-secondary text-muted-foreground/60'
                    }`}
                    title="布林通道 (20, 2)"
                  >BB</button>
                  <span className="w-px h-3 bg-border mx-0.5" />
                  {([
                    { key: 'macd' as const, label: 'MACD' },
                    { key: 'kd' as const, label: 'KD' },
                    { key: 'rsi' as const, label: 'RSI' },
                    { key: 'volume' as const, label: '量' },
                  ]).map(({ key, label }) => (
                    <button key={key}
                      onClick={() => setIndicators(p => ({ ...p, [key]: !p[key] }))}
                      className={`px-1.5 py-0.5 rounded text-[9px] font-medium transition ${
                        indicators[key] ? 'bg-sky-700/60 text-sky-200' : 'bg-secondary text-muted-foreground/60'
                      }`}
                    >{label}</button>
                  ))}
                  <span className="w-px h-3 bg-border mx-0.5" />
                  <button
                    onClick={() => setShowMarkers(v => !v)}
                    className={`px-1.5 py-0.5 rounded text-[9px] font-medium transition ${
                      showMarkers ? 'bg-blue-600/60 text-blue-200' : 'bg-secondary text-muted-foreground/60'
                    }`}
                    title="顯示/隱藏買賣訊號標記"
                  >訊號</button>
                  {showMarkers && (
                    <select
                      value={signalStrengthMin}
                      onChange={e => setSignalStrengthMin(Number(e.target.value))}
                      className="px-1 py-0.5 rounded text-[9px] font-medium bg-secondary text-foreground/80 border border-border outline-none"
                      title="信號共振強度過濾"
                    >
                      <option value={1}>全部</option>
                      <option value={2}>共振≥2</option>
                      <option value={3}>強≥3</option>
                    </select>
                  )}
                </div>
                {metrics.shares > 0 && displayCandle && (() => {
                  const unrealizedPct = metrics.avgCost > 0
                    ? ((displayCandle.close - metrics.avgCost) / metrics.avgCost) * 100
                    : 0;
                  const pnlPos = unrealizedPct >= 0;
                  return (
                    <span className="ml-auto flex items-center gap-2">
                      <span className="text-muted-foreground">
                        均價<span className="text-yellow-400 font-bold ml-0.5">{metrics.avgCost.toFixed(2)}</span>
                      </span>
                      <span className={`font-bold text-xs ${pnlPos ? 'text-bull' : 'text-bear'}`}>
                        {pnlPos ? '+' : ''}{unrealizedPct.toFixed(2)}%
                      </span>
                    </span>
                  );
                })()}
              </div>
            )}

            {/* K 線圖 */}
            <div className="shrink-0" style={{ height: `${chartSplit * 100}%` }}>
              <ErrorBoundary>
                <CandleChart
                  candles={visibleCandles}
                  signals={currentSignals}
                  chartMarkers={showMarkers ? chartMarkers : []}
                  avgCost={metrics.shares > 0 ? metrics.avgCost : undefined}
                  stopLossPrice={stopLossPrice}
                  onCrosshairMove={setHoverCandle}
                  onDoubleClick={(candle) => {
                    const idx = allCandles.findIndex(c => c.date === candle.date);
                    if (idx >= 0) useReplayStore.getState().jumpToIndex(idx);
                  }}
                  fillContainer
                  maToggles={maToggles}
                  showBollinger={showBollinger}
                />
              </ErrorBoundary>
            </div>

            {/* 拖拽分隔條 */}
            <div
              className="shrink-0 h-1.5 bg-secondary hover:bg-blue-500/60 cursor-row-resize flex items-center justify-center group select-none"
              onMouseDown={startSplitDrag}
              title="拖拽調整 K 線 / 副圖比例"
            >
              <div className="w-8 h-px bg-muted-foreground/40 group-hover:bg-blue-400 rounded-full transition-colors" />
            </div>

            {/* 副圖指標 */}
            <div className="flex-1 min-h-0 overflow-hidden">
              <ErrorBoundary>
                <IndicatorCharts candles={visibleCandles} hoverCandle={hoverCandle} indicators={indicators} />
              </ErrorBoundary>
            </div>
          </div>

          {/* 趨勢狀態 + 播放控制 */}
          <div className="shrink-0 space-y-1">
            <div className="bg-secondary/60 rounded-lg border border-border px-2 py-1">
              <TrendStateBar />
            </div>
            <ReplayControls />
          </div>
        </div>

        {/* Right: Sidebar — 只有 3 個 tab */}
        <div className="w-full md:w-72 shrink-0 flex flex-col min-h-0 gap-2">
          {/* Mobile toggle */}
          <button
            onClick={() => setSidebarOpen(o => !o)}
            aria-expanded={sidebarOpen}
            aria-controls="analysis-sidebar"
            className="md:hidden flex items-center justify-between w-full px-3 py-2 bg-secondary rounded-lg text-xs text-foreground/80 border border-border"
          >
            <span>分析面板</span>
            <span className={`transition-transform ${sidebarOpen ? 'rotate-180' : ''}`}>&#9660;</span>
          </button>

          <div id="analysis-sidebar" className={`flex flex-col min-h-0 gap-2 ${sidebarOpen ? 'max-h-[60vh] md:max-h-none' : 'max-h-0 overflow-hidden md:max-h-none'} transition-all duration-300`}>
            {/* Tab header + 舊版連結 */}
            <div className="shrink-0 flex items-center gap-1">
              <div role="tablist" aria-label="分析面板" className="flex flex-1 rounded-lg overflow-hidden border border-border text-xs">
                {SIDE_TABS.map(t => (
                  <button key={t.key} role="tab" aria-selected={sideTab === t.key} aria-controls={`panel-${t.key}`}
                    onClick={() => setSideTab(t.key)}
                    className={`flex-1 py-1.5 font-medium transition-colors relative ${
                      sideTab === t.key ? 'bg-blue-600 text-foreground' : 'bg-secondary text-muted-foreground hover:bg-muted'
                    } ${t.alert && sideTab !== t.key ? 'bg-green-900/40 text-green-300' : ''}`}
                  >
                    {t.label}
                    {t.alert && sideTab !== t.key && (
                      <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                    )}
                  </button>
                ))}
              </div>
            </div>

            {/* Tab content */}
            {sideTab === 'chat' ? (
              <div id="panel-chat" role="tabpanel" className="flex-1 min-h-0">
                <AnalysisChat sidebar />
              </div>
            ) : (
              <div
                id={`panel-${sideTab}`}
                role="tabpanel"
                className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-0.5"
              >
                {sideTab === 'conditions' && (
                  <SectionBoundary section="六大條件">
                    <SixConditionsPanel />
                  </SectionBoundary>
                )}
                {sideTab === 'signals' && (
                  <SectionBoundary section="訊號分析">
                    <div className="space-y-2">
                      <ProhibitionAlerts />
                      <WinnerPatternAlerts />
                      <RuleAlerts />
                    </div>
                  </SectionBoundary>
                )}
                {sideTab === 'chip' && currentStock && (
                  <SectionBoundary section="籌碼分析">
                    <ChipDetailPanel symbol={currentStock.ticker} date={currentDate} />
                  </SectionBoundary>
                )}
              </div>
            )}
          </div>

          {/* Bottom: 自選股 / 持倉 摺疊面板 */}
          <BottomPanel />
        </div>
      </div>
    </PageShell>
  );
}
