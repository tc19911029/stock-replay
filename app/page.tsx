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
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sym = params.get('load');
    const target = sym || (allCandles.length === 0 ? '2330' : null);
    if (target) {
      setLoadError(null);
      loadStock(target, '1d', '2y').catch((e: Error) => {
        setLoadError(`載入 ${target} 失敗：${e.message || '請稍後再試'}`);
      });
      if (sym) window.history.replaceState({}, '', '/');
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
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
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
            <Link href="/optimize"   title="自動搜索最佳策略參數組合，網格搜索+回測比較" className="text-[11px] px-2 py-1 rounded bg-emerald-900/50 text-emerald-300 hover:bg-emerald-700 hover:text-white font-medium transition whitespace-nowrap border border-emerald-700/50 hidden md:block">優化器 <span className="text-[8px] bg-amber-600 text-white px-1 rounded-full">β</span></Link>
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
            <Link href="/settings"   className="text-[11px] px-2 py-1 rounded text-slate-400 hover:bg-slate-700 hover:text-slate-200 transition whitespace-nowrap hidden sm:block" title="設定">⚙</Link>
            {/* 移動端漢堡選單 */}
            <div className="relative sm:hidden">
              <button onClick={() => setMobileMenuOpen(v => !v)}
                className="text-slate-400 hover:text-white px-2 py-1 rounded hover:bg-slate-700 transition text-sm">
                ☰
              </button>
              {mobileMenuOpen && (
                <div className="absolute right-0 top-full mt-1 w-40 bg-slate-800 border border-slate-700 rounded-lg shadow-xl z-50 py-1">
                  {[
                    { href: '/scan', label: '🔍 掃描選股' },
                    { href: '/optimize', label: '🔬 策略優化器' },
                    { href: '/watchlist', label: '⭐ 自選股' },
                    { href: '/portfolio', label: '💼 持倉' },
                    { href: '/report', label: '📊 報表' },
                    { href: '/strategies', label: '⚙ 策略' },
                    { href: '/live-daytrade', label: '⚡ 當沖' },
                    { href: '/settings', label: '🔧 設定' },
                    { href: '/disclaimer', label: '📋 免責聲明' },
                  ].map(item => (
                    <Link key={item.href} href={item.href}
                      onClick={() => setMobileMenuOpen(false)}
                      className="block px-3 py-2 text-xs text-slate-300 hover:bg-slate-700 hover:text-white transition">
                      {item.label}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </div>

          <span className="text-[10px] text-slate-600 hidden lg:block ml-1.5 whitespace-nowrap group relative cursor-help">
            ← → Space
            <div className="absolute z-50 right-0 top-full mt-1 hidden group-hover:block w-48 p-2.5 rounded-lg bg-slate-800 border border-slate-600 text-[10px] text-slate-300 shadow-lg space-y-1">
              <div className="font-medium text-white mb-1">鍵盤快捷鍵</div>
              <div className="flex justify-between"><span>→ 右箭頭</span><span className="text-slate-500">下一根K線</span></div>
              <div className="flex justify-between"><span>← 左箭頭</span><span className="text-slate-500">上一根K線</span></div>
              <div className="flex justify-between"><span>Space</span><span className="text-slate-500">播放/暫停</span></div>
            </div>
          </span>
        </nav>
      </header>

      {/* ── Main ── */}
      <div className="flex-1 flex flex-col md:flex-row gap-2 px-3 py-2 min-h-0 overflow-hidden">

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
                  <RuleAlerts />
                  <TradeHistory />
                </div>
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

    </div>
  );
}
