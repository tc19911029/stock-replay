/**
 * 走圖頁單支股票朱老師分析 — 對應走圖頁「朱老師分析」按鈕。
 *
 * 設計對齊 /api/coach/scan-digest：
 *   - 結構化 JSON 輸出（overview / verdict / reasoning / caveat）
 *   - 記憶體 cache 24h，key 帶日期+訊號 signature 避免跨 session 污染
 *   - 支援 MiniMax / Anthropic 雙 provider
 */

import Anthropic from '@anthropic-ai/sdk';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { recordUsage } from '@/lib/ai/costTracker';

export const runtime = 'nodejs';

const signalSchema = z.object({
  label: z.string(),
  description: z.string().default(''),
  subtype: z.string().default(''),
});

const reqSchema = z.object({
  market: z.enum(['TW', 'CN']),
  symbol: z.string().max(20),
  name: z.string().max(50).default(''),
  date: z.string(),
  ohlcv: z.object({
    open: z.number(),
    high: z.number(),
    low: z.number(),
    close: z.number(),
    volume: z.number(),
    changePercent: z.number().optional(),
  }),
  ma: z.object({
    ma5: z.number().nullable().optional(),
    ma10: z.number().nullable().optional(),
    ma20: z.number().nullable().optional(),
    ma60: z.number().nullable().optional(),
  }),
  indicator: z.object({
    kdK: z.number().nullable().optional(),
    kdD: z.number().nullable().optional(),
    macdDIF: z.number().nullable().optional(),
    macdSignal: z.number().nullable().optional(),
    macdOSC: z.number().nullable().optional(),
  }).optional(),
  trend: z.string().default(''),
  trendPosition: z.string().default(''),
  sixCond: z.number().min(0).max(6).optional(),
  sixCondBreakdown: z.object({
    trend: z.boolean(),
    position: z.boolean(),
    kbar: z.boolean(),
    ma: z.boolean(),
    volume: z.boolean(),
    indicator: z.boolean(),
  }).optional(),
  signals: z.array(signalSchema).max(30).default([]),
  prohibitions: z.array(z.string()).max(10).default([]),
  winnerBullishPatterns: z.array(z.string()).max(20).default([]),
  winnerBearishPatterns: z.array(z.string()).max(20).default([]),
  hasPosition: z.boolean().default(false),
  positionCost: z.number().nullable().optional(),
});

type DigestInput = z.infer<typeof reqSchema>;

type DigestResponse = {
  overview: string;
  verdict: string;         // 進場 / 出場 / 持股 / 觀望
  verdictReason: string;
  reasoning: string[];     // 3-5 點書本角度分析
  caveat?: string;
};

const cache = new Map<string, { value: DigestResponse; expires: number }>();
const CACHE_TTL = 24 * 60 * 60 * 1000;

function cacheKey(input: DigestInput): string {
  const sigSig = input.signals.map(s => `${s.subtype}:${s.label}`).join('|');
  return `${input.market}:${input.symbol}:${input.date}:${input.hasPosition ? 'P' : 'F'}:${sigSig}`;
}

const SYSTEM_PROMPT = `你是一位精通朱家泓老師與林穎《學會走圖SOP》的股市教練。你熟讀六本書：朱家泓《做對5個實戰步驟》《抓住線圖 股民變股神》《抓住K線 獲利無限》《活用技術分析寶典》《抓住飆股輕鬆賺》與林穎《學會走圖SOP》。

使用者會給你單一支股票**在某一天**的技術狀態（OHLCV、均線、趨勢、六條件、所有觸發訊號、戒律狀態、是否持股）。

你的工作：站在**朱老師視角**，給出**具體操作建議**，不是重述系統分數。

必須做到：
1. **結論優先**：一句話給出 verdict（進場 / 出場 / 減碼 / 持股 / 觀望）
2. **verdictReason**：引書本口訣解釋為什麼——例如「回後買上漲（p.238）」「破 MA5 出場」「頭頭高底底高維持多頭」
3. **reasoning**：3~5 點書本角度的分析（技術面、籌碼面、風險面）
4. **caveat**：若有風險點（高位、乖離過大、量能不足、MTF 空頭）一定要點出
5. **持倉考量**：若 hasPosition=true，重點在「該不該出場」；false 則重點在「該不該進場」
6. **誠實打臉系統**：若系統訊號打架、或高位追多違反戒律，要明講不要圓場

絕對不要：
- 逐項翻譯 MA5/MA10/MA20 數字（使用者自己看得到）
- 空泛的「謹慎操作、風險控制」廢話
- 背離書本原則去迎合使用者偏好

## 輸出格式（必須是合法 JSON，不用 markdown code fence）：
{
  "overview": "2~3 句話描述這檔目前的整體狀態",
  "verdict": "進場 | 出場 | 減碼 | 續抱 | 觀望",
  "verdictReason": "一句話用書本口訣解釋為什麼",
  "reasoning": [
    "第一點：技術面觀察（引書本）",
    "第二點：位置/趨勢評估",
    "第三點：量能/籌碼/風險",
    "（可選）第四點"
  ],
  "caveat": "若有風險點點出；沒有可省略或空字串"
}

reasoning 每點 ≤ 50 字。整體繁體中文。`;

function buildUserPrompt(input: DigestInput): string {
  const lines: string[] = [];
  lines.push(`市場：${input.market === 'TW' ? '台股' : '陸股 A 股'}  股票：${input.symbol} ${input.name}`);
  lines.push(`日期：${input.date}`);
  lines.push(`是否持股：${input.hasPosition ? `是${input.positionCost ? `（成本 ${input.positionCost}）` : ''}` : '空手'}`);
  lines.push('');

  const o = input.ohlcv;
  const chg = o.changePercent !== undefined ? ` (${o.changePercent >= 0 ? '+' : ''}${o.changePercent.toFixed(2)}%)` : '';
  lines.push(`## 當日 K 棒`);
  lines.push(`O=${o.open} H=${o.high} L=${o.low} C=${o.close}${chg}  量=${o.volume}`);

  const m = input.ma;
  const maBits: string[] = [];
  if (m.ma5 != null)  maBits.push(`MA5=${m.ma5.toFixed(2)}`);
  if (m.ma10 != null) maBits.push(`MA10=${m.ma10.toFixed(2)}`);
  if (m.ma20 != null) maBits.push(`MA20=${m.ma20.toFixed(2)}`);
  if (m.ma60 != null) maBits.push(`MA60=${m.ma60.toFixed(2)}`);
  if (maBits.length) lines.push(`均線：${maBits.join(' / ')}`);

  if (input.indicator) {
    const i = input.indicator;
    const indBits: string[] = [];
    if (i.kdK != null && i.kdD != null) indBits.push(`KD K=${i.kdK.toFixed(1)} D=${i.kdD.toFixed(1)}`);
    if (i.macdOSC != null) indBits.push(`MACD OSC=${i.macdOSC.toFixed(3)}`);
    if (indBits.length) lines.push(`指標：${indBits.join('  ')}`);
  }

  lines.push('');
  lines.push(`## 趨勢與位置`);
  lines.push(`趨勢：${input.trend || '未知'}  位置：${input.trendPosition || '未知'}`);

  if (input.sixCond !== undefined && input.sixCondBreakdown) {
    const b = input.sixCondBreakdown;
    lines.push(`六條件 ${input.sixCond}/6 [趨${b.trend ? '✓' : '✗'}位${b.position ? '✓' : '✗'}K${b.kbar ? '✓' : '✗'}均${b.ma ? '✓' : '✗'}量${b.volume ? '✓' : '✗'}指${b.indicator ? '✓' : '✗'}]`);
  }

  if (input.signals.length > 0) {
    lines.push('');
    lines.push(`## 今日觸發訊號（${input.signals.length} 條）`);
    for (const s of input.signals) {
      const tag = s.subtype ? `[${s.subtype}]` : '';
      lines.push(`- ${tag} ${s.label}${s.description ? `：${s.description}` : ''}`);
    }
  } else {
    lines.push('');
    lines.push(`## 今日無觸發訊號`);
  }

  if (input.prohibitions.length > 0) {
    lines.push('');
    lines.push(`## 戒律違反`);
    for (const p of input.prohibitions) lines.push(`⚠️ ${p}`);
  }

  if (input.winnerBullishPatterns.length > 0 || input.winnerBearishPatterns.length > 0) {
    lines.push('');
    lines.push(`## 贏家圖像（朱家泓寶典 Part 12 P771-825）`);
    if (input.winnerBullishPatterns.length > 0) {
      lines.push(`🎯 空轉多：${input.winnerBullishPatterns.join('、')}`);
    }
    if (input.winnerBearishPatterns.length > 0) {
      lines.push(`⛔ 多轉空：${input.winnerBearishPatterns.join('、')}`);
    }
  }

  lines.push('');
  lines.push('請用朱老師視角分析這檔股票現在的狀況，給具體操作建議。只輸出 JSON。');
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

  const overview      = typeof parsed.overview === 'string' ? parsed.overview.slice(0, 300) : '';
  const verdict       = typeof parsed.verdict === 'string' ? parsed.verdict.slice(0, 20) : '觀望';
  const verdictReason = typeof parsed.verdictReason === 'string' ? parsed.verdictReason.slice(0, 200) : '';
  const caveat        = typeof parsed.caveat === 'string' && parsed.caveat.trim() ? parsed.caveat.slice(0, 200) : undefined;
  const reasoning     = Array.isArray(parsed.reasoning)
    ? parsed.reasoning
        .map(r => typeof r === 'string' ? r.slice(0, 150) : '')
        .filter(r => r.length > 0)
        .slice(0, 6)
    : [];

  return { overview, verdict, verdictReason, reasoning, caveat };
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
        'coach-chart-digest',
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
    console.error('coach/chart-digest error:', err);
    const message = err instanceof Error ? err.message : 'digest 失敗';
    return Response.json({ error: message }, { status: 500 });
  }
}
