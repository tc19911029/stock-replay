'use client';

import { useEffect, useCallback, useState, useRef } from 'react';
import dynamic from 'next/dynamic';
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
import BacktestPanel from '@/components/BacktestPanel';
import AnalysisChat from '@/components/AnalysisChat';
import TrendStateBar from '@/components/TrendStateBar';
import SixConditionsPanel from '@/components/SixConditionsPanel';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import ChipDetailPanel from '@/components/ChipDetailPanel';

const CandleChart = dynamic(() => import('@/components/CandleChart'), {
  ssr: false,
  loading: () => (
    <div className="w-full bg-slate-900 flex items-center justify-center" style={{ height: 460 }}>
      <span className="text-slate-500 text-sm animate-pulse">載入K線圖中...</span>
    </div>
  ),
});

const IndicatorCharts = dynamic(() => import('@/components/IndicatorCharts'), { ssr: false });

type SideTab = 'conditions' | 'trade' | 'signals' | 'chat' | 'chip';

export default function HomePage() {
  const {
    initData, visibleCandles, currentSignals, chartMarkers,
    isLoadingStock, allCandles, currentIndex,
    nextCandle, prevCandle, isPlaying, startPlay, stopPlay, metrics,
    loadStock, currentStock,
    signalStrengthMin, setSignalStrengthMin,
  } = useReplayStore();

  useEffect(() => { initData(); }, [initData]);

  // Handle ?load=SYMBOL&date=YYYY-MM-DD from scanner page, or auto-load 2330 on first visit
  const [loadError, setLoadError] = useState<string | null>(null);
  const pendingJumpRef = useRef<string | null>(null);
  /* eslint-disable react-hooks/set-state-in-effect */
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
  /* eslint-enable react-hooks/set-state-in-effect */

  // 用 subscribe 監聽 allCandles 變化，載入完成後跳到指定日期
  useEffect(() => {
    if (!pendingJumpRef.current) return;
    const unsub = useReplayStore.subscribe((state) => {
      const target = pendingJumpRef.current;
      if (!target || state.allCandles.length < 30 || state.isLoadingStock) return;
      const idx = state.allCandles.findIndex(c => c.date >= target);
      if (idx >= 0) {
        pendingJumpRef.current = null;
        // 用 setTimeout 確保在 set 之後執行
        setTimeout(() => useReplayStore.getState().jumpToIndex(idx), 50);
        unsub();
      }
    });
    return unsub;
  }, []);

  const handleKey = useCallback((e: KeyboardEvent) => {
    if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); nextCandle(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); prevCandle(); }
    else if (e.key === ' ') { e.preventDefault(); if (isPlaying) { stopPlay(); } else { startPlay(); } }
  }, [nextCandle, prevCandle, isPlaying, startPlay, stopPlay]);

  useEffect(() => {
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [handleKey]);

  const { sixConditions, longProhibitions } = useReplayStore();
  const [hoverCandle, setHoverCandle] = useState<typeof allCandles[0] | null>(null);
  const [sideTab, setSideTab] = useState<SideTab>('conditions');
  const [showMarkers, setShowMarkers] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // 均線開關
  const [maToggles, setMaToggles] = useState({ ma5: true, ma10: true, ma20: true, ma60: true });
  // 布林通道開關
  const [showBollinger, setShowBollinger] = useState(false);
  // 副圖指標開關
  const [indicators, setIndicators] = useState({ macd: true, kd: true, volume: true, rsi: false });

  const displayCandle = hoverCandle ?? allCandles[currentIndex];
  const prev = hoverCandle
    ? allCandles[allCandles.findIndex(c => c.date === hoverCandle.date) - 1]
    : allCandles[currentIndex - 1];
  const chg    = displayCandle && prev ? displayCandle.close - prev.close : 0;
  const chgPct = displayCandle && prev ? (chg / prev.close) * 100 : 0;
  const isUp   = chg >= 0;

  const condScore = sixConditions?.totalScore ?? 0;
  const condAlert = condScore >= 5;
  // 戒律警示：任一戒律觸發時，在訊號 tab 顯示紅點
  const prohibAlert = longProhibitions?.prohibited === true;

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
    { key: 'signals',    label: '訊號', alert: prohibAlert },
    { key: 'chip',       label: '籌碼' },
    { key: 'chat',       label: '問老師' },
  ];

  return (
    <PageShell fullViewport headerSlot={<StockSelector />}>
      {/* ── Main ── */}
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

            {/* Error display */}
            {loadError && (
              <div className="shrink-0 flex items-center gap-2 px-3 py-2 bg-red-900/30 border-b border-red-700/50 text-xs">
                <span className="text-red-400">⚠ {loadError}</span>
                <button onClick={() => { setLoadError(null); loadStock('2330', '1d', '2y'); }}
                  className="text-sky-400 hover:text-sky-300 underline">重試載入台積電</button>
              </div>
            )}

            {/* OHLCV bar */}
            {displayCandle && (
              <div className="shrink-0 flex flex-wrap items-center gap-x-2 sm:gap-x-3 gap-y-0.5 px-2 sm:px-3 py-1 sm:py-1.5 border-b border-slate-800 text-[10px] sm:text-xs font-mono">
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
                <span className="text-slate-600 text-[9px] hidden lg:block" title="資料來源：Yahoo Finance">Yahoo Finance</span>
                {/* 工具列：均線開關 + 指標選擇 + 訊號 */}
                <div className="ml-auto flex items-center gap-1 shrink-0 flex-wrap">
                  {/* 均線開關 */}
                  {([
                    { key: 'ma5' as const, label: 'MA5', color: 'bg-yellow-600' },
                    { key: 'ma10' as const, label: 'MA10', color: 'bg-pink-600' },
                    { key: 'ma20' as const, label: 'MA20', color: 'bg-blue-600' },
                    { key: 'ma60' as const, label: 'MA60', color: 'bg-purple-600' },
                  ]).map(({ key, label, color }) => (
                    <button key={key}
                      onClick={() => setMaToggles(p => ({ ...p, [key]: !p[key] }))}
                      className={`px-1.5 py-0.5 rounded text-[9px] font-medium transition ${
                        maToggles[key] ? `${color}/70 text-white` : 'bg-slate-800 text-slate-600'
                      }`}
                      title={`顯示/隱藏 ${label}`}
                    >{label}</button>
                  ))}
                  <span className="w-px h-3 bg-slate-700 mx-0.5" />
                  {/* 主圖疊加指標 */}
                  <button
                    onClick={() => setShowBollinger(v => !v)}
                    className={`px-1.5 py-0.5 rounded text-[9px] font-medium transition ${
                      showBollinger ? 'bg-emerald-700/60 text-emerald-200' : 'bg-slate-800 text-slate-600'
                    }`}
                    title="布林通道 (20, 2)"
                  >BB</button>
                  <span className="w-px h-3 bg-slate-700 mx-0.5" />
                  {/* 副圖指標 */}
                  {([
                    { key: 'macd' as const, label: 'MACD' },
                    { key: 'kd' as const, label: 'KD' },
                    { key: 'rsi' as const, label: 'RSI' },
                    { key: 'volume' as const, label: '量' },
                  ]).map(({ key, label }) => (
                    <button key={key}
                      onClick={() => setIndicators(p => ({ ...p, [key]: !p[key] }))}
                      className={`px-1.5 py-0.5 rounded text-[9px] font-medium transition ${
                        indicators[key] ? 'bg-sky-700/60 text-sky-200' : 'bg-slate-800 text-slate-600'
                      }`}
                    >{label}</button>
                  ))}
                  <span className="w-px h-3 bg-slate-700 mx-0.5" />
                  <button
                    onClick={() => setShowMarkers(v => !v)}
                    className={`px-1.5 py-0.5 rounded text-[9px] font-medium transition ${
                      showMarkers ? 'bg-blue-600/60 text-blue-200' : 'bg-slate-800 text-slate-600'
                    }`}
                    title="顯示/隱藏買賣訊號標記"
                  >
                    訊號
                  </button>
                  {showMarkers && (
                    <select
                      value={signalStrengthMin}
                      onChange={e => setSignalStrengthMin(Number(e.target.value))}
                      className="px-1 py-0.5 rounded text-[9px] font-medium bg-slate-800 text-slate-300 border border-slate-700 outline-none"
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
                  maToggles={maToggles}
                  showBollinger={showBollinger}
                />
              </ErrorBoundary>
            </div>
            <div className="flex-1 min-h-0 overflow-hidden">
              <ErrorBoundary>
                <IndicatorCharts candles={visibleCandles} hoverCandle={hoverCandle} indicators={indicators} />
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
        <div className="w-full md:w-72 shrink-0 flex flex-col min-h-0 gap-2 md:max-h-none">
          {/* Mobile toggle */}
          <button
            onClick={() => setSidebarOpen(o => !o)}
            className="md:hidden flex items-center justify-between w-full px-3 py-2 bg-slate-800 rounded-lg text-xs text-slate-300 border border-slate-700">
            <span>分析面板</span>
            <span className={`transition-transform ${sidebarOpen ? 'rotate-180' : ''}`}>&#9660;</span>
          </button>
        <div className={`flex flex-col min-h-0 gap-2 ${sidebarOpen ? 'max-h-[60vh] md:max-h-none' : 'max-h-0 overflow-hidden md:max-h-none'} transition-all duration-300`}>
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
                  <ProhibitionAlerts />
                  <WinnerPatternAlerts />
                  <RuleAlerts />
                  <TradeHistory />
                </div>
              )}
              {sideTab === 'chip' && currentStock && (
                <ChipDetailPanel symbol={currentStock.ticker} />
              )}
            </div>
          )}
        </div>
        </div>
      </div>

      {/* ── Bottom: Backtest (collapsible) ── */}
      <div className="shrink-0 px-3 pb-3 max-h-[40vh] overflow-y-auto">
        <BacktestPanel />
      </div>

    </PageShell>
  );
}
