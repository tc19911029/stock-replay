'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useBacktestStore, BacktestHorizon } from '@/store/backtestStore';
import { StockScanResult, StockForwardPerformance } from '@/lib/scanner/types';
import { calcBacktestSummary } from '@/lib/backtest/ForwardAnalyzer';

// ── Helpers ────────────────────────────────────────────────────────────────────

function retColor(v: number | null) {
  if (v === null) return 'text-slate-500';
  if (v > 0)  return 'text-emerald-400';
  if (v < 0)  return 'text-red-400';
  return 'text-slate-400';
}

function fmtRet(v: number | null) {
  if (v === null) return '–';
  return (v > 0 ? '+' : '') + v.toFixed(2) + '%';
}

function scoreColor(s: number) {
  if (s >= 5) return 'text-amber-400 font-bold';
  if (s >= 4) return 'text-emerald-400 font-semibold';
  if (s >= 3) return 'text-sky-400';
  return 'text-slate-400';
}

function trendBadge(t: string) {
  const cls =
    t === '多頭' ? 'bg-emerald-900/60 text-emerald-300 border-emerald-700' :
    t === '空頭' ? 'bg-red-900/60 text-red-300 border-red-700' :
    'bg-slate-700/60 text-slate-300 border-slate-600';
  return (
    <span className={`px-1.5 py-0.5 text-xs rounded border ${cls}`}>{t}</span>
  );
}

// ── Summary Card ───────────────────────────────────────────────────────────────

function SummaryCard({
  label, horizon, performance,
}: {
  label: string;
  horizon: BacktestHorizon;
  performance: StockForwardPerformance[];
}) {
  const stats = calcBacktestSummary(performance, horizon);
  if (!stats) return (
    <div className="bg-slate-800 rounded-xl p-4 flex flex-col items-center gap-1 opacity-40">
      <div className="text-xs text-slate-400">{label}</div>
      <div className="text-slate-500 text-sm">等待資料</div>
    </div>
  );

  return (
    <div className="bg-slate-800 rounded-xl p-4 flex flex-col gap-2">
      <div className="text-xs text-slate-400 font-medium">{label}績效</div>
      <div className={`text-2xl font-bold ${retColor(stats.avgReturn)}`}>
        {fmtRet(stats.avgReturn)}
        <span className="text-xs font-normal text-slate-400 ml-1">平均</span>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <span className="text-slate-400">勝率</span>
        <span className={stats.winRate >= 50 ? 'text-emerald-400' : 'text-red-400'}>
          {stats.winRate}%（{stats.wins}↑{stats.losses}↓）
        </span>
        <span className="text-slate-400">中位數</span>
        <span className={retColor(stats.median)}>{fmtRet(stats.median)}</span>
        <span className="text-slate-400">最大獲利</span>
        <span className="text-emerald-400">+{stats.maxGain.toFixed(2)}%</span>
        <span className="text-slate-400">最大虧損</span>
        <span className="text-red-400">{stats.maxLoss.toFixed(2)}%</span>
      </div>
    </div>
  );
}

// ── Result Row ─────────────────────────────────────────────────────────────────

function ResultRow({
  result, perf,
}: {
  result: StockScanResult;
  perf:   StockForwardPerformance | undefined;
}) {
  const sym = result.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
  const marketSuffix = result.symbol.match(/\.(TW|TWO|SS|SZ)$/i)?.[1]?.toUpperCase() ?? '';

  return (
    <tr className="border-t border-slate-700/50 hover:bg-slate-700/30 transition-colors">
      <td className="py-2.5 px-3">
        <div className="font-medium text-white text-sm">{result.name}</div>
        <div className="text-xs text-slate-400">{sym}
          <span className="ml-1 text-slate-600">.{marketSuffix}</span>
        </div>
      </td>

      <td className="py-2.5 px-3 text-center">
        <span className={`text-sm ${scoreColor(result.sixConditionsScore)}`}>
          {result.sixConditionsScore}/6
        </span>
        <div className="flex justify-center gap-0.5 mt-1">
          {Object.values(result.sixConditionsBreakdown).map((v, i) => (
            <div key={i} className={`w-2 h-2 rounded-full ${v ? 'bg-amber-400' : 'bg-slate-600'}`} />
          ))}
        </div>
      </td>

      <td className="py-2.5 px-3 text-center">
        {trendBadge(result.trendState)}
      </td>

      <td className="py-2.5 px-3 text-right font-mono text-sm text-slate-200">
        {result.price.toFixed(result.price >= 10 ? 2 : 3)}
      </td>

      {/* Forward returns */}
      {perf ? (
        <>
          <td className={`py-2.5 px-2 text-right text-xs font-mono ${retColor(perf.openReturn)}`}>
            {fmtRet(perf.openReturn)}
          </td>
          <td className={`py-2.5 px-2 text-right text-xs font-mono ${retColor(perf.d1Return)}`}>
            {fmtRet(perf.d1Return)}
          </td>
          <td className={`py-2.5 px-2 text-right text-xs font-mono ${retColor(perf.d3Return)}`}>
            {fmtRet(perf.d3Return)}
          </td>
          <td className={`py-2.5 px-2 text-right text-xs font-mono ${retColor(perf.d5Return)}`}>
            {fmtRet(perf.d5Return)}
          </td>
          <td className={`py-2.5 px-2 text-right text-xs font-mono ${retColor(perf.d10Return)}`}>
            {fmtRet(perf.d10Return)}
          </td>
          <td className={`py-2.5 px-2 text-right text-xs font-mono ${retColor(perf.d20Return)}`}>
            {fmtRet(perf.d20Return)}
          </td>
          <td className="py-2.5 px-2 text-right text-xs">
            <span className="text-emerald-400">+{perf.maxGain.toFixed(1)}%</span>
            <span className="text-slate-500 mx-0.5">/</span>
            <span className="text-red-400">{perf.maxLoss.toFixed(1)}%</span>
          </td>
        </>
      ) : (
        <td colSpan={8} className="py-2.5 px-3 text-center text-xs text-slate-500">
          計算中…
        </td>
      )}

      <td className="py-2.5 px-3 text-center">
        <Link
          href={`/?load=${result.symbol}`}
          className="text-xs text-sky-400 hover:text-sky-300 underline underline-offset-2"
        >
          看圖
        </Link>
      </td>
    </tr>
  );
}

// ── Session History Sidebar ────────────────────────────────────────────────────

function SessionHistory() {
  const { sessions, loadSession, market, scanDate } = useBacktestStore();
  const filtered = sessions.filter(s => s.market === market);

  if (filtered.length === 0) return null;

  return (
    <div className="bg-slate-800 rounded-xl p-4">
      <h3 className="text-sm font-semibold text-slate-300 mb-3">回測歷史</h3>
      <div className="space-y-1.5">
        {filtered.map(s => (
          <button
            key={s.id}
            onClick={() => loadSession(s.id)}
            className={`w-full text-left px-3 py-2 rounded-lg text-xs hover:bg-slate-700 transition-colors ${
              s.scanDate === scanDate ? 'bg-slate-700 text-white' : 'text-slate-400'
            }`}
          >
            <span className="font-mono">{s.scanDate}</span>
            <span className="ml-2 text-slate-500">選出 {s.scanResults.length} 檔</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function BacktestPage() {
  const {
    market, scanDate, setMarket, setScanDate,
    isScanning, scanProgress, scanError,
    scanResults, isFetchingForward, forwardError, performance,
    runBacktest, clearCurrent,
  } = useBacktestStore();

  const [activeHorizon, setActiveHorizon] = useState<BacktestHorizon>('d5');

  const perfMap = new Map(performance.map(p => [p.symbol, p]));

  const today = new Date().toISOString().split('T')[0];
  const maxDate = (() => {
    const d = new Date(); d.setDate(d.getDate() - 1);
    return d.toISOString().split('T')[0];
  })();

  const horizonLabels: { key: BacktestHorizon; label: string }[] = [
    { key: 'open', label: '隔天開盤' },
    { key: 'd1',   label: '1日' },
    { key: 'd3',   label: '3日' },
    { key: 'd5',   label: '5日' },
    { key: 'd10',  label: '10日' },
    { key: 'd20',  label: '20日' },
  ];

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 h-14 flex items-center gap-4">
          <Link href="/" className="text-slate-400 hover:text-slate-200 text-sm">← 主頁</Link>
          <div className="h-5 w-px bg-slate-700" />
          <h1 className="font-bold text-white">歷史掃描回測</h1>
          <div className="ml-auto flex items-center gap-2">
            <Link href="/scanner" className="text-xs text-slate-400 hover:text-slate-200 px-3 py-1.5 rounded-lg border border-slate-700 hover:border-slate-500 transition-colors">
              即時掃描
            </Link>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 py-6 space-y-6">

        {/* Controls */}
        <div className="bg-slate-900 rounded-xl p-5 border border-slate-800">
          <div className="flex flex-wrap items-end gap-4">
            {/* Market */}
            <div className="space-y-1.5">
              <label className="text-xs text-slate-400 font-medium">市場</label>
              <div className="flex gap-2">
                {(['TW', 'CN'] as const).map(m => (
                  <button
                    key={m}
                    onClick={() => { setMarket(m); clearCurrent(); }}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                      market === m
                        ? 'bg-sky-600 text-white'
                        : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                    }`}
                  >
                    {m === 'TW' ? '台股' : '陸股'}
                  </button>
                ))}
              </div>
            </div>

            {/* Date */}
            <div className="space-y-1.5">
              <label className="text-xs text-slate-400 font-medium">掃描日期</label>
              <input
                type="date"
                value={scanDate}
                max={maxDate}
                min="2020-01-01"
                onChange={e => { setScanDate(e.target.value); clearCurrent(); }}
                className="bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-sky-500"
              />
            </div>

            {/* Scan button */}
            <button
              onClick={runBacktest}
              disabled={isScanning || isFetchingForward || !scanDate}
              className="px-6 py-2 bg-sky-600 hover:bg-sky-500 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-lg text-sm font-semibold transition-colors"
            >
              {isScanning ? '掃描中…' : isFetchingForward ? '計算績效…' : '開始回測'}
            </button>

            {scanResults.length > 0 && !isScanning && (
              <div className="text-sm text-slate-400">
                <span className="text-white font-semibold">{scanDate}</span> 共選出{' '}
                <span className="text-amber-400 font-bold">{scanResults.length}</span> 檔
              </div>
            )}
          </div>

          {/* Progress */}
          {(isScanning || isFetchingForward) && (
            <div className="mt-4 space-y-1">
              <div className="text-xs text-slate-400">
                {isScanning ? `掃描歷史數據（${scanDate}）…` : '計算後續績效…'}
              </div>
              <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-sky-600 rounded-full transition-all duration-500"
                  style={{ width: isScanning ? `${scanProgress}%` : '100%', animation: isFetchingForward ? 'pulse 1s ease-in-out infinite' : 'none' }}
                />
              </div>
            </div>
          )}

          {(scanError || forwardError) && (
            <div className="mt-3 px-3 py-2 bg-red-900/30 border border-red-800 rounded-lg text-sm text-red-300">
              {scanError || forwardError}
            </div>
          )}
        </div>

        {/* Summary grid – show once forward data is ready */}
        {performance.length > 0 && (
          <div>
            <h2 className="text-sm font-semibold text-slate-400 mb-3 uppercase tracking-wide">
              策略績效統計（{scanDate}）
            </h2>
            <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
              {horizonLabels.map(({ key, label }) => (
                <SummaryCard key={key} label={label} horizon={key} performance={performance} />
              ))}
            </div>
          </div>
        )}

        {/* Main content + sidebar */}
        {scanResults.length > 0 && (
          <div className="flex gap-6">
            {/* Results table */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wide">
                  選股結果 {isFetchingForward && <span className="text-sky-400 animate-pulse">（後續績效計算中…）</span>}
                </h2>
                {performance.length > 0 && (
                  <div className="flex gap-1">
                    {horizonLabels.map(({ key, label }) => (
                      <button
                        key={key}
                        onClick={() => setActiveHorizon(key)}
                        className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                          activeHorizon === key
                            ? 'bg-sky-700 text-white'
                            : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-700 text-xs text-slate-400">
                      <th className="py-2.5 px-3 text-left font-medium">股票</th>
                      <th className="py-2.5 px-3 text-center font-medium">評分</th>
                      <th className="py-2.5 px-3 text-center font-medium">趨勢</th>
                      <th className="py-2.5 px-3 text-right font-medium">收盤價</th>
                      {performance.length > 0 ? (
                        <>
                          <th className="py-2.5 px-2 text-right font-medium">開盤</th>
                          <th className="py-2.5 px-2 text-right font-medium">1日</th>
                          <th className="py-2.5 px-2 text-right font-medium">3日</th>
                          <th className="py-2.5 px-2 text-right font-medium">5日</th>
                          <th className="py-2.5 px-2 text-right font-medium">10日</th>
                          <th className="py-2.5 px-2 text-right font-medium">20日</th>
                          <th className="py-2.5 px-2 text-right font-medium">最高/最低</th>
                        </>
                      ) : (
                        <th className="py-2.5 px-3 text-center font-medium" colSpan={8}>後續績效</th>
                      )}
                      <th className="py-2.5 px-3 text-center font-medium">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scanResults.map(r => (
                      <ResultRow
                        key={r.symbol}
                        result={r}
                        perf={perfMap.get(r.symbol)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Six conditions legend */}
              <div className="mt-2 text-xs text-slate-500 flex gap-4 flex-wrap">
                <span>六大條件：</span>
                {['趨勢', '位置', 'K棒', '均線', '成交量', '指標'].map((n, i) => (
                  <span key={i} className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-amber-400 inline-block" />
                    {n}
                  </span>
                ))}
              </div>
            </div>

            {/* Sidebar: history */}
            <div className="w-52 shrink-0 hidden lg:block">
              <SessionHistory />
            </div>
          </div>
        )}

        {/* Empty state */}
        {!isScanning && !isFetchingForward && scanResults.length === 0 && !scanError && (
          <div className="text-center py-20 text-slate-500 space-y-2">
            <div className="text-5xl">🔍</div>
            <div className="text-lg font-medium text-slate-400">選擇市場與日期，開始歷史回測</div>
            <div className="text-sm">系統將以當日收盤前的資料，跑一次朱老師選股規則</div>
            <div className="text-sm">並自動計算選出股票之後 開盤/1/3/5/10/20 日的漲跌幅</div>
          </div>
        )}

      </div>
    </div>
  );
}
