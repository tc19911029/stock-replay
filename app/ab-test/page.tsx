'use client';

import { useState, useCallback } from 'react';
import { PageShell } from '@/components/shared';
import type {
  ABTestResult,
  ABTestProgressEvent,
  TopNSliceResult,
  QuintileRow,
  PerDateStats,
} from '@/lib/backtest/ABTestEngine';
import type { BacktestStats } from '@/lib/backtest/BacktestEngine';

// ── Progress ────────────────────────────────────────────────────────────────

function ProgressSection({ logs, progress }: {
  logs: string[];
  progress: { done: number; total: number; phase: string } | null;
}) {
  const pct = progress && progress.total > 0
    ? Math.round((progress.done / progress.total) * 100)
    : 0;

  return (
    <div className="space-y-3">
      {progress && (
        <div>
          <div className="flex justify-between text-xs text-muted-foreground mb-1">
            <span>{progress.phase}</span>
            <span>{progress.done}/{progress.total} ({pct}%)</span>
          </div>
          <div className="h-2 bg-secondary rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 rounded-full transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}
      <div className="max-h-32 overflow-y-auto text-xs text-muted-foreground space-y-0.5">
        {logs.map((log, i) => (
          <div key={i}>{log}</div>
        ))}
      </div>
    </div>
  );
}

// ── Stats Helper ────────────────────────────────────────────────────────────

function StatValue({ value, suffix = '', color }: {
  value: number | null | undefined;
  suffix?: string;
  color?: boolean;
}) {
  if (value == null) return <span className="text-muted-foreground/60">-</span>;
  const cls = color
    ? value > 0 ? 'text-bull' : value < 0 ? 'text-bear' : ''
    : '';
  return <span className={cls}>{value > 0 && color ? '+' : ''}{value}{suffix}</span>;
}

// ── Top-N Comparison Table ──────────────────────────────────────────────────

function TopNTable({ results }: { results: TopNSliceResult[] }) {
  return (
    <div>
      <h3 className="text-lg font-semibold mb-3">Top-N 選股對比</h3>
      <p className="text-xs text-muted-foreground mb-3">
        Group A = 六條件篩選 + 成交量最大 | Group B = 完整系統 + compositeScore 最高
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-muted-foreground border-b border-border">
            <tr>
              <th className="px-3 py-2 text-left">Top N</th>
              <th className="px-3 py-2 text-center" colSpan={4}>Group A（量最大）</th>
              <th className="px-3 py-2 text-center" colSpan={4}>Group B（分數最高）</th>
              <th className="px-3 py-2 text-center">B 優勢</th>
            </tr>
            <tr className="text-xs">
              <th className="px-3 py-1"></th>
              <th className="px-3 py-1">筆數</th>
              <th className="px-3 py-1">勝率</th>
              <th className="px-3 py-1">均報酬</th>
              <th className="px-3 py-1">Sharpe</th>
              <th className="px-3 py-1">筆數</th>
              <th className="px-3 py-1">勝率</th>
              <th className="px-3 py-1">均報酬</th>
              <th className="px-3 py-1">Sharpe</th>
              <th className="px-3 py-1">均報酬差</th>
            </tr>
          </thead>
          <tbody>
            {results.map(r => {
              const a = r.groupA;
              const b = r.groupB;
              const edge = a && b ? +(b.avgNetReturn - a.avgNetReturn).toFixed(2) : null;
              return (
                <tr key={r.topN} className="border-b border-border hover:bg-secondary/50">
                  <td className="px-3 py-2 font-medium">Top {r.topN}</td>
                  <td className="px-3 py-2 text-center">{a?.count ?? '-'}</td>
                  <td className="px-3 py-2 text-center">{a?.winRate != null ? `${a.winRate}%` : '-'}</td>
                  <td className="px-3 py-2 text-center"><StatValue value={a?.avgNetReturn} suffix="%" color /></td>
                  <td className="px-3 py-2 text-center">{a?.sharpeRatio?.toFixed(2) ?? '-'}</td>
                  <td className="px-3 py-2 text-center">{b?.count ?? '-'}</td>
                  <td className="px-3 py-2 text-center">{b?.winRate != null ? `${b.winRate}%` : '-'}</td>
                  <td className="px-3 py-2 text-center"><StatValue value={b?.avgNetReturn} suffix="%" color /></td>
                  <td className="px-3 py-2 text-center">{b?.sharpeRatio?.toFixed(2) ?? '-'}</td>
                  <td className="px-3 py-2 text-center font-bold"><StatValue value={edge} suffix="%" color /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Quintile Table ──────────────────────────────────────────────────────────

function QuintileTable({ rows }: { rows: QuintileRow[] }) {
  if (rows.length === 0) return null;

  return (
    <div>
      <h3 className="text-lg font-semibold mb-3">五分位分析（compositeScore 排名）</h3>
      <p className="text-xs text-muted-foreground mb-3">
        如果 Q1 &gt; Q2 &gt; ... &gt; Q5 呈單調遞減 → compositeScore 有效
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-muted-foreground border-b border-border">
            <tr>
              <th className="px-3 py-2 text-left">分位</th>
              <th className="px-3 py-2 text-center">筆數</th>
              <th className="px-3 py-2 text-center">勝率</th>
              <th className="px-3 py-2 text-center">均報酬</th>
              <th className="px-3 py-2 text-center">中位數</th>
              <th className="px-3 py-2 text-center">Sharpe</th>
              <th className="px-3 py-2 text-center">獲利因子</th>
              <th className="px-3 py-2 text-center">期望值</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const s = row.stats;
              // Color gradient: Q1=green → Q5=red
              const bgOpacity = ['bg-green-500/5', 'bg-green-500/3', '', 'bg-red-500/3', 'bg-red-500/5'][i] ?? '';
              return (
                <tr key={row.quintile} className={`border-b border-border ${bgOpacity}`}>
                  <td className="px-3 py-2 font-medium">{row.label}</td>
                  <td className="px-3 py-2 text-center">{row.count}</td>
                  <td className="px-3 py-2 text-center">{s?.winRate != null ? `${s.winRate}%` : '-'}</td>
                  <td className="px-3 py-2 text-center"><StatValue value={s?.avgNetReturn} suffix="%" color /></td>
                  <td className="px-3 py-2 text-center"><StatValue value={s?.medianReturn} suffix="%" color /></td>
                  <td className="px-3 py-2 text-center">{s?.sharpeRatio?.toFixed(2) ?? '-'}</td>
                  <td className="px-3 py-2 text-center">{s?.profitFactor?.toFixed(2) ?? '-'}</td>
                  <td className="px-3 py-2 text-center"><StatValue value={s?.expectancy} suffix="%" color /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Per-Date Sparkline ──────────────────────────────────────────────────────

function PerDateSection({ stats }: { stats: PerDateStats[] }) {
  if (stats.length === 0) return null;

  // Cumulative returns
  let cumA = 0;
  let cumB = 0;
  const cumulative = stats.map(s => {
    cumA += s.groupATop1Return ?? 0;
    cumB += s.groupBTop1Return ?? 0;
    return { date: s.date, cumA: +cumA.toFixed(2), cumB: +cumB.toFixed(2) };
  });

  const lastA = cumulative[cumulative.length - 1]?.cumA ?? 0;
  const lastB = cumulative[cumulative.length - 1]?.cumB ?? 0;

  return (
    <div>
      <h3 className="text-lg font-semibold mb-3">累積報酬比較（Top 1）</h3>
      <div className="grid grid-cols-2 gap-4 mb-4">
        <div className="bg-secondary/50 border border-border rounded-lg p-3">
          <div className="text-xs text-muted-foreground">Group A（量最大）累積</div>
          <div className={`text-xl font-bold ${lastA > 0 ? 'text-bull' : 'text-bear'}`}>
            {lastA > 0 ? '+' : ''}{lastA}%
          </div>
        </div>
        <div className="bg-secondary/50 border border-border rounded-lg p-3">
          <div className="text-xs text-muted-foreground">Group B（分數最高）累積</div>
          <div className={`text-xl font-bold ${lastB > 0 ? 'text-bull' : 'text-bear'}`}>
            {lastB > 0 ? '+' : ''}{lastB}%
          </div>
        </div>
      </div>

      {/* Simple text-based timeline */}
      <div className="max-h-48 overflow-y-auto text-xs space-y-0.5">
        {cumulative.map(c => (
          <div key={c.date} className="flex gap-4">
            <span className="text-muted-foreground w-24 flex-shrink-0">{c.date}</span>
            <span className={`w-20 text-right ${c.cumA >= 0 ? 'text-bull' : 'text-bear'}`}>
              A: {c.cumA > 0 ? '+' : ''}{c.cumA}%
            </span>
            <span className={`w-20 text-right ${c.cumB >= 0 ? 'text-bull' : 'text-bear'}`}>
              B: {c.cumB > 0 ? '+' : ''}{c.cumB}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Summary Card ────────────────────────────────────────────────────────────

function SummaryCard({ result }: { result: ABTestResult }) {
  const top1 = result.topNResults.find(r => r.topN === 1);
  const aRet = top1?.groupA?.avgNetReturn;
  const bRet = top1?.groupB?.avgNetReturn;
  const edge = aRet != null && bRet != null ? +(bRet - aRet).toFixed(2) : null;

  const verdict = edge != null
    ? edge > 1 ? 'compositeScore 選股明顯優於選最大量'
      : edge > 0 ? 'compositeScore 略勝'
      : edge > -1 ? '兩者差異不大'
      : '選最大量反而更好（compositeScore 可能過度擬合）'
    : '資料不足';

  const isMonotonic = result.quintileRows.length >= 5 &&
    result.quintileRows.every((row, i) => {
      if (i === 0) return true;
      const prev = result.quintileRows[i - 1].stats?.avgNetReturn ?? 0;
      const curr = row.stats?.avgNetReturn ?? 0;
      return curr <= prev;
    });

  return (
    <div className="bg-secondary/50 border border-border rounded-lg p-4 space-y-3">
      <h3 className="text-base font-semibold">結論</h3>
      <div className="text-sm">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-muted-foreground">Top 1 均報酬差：</span>
          <span className={`font-bold ${edge != null && edge > 0 ? 'text-bull' : 'text-bear'}`}>
            {edge != null ? `${edge > 0 ? '+' : ''}${edge}%` : '-'}
          </span>
        </div>
        <div className="text-foreground/80">{verdict}</div>
        {result.quintileRows.length >= 5 && (
          <div className="mt-2 text-xs">
            <span className="text-muted-foreground">五分位單調性：</span>
            <span className={isMonotonic ? 'text-green-400' : 'text-yellow-400'}>
              {isMonotonic ? '通過（Q1 > Q2 > ... > Q5）' : '未通過（排序不完全有效）'}
            </span>
          </div>
        )}
      </div>
      <div className="text-xs text-muted-foreground">
        {result.market === 'TW' ? '台股' : '陸股'} |
        {result.fromDate} ~ {result.toDate} |
        {result.datesAnalyzed} 個取樣日期
      </div>
    </div>
  );
}

// ── Main Page ───────────────────────────────────────────────────────────────

export default function ABTestPage() {
  const [isRunning, setIsRunning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number; phase: string } | null>(null);
  const [result, setResult] = useState<ABTestResult | null>(null);

  // Config state
  const [market, setMarket] = useState<'TW' | 'CN'>('TW');
  const [fromDate, setFromDate] = useState('2024-07-01');
  const [toDate, setToDate] = useState('2026-03-28');
  const [sampleInterval, setSampleInterval] = useState(5);

  const startTest = useCallback(async () => {
    setIsRunning(true);
    setLogs([]);
    setProgress(null);
    setResult(null);

    try {
      const res = await fetch('/api/backtest/ab-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          market,
          fromDate,
          toDate,
          sampleInterval,
          topN: [1, 3, 5],
          quintiles: true,
        }),
      });

      if (!res.body) throw new Error('No response body');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event: ABTestProgressEvent = JSON.parse(line.slice(6));

            switch (event.type) {
              case 'status':
                setLogs(prev => [...prev, event.message]);
                break;
              case 'date_start':
                setProgress({
                  done: event.current,
                  total: event.total,
                  phase: `掃描 ${event.date}`,
                });
                break;
              case 'date_done':
                setLogs(prev => [
                  ...prev,
                  `${event.date}: A=${event.groupASignals} / B=${event.groupBSignals} 檔`,
                ]);
                break;
              case 'complete':
                setResult(event.result);
                break;
              case 'error':
                setLogs(prev => [...prev, `錯誤: ${event.message}`]);
                break;
            }
          } catch {
            // Skip malformed events
          }
        }
      }
    } catch (err) {
      setLogs(prev => [...prev, `請求失敗: ${err instanceof Error ? err.message : String(err)}`]);
    } finally {
      setIsRunning(false);
    }
  }, [market, fromDate, toDate, sampleInterval]);

  return (
    <PageShell>
      <div className="max-w-5xl mx-auto space-y-6 py-4 px-4">
        <h1 className="text-2xl font-bold">A/B 測試：選股方式比較</h1>
        <p className="text-sm text-muted-foreground">
          比較「六條件 + 選最大量」vs「完整系統 + compositeScore」的選股績效，
          兩組都用朱老師獲利方程式出場。
        </p>

        {/* Controls */}
        <div className="bg-secondary/50 border border-border rounded-lg p-4">
          <div className="flex flex-wrap gap-4 items-end">
            <div>
              <label className="block text-xs text-muted-foreground mb-1">市場</label>
              <select
                className="bg-card border border-border rounded px-3 py-1.5 text-sm"
                value={market}
                onChange={e => setMarket(e.target.value as 'TW' | 'CN')}
                disabled={isRunning}
              >
                <option value="TW">台股</option>
                <option value="CN">陸股</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">開始日期</label>
              <input
                type="date"
                className="bg-card border border-border rounded px-3 py-1.5 text-sm"
                value={fromDate}
                onChange={e => setFromDate(e.target.value)}
                disabled={isRunning}
              />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">結束日期</label>
              <input
                type="date"
                className="bg-card border border-border rounded px-3 py-1.5 text-sm"
                value={toDate}
                onChange={e => setToDate(e.target.value)}
                disabled={isRunning}
              />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">取樣頻率</label>
              <select
                className="bg-card border border-border rounded px-3 py-1.5 text-sm"
                value={sampleInterval}
                onChange={e => setSampleInterval(Number(e.target.value))}
                disabled={isRunning}
              >
                <option value={3}>每 3 個交易日</option>
                <option value={5}>每 5 個交易日（週）</option>
                <option value={10}>每 10 個交易日（雙週）</option>
              </select>
            </div>
            <button
              className="px-4 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-sm font-medium disabled:opacity-50"
              onClick={startTest}
              disabled={isRunning}
            >
              {isRunning ? '測試中...' : '開始 A/B 測試'}
            </button>
          </div>
        </div>

        {/* Progress */}
        {(isRunning || logs.length > 0) && (
          <ProgressSection logs={logs} progress={progress} />
        )}

        {/* Results */}
        {result && (
          <div className="space-y-6">
            <SummaryCard result={result} />
            <TopNTable results={result.topNResults} />
            <QuintileTable rows={result.quintileRows} />
            <PerDateSection stats={result.perDateStats} />
          </div>
        )}
      </div>
    </PageShell>
  );
}
