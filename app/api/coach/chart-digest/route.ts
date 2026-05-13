/**
 * 走圖頁單支股票朱老師分析 — 「問朱老師」面板背後。
 *
 * 架構：純檔案橋接，零 LLM API
 *   1. 網頁 POST 過來，寫 /tmp/zhu-question.json
 *   2. Poll /tmp/zhu-answer.json（最多 180 秒）
 *   3. 用戶在「朱老師專用 Claude Code Terminal」輸入 `/zhu`
 *   4. Claude 讀問題、用六本書記憶 + docs/ 分析、Write 答案到 /tmp/zhu-answer.json
 *   5. Poll 偵測到，讀檔回傳網頁
 *
 * 為什麼這樣設計：
 *   用戶要的是用「正在跟我講話的 Claude Code session」回答，不打任何 API、
 *   不用 MiniMax。檔案橋接讓 Claude Code session 變成「朱老師後端」，零成本。
 */

import { writeFile, readFile, mkdir, access, unlink } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { triggerZhuKeystroke } from '@/lib/ai/zhuAutoTrigger';
import { prefetchZhuChart } from '@/lib/ai/zhuPrefetch';

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
  // 過去 120 天 K 線歷史（含今天）+ 所有指標
  recentCandles: z.array(z.object({
    date: z.string(),
    o: z.number(), h: z.number(), l: z.number(), c: z.number(),
    v: z.number(),
    ma5: z.number().nullable().optional(),
    ma10: z.number().nullable().optional(),
    ma20: z.number().nullable().optional(),
    ma60: z.number().nullable().optional(),
    ma240: z.number().nullable().optional(),
    avgVol5: z.number().nullable().optional(),
    kdK: z.number().nullable().optional(),
    kdD: z.number().nullable().optional(),
    macdDIF: z.number().nullable().optional(),
    macdOSC: z.number().nullable().optional(),
  })).max(250).optional(),
  // 走圖截圖（base64 PNG，不含 data URL prefix），朱老師讀圖看 K 線型態
  chartScreenshot: z.string().max(5_000_000).nullable().optional(),
  /** true = 略過 server cache，強制重打朱老師 */
  forceRefresh: z.boolean().optional(),
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

// ── 檔案橋接路徑 ─────────────────────────────────────────────────────────
// 用 /tmp 而不是 os.tmpdir() — macOS 上 os.tmpdir() 回 /var/folders/...
// 用戶在 Terminal 和 slash command 都用 /tmp/rockstock-zhu/，要一致
const BRIDGE_DIR = '/tmp/rockstock-zhu';
const QUESTION_FILE = path.join(BRIDGE_DIR, 'chart-question.json');
const ANSWER_FILE = path.join(BRIDGE_DIR, 'chart-answer.json');
const SCREENSHOT_FILE = path.join(BRIDGE_DIR, 'chart-screenshot.png');

const POLL_TIMEOUT_MS = 180_000;  // 等用戶在 Claude Code 輸入 /zhu 並回答完
const POLL_INTERVAL_MS = 1_500;

async function fileExists(p: string): Promise<boolean> {
  try { await access(p, fsConstants.F_OK); return true; } catch { return false; }
}

async function pollAnswer(requestTimestamp: string, timeoutMs: number): Promise<DigestResponse | null> {
  const requestMs = Date.parse(requestTimestamp);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fileExists(ANSWER_FILE)) {
      try {
        const raw = await readFile(ANSWER_FILE, 'utf-8');
        const parsed = JSON.parse(raw) as DigestResponse & { timestamp?: string };
        // 用 Date.parse() 正確比較（避免 "Z" vs "+08:00" 字串比較失準）
        if (parsed.timestamp) {
          const answerMs = Date.parse(parsed.timestamp);
          if (Number.isFinite(answerMs) && answerMs >= requestMs) {
            return parsed;
          }
        }
      } catch {
        // 檔案半寫狀態，再等一輪
      }
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  return null;
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
    if (!input.forceRefresh) {
      const hit = cache.get(key);
      if (hit && hit.expires > Date.now()) {
        return Response.json({ ...hit.value, cached: true });
      }
    }

    // Server-side prefetch — 把朱老師會用到的籌碼/ETF/同業先撈起來
    // 平行打 5 條請求 + ETF 檔案 grep，總時間 ~5s 內
    const prefetch = await prefetchZhuChart({
      market: input.market,
      symbol: input.symbol,
      date: input.date,
    });

    // 寫問題給「朱老師專用」Claude Code session 讀
    await mkdir(BRIDGE_DIR, { recursive: true });
    // 刪掉舊 answer 杜絕殘留（不同股票之間互相污染）
    await unlink(ANSWER_FILE).catch(() => {});
    const requestTimestamp = new Date().toISOString();

    // 走圖截圖另存為 PNG 檔（base64 太大不適合放 JSON 給朱老師讀；獨立 PNG 讓 Read 工具吃）
    let screenshotPath: string | null = null;
    if (input.chartScreenshot) {
      try {
        await writeFile(SCREENSHOT_FILE, Buffer.from(input.chartScreenshot, 'base64'));
        screenshotPath = SCREENSHOT_FILE;
      } catch (err) {
        console.warn('[chart-digest] screenshot decode/write failed:', err);
      }
    }

    // 從 question payload 拿掉 base64，改放 path（朱老師用 Read 工具讀 PNG）
    const { chartScreenshot: _omitted, ...inputWithoutScreenshot } = input;
    void _omitted;
    const questionPayload = {
      ...inputWithoutScreenshot,
      requestTimestamp,
      prefetch,
      screenshotPath,
    };
    await writeFile(QUESTION_FILE, JSON.stringify(questionPayload, null, 2), 'utf-8');

    // 自動切到朱老師 Terminal + 模擬打 /zhu Enter（macOS only，失敗則用戶手動）
    const trigger = await triggerZhuKeystroke();
    console.log(`[chart-digest] auto-trigger /zhu: ${trigger.ok ? 'OK' : 'fail — ' + trigger.detail}`);

    const answer = await pollAnswer(requestTimestamp, POLL_TIMEOUT_MS);

    if (!answer) {
      return Response.json({
        error: '等待朱老師回答超時。請確認你開了一個朱老師專用 Claude Code Terminal 並輸入 /zhu',
        pending: true,
      }, { status: 504 });
    }

    cache.set(key, { value: answer, expires: Date.now() + CACHE_TTL });
    if (cache.size > 200) {
      const firstKey = cache.keys().next().value;
      if (firstKey) cache.delete(firstKey);
    }

    return Response.json(answer);
  } catch (err) {
    console.error('coach/chart-digest error:', err);
    const message = err instanceof Error ? err.message : 'digest 失敗';
    return Response.json({ error: message }, { status: 500 });
  }
}
