/**
 * Multi-Role AI Analysis Engine.
 * Orchestrates 6 analyst roles + research director in 3 phases:
 *   Phase 1: Technical + Fundamental + News analysts (PARALLEL, ROLE-04)
 *   Phase 2: Bull + Bear researchers (PARALLEL, ROLE-03)
 *   Phase 3: Research Director synthesis (SEQUENTIAL)
 *
 * ROLE-01 through ROLE-10.
 */
import Anthropic from '@anthropic-ai/sdk';
import { recordUsage } from './costTracker';
import {
  TECHNICAL_ANALYST,
  FUNDAMENTAL_ANALYST,
  NEWS_ANALYST,
  BULL_RESEARCHER,
  BEAR_RESEARCHER,
  RESEARCH_DIRECTOR,
} from './roles/prompts';
import type {
  RoleAnalysis,
  DebateAnalysis,
  SynthesisResult,
  FullAnalysisResult,
} from './roles/types';
import type { StockScanResult } from '@/lib/scanner/types';
import type { NewsAnalysisResult } from '@/lib/news/types';
import type { FundamentalsData, InstitutionalData } from '@/lib/datasource/FinMindClient';

const client = new Anthropic();
const MODEL = 'claude-sonnet-4-6';

/** Streaming event callback — fired as each role completes */
export type AnalysisEventCallback = (
  type: 'analyst' | 'debate' | 'synthesis',
  data: RoleAnalysis | DebateAnalysis | SynthesisResult
) => void;

/** Robustly parse JSON from Claude's response, handling common formatting issues */
function parseClaudeJson<T>(raw: string): T {
  // Step 1: Strip markdown code fences
  let text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  // Step 2: Try direct parse
  try { return JSON.parse(text) as T; } catch {}

  // Step 3: Extract JSON object/array from surrounding text
  const jsonMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch) text = jsonMatch[1];

  // Step 4: Try parse again
  try { return JSON.parse(text) as T; } catch {}

  // Step 5: Fix unescaped control characters inside string values
  text = text.replace(/(?<=":[ ]*"[^"]*)\n/g, '\\n');
  try { return JSON.parse(text) as T; } catch {}

  // Step 6: Nuclear option — collapse to single line
  text = text.replace(/\r?\n/g, ' ').replace(/\t/g, ' ');
  try { return JSON.parse(text) as T; } catch {}

  // Step 7: Return empty object as last resort
  console.warn('[analysisEngine] Failed to parse Claude JSON, returning empty');
  return {} as T;
}

/** Call Claude with a role prompt and context, return parsed JSON */
async function callRole<T>(
  systemPrompt: string,
  userContent: string,
  roleName: string,
  maxTokens = 1500
): Promise<T> {
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  });

  if (msg.usage) {
    recordUsage(MODEL, roleName, msg.usage.input_tokens, msg.usage.output_tokens);
  }

  const raw = msg.content[0]?.type === 'text' ? msg.content[0].text : '{}';
  const stopReason = msg.stop_reason;
  if (stopReason === 'max_tokens') {
    console.warn(`[analysisEngine] ${roleName}: response truncated at max_tokens`);
  }
  return parseClaudeJson<T>(raw);
}

/** Format scan result data for technical analyst */
function formatTechnicalContext(scan: StockScanResult): string {
  const lines = [
    `股票：${scan.symbol} ${scan.name}`,
    `現價：${scan.price}  漲跌幅：${scan.changePercent.toFixed(2)}%`,
    `成交量：${scan.volume.toLocaleString()}`,
    `趨勢狀態：${scan.trendState}  趨勢位置：${scan.trendPosition}`,
    `六大條件：${scan.sixConditionsScore}/6`,
  ];

  if (scan.sixConditionsBreakdown) {
    const b = scan.sixConditionsBreakdown;
    lines.push(`六大條件明細：${JSON.stringify(b)}`);
  }
  if (scan.surgeScore !== undefined) {
    lines.push(`飆股潛力分：${scan.surgeScore}/100（${scan.surgeGrade}）`);
  }
  if (scan.smartMoneyScore !== undefined) {
    lines.push(`主力資金分：${scan.smartMoneyScore}/100`);
  }
  if (scan.retailSentiment !== undefined) {
    lines.push(`散戶情緒：${scan.retailSentiment}/100`);
  }
  if (scan.chipScore !== undefined) {
    lines.push(`籌碼面：${scan.chipScore}/100（${scan.chipGrade}）${scan.chipSignal ?? ''}`);
    if (scan.chipDetail) lines.push(`籌碼細節：${scan.chipDetail}`);
  }
  if (scan.triggeredRules.length > 0) {
    lines.push(`觸發規則：${scan.triggeredRules.map(r => `${r.signalType} ${r.ruleName}`).join('、')}`);
  }

  return lines.join('\n');
}

/** Format news data for news analyst */
function formatNewsContext(news: NewsAnalysisResult | null): string {
  if (!news || !news.hasNews) return '近期無相關新聞資料。';

  const lines = [
    `整體情緒分數：${news.aggregateSentiment}`,
    `新聞摘要：${news.summary}`,
    '',
    '個別新聞：',
  ];

  for (const a of news.articles) {
    lines.push(`- [${a.label}/${a.score}] ${a.item.title}（${a.item.source}）`);
    lines.push(`  ${a.rationale}`);
  }

  return lines.join('\n');
}

/** Format real FinMind fundamentals for the fundamental analyst */
function formatFundamentalsContext(
  scan: StockScanResult,
  fundamentals: FundamentalsData | null,
  institutional: InstitutionalData[] | null,
): string {
  const lines = [
    `股票：${scan.symbol} ${scan.name}`,
    `現價：${scan.price}  漲跌幅：${scan.changePercent.toFixed(2)}%`,
    `趨勢：${scan.trendState}`,
  ];

  if (fundamentals) {
    if (fundamentals.eps != null)        lines.push(`EPS（最近期）：${fundamentals.eps}`);
    if (fundamentals.epsYoY != null)     lines.push(`EPS 年增率：${fundamentals.epsYoY.toFixed(1)}%`);
    if (fundamentals.grossMargin != null) lines.push(`毛利率：${fundamentals.grossMargin.toFixed(1)}%`);
    if (fundamentals.netMargin != null)   lines.push(`淨利率：${fundamentals.netMargin.toFixed(1)}%`);
    if (fundamentals.per != null)         lines.push(`本益比(PE)：${fundamentals.per.toFixed(1)}`);
    if (fundamentals.pbr != null)         lines.push(`股價淨值比(PB)：${fundamentals.pbr.toFixed(2)}`);
    if (fundamentals.dividendYield != null) lines.push(`殖利率：${fundamentals.dividendYield.toFixed(2)}%`);
    if (fundamentals.revenueLatest != null) {
      const revStr = (fundamentals.revenueLatest / 1e8).toFixed(1);
      lines.push(`最新月營收：${revStr} 億`);
    }
    if (fundamentals.revenueMoM != null) lines.push(`月營收 MoM：${fundamentals.revenueMoM.toFixed(1)}%`);
    if (fundamentals.revenueYoY != null) lines.push(`月營收 YoY：${fundamentals.revenueYoY.toFixed(1)}%`);
  } else {
    lines.push('（注意：詳細財報數據暫未提供，請根據可用資料分析）');
  }

  if (scan.chipDetail) lines.push(`當日籌碼摘要：${scan.chipDetail}`);

  if (institutional && institutional.length > 0) {
    const recent = institutional.slice(0, 5);
    const foreignNet5d = recent.reduce((s, r) => s + r.foreignNet, 0);
    const trustNet5d   = recent.reduce((s, r) => s + r.trustNet, 0);
    lines.push(`外資近5日淨買超：${foreignNet5d.toLocaleString()} 張`);
    lines.push(`投信近5日淨買超：${trustNet5d.toLocaleString()} 張`);
    lines.push(`外資連買天數：${recent[0].consecutiveForeignBuy} 日`);
  }

  return lines.join('\n');
}

interface RawRole {
  verdict: string;
  confidence: number;
  summary: string;
  keyPoints: string[];
  analysis: string;
}

interface RawDebate extends RawRole {
  referencedRoles: string[];
}

interface RawSynthesis {
  overallVerdict: string;
  confidence: number;
  summary: string;
  recommendation: string;
  riskFactors: string[];
  keyPoints: string[];
  analysis: string;
}

/**
 * Run complete 6-role + synthesis analysis.
 * @param scan       Stock scan result with technical data
 * @param news       News analysis result (null if no news)
 * @param onEvent    Streaming callback — fired as each role completes
 */
export async function runFullAnalysis(
  scan: StockScanResult,
  news: NewsAnalysisResult | null,
  onEvent?: AnalysisEventCallback,
  fundamentals?: FundamentalsData | null,
  institutionalHistory?: InstitutionalData[] | null,
): Promise<FullAnalysisResult> {
  const start = Date.now();
  const techContext = formatTechnicalContext(scan);
  const newsContext = formatNewsContext(news);
  const fundamentalContext = formatFundamentalsContext(scan, fundamentals ?? null, institutionalHistory ?? null);

  // ── Phase 1: Three independent analysts in PARALLEL ───────────────────
  // Use .then() on each individual promise so onEvent fires as each role
  // completes — not after all three finish.
  const analysts: RoleAnalysis[] = [];

  const toAnalyst = (
    role: RoleAnalysis['role'],
    title: string,
    raw: RawRole
  ): RoleAnalysis => ({
    role,
    title,
    verdict: raw.verdict as RoleAnalysis['verdict'],
    confidence: raw.confidence,
    summary: raw.summary,
    keyPoints: raw.keyPoints ?? [],
    rawContent: raw.analysis,
  });

  const [techRaw, fundRaw, newsRaw] = await Promise.all([
    callRole<RawRole>(TECHNICAL_ANALYST, techContext, 'technical-analyst').then(raw => {
      const a = toAnalyst('technical-analyst', '技術面分析師', raw);
      analysts.push(a);
      onEvent?.('analyst', a);
      return raw;
    }),
    callRole<RawRole>(FUNDAMENTAL_ANALYST, fundamentalContext, 'fundamental-analyst').then(raw => {
      const a = toAnalyst('fundamental-analyst', '基本面分析師', raw);
      analysts.push(a);
      onEvent?.('analyst', a);
      return raw;
    }),
    news?.hasNews !== false
      ? callRole<RawRole>(NEWS_ANALYST, newsContext, 'news-analyst').then(raw => {
          const a = toAnalyst('news-analyst', '新聞面分析師', raw);
          analysts.push(a);
          onEvent?.('analyst', a);
          return raw;
        })
      : Promise.resolve(null),
  ]);

  // ── Phase 2: Bull + Bear debate in PARALLEL ───────────────────────────
  const debate: DebateAnalysis[] = [];

  const debateContext = [techRaw, fundRaw, newsRaw]
    .filter(Boolean)
    .map((raw, i) => {
      const a = analysts[i];
      return `## ${a?.title ?? '分析師'}\n判斷：${raw?.verdict}（信心度${raw?.confidence}%）\n${raw?.analysis}`;
    })
    .join('\n\n');

  const toDebater = (
    role: DebateAnalysis['role'],
    title: string,
    verdict: DebateAnalysis['verdict'],
    raw: RawDebate
  ): DebateAnalysis => ({
    role,
    title,
    verdict,
    confidence: raw.confidence,
    summary: raw.summary,
    keyPoints: raw.keyPoints ?? [],
    rawContent: raw.analysis,
    referencedRoles: raw.referencedRoles ?? [],
  });

  const [bullRaw, bearRaw] = await Promise.all([
    callRole<RawDebate>(BULL_RESEARCHER, debateContext, 'bull-researcher', 2048).then(raw => {
      const d = toDebater('bull-researcher', '多頭研究員', 'bullish', raw);
      debate.push(d);
      onEvent?.('debate', d);
      return raw;
    }),
    callRole<RawDebate>(BEAR_RESEARCHER, debateContext, 'bear-researcher', 2048).then(raw => {
      const d = toDebater('bear-researcher', '空頭研究員', 'bearish', raw);
      debate.push(d);
      onEvent?.('debate', d);
      return raw;
    }),
  ]);

  // ── Phase 3: Research Director synthesis (SEQUENTIAL) ─────────────────
  const synthesisContext = [
    '# 分析師報告',
    debateContext,
    '',
    '# 多空辯論',
    `## 多頭研究員（信心度${bullRaw.confidence}%）\n${bullRaw.analysis}`,
    `## 空頭研究員（信心度${bearRaw.confidence}%）\n${bearRaw.analysis}`,
  ].join('\n\n');

  const synthRaw = await callRole<RawSynthesis>(
    RESEARCH_DIRECTOR,
    synthesisContext,
    'research-director',
    4096
  );

  const synthesis: SynthesisResult = {
    role: 'research-director',
    title: '研究總監',
    overallVerdict: synthRaw.overallVerdict as SynthesisResult['overallVerdict'],
    confidence: synthRaw.confidence,
    summary: synthRaw.summary,
    recommendation: synthRaw.recommendation,
    riskFactors: synthRaw.riskFactors ?? [],
    keyPoints: synthRaw.keyPoints ?? [],
    rawContent: synthRaw.analysis,
  };

  onEvent?.('synthesis', synthesis);

  return {
    ticker: scan.symbol,
    companyName: scan.name,
    analysisDate: new Date().toISOString(),
    analysts,
    debate,
    synthesis,
    totalDurationMs: Date.now() - start,
  };
}
