'use client';

import { useState, useEffect, useMemo, Fragment, useCallback } from 'react';
import Link from 'next/link';
import { useBacktestStore, BacktestHorizon, CapitalConstraints, WalkForwardResult } from '@/store/backtestStore';
import { useSettingsStore } from '@/store/settingsStore';
import { BUILT_IN_STRATEGIES } from '@/lib/strategy/StrategyConfig';
import { useWatchlistStore } from '@/store/watchlistStore';
import { StockForwardPerformance } from '@/lib/scanner/types';
import { calcBacktestSummary } from '@/lib/backtest/ForwardAnalyzer';
import { BacktestTrade, BacktestStats } from '@/lib/backtest/BacktestEngine';
import {
  calcComposite, chipTooltip, retColor, fmtRet, exportToCsv,
  BacktestStatsPanel, CapitalPanel, ResearchAssumptions, SessionHistory, WalkForwardPanel,
  ScanResultsTable, BacktestSection,
} from '@/features/scan';
import { fetchInstitutionalBatch, type InstitutionalSummary } from '@/lib/datasource/useInstitutionalSummary';
import { PageShell } from '@/components/shared';

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function UnifiedScanPage() {
  const {
    market, scanDate, strategy,
    useCapitalMode, capitalConstraints,
    walkForwardConfig, walkForwardResult, isRunningWF,
    sessions,
    setMarket, setScanDate, setStrategy,
    setCapitalConstraints, toggleCapitalMode,
    setWalkForwardConfig, computeWalkForward,
    isScanning, scanProgress, scanError,
    scanResults, isFetchingForward, forwardError, performance,
    trades, stats,
    skippedByCapital, finalCapital, capitalReturn,
    runScan, clearCurrent,
    scanOnly, setScanOnly,
    scanMode, setScanMode,
    marketTrend,
  } = useBacktestStore();

  // 用 state 避免 SSR hydration mismatch
  const [maxDate, setMaxDate] = useState('2099-12-31');
  useEffect(() => { setMaxDate(new Date().toISOString().split('T')[0]); }, []);

  // ── Strategy picker ──
  const { activeStrategyId, customStrategies, setActiveStrategy } = useSettingsStore();
  const allStrategies = useMemo(
    () => [...BUILT_IN_STRATEGIES, ...customStrategies],
    [customStrategies],
  );

  // ── Backtest params collapsible ──
  const [showBacktestParams, setShowBacktestParams] = useState(false);

  // ── One-click scan actions ──
  const isBusy = isScanning || isFetchingForward;

  const handleScanOnly = useCallback(() => {
    if (isBusy) return;
    setScanOnly(true);
    // runScan reads scanOnly from store; we need to ensure it's set first
    setTimeout(() => useBacktestStore.getState().runScan(), 0);
  }, [isBusy, setScanOnly]);

  const handleScanBacktest = useCallback(() => {
    if (isBusy) return;
    setScanOnly(false);
    setShowBacktestParams(true);
    setTimeout(() => useBacktestStore.getState().runScan(), 0);
  }, [isBusy, setScanOnly]);

  // Summary text for collapsed backtest params
  const paramsSummary = useMemo(() => {
    const parts: string[] = [];
    parts.push(`${strategy.holdDays}日`);
    parts.push(strategy.stopLoss != null ? `停損${(strategy.stopLoss * 100).toFixed(0)}%` : '不停損');
    parts.push(strategy.takeProfit != null ? `停利+${(strategy.takeProfit * 100).toFixed(0)}%` : '不停利');
    parts.push(useCapitalMode ? '資本限制' : '無限資本');
    return parts.join(' · ');
  }, [strategy.holdDays, strategy.stopLoss, strategy.takeProfit, useCapitalMode]);

  return (
    <PageShell>
    <div className="text-slate-200">
      <div className="px-3 sm:px-4 lg:px-6 py-4 sm:py-6 space-y-4 sm:space-y-6">

        {/* ── Action Bar ── */}
        <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden">
          <div className="p-4 sm:p-5 flex flex-wrap items-end gap-3 sm:gap-4">
            {/* Market */}
            <div className="space-y-1.5">
              <label className="text-xs text-slate-500 font-medium">市場</label>
              <div className="flex rounded-lg overflow-hidden border border-slate-700">
                {(['TW', 'CN'] as const).map(m => (
                  <button key={m} onClick={() => { setMarket(m); clearCurrent(); }}
                    className={`px-4 py-2 text-sm font-medium transition-colors ${
                      market === m
                        ? 'bg-sky-600 text-white'
                        : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                    }`}>
                    {m === 'TW' ? '台股' : '陸股'}
                  </button>
                ))}
              </div>
            </div>

            {/* Date */}
            <div className="space-y-1.5">
              <label className="text-xs text-slate-500 font-medium">訊號日期</label>
              <input type="date" value={scanDate} max={maxDate} min="2020-01-01"
                onChange={e => { setScanDate(e.target.value); clearCurrent(); }}
                className="bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-sky-500"
              />
            </div>

            {/* Strategy Picker */}
            <div className="space-y-1.5">
              <label className="text-xs text-slate-500 font-medium">選股策略</label>
              <div className="flex items-center gap-1.5">
                <select
                  value={activeStrategyId}
                  onChange={e => setActiveStrategy(e.target.value)}
                  className="bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-sky-500"
                >
                  {allStrategies.map(s => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
                <Link href="/strategies" className="text-xs text-slate-500 hover:text-sky-400 transition-colors whitespace-nowrap">
                  管理
                </Link>
              </div>
            </div>

            {/* A/B Test: Full vs Pure Mode */}
            <div className="space-y-1.5">
              <label className="text-xs text-slate-500 font-medium">篩選模式</label>
              <div className="flex rounded-lg overflow-hidden border border-slate-700">
                <button onClick={() => { setScanMode('full'); clearCurrent(); }}
                  className={`px-3 py-2 text-xs font-medium transition-colors ${
                    scanMode === 'full'
                      ? 'bg-sky-600 text-white'
                      : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                  }`}
                  title="完整管線：六大條件 + 飆股分 + 主力分 + 壓力區 + 動能 + 淘汰法等 60 個規則"
                >
                  完整 (A)
                </button>
                <button onClick={() => { setScanMode('pure'); clearCurrent(); }}
                  className={`px-3 py-2 text-xs font-medium transition-colors ${
                    scanMode === 'pure'
                      ? 'bg-amber-600 text-white'
                      : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                  }`}
                  title="純朱老師：只用六大條件 SOP 核心篩選，不加任何額外分析層"
                >
                  純朱老師 (B)
                </button>
              </div>
            </div>

            {/* Scan Result Badge */}
            {scanResults.length > 0 && !isScanning && (
              <div className="text-sm text-slate-400 hidden sm:flex items-center gap-1.5">
                <span className="text-slate-300 font-medium">{scanDate}</span>
                {' 選出 '}
                <span className="text-amber-400 font-bold">{scanResults.length}</span>
                {' 檔'}
                {scanMode === 'pure' && (
                  <span className="ml-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-900/50 text-amber-300">純朱老師</span>
                )}
                {marketTrend && (
                  <span title={`大盤趨勢：${marketTrend}｜多頭＝大盤上漲，選股勝率較高｜盤整＝方向不明，需謹慎｜空頭＝大盤下跌，風險較大`}
                    className={`ml-1 px-1.5 py-0.5 rounded text-xs font-bold cursor-help ${
                    marketTrend === '多頭' ? 'bg-red-900/50 text-red-300' :
                    marketTrend === '空頭' ? 'bg-green-900/50 text-green-300' :
                    'bg-yellow-900/50 text-yellow-300'
                  }`}>{marketTrend}</span>
                )}
              </div>
            )}

            {/* ── Action Buttons (one-click) ── */}
            <div className="flex items-center gap-2 ml-auto">
              <button
                onClick={handleScanOnly}
                disabled={isBusy || !scanDate}
                title="僅篩選符合條件的股票清單，速度快"
                className="px-5 py-2.5 bg-violet-600 hover:bg-violet-500 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-lg text-sm font-semibold transition-colors whitespace-nowrap"
              >
                {isScanning && scanOnly ? (
                  <span className="flex items-center gap-2">
                    <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    掃描中 {Math.round(scanProgress)}%
                  </span>
                ) : '掃描選股'}
              </button>
              <button
                onClick={handleScanBacktest}
                disabled={isBusy || !scanDate}
                title="篩選後模擬買入出場，計算每筆交易的報酬率（含手續費）"
                className="px-5 py-2.5 bg-sky-600 hover:bg-sky-500 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-lg text-sm font-semibold transition-colors whitespace-nowrap"
              >
                {(isScanning && !scanOnly) || isFetchingForward ? (
                  <span className="flex items-center gap-2">
                    <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    {isScanning ? `掃描中 ${Math.round(scanProgress)}%` : '計算績效…'}
                  </span>
                ) : '掃描+回測'}
              </button>
            </div>
          </div>

          {/* ── Backtest Params (collapsible) ── */}
          <div className="border-t border-slate-800">
            <button
              onClick={() => setShowBacktestParams(v => !v)}
              className="w-full px-5 py-2.5 flex items-center justify-between text-xs text-slate-400 hover:text-slate-300 hover:bg-slate-800/50 transition-colors"
            >
              <span className="flex items-center gap-2">
                <span className="font-medium">回測參數</span>
                <span className="text-slate-600">{paramsSummary}</span>
              </span>
              <span className={`transition-transform ${showBacktestParams ? 'rotate-180' : ''}`}>▾</span>
            </button>

            {showBacktestParams && (
              <div className="px-5 pb-4 flex flex-wrap items-end gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs text-slate-500 font-medium">持有天數</label>
                  <select value={strategy.holdDays}
                    onChange={e => setStrategy({ holdDays: +e.target.value })}
                    className="bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-sky-500">
                    {[1, 3, 5, 10, 20].map(d => <option key={d} value={d}>{d} 日</option>)}
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs text-slate-500 font-medium">停損</label>
                  <select
                    value={strategy.stopLoss == null ? 'off' : String(strategy.stopLoss)}
                    onChange={e => setStrategy({ stopLoss: e.target.value === 'off' ? null : +e.target.value })}
                    className="bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-sky-500">
                    <option value="off">不設停損</option>
                    <option value="-0.05">-5%</option>
                    <option value="-0.07">-7%（朱老師）</option>
                    <option value="-0.10">-10%</option>
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs text-slate-500 font-medium">停利</label>
                  <select
                    value={strategy.takeProfit == null ? 'off' : String(strategy.takeProfit)}
                    onChange={e => setStrategy({ takeProfit: e.target.value === 'off' ? null : +e.target.value })}
                    className="bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-sky-500">
                    <option value="off">不設停利</option>
                    <option value="0.10">+10%</option>
                    <option value="0.15">+15%</option>
                    <option value="0.20">+20%</option>
                  </select>
                </div>

                {/* Capital Mode Toggle */}
                <div className="space-y-1.5">
                  <label className="text-xs text-slate-500 font-medium">資本模式</label>
                  <button
                    onClick={toggleCapitalMode}
                    className={`px-4 py-2 text-sm rounded-lg border transition-colors ${
                      useCapitalMode
                        ? 'bg-amber-700/60 border-amber-600 text-amber-200'
                        : 'bg-slate-800 border-slate-700 text-slate-400 hover:bg-slate-700'
                    }`}
                  >
                    {useCapitalMode ? '資本限制' : '無限資本'}
                  </button>
                </div>

                {/* Capital params (shown when capital mode is on) */}
                {useCapitalMode && (
                  <>
                    <div className="space-y-1.5">
                      <label className="text-xs text-amber-500/80 font-medium">初始資金（萬）</label>
                      <input
                        type="number" min="10" max="10000" step="10"
                        value={capitalConstraints.initialCapital / 10000}
                        onChange={e => setCapitalConstraints({ initialCapital: +e.target.value * 10000 })}
                        className="bg-slate-800 border border-amber-700/60 text-white rounded-lg px-3 py-2 text-sm w-24 focus:outline-none focus:border-amber-500"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs text-amber-500/80 font-medium">最多持倉</label>
                      <select
                        value={capitalConstraints.maxPositions}
                        onChange={e => setCapitalConstraints({ maxPositions: +e.target.value })}
                        className="bg-slate-800 border border-amber-700/60 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-amber-500"
                      >
                        {[1, 2, 3, 5, 8, 10].map(n => <option key={n} value={n}>{n} 檔</option>)}
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs text-amber-500/80 font-medium">每筆倉位</label>
                      <select
                        value={capitalConstraints.positionSizePct}
                        onChange={e => setCapitalConstraints({ positionSizePct: +e.target.value })}
                        className="bg-slate-800 border border-amber-700/60 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-amber-500"
                      >
                        <option value={0.05}>5%</option>
                        <option value={0.1}>10%</option>
                        <option value={0.15}>15%</option>
                        <option value={0.2}>20%</option>
                        <option value={0.25}>25%</option>
                        <option value={0.3}>30%</option>
                        <option value={0.5}>50%</option>
                        <option value={1.0}>100%（全倉）</option>
                      </select>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Progress */}
          {(isScanning || isFetchingForward) && (
            <div className="px-5 pb-4 space-y-2 border-t border-slate-800 pt-3">
              <div className="text-xs text-slate-400 flex items-center justify-between">
                <span>{isScanning ? `掃描歷史數據（${scanDate}）…` : '計算後續績效與回測引擎…'}</span>
                {isScanning && <span className="text-sky-400 font-mono">{Math.round(scanProgress)}%</span>}
              </div>
              <div className="h-1 bg-slate-800 rounded-full overflow-hidden">
                <div className="h-full bg-sky-500 rounded-full transition-all duration-500"
                  style={{ width: isScanning ? `${scanProgress}%` : '100%',
                           animation: isFetchingForward ? 'pulse 1s infinite' : 'none' }} />
              </div>
            </div>
          )}

          {(scanError || forwardError) && (
            <div className="mx-5 mb-4 px-4 py-2.5 bg-red-950/60 border border-red-900 rounded-lg text-sm text-red-300">
              {scanError || forwardError}
            </div>
          )}
        </div>

        {/* Results */}
        {(scanResults.length > 0 || trades.length > 0 || performance.length > 0 || sessions.filter(s => s.market === market).length > 0) && (
          <div className="flex gap-4">
            <div className="flex-1 min-w-0 space-y-4 overflow-x-auto">

              {/* Research Assumptions Notice */}
              <ResearchAssumptions market={market} strategy={strategy} />

              {/* 🎯 當日 Top 3 推薦績效追蹤 */}
              {scanResults.length > 0 && (() => {
                const sorted = [...scanResults]
                  .filter(r => r.surgeScore != null && r.surgeScore >= 30)
                  .map(r => ({ ...r, _composite: calcComposite(r) }))
                  .sort((a, b) => b._composite - a._composite);
                // 板塊分散：同板塊最多 2 支，避免過度集中
                const scored: typeof sorted = [];
                const sectorCount: Record<string, number> = {};
                for (const s of sorted) {
                  const sector = s.industry || s.symbol.slice(0, 2);
                  if ((sectorCount[sector] || 0) >= 2) continue;
                  scored.push(s);
                  sectorCount[sector] = (sectorCount[sector] || 0) + 1;
                  if (scored.length >= 3) break;
                }

                if (scored.length === 0) return null;
                const perfMap = new Map(performance.map(p => [p.symbol, p]));

                const getReasons = (r: typeof scored[0]) => {
                  const reasons: string[] = [];
                  const bd = r.sixConditionsBreakdown;
                  const passed = [
                    bd.trend && '趨勢', bd.position && '位置', bd.kbar && 'K棒',
                    bd.ma && '均線', bd.volume && '量能', bd.indicator && '指標'
                  ].filter(Boolean);
                  if (passed.length > 0) reasons.push(`六大條件 ${r.sixConditionsScore}/6（${passed.join('+')}）`);
                  if (r.trendState && r.trendPosition) reasons.push(`${r.trendState}・${r.trendPosition}`);
                  if (r.surgeFlags && r.surgeFlags.length > 0) {
                    const flagMap: Record<string, string> = {
                      'BB_SQUEEZE_BREAKOUT': '布林收縮突破', 'VOLUME_CLIMAX': '量能高潮',
                      'MA_CONVERGENCE_BREAKOUT': '均線收斂突破', 'CONSOLIDATION_BREAKOUT': '盤整突破',
                      'NEW_60D_HIGH': '60日新高', 'MOMENTUM_ACCELERATION': '動能加速',
                      'PROGRESSIVE_VOLUME': '遞增量', 'NEW_20D_HIGH': '20日新高',
                    };
                    reasons.push(r.surgeFlags.map(f => flagMap[f] || f).slice(0, 3).join('、'));
                  }
                  if (r.triggeredRules.length > 0) {
                    const buyRules = r.triggeredRules.filter(t => t.signalType === 'BUY').slice(0, 2);
                    if (buyRules.length > 0) reasons.push(buyRules.map(t => t.ruleName).join('、'));
                  }
                  if (r.histWinRate != null && r.histWinRate >= 60)
                    reasons.push(`歷史勝率 ${r.histWinRate}%（${r.histSignalCount ?? '?'}次）`);
                  return reasons;
                };

                return (
                  <div className="bg-gradient-to-r from-violet-900/20 to-blue-900/20 border border-violet-700/50 rounded-xl p-4">
                    <div className="flex items-center gap-2 mb-3">
                      <span className="text-lg">🎯</span>
                      <span className="text-sm font-bold text-white">當日 Top 3 推薦績效追蹤</span>
                      <span className="text-[10px] text-slate-500">{scanDate}</span>
                    </div>

                    <div className="space-y-3">
                      {scored.map((r, idx) => {
                        const p = perfMap.get(r.symbol);
                        const reasons = getReasons(r);
                        const retClass = (v: number | null | undefined) =>
                          v == null ? 'text-slate-600' : v > 0 ? 'text-red-400' : v < 0 ? 'text-green-400' : 'text-slate-400';
                        const fmt = (v: number | null | undefined) =>
                          v != null ? `${v > 0 ? '+' : ''}${v.toFixed(2)}%` : '—';
                        const rankColors = ['border-red-500/60 bg-red-950/30', 'border-orange-500/60 bg-orange-950/30', 'border-yellow-500/60 bg-yellow-950/30'];
                        const rankBg = ['bg-red-600', 'bg-orange-500', 'bg-yellow-500'];
                        const rankText = ['text-white', 'text-white', 'text-black'];

                        return (
                          <div key={r.symbol} className={`border rounded-lg p-3 ${rankColors[idx]}`}>
                            <div className="flex items-start gap-3">
                              <span className={`text-xs font-black w-6 h-6 flex items-center justify-center rounded-full shrink-0 mt-0.5 ${rankBg[idx]} ${rankText[idx]}`}>
                                {idx + 1}
                              </span>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="font-bold text-white text-sm">{r.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '')}</span>
                                  <span className="text-slate-400 text-xs">{r.name}</span>
                                  <span className={`font-bold px-1.5 py-0.5 rounded text-[10px] ${
                                    r.surgeGrade === 'S' ? 'bg-red-600 text-white' :
                                    r.surgeGrade === 'A' ? 'bg-orange-500 text-white' : 'bg-yellow-600 text-white'
                                  }`}>{r.surgeGrade}級</span>
                                  <span className="text-[10px] text-slate-500">潛力{r.surgeScore}</span>
                                  <span className="text-[10px] text-sky-400">綜合{r._composite}</span>
                                  {r.histWinRate != null && (
                                    <span className={`text-[10px] px-1 rounded ${r.histWinRate >= 60 ? 'bg-green-900/60 text-green-300' : r.histWinRate >= 50 ? 'bg-yellow-900/60 text-yellow-300' : 'bg-red-900/60 text-red-300'}`}>
                                      勝率{r.histWinRate}%
                                    </span>
                                  )}
                                  <span className="text-[10px] text-slate-500">買入 {r.price.toFixed(2)}</span>
                                  <Link href={`/?load=${r.symbol}&date=${scanDate}`}
                                    className="text-[10px] text-sky-400 hover:text-sky-300 px-1.5 py-0.5 rounded border border-sky-700/50 hover:bg-sky-900/30 ml-1">
                                    走圖
                                  </Link>
                                  <Link href={`/analysis/${r.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '')}`}
                                    className="text-[10px] text-violet-400 hover:text-violet-300 px-1.5 py-0.5 rounded border border-violet-700/50 hover:bg-violet-900/30 ml-1">
                                    AI分析
                                  </Link>
                                  <button
                                    onClick={(e) => {
                                      useWatchlistStore.getState().add(r.symbol, r.name);
                                      const btn = e.currentTarget;
                                      btn.textContent = '✓ 已加';
                                      setTimeout(() => { btn.textContent = '+自選'; }, 1200);
                                    }}
                                    className="text-[10px] text-amber-400 hover:text-amber-300 px-1.5 py-0.5 rounded border border-amber-700/50 hover:bg-amber-900/30">
                                    {useWatchlistStore.getState().has(r.symbol) ? '✓ 已加' : '+自選'}
                                  </button>
                                </div>

                                <div className="mt-1.5 flex flex-wrap gap-1">
                                  {reasons.map((reason, i) => (
                                    <span key={i} className="text-[10px] bg-slate-800/80 text-slate-300 px-1.5 py-0.5 rounded">
                                      {reason}
                                    </span>
                                  ))}
                                </div>

                                {performance.length > 0 && <div className="mt-2 grid grid-cols-10 gap-1 text-[10px]">
                                  {[
                                    { label: '隔日開', val: p?.openReturn },
                                    { label: '1日', val: p?.d1Return },
                                    { label: '2日', val: p?.d2Return },
                                    { label: '3日', val: p?.d3Return },
                                    { label: '4日', val: p?.d4Return },
                                    { label: '5日', val: p?.d5Return },
                                    { label: '10日', val: p?.d10Return },
                                    { label: '20日', val: p?.d20Return },
                                  ].map(({ label, val }) => (
                                    <div key={label} className="text-center">
                                      <div className="text-slate-500">{label}</div>
                                      <div className={`font-mono font-bold ${retClass(val)}`}>{fmt(val)}</div>
                                    </div>
                                  ))}
                                  <div className="text-center">
                                    <div className="text-slate-500">最高</div>
                                    <div className="font-mono font-bold text-red-400">{p ? `+${p.maxGain.toFixed(1)}%` : '—'}</div>
                                  </div>
                                  <div className="text-center">
                                    <div className="text-slate-500">最低</div>
                                    <div className="font-mono font-bold text-green-400">{p ? `${p.maxLoss.toFixed(1)}%` : '—'}</div>
                                  </div>
                                </div>}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}

              {/* Scan Results Table (scanOnly mode) */}
              <ScanResultsTable />

              {/* Backtest Section (backtest mode) */}
              <BacktestSection />

            </div>

            {/* Sidebar */}
            <div className="w-44 shrink-0 hidden xl:block">
              <SessionHistory />
            </div>
          </div>
        )}

        {/* Empty state */}
        {!isScanning && !isFetchingForward && scanResults.length === 0 && !scanError && (
          scanProgress ? (
            <div className="text-center py-16 text-slate-500 space-y-3">
              <div className="text-5xl">📭</div>
              <div className="text-lg font-medium text-slate-400">本日無符合條件的個股</div>
              <div className="text-sm space-y-1">
                <p>可能的原因：</p>
                <ul className="text-xs text-slate-500 space-y-0.5">
                  <li>大盤處於空頭或盤整，門檻自動提高</li>
                  <li>該日期市場整體量能不足</li>
                  <li>策略條件較嚴格（可在「策略」頁面調整門檻）</li>
                </ul>
                <p className="text-xs text-sky-400 mt-3">建議：嘗試其他日期，或降低最低評分門檻</p>
              </div>
            </div>
          ) : (
            <div className="text-center py-20 text-slate-500 space-y-2">
              <div className="text-5xl">🔬</div>
              <div className="text-lg font-medium text-slate-400">選擇市場、日期、策略，開始回測</div>
              <div className="text-sm">嚴謹模式：進場用隔日開盤價，成本模型台股/陸股分開計算</div>
              <div className="text-sm">每筆交易保留完整進出場紀錄與命中原因</div>
            </div>
          )
        )}

      </div>
    </div>
    </PageShell>
  );
}
