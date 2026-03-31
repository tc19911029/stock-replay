/**
 * Sentiment analysis via Claude claude-haiku-4-5 (cost-efficient).
 * NEWS-03: score each article -1 to +1, produce aggregate summary.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { NewsItem, ArticleSentiment, NewsAnalysisResult } from './types';
import { recordUsage } from '@/lib/ai/costTracker';

const client = new Anthropic();

const SENTIMENT_SYSTEM = `You are a financial news sentiment analyst specializing in Taiwan equities.
For each news article, return ONLY valid JSON in this exact shape:
{"score": <number from -1.0 to 1.0>, "label": "positive"|"negative"|"neutral", "rationale": "<one sentence in Traditional Chinese>"}
- score > 0.2 = positive; < -0.2 = negative; else neutral
- rationale must be in Traditional Chinese, ≤30 characters`;

/** Analyze a single article. Returns null on API error (article is skipped). */
async function scoreArticle(item: NewsItem): Promise<ArticleSentiment | null> {
  const prompt = `標題：${item.title}\n摘要：${item.snippet}`;
  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 128,
      system: SENTIMENT_SYSTEM,
      messages: [{ role: 'user', content: prompt }],
    });

    let text = msg.content[0]?.type === 'text' ? msg.content[0].text.trim() : '';
    // Strip markdown code fences if present (```json ... ```)
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(text) as { score: number; label: 'positive' | 'negative' | 'neutral'; rationale: string };

    // COST-01: Record token usage
    if (msg.usage) {
      recordUsage('claude-haiku-4-5-20251001', 'news-sentiment', msg.usage.input_tokens, msg.usage.output_tokens);
    }

    return {
      item,
      score: Math.max(-1, Math.min(1, parsed.score)),
      label: parsed.label,
      rationale: parsed.rationale,
    };
  } catch {
    return null;
  }
}

/** Produce an aggregate 1-2 sentence summary from scored articles */
async function summarize(articles: ArticleSentiment[], ticker: string): Promise<string> {
  if (articles.length === 0) return '近期無足夠新聞資料進行分析。';

  const bulletPoints = articles
    .map((a) => `• [${a.label}] ${a.item.title}（${a.rationale}）`)
    .join('\n');

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      system: '你是台股新聞情緒彙整分析師，請用繁體中文寫1-2句話彙整這些新聞對該股票的整體情緒影響。直接給結論，不要開頭語。',
      messages: [{ role: 'user', content: `股票代號：${ticker}\n\n新聞列表：\n${bulletPoints}` }],
    });
    if (msg.usage) {
      recordUsage('claude-haiku-4-5-20251001', 'news-summary', msg.usage.input_tokens, msg.usage.output_tokens);
    }
    return msg.content[0]?.type === 'text' ? msg.content[0].text.trim() : '分析完成。';
  } catch {
    return '新聞情緒分析完成。';
  }
}

/**
 * Run full sentiment analysis pipeline on aggregated news items.
 * Scores each article in parallel, then generates aggregate summary.
 */
export async function analyzeNewsSentiment(
  ticker: string,
  items: NewsItem[]
): Promise<NewsAnalysisResult> {
  if (items.length === 0) {
    return {
      ticker,
      fetchedAt: new Date().toISOString(),
      articles: [],
      aggregateSentiment: 0,
      summary: '新聞資料不足',
      hasNews: false,
    };
  }

  // Score all articles in parallel (NEWS-03)
  const results = await Promise.all(items.map(scoreArticle));
  const articles = results.filter((r): r is ArticleSentiment => r !== null);

  // Weighted average sentiment
  const aggregateSentiment =
    articles.length > 0
      ? articles.reduce((sum, a) => sum + a.score, 0) / articles.length
      : 0;

  const summary = await summarize(articles, ticker);

  return {
    ticker,
    fetchedAt: new Date().toISOString(),
    articles,
    aggregateSentiment: Math.round(aggregateSentiment * 100) / 100,
    summary,
    hasNews: articles.length > 0,
  };
}
