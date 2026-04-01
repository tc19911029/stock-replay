'use client';

/**
 * ObservationPanel.tsx — 回測模式 A：選股後表現觀察面板
 *
 * 功能：
 * - 輸入：掃描會話歷史（StoredSession）+ 排序因子
 * - 使用 /api/backtest/forward 取得前瞻資料
 * - 呼叫 /api/backtest/observation 計算摘要統計
 * - 顯示 Top-1/Top-3 勝率、平均報酬、Spearman IC
 * - 顯示每筆觀察紀錄（排名 + d1/d5/d10/d20 報酬）
 */

import { useState, useCallback } from 'react';
import type { ScanSession } from '@/lib/scanner/types';
import type { ObservationRecord, ObservationSummary, FactorComparisonRow } from '@/lib/backtest/ObservationBacktest';
import { retColor, fmtRet } from '../utils';

// ── Types ─────────────────────────────────────────────────────────────────────

type RankingFactor = 'composite' | 'surge' | 'smartMoney' | 'histWinRate' | 'sixConditions';

const FACTOR_LABELS: Record<RankingFactor, string> = {
  composite:     '複合評分',
  surge:         '飆股潛力',
  smartMoney:    '智慧資金',
  histWinRate:   '歷史勝率',
  sixConditions: '六條件分',
};

// ── Sub-components ─────────────────────────────────────────────────────────────

function SummaryKpi({ label, value, sub, color = 'text-white' }: {
  label: string; value: string; sub?: string; color?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 p-4 bg-slate-800/60 rounded-lg border border-slate-700/40">
      <div className="text-[10px] text-slate-500 uppercase tracking-wide">{label}</div>
      <div className={`text-lg font-bold leading-tight ${color}`}>{value}</div>
      {sub && <div className="text-[10px] text-slate-600 mt-0.5">{sub}</div>}
    </div>
  );
}

function icColor(ic: number | undefined): string {
  if (ic == null) return 'text-slate-400';
  if (ic > 0.05) return 'text-red-400';
  if (ic > 0) return 'text-orange-400';
  if (ic < -0.05) return 'text-green-400';
  return 'text-slate-400';
}

function SummarySection({ summary }: { summary: ObservationSummary }) {
  return (
    <div className="space-y-3">
      <div className="text-xs text-slate-400 font-semibold uppercase tracking-wide border-b border-slate-700 pb-2">
        摘要統計 — {FACTOR_LABELS[summary.rankingFactor as RankingFactor] ?? summary.rankingFactor}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <SummaryKpi
          label="Top-1 勝率"
          value={summary.top1WinRate != null ? `${summary.top1WinRate}%` : '—'}
          sub={summary.top1AvgReturn != null ? `平均 ${fmtRet(summary.top1AvgReturn)}` : undefined}
          color={retColor(summary.top1WinRate != null ? summary.top1WinRate - 50 : null)}
        />
        <SummaryKpi
          label="Top-3 勝率"
          value={summary.top3WinRate != null ? `${summary.top3WinRate}%` : '—'}
          sub={summary.top3AvgReturn != null ? `平均 ${fmtRet(summary.top3AvgReturn)}` : undefined}
          color={retColor(summary.top3WinRate != null ? summary.top3WinRate - 50 : null)}
        />
        <SummaryKpi
          label="Spearman IC"
          value={summary.spearmanIC != null ? summary.spearmanIC.toFixed(3) : '—'}
          sub={summary.icIR != null ? `IR: ${summary.icIR.toFixed(2)}` : undefined}
          color={icColor(summary.spearmanIC)}
        />
        <SummaryKpi
          label="覆蓋率"
          value={summary.coverageRate != null ? `${summary.coverageRate}%` : '—'}
          sub={`${summary.totalSignals} 筆訊號`}
        />
      </div>
    </div>
  );
}

function RetCell({ v }: { v: number | undefined }) {
  if (v == null) return <span className="text-slate-600">—</span>;
  return <span className={retColor(v)}>{fmtRet(v)}</span>;
}

function RecordsTable({ records }: { records: ObservationRecord[] }) {
  const topN = records.filter(r => r.rank <= 5);
  if (topN.length === 0) return <p className="text-slate-600 text-sm py-4">無資料</p>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs text-slate-300">
        <thead>
          <tr className="border-b border-slate-700 text-slate-500">
            <th className="py-2 pr-3 text-left">日期</th>
            <th className="py-2 pr-3 text-left">代號</th>
            <th className="py-2 pr-3 text-center">名次</th>
            <th className="py-2 pr-3 text-right">六條件</th>
            <th className="py-2 pr-3 text-right">因子分</th>
            <th className="py-2 pr-3 text-right">D1</th>
            <th className="py-2 pr-3 text-right">D3</th>
            <th className="py-2 pr-3 text-right">D5</th>
            <th className="py-2 pr-3 text-right">D10</th>
            <th className="py-2 pr-3 text-right">D20</th>
            <th className="py-2 text-right">MaxGain</th>
          </tr>
        </thead>
        <tbody>
          {topN.map((r, i) => {
            const factorScore = r.compositeScore ?? r.surgeScore ?? r.sixConditionsScore;
            return (
              <tr key={i} className="border-b border-slate-800/60 hover:bg-slate-800/30">
                <td className="py-1.5 pr-3 text-slate-500 font-mono">{r.scanDate}</td>
                <td className="py-1.5 pr-3 font-medium">{r.symbol} <span className="text-slate-500">{r.name}</span></td>
                <td className="py-1.5 pr-3 text-center">
                  <span className={`font-bold ${r.rank === 1 ? 'text-yellow-400' : r.rank <= 3 ? 'text-slate-300' : 'text-slate-500'}`}>
                    #{r.rank}
                  </span>
                </td>
                <td className="py-1.5 pr-3 text-right text-slate-400">{r.sixConditionsScore}/6</td>
                <td className="py-1.5 pr-3 text-right">{factorScore != null ? Math.round(factorScore) : '—'}</td>
                <td className="py-1.5 pr-3 text-right"><RetCell v={r.returnD1} /></td>
                <td className="py-1.5 pr-3 text-right"><RetCell v={r.returnD3} /></td>
                <td className="py-1.5 pr-3 text-right"><RetCell v={r.returnD5} /></td>
                <td className="py-1.5 pr-3 text-right"><RetCell v={r.returnD10} /></td>
                <td className="py-1.5 pr-3 text-right"><RetCell v={r.returnD20} /></td>
                <td className="py-1.5 text-right"><RetCell v={r.maxGain} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Factor Comparison Table (Phase 6) ─────────────────────────────────────────

const ALL_FACTORS: RankingFactor[] = ['composite', 'surge', 'smartMoney', 'histWinRate', 'sixConditions'];

function ComparisonTable({ rows }: { rows: FactorComparisonRow[] }) {
  if (rows.length === 0) return null;
  // Find best row for each metric
  const bestTop1WR  = Math.max(...rows.map(r => r.top1WinRate  ?? 0));
  const bestTop1Ret = Math.max(...rows.map(r => r.top1AvgReturn ?? -Infinity));
  const bestIC      = Math.max(...rows.map(r => r.spearmanIC    ?? -Infinity));

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs text-slate-300">
        <thead>
          <tr className="border-b border-slate-700 text-slate-500">
            <th className="py-2 pr-4 text-left">排序因子</th>
            <th className="py-2 pr-4 text-right">Top-1 勝率</th>
            <th className="py-2 pr-4 text-right">Top-1 均報酬</th>
            <th className="py-2 pr-4 text-right">Top-3 勝率</th>
            <th className="py-2 pr-4 text-right">Top-3 均報酬</th>
            <th className="py-2 pr-4 text-right">Spearman IC</th>
            <th className="py-2 text-right">訊號數</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-slate-800/60 hover:bg-slate-800/30">
              <td className="py-1.5 pr-4 font-medium">{FACTOR_LABELS[r.factor]}</td>
              <td className={`py-1.5 pr-4 text-right font-mono ${r.top1WinRate === bestTop1WR ? 'text-yellow-400 font-bold' : retColor(r.top1WinRate != null ? r.top1WinRate - 50 : null)}`}>
                {r.top1WinRate != null ? `${r.top1WinRate}%` : '—'}
              </td>
              <td className={`py-1.5 pr-4 text-right font-mono ${r.top1AvgReturn === bestTop1Ret ? 'text-yellow-400 font-bold' : retColor(r.top1AvgReturn ?? null)}`}>
                {r.top1AvgReturn != null ? fmtRet(r.top1AvgReturn) : '—'}
              </td>
              <td className={`py-1.5 pr-4 text-right font-mono ${retColor(r.top3WinRate != null ? r.top3WinRate - 50 : null)}`}>
                {r.top3WinRate != null ? `${r.top3WinRate}%` : '—'}
              </td>
              <td className={`py-1.5 pr-4 text-right font-mono ${retColor(r.top3AvgReturn ?? null)}`}>
                {r.top3AvgReturn != null ? fmtRet(r.top3AvgReturn) : '—'}
              </td>
              <td className={`py-1.5 pr-4 text-right font-mono ${r.spearmanIC === bestIC ? 'text-yellow-400 font-bold' : icColor(r.spearmanIC)}`}>
                {r.spearmanIC != null ? r.spearmanIC.toFixed(3) : '—'}
              </td>
              <td className="py-1.5 text-right text-slate-500">{r.totalSignals}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[10px] text-slate-600 mt-2">黃色 = 各項最佳值</p>
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────

interface ObservationPanelProps {
  sessions: ScanSession[];
}

export function ObservationPanel({ sessions }: ObservationPanelProps) {
  const [mode,   setMode]   = useState<'single' | 'compare'>('single');
  const [factor, setFactor] = useState<RankingFactor>('composite');
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [records, setRecords]   = useState<ObservationRecord[]>([]);
  const [summary, setSummary]   = useState<ObservationSummary | null>(null);
  const [compareRows, setCompareRows] = useState<FactorComparisonRow[]>([]);

  const validSessions = sessions.filter(s => s.results.length > 0);

  // Shared: fetch forward data for all sessions
  const fetchForwardData = useCallback(async () => {
    const forwardDataByDate: Record<string, Record<string, unknown>> = {};
    await Promise.allSettled(
      validSessions.map(async (s) => {
        const stocks = s.results.map(r => ({ symbol: r.symbol, name: r.name, scanPrice: r.price }));
        try {
          const res  = await fetch('/api/backtest/forward', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scanDate: s.date, stocks }),
          });
          const data = await res.json();
          if (data.performance) {
            forwardDataByDate[s.date] = {};
            for (const p of data.performance) {
              forwardDataByDate[s.date][p.symbol] = {
                symbol: p.symbol, nextOpen: p.nextOpenPrice,
                returnD1: p.d1ReturnFromOpen, returnD2: p.d2Return,
                returnD3: p.d3Return,         returnD5: p.d5ReturnFromOpen,
                returnD10: p.d10ReturnFromOpen, returnD20: p.d20ReturnFromOpen,
                maxGain: p.maxGain, maxDrawdown: p.maxLoss,
              };
            }
          }
        } catch { /* skip */ }
      })
    );
    return forwardDataByDate;
  }, [validSessions]);

  const runBacktest = useCallback(async () => {
    if (validSessions.length === 0) return;
    setLoading(true);
    setError(null);
    setRecords([]);
    setSummary(null);
    setCompareRows([]);

    try {
      const forwardDataByDate = await fetchForwardData();
      const scanResultsByDate = validSessions.map(s => ({ date: s.date, results: s.results }));
      const market = validSessions[0].market;

      if (mode === 'compare') {
        // 對比模式：並行跑所有5個因子
        const results = await Promise.all(
          ALL_FACTORS.map(f =>
            fetch('/api/backtest/observation', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ scanResultsByDate, forwardDataByDate, factor: f, market }),
            }).then(r => r.json())
          )
        );
        const rows: FactorComparisonRow[] = results.map((data, i) => ({
          factor:         ALL_FACTORS[i],
          top1WinRate:    data.summary?.top1WinRate,
          top3WinRate:    data.summary?.top3WinRate,
          top1AvgReturn:  data.summary?.top1AvgReturn,
          top3AvgReturn:  data.summary?.top3AvgReturn,
          spearmanIC:     data.summary?.spearmanIC,
          icIR:           data.summary?.icIR,
          totalSignals:   data.summary?.totalSignals ?? 0,
          coverageRate:   data.summary?.coverageRate,
        }));
        setCompareRows(rows);
      } else {
        // 單因子模式
        const res  = await fetch('/api/backtest/observation', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scanResultsByDate, forwardDataByDate, factor, market }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? '回測失敗');
        setRecords(data.records ?? []);
        setSummary(data.summary ?? null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '未知錯誤');
    } finally {
      setLoading(false);
    }
  }, [validSessions, factor, mode, fetchForwardData]);

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-slate-500 uppercase tracking-wide">模式</label>
          <div className="flex rounded overflow-hidden border border-slate-600">
            {(['single', 'compare'] as const).map(m => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`px-3 py-1.5 text-sm ${mode === m ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}
              >
                {m === 'single' ? '單因子' : '對比所有'}
              </button>
            ))}
          </div>
        </div>
        {mode === 'single' && (
          <div className="flex flex-col gap-1">
            <label className="text-[10px] text-slate-500 uppercase tracking-wide">排序因子</label>
            <select
              value={factor}
              onChange={e => setFactor(e.target.value as RankingFactor)}
              className="bg-slate-800 border border-slate-600 text-slate-200 text-sm rounded px-3 py-1.5"
            >
              {(Object.entries(FACTOR_LABELS) as [RankingFactor, string][]).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </div>
        )}
        <div className="flex flex-col gap-1">
          <div className="text-[10px] text-slate-500 uppercase tracking-wide">會話數</div>
          <div className="text-sm text-slate-300 py-1.5">{validSessions.length} 個掃描日</div>
        </div>
        <button
          onClick={runBacktest}
          disabled={loading || validSessions.length === 0}
          className="px-5 py-1.5 text-sm font-medium rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white transition-colors"
        >
          {loading ? '計算中…' : '執行觀察型回測'}
        </button>
      </div>

      {error && (
        <div className="text-sm text-red-400 bg-red-900/20 border border-red-800/40 rounded px-4 py-2">
          {error}
        </div>
      )}

      {summary && <SummarySection summary={summary} />}

      {compareRows.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs text-slate-400 font-semibold uppercase tracking-wide border-b border-slate-700 pb-2">
            排序因子對比（Phase 6 — 找出最佳因子）
          </div>
          <ComparisonTable rows={compareRows} />
        </div>
      )}

      {records.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs text-slate-400 font-semibold uppercase tracking-wide border-b border-slate-700 pb-2">
            Top-5 排名紀錄（每日前5名）
          </div>
          <RecordsTable records={records} />
        </div>
      )}

      {!loading && validSessions.length === 0 && (
        <p className="text-slate-600 text-sm">請先執行選股掃描以取得歷史會話</p>
      )}
    </div>
  );
}
