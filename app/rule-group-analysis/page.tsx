'use client';

import { useState, useCallback } from 'react';
import { PageShell } from '@/components/shared';
import {
  RuleGroupAnalysisResult,
  MarketAnalysisResult,
  AnalysisProgressEvent,
  RuleGroupStats,
  CrossMarketComparison,
} from '@/lib/backtest/ruleGroupAnalyzerTypes';

// ── Grade 顏色 ───────────────────────────────────────────────────────────────

const GRADE_COLORS: Record<string, string> = {
  S: 'text-yellow-400 bg-yellow-400/10',
  A: 'text-green-400 bg-green-400/10',
  B: 'text-blue-400 bg-blue-400/10',
  C: 'text-slate-400 bg-slate-400/10',
  D: 'text-orange-400 bg-orange-400/10',
  F: 'text-red-400 bg-red-400/10',
};

// ── 進度條 ───────────────────────────────────────────────────────────────────

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
          <div className="flex justify-between text-xs text-slate-400 mb-1">
            <span>{progress.phase}</span>
            <span>{progress.done}/{progress.total} ({pct}%)</span>
          </div>
          <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 rounded-full transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}
      <div className="max-h-32 overflow-y-auto text-xs text-slate-500 space-y-0.5">
        {logs.map((log, i) => (
          <div key={i}>{log}</div>
        ))}
      </div>
    </div>
  );
}

// ── 群組排名表格 ─────────────────────────────────────────────────────────────

function GroupStatsTable({ stats, title }: { stats: RuleGroupStats[]; title: string }) {
  const [sortKey, setSortKey] = useState<keyof RuleGroupStats>('compositeScore');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const sorted = [...stats].sort((a, b) => {
    const av = a[sortKey] as number;
    const bv = b[sortKey] as number;
    return sortDir === 'desc' ? bv - av : av - bv;
  });

  const toggleSort = (key: keyof RuleGroupStats) => {
    if (sortKey === key) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortKey(key); setSortDir('desc'); }
  };

  const header = (label: string, key: keyof RuleGroupStats) => (
    <th
      className="px-2 py-2 text-left text-xs cursor-pointer hover:text-blue-400 whitespace-nowrap"
      onClick={() => toggleSort(key)}
    >
      {label} {sortKey === key ? (sortDir === 'desc' ? '↓' : '↑') : ''}
    </th>
  );

  return (
    <div>
      <h3 className="text-lg font-semibold mb-3">{title}</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-slate-400 border-b border-slate-700">
            <tr>
              <th className="px-2 py-2 text-left text-xs">#</th>
              <th className="px-2 py-2 text-left text-xs">群組</th>
              <th className="px-2 py-2 text-left text-xs">作者</th>
              {header('分數', 'compositeScore')}
              <th className="px-2 py-2 text-left text-xs">等級</th>
              {header('訊號數', 'signalCount')}
              {header('5D勝率', 'winRate5d')}
              {header('10D勝率', 'winRate10d')}
              {header('10D均報酬', 'avgReturn10d')}
              {header('Sharpe', 'sharpeRatio')}
              {header('獲利因子', 'profitFactor')}
            </tr>
          </thead>
          <tbody>
            {sorted.map((g, i) => (
              <tr key={g.groupId} className="border-b border-slate-800 hover:bg-slate-800/50">
                <td className="px-2 py-2 text-slate-500">{i + 1}</td>
                <td className="px-2 py-2 font-medium">{g.groupName}</td>
                <td className="px-2 py-2 text-slate-400">{g.author}</td>
                <td className="px-2 py-2">{g.compositeScore}</td>
                <td className="px-2 py-2">
                  <span className={`px-1.5 py-0.5 rounded text-xs font-bold ${GRADE_COLORS[g.grade] ?? ''}`}>
                    {g.grade}
                  </span>
                </td>
                <td className="px-2 py-2">{g.signalCount}</td>
                <td className="px-2 py-2">{g.winRate5d}%</td>
                <td className="px-2 py-2">{g.winRate10d}%</td>
                <td className={`px-2 py-2 ${Number(g.avgReturn10d) > 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {Number(g.avgReturn10d) > 0 ? '+' : ''}{g.avgReturn10d}%
                </td>
                <td className="px-2 py-2">{g.sharpeRatio}</td>
                <td className="px-2 py-2">{g.profitFactor}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── 推薦卡片 ─────────────────────────────────────────────────────────────────

function RecommendationCard({ result }: { result: MarketAnalysisResult }) {
  const recommended = result.groupStats.filter(g =>
    result.recommendedGroups.includes(g.groupId),
  );
  const label = result.market === 'TW' ? '台股' : '陸股';

  return (
    <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-4">
      <h3 className="text-base font-semibold mb-2">
        {label}推薦組合
        <span className="ml-2 text-xs text-slate-400">
          ({result.stockCount} 支股票 / {result.dateRange.from} ~ {result.dateRange.to})
        </span>
      </h3>
      <div className="flex flex-wrap gap-2 mb-3">
        {recommended.map(g => (
          <span key={g.groupId} className={`px-2 py-1 rounded text-xs font-medium ${GRADE_COLORS[g.grade] ?? ''}`}>
            {g.groupName} ({g.grade})
          </span>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-3 text-sm">
        <div>
          <div className="text-slate-400 text-xs">平均 10D 勝率</div>
          <div className="font-semibold">
            {recommended.length > 0
              ? (recommended.reduce((s, g) => s + g.winRate10d, 0) / recommended.length).toFixed(1)
              : '0'}%
          </div>
        </div>
        <div>
          <div className="text-slate-400 text-xs">平均 10D 報酬</div>
          <div className="font-semibold">
            {recommended.length > 0
              ? (recommended.reduce((s, g) => s + Number(g.avgReturn10d), 0) / recommended.length).toFixed(2)
              : '0'}%
          </div>
        </div>
        <div>
          <div className="text-slate-400 text-xs">總訊號數</div>
          <div className="font-semibold">
            {recommended.reduce((s, g) => s + g.signalCount, 0)}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 交叉比較 ─────────────────────────────────────────────────────────────────

function ComparisonSection({ comparison }: { comparison: CrossMarketComparison }) {
  const Section = ({ title, ids, color }: { title: string; ids: string[]; color: string }) => (
    ids.length > 0 ? (
      <div>
        <div className={`text-xs font-medium mb-1 ${color}`}>{title}</div>
        <div className="flex flex-wrap gap-1">
          {ids.map(id => (
            <span key={id} className="px-2 py-0.5 rounded bg-slate-800 text-xs">{id}</span>
          ))}
        </div>
      </div>
    ) : null
  );

  return (
    <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-4 space-y-3">
      <h3 className="text-base font-semibold">交叉比較</h3>
      <Section title="兩邊都好" ids={comparison.strongBoth} color="text-green-400" />
      <Section title="台股專用" ids={comparison.twOnly} color="text-blue-400" />
      <Section title="陸股專用" ids={comparison.cnOnly} color="text-yellow-400" />
      <Section title="兩邊都差" ids={comparison.weakBoth} color="text-red-400" />
    </div>
  );
}

// ── 主頁面 ───────────────────────────────────────────────────────────────────

export default function RuleGroupAnalysisPage() {
  const [isRunning, setIsRunning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number; phase: string } | null>(null);
  const [result, setResult] = useState<RuleGroupAnalysisResult | null>(null);
  const [activeTab, setActiveTab] = useState<'TW' | 'CN'>('TW');

  const startAnalysis = useCallback(async () => {
    setIsRunning(true);
    setLogs([]);
    setProgress(null);
    setResult(null);

    try {
      const res = await fetch('/api/backtest/rule-group-analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markets: ['TW', 'CN'] }),
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
            const event: AnalysisProgressEvent = JSON.parse(line.slice(6));

            switch (event.type) {
              case 'status':
                setLogs(prev => [...prev, `[${event.market}] ${event.message}`]);
                break;
              case 'fetching':
                setProgress({ done: event.done, total: event.total, phase: `${event.market} 抓取資料` });
                break;
              case 'analyzing':
                setProgress({ done: event.done, total: event.total, phase: `${event.market} 規則分析` });
                break;
              case 'market_complete':
                setLogs(prev => [...prev, `[${event.market}] 分析完成！`]);
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
  }, []);

  const activeResult = result ? (activeTab === 'TW' ? result.tw : result.cn) : null;

  return (
    <PageShell>
      <div className="max-w-7xl mx-auto p-4 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold">規則群組回測分析</h1>
            <p className="text-sm text-slate-400 mt-1">
              對 18 個規則群組分別回測台股/陸股前 100 大，找出最有效的組合
            </p>
          </div>
          <button
            onClick={startAnalysis}
            disabled={isRunning}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              isRunning
                ? 'bg-slate-700 text-slate-400 cursor-not-allowed'
                : 'bg-blue-600 hover:bg-blue-500 text-white'
            }`}
          >
            {isRunning ? '分析中...' : '開始分析'}
          </button>
        </div>

        {/* Progress */}
        {(isRunning || logs.length > 0) && !result && (
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
            <ProgressSection logs={logs} progress={progress} />
          </div>
        )}

        {/* Results */}
        {result && (
          <>
            {/* Recommendation cards */}
            <div className="grid md:grid-cols-2 gap-4">
              <RecommendationCard result={result.tw} />
              <RecommendationCard result={result.cn} />
            </div>

            {/* Cross-market comparison */}
            <ComparisonSection comparison={result.comparison} />

            {/* Tab switch */}
            <div className="flex gap-2 border-b border-slate-800 pb-1">
              {(['TW', 'CN'] as const).map(m => (
                <button
                  key={m}
                  onClick={() => setActiveTab(m)}
                  className={`px-4 py-1.5 text-sm rounded-t-lg transition-colors ${
                    activeTab === m
                      ? 'bg-slate-800 text-white border-b-2 border-blue-500'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {m === 'TW' ? '台股' : '陸股'} 詳細排名
                </button>
              ))}
            </div>

            {/* Detailed table */}
            {activeResult && (
              <GroupStatsTable
                stats={activeResult.groupStats}
                title={`${activeTab === 'TW' ? '台股' : '陸股'}規則群組排名`}
              />
            )}
          </>
        )}
      </div>
    </PageShell>
  );
}
