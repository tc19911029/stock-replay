'use client';

import { useState } from 'react';
import type { DiagnosticsReport, DiagnosticIssue, RuleDiagnostic, OptimizationSuggestion } from '@/lib/optimizer/types';

interface IterationResult {
  round: number;
  version: { id: string };
  metrics: { winRate: number; profitFactor: number } | null;
  topSuggestion: string;
}

interface OptimizerResult {
  totalRounds: number;
  iterations: IterationResult[];
  finalVersion: string;
}

interface DiagResult {
  diagnostics: DiagnosticsReport;
  version?: { id: string };
}

export function StrategyOptimizerPanel({ symbol }: { symbol: string }) {
  const [days, setDays] = useState(30);
  const [rounds, setRounds] = useState(3);
  const [tf, setTf] = useState('5m');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<OptimizerResult | null>(null);
  const [diagResult, setDiagResult] = useState<DiagResult | null>(null);
  const [error, setError] = useState('');

  const retCls = (v: number) => v > 0 ? 'text-red-400' : v < 0 ? 'text-green-400' : 'text-slate-400';

  const runIterate = async () => {
    setLoading(true); setError(''); setResult(null); setDiagResult(null);
    try {
      const res = await fetch(`/api/daytrade/optimize?action=iterate&symbol=${symbol}&days=${days}&timeframe=${tf}&rounds=${rounds}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Error');
      setResult(json);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    setLoading(false);
  };

  const runSingle = async () => {
    setLoading(true); setError(''); setDiagResult(null);
    try {
      const res = await fetch(`/api/daytrade/optimize?action=run&symbol=${symbol}&days=${days}&timeframe=${tf}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Error');
      setDiagResult(json);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    setLoading(false);
  };

  return (
    <div className="p-2 space-y-3 text-xs">
      <div className="text-center font-bold text-sm text-violet-300">策略自動優化</div>
      <div className="text-center text-[10px] text-slate-500">回測→診斷→優化→再回測</div>

      <div className="grid grid-cols-3 gap-1.5">
        <div>
          <label className="text-slate-500 text-[9px]">天數</label>
          <select value={days} onChange={e => setDays(+e.target.value)} className="w-full bg-slate-800 border border-slate-700 rounded px-1 py-1 text-white text-[10px]">
            <option value={10}>10天</option><option value={20}>20天</option><option value={30}>30天</option><option value={60}>60天</option>
          </select>
        </div>
        <div>
          <label className="text-slate-500 text-[9px]">週期</label>
          <select value={tf} onChange={e => setTf(e.target.value)} className="w-full bg-slate-800 border border-slate-700 rounded px-1 py-1 text-white text-[10px]">
            <option value="1m">1分</option><option value="5m">5分</option><option value="15m">15分</option>
          </select>
        </div>
        <div>
          <label className="text-slate-500 text-[9px]">輪數</label>
          <select value={rounds} onChange={e => setRounds(+e.target.value)} className="w-full bg-slate-800 border border-slate-700 rounded px-1 py-1 text-white text-[10px]">
            <option value={1}>1</option><option value={3}>3</option><option value={5}>5</option><option value={10}>10</option>
          </select>
        </div>
      </div>

      <div className="flex gap-2">
        <button onClick={runSingle} disabled={loading}
          className="flex-1 bg-sky-600 hover:bg-sky-500 disabled:bg-slate-700 text-white py-2 rounded font-bold text-[11px]">
          {loading ? '...' : '單輪診斷'}
        </button>
        <button onClick={runIterate} disabled={loading}
          className="flex-1 bg-violet-600 hover:bg-violet-500 disabled:bg-slate-700 text-white py-2 rounded font-bold text-[11px]">
          {loading ? '優化中...' : `迭代${rounds}輪`}
        </button>
      </div>

      {error && <div className="text-red-400 text-center text-[10px]">{error}</div>}

      {/* Single diagnostics */}
      {diagResult?.diagnostics && (() => {
        const d = diagResult.diagnostics;
        const m = d.overallMetrics;
        return (
          <div className="space-y-2">
            <div className="text-center text-slate-400 font-bold">診斷 {diagResult.version?.id}</div>
            <div className="grid grid-cols-3 gap-1">
              {[
                ['勝率', `${m.winRate}%`, m.winRate >= 50],
                ['盈虧比', m.profitFactor.toFixed(2), m.profitFactor >= 1],
                ['停損率', `${m.stopLossRate}%`, m.stopLossRate < 40],
              ].map(([label, val, good]) => (
                <div key={String(label)} className="bg-slate-800 rounded p-1 text-center">
                  <div className="text-[8px] text-slate-500">{label}</div>
                  <div className={`font-bold ${good ? 'text-red-400' : 'text-green-400'}`}>{val}</div>
                </div>
              ))}
            </div>

            {d.issues.length > 0 && (
              <div>
                <div className="text-slate-400 font-bold mb-1">問題 ({d.issues.length})</div>
                <div className="space-y-0.5 max-h-20 overflow-y-auto">
                  {d.issues.map((issue: DiagnosticIssue, i: number) => (
                    <div key={i} className={`text-[10px] px-2 py-0.5 rounded ${
                      issue.severity === 'critical' ? 'bg-red-900/30 text-red-300' :
                      issue.severity === 'warning' ? 'bg-orange-900/30 text-orange-300' : 'bg-slate-800 text-slate-400'
                    }`}>
                      {issue.message}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {d.ruleAnalysis.length > 0 && (
              <div>
                <div className="text-slate-400 font-bold mb-1">規則品質</div>
                <div className="space-y-0.5 max-h-20 overflow-y-auto">
                  {d.ruleAnalysis.map((r: RuleDiagnostic) => (
                    <div key={r.ruleId} className="flex items-center gap-1 text-[10px] bg-slate-800/40 rounded px-1.5 py-0.5">
                      <span className={`w-3 font-black ${
                        r.grade === 'A' ? 'text-green-400' : r.grade === 'B' ? 'text-sky-400' :
                        r.grade === 'C' ? 'text-yellow-400' : r.grade === 'D' ? 'text-orange-400' : 'text-red-400'
                      }`}>{r.grade}</span>
                      <span className="text-slate-300 flex-1 truncate">{r.ruleId}</span>
                      <span className={`font-mono ${retCls(r.avgReturn)}`}>{r.avgReturn.toFixed(2)}%</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {d.suggestions.length > 0 && (
              <div>
                <div className="text-slate-400 font-bold mb-1">優化建議</div>
                {d.suggestions.slice(0, 3).map((s: OptimizationSuggestion) => (
                  <div key={s.id} className={`text-[10px] px-2 py-1 rounded border mb-1 ${
                    s.priority === 'high' ? 'bg-violet-900/20 border-violet-700/50 text-violet-200' : 'bg-slate-800/60 border-slate-700 text-slate-300'
                  }`}>
                    <div className="font-bold">{s.priority === 'high' ? '⚡' : '💡'} {s.description}</div>
                    <div className="text-[9px] text-slate-500">{s.expectedImpact}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {/* Multi-round results */}
      {result && (
        <div className="space-y-2">
          <div className="text-center text-violet-300 font-bold">迭代結果 ({result.totalRounds}輪)</div>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {result.iterations.map((it: IterationResult) => (
              <div key={it.round} className="bg-slate-800/60 rounded p-1.5">
                <div className="flex items-center gap-1 text-[10px]">
                  <span className="bg-violet-700 text-white px-1 py-0.5 rounded-full font-bold text-[8px]">R{it.round}</span>
                  <span className="text-white font-bold">{it.version.id}</span>
                  {it.metrics && <>
                    <span className={`${it.metrics.winRate >= 50 ? 'text-red-400' : 'text-green-400'}`}>{it.metrics.winRate}%</span>
                    <span className={`${it.metrics.profitFactor >= 1 ? 'text-red-400' : 'text-green-400'}`}>PF{it.metrics.profitFactor.toFixed(1)}</span>
                  </>}
                </div>
                <div className="text-[9px] text-slate-500 truncate">{it.topSuggestion}</div>
              </div>
            ))}
          </div>
          <div className="text-center text-[10px] text-slate-500">
            最終：<span className="text-violet-400 font-bold">{result.finalVersion}</span>
          </div>
        </div>
      )}
    </div>
  );
}
