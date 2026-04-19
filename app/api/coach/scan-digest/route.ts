import Anthropic from '@anthropic-ai/sdk';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { recordUsage } from '@/lib/ai/costTracker';

export const runtime = 'nodejs';

const candidateSchema = z.object({
  rank: z.number(),
  symbol: z.string().max(20),
  name: z.string().max(50).default(''),
  industry: z.string().max(30).optional(),
  price: z.number(),
  changePercent: z.number(),
  sixCond: z.number().min(0).max(6),
  sixCondBreakdown: z.object({
    trend: z.boolean(),
    position: z.boolean(),
    kbar: z.boolean(),
    ma: z.boolean(),
    volume: z.boolean(),
    indicator: z.boolean(),
  }),
  trendState: z.string().default(''),
  trendPosition: z.string().default(''),
  mtfScore: z.number().optional(),
  highWinRateTypes: z.array(z.string()).optional(),
  winnerBullish: z.array(z.string()).optional(),
  winnerBearish: z.array(z.string()).optional(),
  elimination: z.array(z.string()).optional(),
  prohibitions: z.array(z.string()).optional(),
  turnoverRank: z.number().optional(),
  histWinRate: z.number().optional(),
});

const reqSchema = z.object({
  market: z.enum(['TW', 'CN']),
  scanDate: z.string(),
  direction: z.enum(['long', 'short', 'daban']),
  marketTrend: z.string().default(''),
  candidates: z.array(candidateSchema).min(1).max(50),
});

type DigestInput = z.infer<typeof reqSchema>;

type DigestResponse = {
  overview: string;
  topPicks: Array<{ rank: number; symbol: string; reason: string }>;
  watchOut: Array<{ rank: number; symbol: string; reason: string }>;
  sectorHint?: string;
  marketCaveat?: string;
};

/** 記憶體 cache：同一天同一批候選 24h 內直接重用 */
const cache = new Map<string, { value: DigestResponse; expires: number }>();
const CACHE_TTL = 24 * 60 * 60 * 1000;

function cacheKey(input: DigestInput): string {
  // 用 rank+symbol 列表當簽章（同一批結果）
  const sig = input.candidates.map(c => `${c.rank}:${c.symbol}:${c.sixCond}`).join('|');
  return `${input.market}:${input.direction}:${input.scanDate}:${sig}`;
}

const SYSTEM_PROMPT = `你是一位精通朱家泓老師與林穎《學會走圖SOP》的股市教練。你熟讀六本書：朱家泓《做對5個實戰步驟》《抓住線圖 股民變股神》《抓住K線 獲利無限》《活用技術分析寶典》《抓住飆股輕鬆賺》與林穎《學會走圖SOP》。

使用者會給你今天一整批掃描選出的候選股（含六條件、MTF、位置、贏家圖像、戒律、淘汰法、產業、漲幅、成交額排名）。
你的工作 **不是** 逐檔翻譯分數——那些卡片上都看得到。你的工作是：

1. **給市場大盤視角**：結合 marketTrend，告訴使用者今天整體氛圍是可以進場、謹慎觀望、還是該休息
2. **挑前 2~3 檔最值得關注**：不是按 rank 照念，要從「六條件完整度 × MTF 多頭保護 × 位置（起漲/主升優於末升）× 成交額健康 × 贏家圖像」綜合判斷，挑出**真正穩的**，並指出它為什麼勝過其他檔
3. **點出 1~2 檔有風險但上榜的**：例如高檔位、量能不足、MTF 空頭、觸發警示圖像
4. **若產業集中**提醒產業輪動風險／題材偏好
5. **引用朱老師書中概念**：「回後買上漲」「起漲段」「量增價漲」「頭頭高底底高」「回檔不破前低」等，讓解釋有書本厚度

絕對不要：逐檔重述六條件分數、MTF 分數——那些數字使用者自己看得到。要提供**比較、判斷、取捨**。

## 輸出格式（必須是合法 JSON，不用 markdown code fence）：
{
  "overview": "2~3 句話描述大盤背景與這批候選的整體質地，帶書本語氣",
  "topPicks": [
    { "rank": 1, "symbol": "2345.TW", "reason": "一句話說為什麼這檔勝出（引書本口訣）" }
  ],
  "watchOut": [
    { "rank": 5, "symbol": "1234.TW", "reason": "一句話說風險在哪" }
  ],
  "sectorHint": "產業觀察（可選，沒特別就省略欄位或給空字串）",
  "marketCaveat": "大盤層面的警示（空頭/盤整時必填；多頭可省略或給空字串）"
}

topPicks 2~3 項、watchOut 1~2 項。每個 reason ≤ 60 字。整體繁體中文。`;

function buildUserPrompt(input: DigestInput): string {
  const lines: string[] = [];
  const directionLabel =
    input.direction === 'long' ? '做多' :
    input.direction === 'short' ? '做空' : '打板';
  lines.push(`市場：${input.market === 'TW' ? '台股' : '陸股 A 股'}  方向：${directionLabel}`);
  lines.push(`掃描日期：${input.scanDate}  大盤趨勢：${input.marketTrend || '未知'}`);
  lines.push(`候選數：${input.candidates.length}`);
  lines.push('');
  lines.push('## 候選清單（按掃描排名）：');

  for (const c of input.candidates) {
    const b = c.sixCondBreakdown;
    const bits: string[] = [];
    bits.push(`#${c.rank} ${c.symbol} ${c.name}`);
    if (c.industry) bits.push(`[${c.industry}]`);
    bits.push(`價 ${c.price.toFixed(2)} (${c.changePercent >= 0 ? '+' : ''}${c.changePercent.toFixed(1)}%)`);
    bits.push(`六條件 ${c.sixCond}/6 [趨${b.trend ? '✓' : '✗'}位${b.position ? '✓' : '✗'}K${b.kbar ? '✓' : '✗'}均${b.ma ? '✓' : '✗'}量${b.volume ? '✓' : '✗'}指${b.indicator ? '✓' : '✗'}]`);
    bits.push(`${c.trendState}・${c.trendPosition}`);
    if (c.mtfScore !== undefined) bits.push(`MTF ${c.mtfScore}/4`);
    if (c.turnoverRank !== undefined) bits.push(`成交額#${c.turnoverRank}`);
    if (c.highWinRateTypes?.length) bits.push(`高勝率位置:${c.highWinRateTypes.join(',')}`);
    if (c.winnerBullish?.length) bits.push(`空轉多圖像:${c.winnerBullish.join(',')}`);
    if (c.winnerBearish?.length) bits.push(`⚠多轉空圖像:${c.winnerBearish.join(',')}`);
    if (c.elimination?.length) bits.push(`⚠淘汰:${c.elimination.join(',')}`);
    if (c.prohibitions?.length) bits.push(`⚠戒律:${c.prohibitions.join(',')}`);
    if (c.histWinRate !== undefined) bits.push(`歷史勝率${c.histWinRate.toFixed(0)}%`);
    lines.push(bits.join('　'));
  }

  lines.push('');
  lines.push('請用朱老師視角做跨檔比較，挑出最穩的幾檔、點出要小心的幾檔。只輸出 JSON。');
  return lines.join('\n');
}

function autoCloseJSON(s: string): string {
  let result = s.trimEnd();
  let inString = false;
  let escape = false;
  let braceDepth = 0;
  let bracketDepth = 0;
  for (const ch of result) {
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') braceDepth++;
    else if (ch === '}') braceDepth--;
    else if (ch === '[') bracketDepth++;
    else if (ch === ']') bracketDepth--;
  }
  if (inString) result += '"';
  while (bracketDepth-- > 0) result += ']';
  while (braceDepth-- > 0) result += '}';
  return result;
}

function parseDigest(text: string): DigestResponse {
  let clean = text.trim();
  clean = clean.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '');
  const start = clean.indexOf('{');
  if (start < 0) throw new Error('LLM 回覆不含 JSON');
  const end = clean.lastIndexOf('}');
  const json = end > start ? clean.slice(start, end + 1) : autoCloseJSON(clean.slice(start));

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    parsed = JSON.parse(autoCloseJSON(clean.slice(start))) as Record<string, unknown>;
  }

  const toPickArr = (x: unknown): Array<{ rank: number; symbol: string; reason: string }> => {
    if (!Array.isArray(x)) return [];
    return x
      .map(item => {
        if (!item || typeof item !== 'object') return null;
        const o = item as Record<string, unknown>;
        const rank = typeof o.rank === 'number' ? o.rank : 0;
        const symbol = typeof o.symbol === 'string' ? o.symbol : '';
        const reason = typeof o.reason === 'string' ? o.reason.slice(0, 120) : '';
        if (!symbol || !reason) return null;
        return { rank, symbol, reason };
      })
      .filter((x): x is { rank: number; symbol: string; reason: string } => x !== null)
      .slice(0, 5);
  };

  const overview = typeof parsed.overview === 'string' ? parsed.overview.slice(0, 300) : '';
  const sectorHint = typeof parsed.sectorHint === 'string' && parsed.sectorHint.trim() ? parsed.sectorHint.slice(0, 150) : undefined;
  const marketCaveat = typeof parsed.marketCaveat === 'string' && parsed.marketCaveat.trim() ? parsed.marketCaveat.slice(0, 150) : undefined;

  return {
    overview,
    topPicks: toPickArr(parsed.topPicks),
    watchOut: toPickArr(parsed.watchOut),
    sectorHint,
    marketCaveat,
  };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = reqSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        { error: parsed.error.issues[0]?.message ?? '輸入格式錯誤' },
        { status: 400 },
      );
    }
    const input = parsed.data;

    const key = cacheKey(input);
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) {
      return Response.json({ ...hit.value, cached: true });
    }

    const minimaxKey = process.env.MINIMAX_API_KEY;
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const apiKey = minimaxKey || anthropicKey;
    if (!apiKey) {
      return Response.json(
        { error: '伺服器未設定 MINIMAX_API_KEY 或 ANTHROPIC_API_KEY' },
        { status: 500 },
      );
    }
    const useMinimax = !!minimaxKey;
    const minimaxBaseURL = process.env.MINIMAX_BASE_URL ?? 'https://api.minimax.chat/anthropic';
    const client = new Anthropic({
      apiKey,
      ...(useMinimax ? { baseURL: minimaxBaseURL } : {}),
    });
    const model = useMinimax ? 'MiniMax-M2.7' : 'claude-sonnet-4-6';

    const msg = await client.messages.create({
      model,
      max_tokens: 1200,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(input) }],
    });

    if (msg.usage) {
      recordUsage(
        model,
        'coach-scan-digest',
        msg.usage.input_tokens,
        msg.usage.output_tokens,
        (msg.usage as unknown as Record<string, number>).cache_read_input_tokens ?? 0,
      );
    }

    const contentBlocks = Array.isArray(msg.content) ? msg.content : [];
    const raw = contentBlocks
      .map(block => (block && block.type === 'text' ? block.text : ''))
      .join('');
    if (!raw.trim()) throw new Error('LLM 回覆為空');

    const digest = parseDigest(raw);

    cache.set(key, { value: digest, expires: Date.now() + CACHE_TTL });
    if (cache.size > 200) {
      const firstKey = cache.keys().next().value;
      if (firstKey) cache.delete(firstKey);
    }

    return Response.json(digest);
  } catch (err) {
    console.error('coach/scan-digest error:', err);
    const message = err instanceof Error ? err.message : 'digest 失敗';
    return Response.json({ error: message }, { status: 500 });
  }
}
