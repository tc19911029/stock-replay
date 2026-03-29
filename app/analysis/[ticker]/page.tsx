'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import type { RoleAnalysis, DebateAnalysis, SynthesisResult, FullAnalysisResult } from '@/lib/ai/roles/types';
import type { NewsAnalysisResult } from '@/lib/news/types';
import { PageShell } from '@/components/shared';
import { FundamentalsPanel } from '@/features/analysis';
import type { FundamentalsData } from '@/lib/datasource/FinMindClient';

// ── Types ──────────────────────────────────────────────────────────────────────

interface CostSummary {
  totalCostUsd: number;
  callCount: number;
}

interface StreamState {
  status: 'idle' | 'loading' | 'done' | 'error';
  analysts: RoleAnalysis[];
  debate: DebateAnalysis[];
  synthesis: SynthesisResult | null;
  fullResult: FullAnalysisResult | null;
  news: NewsAnalysisResult | null;
  cost: CostSummary | null;
  errorMsg: string | null;
}

// ── Labels ─────────────────────────────────────────────────────────────────────

const VERDICT_LABELS: Record<string, { text: string; cls: string }> = {
  'strong-buy': { text: '強力買入', cls: 'text-red-400 bg-red-900/40 border-red-700' },
  'buy':        { text: '買入',     cls: 'text-orange-400 bg-orange-900/40 border-orange-700' },
  'hold':       { text: '持有',     cls: 'text-yellow-400 bg-yellow-900/40 border-yellow-700' },
  'sell':       { text: '賣出',     cls: 'text-green-400 bg-green-900/40 border-green-700' },
  'strong-sell':{ text: '強力賣出', cls: 'text-emerald-400 bg-emerald-900/40 border-emerald-700' },
  'bullish':    { text: '看多',     cls: 'text-red-400 bg-red-900/40 border-red-700' },
  'bearish':    { text: '看空',     cls: 'text-green-400 bg-green-900/40 border-green-700' },
  'neutral':    { text: '中性',     cls: 'text-slate-400 bg-slate-800/60 border-slate-600' },
};

const ROLE_STEPS = [
  { key: 'technical-analyst',   label: '技術面', phase: 'analyst' },
  { key: 'fundamental-analyst', label: '基本面', phase: 'analyst' },
  { key: 'news-analyst',        label: '新聞面', phase: 'analyst' },
  { key: 'bull-researcher',     label: '多頭',   phase: 'debate' },
  { key: 'bear-researcher',     label: '空頭',   phase: 'debate' },
  { key: 'research-director',   label: '總監',   phase: 'synthesis' },
];

// ── Sub-components ─────────────────────────────────────────────────────────────

function VerdictBadge({ verdict, confidence }: { verdict: string; confidence: number }) {
  const v = VERDICT_LABELS[verdict] ?? { text: verdict, cls: 'text-slate-400 bg-slate-800 border-slate-600' };
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-bold ${v.cls}`}>
      {v.text}
      <span className="opacity-70 font-normal">{confidence}%</span>
    </span>
  );
}

function ConfidenceBar({ value }: { value: number }) {
  const color = value >= 75 ? 'bg-sky-500' : value >= 55 ? 'bg-amber-500' : 'bg-slate-500';
  return (
    <div className="flex items-center gap-2 mt-1">
      <div className="flex-1 h-1.5 bg-slate-700 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-700 ${color}`} style={{ width: `${value}%` }} />
      </div>
      <span className="text-[10px] text-slate-400 w-8 text-right">{value}%</span>
    </div>
  );
}

function AnalystCard({ analyst }: { analyst: RoleAnalysis | DebateAnalysis }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl p-4 animate-in fade-in duration-300">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-semibold text-white">{analyst.title}</span>
        <VerdictBadge verdict={analyst.verdict} confidence={analyst.confidence} />
      </div>
      <ConfidenceBar value={analyst.confidence} />
      <p className="mt-3 text-[13px] text-slate-300 leading-relaxed">{analyst.summary}</p>
      {analyst.keyPoints.length > 0 && (
        <>
          <button
            onClick={() => setExpanded(e => !e)}
            className="mt-2 text-[11px] text-sky-400 hover:text-sky-300"
          >
            {expanded ? '收起重點 ▲' : `展開 ${analyst.keyPoints.length} 個重點 ▼`}
          </button>
          {expanded && (
            <ul className="mt-2 space-y-1">
              {analyst.keyPoints.map((p, i) => (
                <li key={i} className="flex gap-2 text-[12px] text-slate-400">
                  <span className="text-sky-500 mt-0.5">•</span>
                  <span>{p}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function ProgressStepper({ state }: { state: StreamState }) {
  const completedKeys = new Set<string>([
    ...state.analysts.map(a => a.role),
    ...state.debate.map(d => d.role),
    ...(state.synthesis ? ['research-director'] : []),
  ]);

  const totalDone = completedKeys.size;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        {ROLE_STEPS.map((step, i) => {
          const done = completedKeys.has(step.key);
          // Active = loading and not yet done, and previous step is done (or it's first)
          const prevDone = i === 0 || completedKeys.has(ROLE_STEPS[i - 1].key);
          const active = state.status === 'loading' && !done && prevDone;

          return (
            <div key={step.key} className="flex items-center gap-1">
              {i > 0 && <div className={`w-4 h-px ${done ? 'bg-sky-600' : 'bg-slate-700'}`} />}
              <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] border transition-all duration-300 ${
                done    ? 'bg-sky-900/60 border-sky-700 text-sky-300' :
                active  ? 'bg-amber-900/50 border-amber-600 text-amber-300 animate-pulse' :
                          'bg-slate-800/50 border-slate-700 text-slate-500'
              }`}>
                {done   ? <span className="text-sky-400">✓</span> : null}
                {active ? <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping inline-block" /> : null}
                {step.label}
              </div>
            </div>
          );
        })}
      </div>
      {state.status === 'loading' && (
        <div className="text-[11px] text-slate-500">
          {totalDone}/6 角色完成…
        </div>
      )}
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function AnalysisPage() {
  const params = useParams();
  const router = useRouter();
  const ticker = typeof params.ticker === 'string' ? params.ticker.toUpperCase() : '';
  const abortRef = useRef<AbortController | null>(null);

  const [state, setState] = useState<StreamState>({
    status: 'idle',
    analysts: [],
    debate: [],
    synthesis: null,
    fullResult: null,
    news: null,
    cost: null,
    errorMsg: null,
  });
  const [fundamentals, setFundamentals] = useState<FundamentalsData | null>(null);

  // Pre-fetch fundamentals so PDF can include them
  useEffect(() => {
    if (!ticker) return;
    fetch(`/api/fundamentals/${ticker}`)
      .then(r => r.json())
      .then(json => { if (json.ok) setFundamentals(json.data as FundamentalsData); })
      .catch(() => {});
  }, [ticker]);

  const runAnalysis = useCallback(async () => {
    // Cancel any in-flight request
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;

    setState({
      status: 'loading',
      analysts: [],
      debate: [],
      synthesis: null,
      fullResult: null,
      news: null,
      cost: null,
      errorMsg: null,
    });

    try {
      const response = await fetch(`/api/ai/analyze/${ticker}`, {
        signal: abort.signal,
        cache: 'no-store',
        headers: { Accept: 'text/event-stream' },
      });

      if (!response.ok || !response.body) {
        const err = await response.json().catch(() => ({ error: 'Unknown error' })) as { error?: string };
        throw new Error(err.error ?? `HTTP ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() ?? '';

        for (const block of blocks) {
          let type = '';
          let dataStr = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) type = line.slice(7).trim();
            if (line.startsWith('data: '))  dataStr = line.slice(6).trim();
          }
          if (!type || !dataStr) continue;

          try {
            const data = JSON.parse(dataStr) as unknown;

            if (type === 'news') {
              setState(s => ({ ...s, news: data as NewsAnalysisResult }));
            } else if (type === 'analyst') {
              setState(s => ({ ...s, analysts: [...s.analysts, data as RoleAnalysis] }));
            } else if (type === 'debate') {
              setState(s => ({ ...s, debate: [...s.debate, data as DebateAnalysis] }));
            } else if (type === 'synthesis') {
              setState(s => ({ ...s, synthesis: data as SynthesisResult }));
            } else if (type === 'complete') {
              const full = data as FullAnalysisResult;
              setState(s => ({
                ...s,
                status: 'done',
                fullResult: full,
                // Ensure synthesis is set from the complete result
                synthesis: s.synthesis ?? full.synthesis,
              }));
              // Fetch cost after analysis completes
              fetch('/api/ai/cost', { cache: 'no-store' })
                .then(r => r.json())
                .then(c => setState(s => ({ ...s, cost: c as CostSummary })))
                .catch(() => null);
            } else if (type === 'error') {
              throw new Error((data as { message?: string }).message ?? 'Unknown error');
            }
          } catch (parseErr) {
            if (type === 'error') throw parseErr;
            // Ignore JSON parse errors for non-error events
          }
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setState(s => ({
        ...s,
        status: 'error',
        errorMsg: err instanceof Error ? err.message : 'Unknown error',
      }));
    }
  }, [ticker]);

  useEffect(() => {
    if (ticker) runAnalysis();
    return () => abortRef.current?.abort();
  }, [ticker, runAnalysis]);

  // PDF download
  const handleDownloadPdf = async () => {
    if (!state.fullResult) return;
    const { generateReport } = await import('@/lib/pdf/reportGenerator');
    await generateReport({
      analysis: state.fullResult,
      news: state.news,
      fundamentals,
      costSummary: state.cost
        ? { totalCostUsd: state.cost.totalCostUsd, callCount: state.cost.callCount, totalInputTokens: 0, totalOutputTokens: 0 }
        : undefined,
    });
  };

  const synthesis = state.synthesis;
  const synthVerdict = synthesis ? (VERDICT_LABELS[synthesis.overallVerdict] ?? { text: synthesis.overallVerdict, cls: 'text-slate-400 bg-slate-800 border-slate-600' }) : null;

  return (
    <PageShell>
    <div className="text-slate-100">
      {/* Sub-header for analysis context */}
      <div className="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-14 z-40">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3">
          <button
            onClick={() => router.back()}
            className="text-slate-400 hover:text-white text-sm px-2 py-1 rounded hover:bg-slate-800 transition-colors"
          >
            ← 返回
          </button>
          <div className="h-4 w-px bg-slate-700" />
          <span className="text-white font-bold">{ticker}</span>
          <span className="text-slate-400 text-sm">AI 深度分析</span>

          {state.status === 'done' && state.cost && (
            <span className="ml-auto text-[11px] text-slate-500">
              成本 ${state.cost.totalCostUsd.toFixed(4)} USD · {state.cost.callCount} 次呼叫
            </span>
          )}
          {state.status === 'loading' && (
            <span className="ml-auto flex items-center gap-1.5 text-[11px] text-amber-400">
              <span className="w-3 h-3 border-2 border-amber-400 border-t-transparent rounded-full animate-spin inline-block" />
              分析中
            </span>
          )}
          {state.status === 'done' && (
            <button
              onClick={handleDownloadPdf}
              className="ml-2 text-[11px] text-sky-400 hover:text-sky-300 px-2.5 py-1 rounded border border-sky-700/50 hover:bg-sky-900/30 transition-colors"
            >
              下載 PDF
            </button>
          )}
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 py-6 space-y-5">

        {/* Progress stepper — always shown while loading or done */}
        {(state.status === 'loading' || state.status === 'done') && (
          <div className="bg-slate-900/60 border border-slate-700/60 rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-medium text-slate-300">
                {state.status === 'loading' ? '多角色分析進行中…' : '分析完成 ✓'}
              </span>
              {state.status === 'done' && state.fullResult && (
                <span className="text-[11px] text-slate-500">
                  耗時 {(state.fullResult.totalDurationMs / 1000).toFixed(0)}s
                </span>
              )}
            </div>
            <ProgressStepper state={state} />
          </div>
        )}

        {/* Error */}
        {state.status === 'error' && (
          <div className="bg-red-900/30 border border-red-700/60 rounded-xl p-4">
            <p className="text-red-300 text-sm font-medium">分析失敗</p>
            <p className="text-red-400/80 text-[12px] mt-1">{state.errorMsg}</p>
            <button
              onClick={runAnalysis}
              className="mt-3 text-[12px] text-red-300 hover:text-red-200 px-3 py-1.5 rounded border border-red-700/50 hover:bg-red-900/40 transition-colors"
            >
              重試
            </button>
          </div>
        )}

        {/* Fundamentals panel — fetches real FinMind data */}
        <FundamentalsPanel ticker={ticker} />

        {/* Research Director synthesis — shown as soon as synthesis event arrives */}
        {synthesis && synthVerdict && (
          <div className={`border rounded-xl p-5 animate-in fade-in duration-300 ${
            synthVerdict.cls.includes('red')    ? 'bg-red-950/20 border-red-800/40' :
            synthVerdict.cls.includes('orange') ? 'bg-orange-950/20 border-orange-800/40' :
            synthVerdict.cls.includes('green')  ? 'bg-green-950/20 border-green-800/40' :
                                                  'bg-slate-800/40 border-slate-700/40'
          }`}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[11px] text-slate-500 mb-1">研究總監最終評級</p>
                <div className="flex items-center gap-3">
                  <span className={`text-2xl font-bold ${synthVerdict.cls.split(' ')[0]}`}>
                    {synthVerdict.text}
                  </span>
                  <span className="text-slate-400 text-sm">信心度 {synthesis.confidence}%</span>
                </div>
              </div>
              <div className="text-right">
                <p className="text-[11px] text-slate-500">{ticker}</p>
                <p className="text-[11px] text-slate-500">{state.fullResult?.companyName}</p>
              </div>
            </div>
            <ConfidenceBar value={synthesis.confidence} />
            <p className="mt-4 text-[13px] text-slate-200 leading-relaxed">{synthesis.summary}</p>
            {synthesis.recommendation && (
              <div className="mt-3 p-3 bg-slate-900/60 rounded-lg">
                <p className="text-[11px] text-slate-400 mb-1">投資建議</p>
                <p className="text-[12px] text-slate-300 leading-relaxed">{synthesis.recommendation}</p>
              </div>
            )}
            {synthesis.riskFactors.length > 0 && (
              <div className="mt-3">
                <p className="text-[11px] text-slate-400 mb-1.5">風險因子</p>
                <div className="flex flex-wrap gap-1.5">
                  {synthesis.riskFactors.map((r, i) => (
                    <span key={i} className="text-[11px] bg-red-900/30 text-red-400 border border-red-800/50 px-2 py-0.5 rounded-full">
                      {r}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Analysts — cards appear one by one as SSE events arrive */}
        {state.analysts.length > 0 && (
          <div>
            <h2 className="text-sm font-semibold text-slate-400 mb-3">分析師報告</h2>
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              {state.analysts.map(a => <AnalystCard key={a.role} analyst={a} />)}
            </div>
          </div>
        )}

        {/* Debate — appears after both debaters complete */}
        {state.debate.length > 0 && (
          <div>
            <h2 className="text-sm font-semibold text-slate-400 mb-3">多空辯論</h2>
            <div className="grid gap-3 md:grid-cols-2">
              {state.debate.map(d => <AnalystCard key={d.role} analyst={d} />)}
            </div>
          </div>
        )}

        {/* News */}
        {state.news?.hasNews && (
          <div>
            <h2 className="text-sm font-semibold text-slate-400 mb-3">新聞情緒</h2>
            <div className="bg-slate-900/60 border border-slate-700/60 rounded-xl overflow-hidden">
              <div className="px-4 py-2.5 border-b border-slate-700/50 flex items-center gap-3">
                <span className="text-[12px] text-slate-300">整體情緒：</span>
                <span className={`text-[12px] font-bold ${
                  state.news.aggregateSentiment > 0.1  ? 'text-red-400' :
                  state.news.aggregateSentiment < -0.1 ? 'text-green-400' :
                                                          'text-slate-400'
                }`}>
                  {state.news.aggregateSentiment > 0.1 ? '偏多' : state.news.aggregateSentiment < -0.1 ? '偏空' : '中性'}
                  <span className="font-normal text-slate-500 ml-1">({state.news.aggregateSentiment.toFixed(2)})</span>
                </span>
                <span className="text-[11px] text-slate-500 ml-auto">{state.news.summary}</span>
              </div>
              <div className="divide-y divide-slate-800/60">
                {state.news.articles.map((a, i) => (
                  <div key={i} className="px-4 py-2.5 flex items-start gap-3">
                    <span className={`mt-0.5 text-[10px] px-1.5 py-0.5 rounded font-medium ${
                      a.label === 'positive' ? 'bg-red-900/50 text-red-300' :
                      a.label === 'negative' ? 'bg-green-900/50 text-green-300' :
                                               'bg-slate-700/50 text-slate-400'
                    }`}>
                      {a.label === 'positive' ? '正面' : a.label === 'negative' ? '負面' : '中性'}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-[12px] text-slate-300 truncate">{a.item.title}</p>
                      <p className="text-[10px] text-slate-500 mt-0.5">{a.item.source} · {a.item.publishedAt.slice(0, 10)}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Idle state */}
        {state.status === 'idle' && (
          <div className="text-center py-20 text-slate-500">
            <p className="text-sm">準備分析 {ticker}…</p>
          </div>
        )}

        {/* Footer */}
        <p className="text-[10px] text-slate-600 text-center pb-4">
          本報告由 AI 自動生成，僅供投資研究與學習使用，不構成任何投資建議。
        </p>
      </div>
    </div>
    </PageShell>
  );
}
