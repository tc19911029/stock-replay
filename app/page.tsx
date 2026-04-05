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
import { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import ReplayControls from '@/components/ReplayControls';
import RuleAlerts from '@/components/RuleAlerts';
import ProhibitionAlerts from '@/components/ProhibitionAlerts';
import WinnerPatternAlerts from '@/components/WinnerPatternAlerts';
import SixConditionsPanel from '@/components/SixConditionsPanel';
import ChipDetailPanel from '@/components/ChipDetailPanel';
import AnalysisChat from '@/components/AnalysisChat';
import { ErrorBoundary, SectionBoundary } from '@/components/ErrorBoundary';
import BottomPanel from '@/components/BottomPanel';
import { useSettingsStore } from '@/store/settingsStore';
import { toast } from 'sonner';
import ChartToolbar from '@/components/ChartToolbar';

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
        const msg = `載入 ${sym} 失敗：${e.message || '請稍後再試'}`;
        setLoadError(msg);
        toast.error(msg);
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
    // P2-3: tab switching
    else if (e.key === '1') { e.preventDefault(); setSideTab('conditions'); }
    else if (e.key === '2') { e.preventDefault(); setSideTab('signals'); }
    else if (e.key === '3') { e.preventDefault(); setSideTab('chip'); }
    else if (e.key === '4') { e.preventDefault(); setSideTab('chat'); }
    // P2-3: indicator toggle
    else if (e.key === 'i' || e.key === 'I') { e.preventDefault(); setShowIndicators(v => !v); }
    // P1-5: help overlay
    else if (e.key === '?') { e.preventDefault(); setShowHelp(h => !h); }
    // 買賣快捷鍵
    else if (e.key === 'b' || e.key === 'B') {
      e.preventDefault();
      useReplayStore.getState().buyPercent(100);
    } else if (e.key === 's' || e.key === 'S') {
      e.preventDefault();
      useReplayStore.getState().sellPercent(50);
    } else if (e.key === 'q' || e.key === 'Q') {
      e.preventDefault();
      const { metrics } = useReplayStore.getState();
      if (metrics.shares > 0) useReplayStore.getState().sell(metrics.shares);
    }
  }, [nextCandle, prevCandle, isPlaying, startPlay, stopPlay]);

  useEffect(() => {
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [handleKey]);

  const [hoverCandle, setHoverCandle] = useState<typeof allCandles[0] | null>(null);
  const currentInterval = useReplayStore(s => s.currentInterval);
  // P1-2: remember last tab per interval
  const [sideTabPerInterval, setSideTabPerInterval] = useState<Record<string, SideTab>>({});
  const sideTab: SideTab = sideTabPerInterval[currentInterval] ?? 'conditions';
  const setSideTab = (tab: SideTab) => setSideTabPerInterval(prev => ({ ...prev, [currentInterval]: tab }));
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);
  const [showMarkers, setShowMarkers] = useState(true);
  const [maToggles, setMaToggles] = useState({ ma5: true, ma10: true, ma20: true, ma60: true });
  const [showBollinger, setShowBollinger] = useState(false);
  const [indicators, setIndicators] = useState({ macd: true, kd: true, volume: true, rsi: false });
  // P0-3: hide indicator subcharts by default on mobile
  const [showIndicators, setShowIndicators] = useState(true);
  useEffect(() => {
    if (typeof window !== 'undefined' && window.innerWidth < 768) setShowIndicators(false);
  }, []);
  // P1-5: keyboard shortcut help overlay
  const [showHelp, setShowHelp] = useState(false);

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

  // P3-8: Sound alert when a new signal appears during replay
  const [soundEnabled, setSoundEnabled] = useState(true);
  const prevSignalCountRef = useRef(0);
  const soundEnabledRef = useRef(true);
  useEffect(() => { soundEnabledRef.current = soundEnabled; }, [soundEnabled]);
  useEffect(() => {
    const prev = prevSignalCountRef.current;
    const curr = currentSignals.length;
    if (isPlaying && curr > prev && soundEnabledRef.current) {
      try {
        const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.3);
      } catch { /* AudioContext not available */ }
    }
    prevSignalCountRef.current = curr;
  }, [currentSignals, isPlaying]);

  const displayCandle = hoverCandle ?? allCandles[currentIndex];
  const prev = hoverCandle
    ? allCandles[allCandles.findIndex(c => c.date === hoverCandle.date) - 1]
    : allCandles[currentIndex - 1];
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

  const sidebarTabs = (
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
  );

  const sidebarContent = sideTab === 'chat' ? (
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
      {sideTab === 'chip' && (
        currentStock ? (
          <SectionBoundary section="籌碼分析">
            <ChipDetailPanel symbol={currentStock.ticker} date={currentDate} />
          </SectionBoundary>
        ) : (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <p className="text-2xl mb-2">📋</p>
            <p className="text-sm font-medium text-muted-foreground">尚未載入股票</p>
            <p className="text-xs text-muted-foreground/70 mt-1">請先選擇一檔股票以查看籌碼資料</p>
          </div>
        )
      )}
    </div>
  );

  return (
    <PageShell fullViewport headerSlot={<StockSelector />}>
      <div className="flex-1 flex flex-col md:flex-row gap-2 px-3 py-2 min-h-0 overflow-hidden h-full">

        {/* Left: Chart + BottomPanel (desktop) */}
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
              <ChartToolbar
                candle={displayCandle}
                prevCandle={prev}
                isHover={!!hoverCandle}
                stockName={currentStock?.name}
                maToggles={maToggles}
                onMaToggle={key => setMaToggles(p => ({ ...p, [key]: !p[key] }))}
                showBollinger={showBollinger}
                onBollingerToggle={() => setShowBollinger(v => !v)}
                indicators={indicators}
                onIndicatorToggle={key => setIndicators(p => ({ ...p, [key]: !p[key] }))}
                showMarkers={showMarkers}
                onMarkersToggle={() => setShowMarkers(v => !v)}
                signalStrengthMin={signalStrengthMin}
                onSignalStrengthChange={setSignalStrengthMin}
                avgCost={metrics.avgCost}
                shares={metrics.shares}
              />
            )}

            {/* K 線圖 */}
            <div className={showIndicators ? 'shrink-0' : 'flex-1 min-h-0'} style={showIndicators ? { height: `${chartSplit * 100}%` } : undefined}>
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

            {/* 拖拽分隔條 + 副圖展開按鈕 */}
            <div className="shrink-0 flex items-center">
              {showIndicators ? (
                <div
                  role="separator"
                  aria-orientation="horizontal"
                  aria-label="拖拽調整 K 線圖與副圖比例"
                  className="flex-1 h-1.5 bg-secondary hover:bg-blue-500/60 cursor-row-resize flex items-center justify-center group select-none"
                  onMouseDown={startSplitDrag}
                  title="拖拽調整 K 線 / 副圖比例"
                >
                  <div className="w-8 h-px bg-muted-foreground/40 group-hover:bg-blue-400 rounded-full transition-colors" />
                </div>
              ) : (
                <div className="flex-1 h-px bg-border" />
              )}
              <button
                onClick={() => setShowIndicators(v => !v)}
                aria-label={showIndicators ? '收起副圖指標' : '展開副圖指標'}
                aria-expanded={showIndicators}
                className="shrink-0 px-2 py-0.5 text-[9px] text-muted-foreground hover:text-foreground bg-secondary/60 hover:bg-secondary rounded transition-colors"
              >
                {showIndicators ? '▼ 副圖' : '▲ 副圖'}
              </button>
            </div>

            {/* 副圖指標 */}
            {showIndicators && (
              <div className="flex-1 min-h-0 overflow-hidden">
                <ErrorBoundary>
                  <IndicatorCharts candles={visibleCandles} hoverCandle={hoverCandle} indicators={indicators} />
                </ErrorBoundary>
              </div>
            )}
          </div>

          {/* 趨勢狀態 + 播放控制 */}
          <div className="shrink-0 space-y-1">
            <div className="bg-secondary/60 rounded-lg border border-border px-2 py-1 flex items-center gap-2">
              <button
                onClick={() => setSoundEnabled(v => !v)}
                title={soundEnabled ? '關閉訊號音效' : '開啟訊號音效（走圖出現買賣訊號時嗶一聲）'}
                className={`shrink-0 ml-auto text-base leading-none px-1 rounded transition-opacity ${soundEnabled ? 'opacity-80 hover:opacity-100' : 'opacity-30 hover:opacity-60'}`}
                aria-pressed={soundEnabled}
              >
                {soundEnabled ? '🔔' : '🔕'}
              </button>
            </div>
            <ReplayControls />
          </div>

        </div>

        {/* Right: Sidebar */}
        <div className="w-full md:w-72 shrink-0 flex flex-col min-h-0 gap-2">
          {/* Mobile: Sheet drawer */}
          <div className="md:hidden">
            <Sheet open={mobileSheetOpen} onOpenChange={setMobileSheetOpen}>
              <SheetTrigger className="flex items-center justify-between w-full px-3 py-2 bg-secondary rounded-lg text-xs text-foreground/80 border border-border">
                <span>分析面板</span>
                <span className={`transition-transform ${mobileSheetOpen ? 'rotate-180' : ''}`}>&#9660;</span>
              </SheetTrigger>
              <SheetContent side="bottom" className="h-[85vh] flex flex-col p-0">
                <SheetHeader className="px-4 pt-4 pb-2 shrink-0">
                  <SheetTitle className="text-sm">分析面板</SheetTitle>
                </SheetHeader>
                <div className="flex-1 flex flex-col min-h-0 px-3 pb-3 gap-2">
                  {sidebarTabs}
                  {sidebarContent}
                </div>
              </SheetContent>
            </Sheet>
          </div>

          {/* Desktop: inline sidebar */}
          <div id="analysis-sidebar" className="hidden md:flex flex-col min-h-0 gap-2">
            {sidebarTabs}
            {sidebarContent}
          </div>

          {/* 自選股 / 持倉 摺疊面板 */}
          <BottomPanel />
        </div>
      </div>
      {/* P1-5: Keyboard shortcut help overlay */}
      {showHelp && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setShowHelp(false)}
        >
          <div
            className="bg-card border border-border rounded-xl shadow-2xl p-5 w-80 max-w-[90vw]"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-bold text-foreground">鍵盤快捷鍵</h2>
              <button onClick={() => setShowHelp(false)} aria-label="關閉" className="text-muted-foreground hover:text-foreground text-lg leading-none">×</button>
            </div>
            <div className="space-y-1 text-xs">
              {([
                ['←  /  →', '前一根 / 下一根 K 棒'],
                ['空白鍵', '播放 / 暫停'],
                ['I', '展開 / 收起副圖指標'],
                ['1', '切換至「條件」面板'],
                ['2', '切換至「訊號」面板'],
                ['3', '切換至「籌碼」面板'],
                ['4', '切換至「問老師」面板'],
                ['B', '買入（全倉）'],
                ['S', '賣出（半倉）'],
                ['Q', '全部賣出'],
                ['?', '顯示 / 關閉本說明'],
              ] as [string, string][]).map(([key, desc]) => (
                <div key={key} className="flex items-center gap-3 py-1 border-b border-border/50 last:border-0">
                  <kbd className="shrink-0 w-24 text-center px-2 py-0.5 rounded bg-secondary text-foreground/80 font-mono text-[10px]">{key}</kbd>
                  <span className="text-muted-foreground">{desc}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </PageShell>
  );
}
