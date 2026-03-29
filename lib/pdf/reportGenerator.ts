/**
 * PDF Report Generator — client-side PDF creation using pdfmake.
 * PDF-01 through PDF-06.
 *
 * Generates a complete stock analysis report with:
 * 1. Cover page with ticker, company name, date
 * 2. AI Analysis section (6 roles + synthesis)
 * 3. News sentiment section
 * 4. Cost tracking summary
 *
 * Runs entirely in the browser (PDF-02).
 * Uses pdfmake which supports CJK characters (PDF-03).
 * File naming: {股票代號}_{日期}_分析報告.pdf (PDF-04)
 */
import type { FullAnalysisResult } from '@/lib/ai/roles/types';
import type { NewsAnalysisResult } from '@/lib/news/types';
import type { FundamentalsData } from '@/lib/datasource/FinMindClient';

interface ReportData {
  analysis: FullAnalysisResult;
  news: NewsAnalysisResult | null;
  fundamentals?: FundamentalsData | null;
  costSummary?: {
    totalCostUsd: number;
    callCount: number;
    totalInputTokens: number;
    totalOutputTokens: number;
  };
}

const VERDICT_LABELS: Record<string, string> = {
  'strong-buy': '強力買入',
  'buy': '買入',
  'hold': '持有',
  'sell': '賣出',
  'strong-sell': '強力賣出',
  'bullish': '看多',
  'bearish': '看空',
  'neutral': '中性',
};

const SENTIMENT_LABELS: Record<string, string> = {
  'positive': '正面',
  'negative': '負面',
  'neutral': '中性',
};

function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Generate and download a PDF report.
 * Must be called from a browser context (uses dynamic import of pdfmake).
 */
export async function generateReport(data: ReportData): Promise<void> {
  // Dynamic import — pdfmake is client-only (PDF-02, PDF-05)
  const pdfMake = await import('pdfmake/build/pdfmake');
  const pdfFonts = await import('pdfmake/build/vfs_fonts');
  (pdfMake as unknown as { vfs: unknown }).vfs = (pdfFonts as unknown as { pdfMake: { vfs: unknown } }).pdfMake.vfs;

  const { analysis, news, costSummary, fundamentals } = data;
  const date = formatDate(analysis.analysisDate);

  // Build document definition
  const docDefinition = {
    pageSize: 'A4' as const,
    pageMargins: [40, 60, 40, 60] as [number, number, number, number],
    defaultStyle: { font: 'Roboto', fontSize: 10, lineHeight: 1.4 },
    content: [
      // ── Cover ──
      { text: `${analysis.companyName}（${analysis.ticker}）`, style: 'title' },
      { text: `AI 深度分析報告`, style: 'subtitle' },
      { text: `報告日期：${date}`, style: 'date' },
      { text: `研究總監評級：${VERDICT_LABELS[analysis.synthesis.overallVerdict] ?? analysis.synthesis.overallVerdict}（信心度 ${analysis.synthesis.confidence}%）`, style: 'verdict' },
      { text: '\n' },

      // ── Research Director Summary ──
      { text: '研究總監結論', style: 'sectionHeader' },
      { text: analysis.synthesis.summary },
      { text: '\n建議：', bold: true },
      { text: analysis.synthesis.recommendation },
      ...(analysis.synthesis.riskFactors.length > 0
        ? [
            { text: '\n風險因子：', bold: true },
            { ul: analysis.synthesis.riskFactors },
          ]
        : []),
      { text: '\n' },

      // ── Fundamentals ──
      ...(fundamentals
        ? [
            { text: '基本面數據（FinMind）', style: 'sectionHeader' as const },
            {
              table: {
                widths: ['*', 'auto', '*', 'auto', '*', 'auto', '*', 'auto'],
                body: [
                  ['EPS', fundamentals.eps?.toFixed(2) ?? '—',
                   'EPS YoY', fundamentals.epsYoY != null ? `${fundamentals.epsYoY.toFixed(1)}%` : '—',
                   '毛利率', fundamentals.grossMargin != null ? `${fundamentals.grossMargin.toFixed(1)}%` : '—',
                   '淨利率', fundamentals.netMargin != null ? `${fundamentals.netMargin.toFixed(1)}%` : '—'],
                  ['本益比', fundamentals.per?.toFixed(1) ?? '—',
                   '淨值比', fundamentals.pbr?.toFixed(2) ?? '—',
                   '殖利率', fundamentals.dividendYield != null ? `${fundamentals.dividendYield.toFixed(2)}%` : '—',
                   '月營收 YoY', fundamentals.revenueYoY != null ? `${fundamentals.revenueYoY.toFixed(1)}%` : '—'],
                ],
              },
              margin: [0, 0, 0, 10] as [number, number, number, number],
            },
          ]
        : []),

      // ── Analysts ──
      { text: '分析師報告', style: 'sectionHeader' },
      ...analysis.analysts.flatMap((a) => [
        { text: `${a.title}：${VERDICT_LABELS[a.verdict] ?? a.verdict}（${a.confidence}%）`, style: 'roleHeader' },
        { text: a.summary },
        ...(a.keyPoints.length > 0 ? [{ ul: a.keyPoints }] : []),
        { text: '\n' },
      ]),

      // ── Bull/Bear Debate ──
      { text: '多空辯論', style: 'sectionHeader' },
      ...analysis.debate.flatMap((d) => [
        { text: `${d.title}：${VERDICT_LABELS[d.verdict] ?? d.verdict}（${d.confidence}%）`, style: 'roleHeader' },
        { text: d.summary },
        ...(d.keyPoints.length > 0 ? [{ ul: d.keyPoints }] : []),
        { text: '\n' },
      ]),

      // ── News Sentiment ──
      ...(news?.hasNews
        ? [
            { text: '新聞情緒分析', style: 'sectionHeader' as const },
            { text: `整體情緒：${news.aggregateSentiment > 0 ? '偏多' : news.aggregateSentiment < 0 ? '偏空' : '中性'}（${news.aggregateSentiment}）` },
            { text: news.summary },
            { text: '\n' },
            {
              table: {
                widths: ['auto', '*', 'auto', 'auto'],
                body: [
                  ['情緒', '標題', '來源', '日期'],
                  ...news.articles.map((a) => [
                    SENTIMENT_LABELS[a.label] ?? a.label,
                    a.item.title.slice(0, 50),
                    a.item.source,
                    formatDate(a.item.publishedAt),
                  ]),
                ],
              },
            },
          ]
        : [{ text: '新聞情緒：新聞資料不足\n', italics: true }]),

      // ── Cost Summary ──
      ...(costSummary
        ? [
            { text: '\n' },
            { text: 'API 成本', style: 'sectionHeader' as const },
            { text: `總成本：$${costSummary.totalCostUsd.toFixed(4)} USD | ${costSummary.callCount} 次呼叫 | ${costSummary.totalInputTokens.toLocaleString()} input / ${costSummary.totalOutputTokens.toLocaleString()} output tokens` },
          ]
        : []),

      // ── Footer ──
      { text: '\n\n' },
      { text: '本報告由 AI 自動生成，僅供投資研究與學習使用，不構成任何投資建議。', style: 'disclaimer' },
    ],
    styles: {
      title: { fontSize: 22, bold: true, margin: [0, 40, 0, 8] as [number, number, number, number] },
      subtitle: { fontSize: 16, color: '#666', margin: [0, 0, 0, 4] as [number, number, number, number] },
      date: { fontSize: 11, color: '#999', margin: [0, 0, 0, 8] as [number, number, number, number] },
      verdict: { fontSize: 14, bold: true, color: '#1a56db', margin: [0, 0, 0, 20] as [number, number, number, number] },
      sectionHeader: { fontSize: 14, bold: true, margin: [0, 12, 0, 6] as [number, number, number, number], color: '#1e293b' },
      roleHeader: { fontSize: 11, bold: true, margin: [0, 4, 0, 2] as [number, number, number, number] },
      disclaimer: { fontSize: 8, color: '#999', italics: true },
    },
  };

  // Generate and download (PDF-04: naming format)
  const fileName = `${analysis.ticker}_${date}_分析報告.pdf`;
  pdfMake.createPdf(docDefinition).download(fileName);
}
