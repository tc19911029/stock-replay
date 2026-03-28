'use client';

import { useState, useRef, useCallback } from 'react';
import Link from 'next/link';

// ── Types ───────────────────────────────────────────────────────────────────────

interface ParamConfig {
  key:    string;
  label:  string;
  min:    number;
  max:    number;
  step:   number;
  defaultMin: number;
  defaultMax: number;
  defaultStep: number;
  enabled: boolean;
  isBacktestParam?: boolean;
  unit?:  string;
}

interface SearchResultItem {
  params:         Record<string, number>;
  compositeScore: number;
  tradeCount:     number;
  winRate:        number;
  avgReturn:      number;
  stats:          {
    count: number; winRate: number; avgNetReturn: number;
    profitFactor: number | null; sharpeRatio: number | null;
    maxGain: number; maxLoss: number; maxDrawdown: number;
    expectancy: number; coverageRate: number;
  } | null;
}

// ── Default Params ──────────────────────────────────────────────────────────────

const DEFAULT_PARAMS: ParamConfig[] = [
  { key: 'minScore',       label: '最低評分',     min: 1,   max: 6,   step: 1,   defaultMin: 3,    defaultMax: 6,   defaultStep: 1,   enabled: true,  unit: '分' },
  { key: 'volumeRatioMin', label: '量比門檻',     min: 0.5, max: 5.0, step: 0.1, defaultMin: 1.0,  defaultMax: 3.0, defaultStep: 0.5, enabled: true,  unit: 'x' },
  { key: 'kdMaxEntry',     label: 'KD 上限',      min: 50,  max: 99,  step: 1,   defaultMin: 70,   defaultMax: 95,  defaultStep: 5,   enabled: false, unit: '' },
  { key: 'holdDays',       label: '持有天數',     min: 1,   max: 30,  step: 1,   defaultMin: 3,    defaultMax: 15,  defaultStep: 2,   enabled: true,  isBacktestParam: true, unit: '日' },
  { key: 'stopLoss',       label: '停損',         min: -20, max: -1,  step: 1,   defaultMin: -10,  defaultMax: -3,  defaultStep: 1,   enabled: false, isBacktestParam: true, unit: '%' },
  { key: 'surgeScoreMin',  label: '最低飆股分',   min: 0,   max: 90,  step: 5,   defaultMin: 0,    defaultMax: 70,  defaultStep: 10,  enabled: false, unit: '分' },
];

// ── Test Dates (近期交易日) ─────────────────────────────────────────────────────

function getRecentTradingDates(count: number): string[] {
  const dates: string[] = [];
  const d = new Date();
  d.setDate(d.getDate() - 1); // start from yesterday
  while (dates.length < count) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) { // skip weekends
      dates.push(d.toISOString().split('T')[0]);
    }
    d.setDate(d.getDate() - 1);
  }
  return dates;
}

// ── Component ───────────────────────────────────────────────────────────────────

export default function OptimizePage() {
  const [params, setParams] = useState<ParamConfig[]>(DEFAULT_PARAMS);
  const [market, setMarket] = useState<'TW' | 'CN'>('TW');
  const [dateCount, setDateCount] = useState(3);
  const [stockLimit, setStockLimit] = useState(30);

  const [isRunning, setIsRunning] = useState(false);
  const [results, setResults]     = useState<SearchResultItem[]>([]);
  const [progress, setProgress]   = useState({ current: 0, total: 0, bestScore: 0, bestWinRate: 0, elapsedMs: 0 });
  const [error, setError]         = useState<string | null>(null);
  const [sortBy, setSortBy]       = useState<'compositeScore' | 'winRate' | 'avgReturn' | 'tradeCount'>('compositeScore');
  const [sortDir, setSortDir]     = useState<'desc' | 'asc'>('desc');

  const abortRef = useRef<AbortController | null>(null);

  // ── Param management ──

  const updateParam = useCallback((idx: number, field: string, value: number | boolean) => {
    setParams(prev => prev.map((p, i) => i === idx ? { ...p, [field]: value } : p));
  }, []);

  const enabledParams = params.filter(p => p.enabled);
  const totalCombos = enabledParams.reduce((acc, p) => {
    const count = Math.floor((p.defaultMax - p.defaultMin) / p.defaultStep) + 1;
    return acc * Math.max(count, 1);
  }, 1);

  // ── Run search ──

  const runSearch = useCallback(async () => {
    if (enabledParams.length === 0) {
      setError('請至少勾選一個參數');
      return;
    }
    if (totalCombos > 200) {
      setError(`組合數太多 (${totalCombos})，請減少參數範圍或加大步長，建議 ≤ 100`);
      return;
    }

    setIsRunning(true);
    setResults([]);
    setProgress({ current: 0, total: totalCombos, bestScore: 0, bestWinRate: 0, elapsedMs: 0 });
    setError(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const paramRanges = enabledParams.map(p => ({
        key:   p.key,
        label: p.label,
        min:   p.defaultMin,
        max:   p.defaultMax,
        step:  p.defaultStep,
        isBacktestParam: p.isBacktestParam,
      }));

      const testDates = getRecentTradingDates(dateCount);

      const res = await fetch('/api/optimize/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paramRanges, testDates, market, stockLimit }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(`API error: ${res.status}`);
      }

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer    = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            if (data.type === 'result') {
              setResults(prev => [...prev, data.result]);
              setProgress(data.progress);
            } else if (data.type === 'error') {
              setError(data.message);
            }
          } catch { /* skip malformed lines */ }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError((err as Error).message);
      }
    } finally {
      setIsRunning(false);
      abortRef.current = null;
    }
  }, [enabledParams, totalCombos, dateCount, market, stockLimit]);

  const stopSearch = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // ── Sorted results ──

  const sortedResults = [...results].sort((a, b) => {
    const dir = sortDir === 'desc' ? 1 : -1;
    return dir * ((b[sortBy] ?? 0) - (a[sortBy] ?? 0));
  });

  const bestResult  = sortedResults[0] ?? null;
  const pctComplete = progress.total > 0 ? Math.round(progress.current / progress.total * 100) : 0;

  // ── Export CSV ──

  const exportCsv = useCallback(() => {
    if (results.length === 0) return;
    const headers = ['排名', ...enabledParams.map(p => p.label), '複合分', '勝率%', '均值%', '交易數', 'PF', 'Sharpe'];
    const rows = sortedResults.map((r, i) => [
      i + 1,
      ...enabledParams.map(p => r.params[p.key] ?? ''),
      r.compositeScore.toFixed(1),
      r.winRate.toFixed(1),
      r.avgReturn.toFixed(2),
      r.tradeCount,
      r.stats?.profitFactor?.toFixed(2) ?? '',
      r.stats?.sharpeRatio?.toFixed(2) ?? '',
    ]);
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `optimize-${market}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [results, sortedResults, enabledParams, market]);

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-[#0b1120] text-white">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-950 px-4 py-2.5 flex items-center gap-3">
        <Link href="/" className="text-slate-400 hover:text-white text-sm">← 主頁</Link>
        <span className="text-slate-700">|</span>
        <h1 className="text-sm font-bold text-sky-400">🔬 策略優化器</h1>
        <span className="text-[9px] bg-amber-600 text-white px-1.5 py-0.5 rounded-full font-bold">Beta</span>
        <Link href="/scan" className="ml-auto text-xs text-slate-400 hover:text-white">掃描選股</Link>
      </header>

      <div className="max-w-6xl mx-auto p-4 space-y-4">

        {/* ── 參數設定面板 ── */}
        <div className="bg-slate-900/80 border border-slate-700 rounded-xl p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-white">⚙ 參數搜索設定</h2>
            <div className="flex items-center gap-3 text-xs">
              <div className="flex items-center gap-1.5">
                <span className="text-slate-400">市場</span>
                {(['TW', 'CN'] as const).map(m => (
                  <button key={m} onClick={() => setMarket(m)}
                    className={`px-2.5 py-1 rounded font-medium transition ${market === m ? 'bg-sky-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}>
                    {m === 'TW' ? '台股' : '陸股'}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-slate-400">測試日期數</span>
                <select value={dateCount} onChange={e => setDateCount(+e.target.value)}
                  className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-white text-xs">
                  {[1, 2, 3, 5, 7, 10].map(n => <option key={n} value={n}>{n} 天</option>)}
                </select>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-slate-400">每日取</span>
                <select value={stockLimit} onChange={e => setStockLimit(+e.target.value)}
                  className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-white text-xs">
                  {[10, 20, 30, 50].map(n => <option key={n} value={n}>前 {n} 檔</option>)}
                </select>
              </div>
            </div>
          </div>

          {/* 參數列表 */}
          <div className="space-y-2">
            {params.map((p, idx) => (
              <div key={p.key} className={`flex items-center gap-3 px-3 py-2 rounded-lg transition ${p.enabled ? 'bg-slate-800/80' : 'bg-slate-800/30 opacity-60'}`}>
                <input type="checkbox" checked={p.enabled}
                  onChange={e => updateParam(idx, 'enabled', e.target.checked)}
                  className="w-4 h-4 accent-sky-500" />
                <span className="text-xs font-medium w-24 shrink-0">{p.label}</span>
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <span>從</span>
                  <input type="number" value={p.defaultMin} step={p.step} min={p.min} max={p.max}
                    onChange={e => updateParam(idx, 'defaultMin', +e.target.value)}
                    disabled={!p.enabled}
                    className="w-16 bg-slate-700 border border-slate-600 rounded px-2 py-1 text-white text-center disabled:opacity-40" />
                  <span>到</span>
                  <input type="number" value={p.defaultMax} step={p.step} min={p.min} max={p.max}
                    onChange={e => updateParam(idx, 'defaultMax', +e.target.value)}
                    disabled={!p.enabled}
                    className="w-16 bg-slate-700 border border-slate-600 rounded px-2 py-1 text-white text-center disabled:opacity-40" />
                  <span>步長</span>
                  <input type="number" value={p.defaultStep} step={p.step < 1 ? 0.1 : 1} min={p.step}
                    onChange={e => updateParam(idx, 'defaultStep', +e.target.value)}
                    disabled={!p.enabled}
                    className="w-16 bg-slate-700 border border-slate-600 rounded px-2 py-1 text-white text-center disabled:opacity-40" />
                  {p.unit && <span className="text-slate-500">{p.unit}</span>}
                </div>
              </div>
            ))}
          </div>

          {/* 底部操作列 */}
          <div className="flex items-center gap-3 pt-2 border-t border-slate-700/50">
            <span className="text-xs text-slate-400">
              預估組合數: <span className={`font-bold ${totalCombos > 100 ? 'text-amber-400' : 'text-sky-400'}`}>{totalCombos}</span>
              {totalCombos > 100 && <span className="text-amber-400 ml-1">（建議 ≤ 100）</span>}
            </span>
            <div className="ml-auto flex gap-2">
              {isRunning ? (
                <button onClick={stopSearch}
                  className="px-4 py-2 bg-red-600 hover:bg-red-500 rounded-lg text-sm font-bold transition">
                  ⏹ 停止
                </button>
              ) : (
                <button onClick={runSearch} disabled={enabledParams.length === 0}
                  className="px-6 py-2 bg-sky-600 hover:bg-sky-500 disabled:opacity-40 rounded-lg text-sm font-bold transition">
                  🚀 開始搜索
                </button>
              )}
            </div>
          </div>
        </div>

        {/* ── 錯誤提示 ── */}
        {error && (
          <div className="bg-red-900/20 border border-red-800/40 rounded-lg px-4 py-2 text-xs text-red-400 flex items-center gap-2">
            <span>⚠</span> {error}
            <button onClick={() => setError(null)} className="ml-auto text-slate-500 hover:text-white">✕</button>
          </div>
        )}

        {/* ── 搜索進度 ── */}
        {(isRunning || results.length > 0) && (
          <div className="bg-slate-900/80 border border-slate-700 rounded-xl p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-slate-400">
                搜索進度 {progress.current}/{progress.total} ({pctComplete}%)
                {progress.elapsedMs > 0 && ` — ${(progress.elapsedMs / 1000).toFixed(0)}s`}
              </span>
              <span className="text-xs">
                最佳勝率 <span className="font-bold text-green-400">{progress.bestWinRate.toFixed(1)}%</span>
                {' '}複合分 <span className="font-bold text-sky-400">{progress.bestScore.toFixed(1)}</span>
              </span>
            </div>
            <div className="w-full h-2 bg-slate-700 rounded-full overflow-hidden">
              <div className="h-full bg-sky-500 transition-all duration-300 rounded-full"
                style={{ width: `${pctComplete}%` }} />
            </div>
          </div>
        )}

        {/* ── 結果排行 ── */}
        {results.length > 0 && (
          <div className="bg-slate-900/80 border border-slate-700 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold">📊 搜索結果排行 ({results.length} 組合)</h2>
              <button onClick={exportCsv}
                className="text-xs px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded-lg text-slate-300 transition">
                ↓ 匯出 CSV
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-700 text-slate-400">
                    <th className="py-2 px-2 text-center">#</th>
                    {enabledParams.map(p => (
                      <th key={p.key} className="py-2 px-2 text-center whitespace-nowrap">{p.label}</th>
                    ))}
                    {([
                      { k: 'compositeScore' as const, l: '複合分' },
                      { k: 'winRate' as const,        l: '勝率%' },
                      { k: 'avgReturn' as const,      l: '均值%' },
                      { k: 'tradeCount' as const,     l: '交易數' },
                    ]).map(({ k, l }) => (
                      <th key={k} className="py-2 px-2 text-right cursor-pointer hover:text-white select-none whitespace-nowrap"
                        onClick={() => {
                          if (sortBy === k) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
                          else { setSortBy(k); setSortDir('desc'); }
                        }}>
                        {l} {sortBy === k && <span className="text-sky-400">{sortDir === 'desc' ? '▼' : '▲'}</span>}
                      </th>
                    ))}
                    <th className="py-2 px-2 text-right whitespace-nowrap">PF</th>
                    <th className="py-2 px-2 text-right whitespace-nowrap">Sharpe</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedResults.slice(0, 50).map((r, i) => (
                    <tr key={i} className={`border-b border-slate-800/50 hover:bg-slate-800/40 ${i === 0 ? 'bg-sky-900/20' : ''}`}>
                      <td className="py-2 px-2 text-center font-bold text-slate-500">{i + 1}</td>
                      {enabledParams.map(p => (
                        <td key={p.key} className="py-2 px-2 text-center font-mono text-white">
                          {r.params[p.key] ?? '—'}
                        </td>
                      ))}
                      <td className={`py-2 px-2 text-right font-bold ${r.compositeScore >= 50 ? 'text-sky-400' : 'text-slate-400'}`}>
                        {r.compositeScore.toFixed(1)}
                      </td>
                      <td className={`py-2 px-2 text-right font-bold ${r.winRate >= 60 ? 'text-green-400' : r.winRate >= 40 ? 'text-yellow-400' : 'text-red-400'}`}>
                        {r.winRate.toFixed(1)}%
                      </td>
                      <td className={`py-2 px-2 text-right font-mono ${r.avgReturn >= 0 ? 'text-red-400' : 'text-green-400'}`}>
                        {r.avgReturn >= 0 ? '+' : ''}{r.avgReturn.toFixed(2)}%
                      </td>
                      <td className="py-2 px-2 text-right text-slate-300">{r.tradeCount}</td>
                      <td className="py-2 px-2 text-right text-slate-400">{r.stats?.profitFactor?.toFixed(2) ?? '—'}</td>
                      <td className="py-2 px-2 text-right text-slate-400">{r.stats?.sharpeRatio?.toFixed(2) ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── 最佳 vs 當前 比較 ── */}
        {bestResult && !isRunning && (
          <div className="bg-slate-900/80 border border-sky-700/50 rounded-xl p-4 space-y-3">
            <h2 className="text-sm font-bold text-sky-400">🏆 最佳搜索結果</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {([
                { label: '最佳參數', value: enabledParams.map(p => `${p.label}=${bestResult.params[p.key]}`).join(', '), color: 'text-white' },
                { label: '勝率', value: `${bestResult.winRate.toFixed(1)}%`, color: bestResult.winRate >= 60 ? 'text-green-400' : 'text-yellow-400' },
                { label: '平均報酬', value: `${bestResult.avgReturn >= 0 ? '+' : ''}${bestResult.avgReturn.toFixed(2)}%`, color: bestResult.avgReturn >= 0 ? 'text-red-400' : 'text-green-400' },
                { label: '複合分', value: bestResult.compositeScore.toFixed(1), color: 'text-sky-400' },
              ]).map(({ label, value, color }) => (
                <div key={label} className="bg-slate-800/60 rounded-lg p-3">
                  <div className="text-[10px] text-slate-500 mb-1">{label}</div>
                  <div className={`text-sm font-bold ${color}`}>{value}</div>
                </div>
              ))}
            </div>
            {bestResult.stats && (
              <div className="grid grid-cols-3 md:grid-cols-6 gap-2 text-[10px]">
                <div className="text-slate-500">交易數 <span className="text-white font-bold">{bestResult.tradeCount}</span></div>
                <div className="text-slate-500">PF <span className="text-white font-bold">{bestResult.stats.profitFactor?.toFixed(2) ?? '—'}</span></div>
                <div className="text-slate-500">Sharpe <span className="text-white font-bold">{bestResult.stats.sharpeRatio?.toFixed(2) ?? '—'}</span></div>
                <div className="text-slate-500">最大盈 <span className="text-red-400 font-bold">+{bestResult.stats.maxGain.toFixed(1)}%</span></div>
                <div className="text-slate-500">最大虧 <span className="text-green-400 font-bold">{bestResult.stats.maxLoss.toFixed(1)}%</span></div>
                <div className="text-slate-500">覆蓋率 <span className="text-white font-bold">{bestResult.stats.coverageRate.toFixed(0)}%</span></div>
              </div>
            )}
          </div>
        )}

        {/* ── 說明 ── */}
        <div className="text-[10px] text-slate-600 space-y-1 pb-8">
          <p>💡 策略優化器會在指定的歷史日期範圍內，逐一測試不同參數組合的回測績效，幫助你找到更好的策略參數。</p>
          <p>⚠ 注意：過度優化可能導致過擬合（只在歷史數據上表現好，未來不一定有效）。建議用不同時間段驗證結果。</p>
          <p>📊 複合分 = 30%勝率 + 25%盈虧比(PF) + 20%Sharpe + 15%交易數量 + 10%覆蓋率</p>
        </div>
      </div>
    </div>
  );
}
