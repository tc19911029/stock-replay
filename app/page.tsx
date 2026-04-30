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

import { useEffect, useCallback, useState, useRef, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { useReplayStore } from '@/store/replayStore';
import { findBuyPoints, prevBuyPointIndex, nextBuyPointIndex } from '@/lib/analysis/findBuyPoints';
import { detectTrend } from '@/lib/analysis/trendAnalysis';
import StockSelector from '@/components/StockSelector';
import { PageShell } from '@/components/shared';
import { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import RuleAlerts from '@/components/RuleAlerts';
import ProhibitionAlerts from '@/components/ProhibitionAlerts';
import WinnerPatternAlerts from '@/components/WinnerPatternAlerts';
import SixConditionsPanel from '@/components/SixConditionsPanel';
import BuyMethodConditionsPanel from '@/components/BuyMethodConditionsPanel';
import ChipDetailPanel from '@/components/ChipDetailPanel';
import AnalysisChat from '@/components/AnalysisChat';
import { ErrorBoundary, SectionBoundary } from '@/components/ErrorBoundary';
import BottomPanel from '@/components/BottomPanel';
import { ScanPanelVertical } from '@/features/scan';
import { DataHealthBadge } from '@/features/scan/components/DataHealthBadge';
import type { SelectedStock } from '@/features/scan';
import { useBacktestStore } from '@/store/backtestStore';
import { useSettingsStore } from '@/store/settingsStore';
import { ChevronDown, Search, ArrowLeft } from 'lucide-react';
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

/** 根據 activeBuyMethod 切換渲染：A 走六條件，其他走買法條件面板 */
function ConditionsPanelSwitch() {
  const method = useBacktestStore(s => s.activeBuyMethod);
  if (method === 'A') return <SixConditionsPanel />;
  return <BuyMethodConditionsPanel method={method} />;
}

export default function HomePage() {
  const {
    initData, visibleCandles, currentSignals, chartMarkers,
    isLoadingStock, allCandles, currentIndex, dataGaps,
    nextCandle, prevCandle, isPlaying, startPlay, stopPlay, metrics,
    loadStock, currentStock, sixConditions, longProhibitions,
    signalStrengthMin, setSignalStrengthMin,
    resetReplay, targetDate,
  } = useReplayStore();

  // 買點索引（對齊生產掃描規則：六條件+戒律+淘汰法）
  const buyPointIndices = useMemo(
    () => (allCandles.length > 60 ? findBuyPoints(allCandles) : []),
    [allCandles]
  );
  const jumpToBuyPoint = useCallback((direction: 'prev' | 'next') => {
    const finder = direction === 'prev' ? prevBuyPointIndex : nextBuyPointIndex;
    const target = finder(buyPointIndices, currentIndex);
    if (target != null) useReplayStore.getState().jumpToIndex(target);
  }, [buyPointIndices, currentIndex]);
  const canPrevBuyPoint = buyPointIndices.length > 0 && buyPointIndices[0] < currentIndex;
  const canNextBuyPoint = buyPointIndices.length > 0 && buyPointIndices[buyPointIndices.length - 1] > currentIndex;

  const currentTrend = useMemo(
    () => allCandles.length > 0 && currentIndex >= 20 ? detectTrend(allCandles, currentIndex) : null,
    [allCandles, currentIndex],
  );

  useEffect(() => { initData(); }, [initData]);

  // Handle ?load=SYMBOL&date=YYYY-MM-DD
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sym = params.get('load');
    const date = params.get('date');
    if (sym) {
      loadStock(sym, '1d', '2y', date ?? undefined).catch((e: Error) => {
        const msg = `載入 ${sym} 失敗：${e.message || '請稍後再試'}`;
        setLoadError(msg);
        toast.error(msg);
      });
      window.history.replaceState({}, '', '/');
    } else if (allCandles.length === 0) {
      loadStock('^TWII', '1d', '2y').catch(() => {});
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const currentInterval = useReplayStore(s => s.currentInterval);
  // P1-2: remember last tab per interval (declared before handleKey to avoid TDZ errors)
  const [sideTabPerInterval, setSideTabPerInterval] = useState<Record<string, SideTab>>({});
  const sideTab: SideTab = sideTabPerInterval[currentInterval] ?? 'conditions';
  const setSideTab = (tab: SideTab) => setSideTabPerInterval(prev => ({ ...prev, [currentInterval]: tab }));
  // P0-3: hide indicator subcharts by default on mobile
  const [showIndicators, setShowIndicators] = useState(true);
  // P1-5: keyboard shortcut help overlay
  const [showHelp, setShowHelp] = useState(false);
  // Scanner bottom panel
  const [scannerOpen, setScannerOpen] = useState(false);
  // 手機點「走圖」→ 全螢幕 K 線視圖
  const [mobileChartFullscreen, setMobileChartFullscreen] = useState(false);
  const openMobileChart = useCallback(() => {
    setMobileChartFullscreen(true);
    setScannerOpen(false);
    try { window.history.pushState({ chartFullscreen: true }, ''); } catch { /* noop */ }
  }, []);
  const closeMobileChart = useCallback(() => {
    setMobileChartFullscreen(false);
    setScannerOpen(true);
  }, []);
  useEffect(() => {
    if (!mobileChartFullscreen) return;
    const onPop = () => setMobileChartFullscreen(false);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [mobileChartFullscreen]);

  // Keyboard: ← → Space B S Q
  const handleKey = useCallback((e: KeyboardEvent) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName)) return;
    if (e.key === 'ArrowRight' && e.shiftKey) { e.preventDefault(); jumpToBuyPoint('next'); }
    else if (e.key === 'ArrowLeft' && e.shiftKey) { e.preventDefault(); jumpToBuyPoint('prev'); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); nextCandle(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); prevCandle(); }
    else if (e.key === ' ') { e.preventDefault(); if (isPlaying) stopPlay(); else startPlay(); }
    // P2-3: tab switching
    else if (e.key === '1') { e.preventDefault(); setSideTab('conditions'); }
    else if (e.key === '2') { e.preventDefault(); setSideTab('signals'); }
    else if (e.key === '3') { e.preventDefault(); setSideTab('chip'); }
    else if (e.key === '4') { e.preventDefault(); setSideTab('chat'); }
    else if (e.key === '5') { e.preventDefault(); setScannerOpen(true); }
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
  }, [nextCandle, prevCandle, isPlaying, startPlay, stopPlay, setSideTab, setScannerOpen, setShowIndicators, setShowHelp, jumpToBuyPoint]);

  useEffect(() => {
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [handleKey]);

  // Mobile check for indicators (runs after mount)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (typeof window !== 'undefined' && window.innerWidth < 768) setShowIndicators(false);
  }, []);

  const [hoverCandle, setHoverCandle] = useState<typeof allCandles[0] | null>(null);
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);
  const [showMarkers, setShowMarkers] = useState(false);
  const [showPivots, setShowPivots] = useState(false);
  const [showSupportResistance, setShowSupportResistance] = useState(false);
  const [showAscendingTrendline, setShowAscendingTrendline] = useState(false);
  const [showDescendingTrendline, setShowDescendingTrendline] = useState(false);
  const [maToggles, setMaToggles] = useState({ ma5: true, ma10: true, ma20: true, ma60: true, ma240: false });
  const [showBollinger, setShowBollinger] = useState(false);
  const [indicators, setIndicators] = useState({
    macd: true, kd: true, volume: true, rsi: false,
    foreign: false, trust: false, dealer: false, retail: false,
    h400: false, h1000: false,
    cnMain: false, cnRetail: false,
  });
  // ── 籌碼面資料（TW 法人/大戶 + CN 主力資金） ────────────────────────────────
  // 優化：用 ticker + 「是否需要籌碼」字串 key 當依賴；同一 key 不會 refetch
  const anyTwChipOn = indicators.foreign || indicators.trust || indicators.dealer
    || indicators.retail || indicators.h400 || indicators.h1000;
  const anyCnChipOn = indicators.cnMain || indicators.cnRetail;
  const ticker = currentStock?.ticker ?? '';
  const isTwTicker = /\.(TW|TWO)$/i.test(ticker) || /^\d{4,5}$/.test(ticker);
  const isCnTicker = /\.(SS|SZ)$/i.test(ticker) || /^\d{6}$/.test(ticker);
  const wantChips = (isTwTicker && anyTwChipOn) || (isCnTicker && anyCnChipOn);
  // 把 fetch trigger 編成單一 string key，dep 比較穩定
  const chipFetchKey = wantChips ? ticker : '';
  const [chips, setChips] = useState<{
    inst: Array<{ date: string; foreign: number; trust: number; dealer: number; total: number }>;
    tdcc: Array<{ date: string; holder400Pct: number; holder1000Pct: number; holderCount?: number }>;
    cnFlow?: Array<{ date: string; mainNet: number; superLargeNet: number; largeNet: number; mediumNet: number; smallNet: number }>;
    divergence?: { type: 'bullish' | 'bearish'; priceChangePct: number; instAccumNet: number; strength: 0|1|2|3; detail: string } | null;
  } | null>(null);
  const [chipsLoading, setChipsLoading] = useState(false);
  useEffect(() => {
    if (!chipFetchKey) { return; }
    const ctrl = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 載入 flag，搭配下方 finally 清除
    setChipsLoading(true);
    fetch(`/api/stock/chips?symbol=${encodeURIComponent(chipFetchKey)}&days=180`, { signal: ctrl.signal })
      .then(r => r.json())
      .then(json => {
        if (json.ok) setChips({
          inst: json.inst ?? [],
          tdcc: json.tdcc ?? [],
          cnFlow: json.cnFlow ?? [],
          divergence: json.divergence ?? null,
        });
      })
      .catch(err => { if (err.name !== 'AbortError') console.warn('[chips] load failed:', err); })
      .finally(() => setChipsLoading(false));
    return () => ctrl.abort();
  }, [chipFetchKey]);
  // 切到別的股 / 關掉所有 chip toggle → 清空 chips（不在主 effect 內，避免抖動）
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 切股時清舊 chips
    if (!ticker) setChips(null);
  }, [ticker]);
  const handleScanSelectStock = useCallback((stock: SelectedStock) => {
    const scanDate = useBacktestStore.getState().scanDate;
    loadStock(stock.symbol, '1d', '2y', scanDate || undefined).catch((e: Error) => {
      toast.error(`載入 ${stock.name} 失敗：${e.message || '請稍後再試'}`);
    });
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      openMobileChart();
    }
  }, [loadStock, openMobileChart]);

  // P1-5: 可拖拽分隔條 — K 線圖 vs 副圖指標
  // 預設 0.65，mount 後再從 localStorage 讀取，避免 SSR hydration mismatch
  const [chartSplit, setChartSplit] = useState(0.65);
  useEffect(() => {
    const saved = localStorage.getItem('chartSplit');
    // 如果舊值太小（< 0.5），清掉用新預設
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (saved && parseFloat(saved) >= 0.5) setChartSplit(parseFloat(saved));
    else localStorage.removeItem('chartSplit');
  }, []);
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const splitDraggingRef = useRef(false);

  const startSplitDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    splitDraggingRef.current = true;

    const handleMove = (me: MouseEvent) => {
      if (!splitDraggingRef.current || !chartContainerRef.current) return;
      const rect = chartContainerRef.current.getBoundingClientRect();
      const newSplit = Math.min(Math.max((me.clientY - rect.top) / rect.height, 0.2), 0.85);
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
  const [soundEnabled, _setSoundEnabled] = useState(true);
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
      <div role="tablist" aria-label="分析面板" className="flex flex-1 rounded-lg overflow-hidden border border-border/60 text-xs">
        {SIDE_TABS.map(t => (
          <button key={t.key} role="tab" aria-selected={sideTab === t.key} aria-controls={`panel-${t.key}`}
            onClick={() => setSideTab(t.key)}
            className={`flex-1 py-2 font-medium transition-all relative ${
              sideTab === t.key ? 'bg-blue-600 text-foreground shadow-[0_0_8px_rgba(37,99,235,0.3)]' : 'bg-secondary/60 text-muted-foreground hover:bg-muted hover:text-foreground/80'
            } ${t.alert && sideTab !== t.key ? 'bg-green-900/40 text-green-300' : ''}`}
          >
            {t.label}
            {t.alert && sideTab !== t.key && (
              <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
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
        <SectionBoundary section="買法條件">
          <ConditionsPanelSwitch />
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
      <div className="flex-1 flex flex-col md:flex-row min-h-0 md:overflow-x-auto md:overflow-y-hidden overflow-y-auto h-full px-3 py-2 gap-2">

        {/* Left: Chart */}
        <div className="w-full md:flex-1 md:min-w-[480px] flex flex-col min-w-0 min-h-[60vh] md:min-h-0 gap-1.5">
          <div
            ref={chartContainerRef}
            className={`relative flex flex-col flex-1 rounded-xl border border-border overflow-hidden bg-card transition-opacity animate-fade-in ${isLoadingStock ? 'opacity-40 pointer-events-none' : ''}`}
          >
            {isLoadingStock && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-card/90">
                <div className="w-3/4 max-w-md space-y-2 mb-4">
                  {/* Skeleton chart lines */}
                  <div className="flex items-end gap-[2px] h-24 justify-center">
                    {Array.from({ length: 30 }).map((_, i) => (
                      <div key={i} className="w-1.5 bg-muted/60 rounded-sm animate-pulse"
                        style={{ height: `${20 + Math.sin(i * 0.4) * 40 + 10}%`, animationDelay: `${i * 30}ms` }} />
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

            {dataGaps.length > 0 && currentInterval === '1d' && (
              <div className="shrink-0 px-3 py-1.5 bg-yellow-500/10 border-b border-yellow-500/30 text-yellow-400 text-xs flex items-center justify-between">
                <span>
                  資料斷層：{dataGaps.map((g: { fromDate: string; toDate: string; calendarDays: number }) => `${g.fromDate} → ${g.toDate}（${g.calendarDays}天）`).join('、')}
                </span>
                <button
                  onClick={() => { if (!currentStock) return; loadStock(currentStock.ticker.replace(/\.(TW|TWO|SS|SZ)$/i, ''), '1d', '2y').catch(() => {}); }}
                  className="text-yellow-300 hover:text-yellow-200 underline ml-2 whitespace-nowrap">
                  重新下載
                </button>
              </div>
            )}

            {/* OHLCV bar + 指標切換列 */}
            {displayCandle && (
              <ChartToolbar
                candle={displayCandle}
                prevCandle={prev}
                isHover={!!hoverCandle}
                stockName={currentStock?.name}
                trend={currentTrend}
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
                showPivots={showPivots}
                onPivotsToggle={() => setShowPivots(v => !v)}
                showSupportResistance={showSupportResistance}
                onSupportResistanceToggle={() => setShowSupportResistance(v => !v)}
                showAscendingTrendline={showAscendingTrendline}
                onAscendingTrendlineToggle={() => setShowAscendingTrendline(v => !v)}
                showDescendingTrendline={showDescendingTrendline}
                onDescendingTrendlineToggle={() => setShowDescendingTrendline(v => !v)}
                avgCost={metrics.avgCost}
                shares={metrics.shares}
                onPrev={prevCandle}
                onNext={nextCandle}
                onReset={resetReplay}
                canPrev={currentIndex > 0 && !isPlaying}
                canNext={currentIndex < allCandles.length - 1 && !isPlaying}
                onPrevBuyPoint={() => jumpToBuyPoint('prev')}
                onNextBuyPoint={() => jumpToBuyPoint('next')}
                canPrevBuyPoint={canPrevBuyPoint && !isPlaying}
                canNextBuyPoint={canNextBuyPoint && !isPlaying}
                ticker={currentStock?.ticker}
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
                  showPivots={showPivots}
                  showSupportResistance={showSupportResistance}
                  showAscendingTrendline={showAscendingTrendline}
                  showDescendingTrendline={showDescendingTrendline}
                  highlightDate={targetDate ?? undefined}
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
                  className="flex-1 h-4 bg-border/60 hover:bg-blue-500/40 cursor-row-resize flex items-center justify-center group select-none"
                  onMouseDown={startSplitDrag}
                  title="拖拽調整 K 線 / 副圖比例（上下拖動）"
                >
                  <div className="w-12 h-1 bg-muted-foreground/50 group-hover:bg-blue-400 rounded-full transition-colors" />
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
                  <IndicatorCharts candles={visibleCandles} hoverCandle={hoverCandle} indicators={indicators} ticker={currentStock?.ticker} chips={chips} chipsLoading={chipsLoading} />
                </ErrorBoundary>
              </div>
            )}
          </div>


        </div>

        {/* Middle: Sidebar */}
        <div className="w-full md:w-64 shrink-0 flex flex-col min-h-0 gap-2">
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

          {/* 數據健康度 L1-L4 */}
          <div className="shrink-0 px-2 py-1.5">
            <DataHealthBadge market={useBacktestStore(s => s.market)} forceDown />
          </div>
        </div>

        {/* ── Right: Scan Panel (vertical on desktop, full-width stacked on mobile) ── */}
        <div className={`shrink-0 flex flex-col min-h-0 border border-border bg-card/80 rounded-lg overflow-hidden transition-all duration-300 ${
          scannerOpen
            ? 'w-full md:w-[600px] min-h-[50vh] md:min-h-0'
            : 'w-full md:w-8 h-10 md:h-auto'
        }`}>
          {scannerOpen ? (
            <>
              {/* Panel header: 掃描標題 + close button */}
              <div className="shrink-0 flex items-center justify-between px-2 py-1.5 border-b border-border bg-secondary/30">
                <div className="flex items-center gap-1 px-2 py-1 text-xs font-semibold text-foreground">
                  <Search className="w-3 h-3" />
                  <span>掃描</span>
                </div>
                <button onClick={() => setScannerOpen(false)}
                  className="text-muted-foreground hover:text-foreground p-0.5 rounded hover:bg-muted transition-colors">
                  <ChevronDown className="w-3.5 h-3.5 rotate-90" />
                </button>
              </div>
              <div className="animate-fade-in flex-1 min-h-0">
                <ScanPanelVertical onSelectStock={handleScanSelectStock} />
              </div>
            </>
          ) : (
            /* Collapsed: horizontal bar on mobile, vertical label on desktop */
            <button
              onClick={() => setScannerOpen(true)}
              className="flex-1 flex flex-row md:flex-col items-center justify-center gap-2 hover:bg-muted/50 transition-colors group"
              title="掃描"
            >
              <Search className="w-3.5 h-3.5 text-muted-foreground group-hover:text-blue-400 transition-colors" />
              <span className="text-[10px] text-muted-foreground group-hover:text-foreground transition-colors md:[writing-mode:vertical-rl]">掃描</span>
            </button>
          )}
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
                ['5', '展開 / 收起掃描面板'],
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

      {/* 手機走圖全螢幕視圖 */}
      {mobileChartFullscreen && (
        <div className="md:hidden fixed inset-0 z-[100] bg-background flex flex-col">
          <div className="shrink-0 flex items-center gap-2 px-2 py-2 border-b border-border bg-card">
            <button
              onClick={closeMobileChart}
              aria-label="返回掃描清單"
              className="shrink-0 p-1.5 rounded hover:bg-muted text-foreground"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div className="flex-1 min-w-0">
              <StockSelector />
            </div>
          </div>

          {displayCandle && (
            <div className="shrink-0">
              <ChartToolbar
                candle={displayCandle}
                prevCandle={prev}
                isHover={!!hoverCandle}
                stockName={currentStock?.name}
                trend={currentTrend}
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
                showPivots={showPivots}
                onPivotsToggle={() => setShowPivots(v => !v)}
                showSupportResistance={showSupportResistance}
                onSupportResistanceToggle={() => setShowSupportResistance(v => !v)}
                showAscendingTrendline={showAscendingTrendline}
                onAscendingTrendlineToggle={() => setShowAscendingTrendline(v => !v)}
                showDescendingTrendline={showDescendingTrendline}
                onDescendingTrendlineToggle={() => setShowDescendingTrendline(v => !v)}
                avgCost={metrics.avgCost}
                shares={metrics.shares}
                onPrev={prevCandle}
                onNext={nextCandle}
                onReset={resetReplay}
                canPrev={currentIndex > 0 && !isPlaying}
                canNext={currentIndex < allCandles.length - 1 && !isPlaying}
                onPrevBuyPoint={() => jumpToBuyPoint('prev')}
                onNextBuyPoint={() => jumpToBuyPoint('next')}
                canPrevBuyPoint={canPrevBuyPoint && !isPlaying}
                canNextBuyPoint={canNextBuyPoint && !isPlaying}
                ticker={currentStock?.ticker}
              />
            </div>
          )}

          <div className="flex-1 min-h-0 flex flex-col">
            {isLoadingStock ? (
              <div className="flex-1 flex items-center justify-center">
                <span className="w-5 h-5 border-2 border-sky-500 border-t-transparent rounded-full animate-spin mr-2" />
                <span className="text-sm text-muted-foreground">載入中…</span>
              </div>
            ) : (
              <>
                <div className="flex-[3] min-h-0">
                  <ErrorBoundary>
                    <CandleChart
                      candles={visibleCandles}
                      signals={currentSignals}
                      chartMarkers={showMarkers ? chartMarkers : []}
                      avgCost={metrics.shares > 0 ? metrics.avgCost : undefined}
                      stopLossPrice={stopLossPrice}
                      onCrosshairMove={setHoverCandle}
                      fillContainer
                      maToggles={maToggles}
                      showBollinger={showBollinger}
                      showPivots={showPivots}
                      showSupportResistance={showSupportResistance}
                      showAscendingTrendline={showAscendingTrendline}
                      showDescendingTrendline={showDescendingTrendline}
                      highlightDate={targetDate ?? undefined}
                    />
                  </ErrorBoundary>
                </div>
                {showIndicators && (
                  <div className="flex-[2] min-h-0 border-t border-border">
                    <ErrorBoundary>
                      <IndicatorCharts candles={visibleCandles} hoverCandle={hoverCandle} indicators={indicators} ticker={currentStock?.ticker} chips={chips} chipsLoading={chipsLoading} />
                    </ErrorBoundary>
                  </div>
                )}
                <button
                  onClick={() => setShowIndicators(v => !v)}
                  className="shrink-0 py-1 text-[10px] text-muted-foreground hover:text-foreground bg-secondary/60 border-t border-border"
                >
                  {showIndicators ? '▼ 收起副圖' : '▲ 展開副圖'}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </PageShell>
  );
}
