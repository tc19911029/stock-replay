/**
 * 掃描頁「問朱老師」— 對候選清單跨檔比較、挑出最值得做的幾支
 *
 * 架構：純檔案橋接，零 LLM API（同 chart-digest）
 *   1. 網頁 POST 過來，寫 /tmp/rockstock-zhu/scan-question.json
 *   2. Poll /tmp/rockstock-zhu/scan-answer.json（最多 180 秒）
 *   3. 用戶在「朱老師專用 Claude Code Terminal」輸入 /zhu
 *   4. Claude 讀問題、做跨檔比較、Write 答案
 *   5. Poll 偵測到，回傳網頁
 */

import { writeFile, readFile, mkdir, access, unlink } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { triggerZhuKeystroke } from '@/lib/ai/zhuAutoTrigger';

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
  matchedMethods: z.array(z.string()).optional(),
  patternType: z.string().optional(),
  patternAchievementRate: z.number().optional(),
  patternTargetPrice: z.number().optional(),
  triggerPrice: z.number().optional(),
  endPhaseFlag: z.boolean().optional(),
  volumeLevel: z.string().optional(),
  kdDecliningWarning: z.boolean().optional(),
  seasonLineResistance: z.number().nullable().optional(),
});

const reqSchema = z.object({
  market: z.enum(['TW', 'CN']),
  scanDate: z.string(),
  direction: z.enum(['long', 'short', 'daban']),
  marketTrend: z.string().default(''),
  candidates: z.array(candidateSchema).min(1).max(50),
  /** true = 略過 server cache，強制重打朱老師 */
  forceRefresh: z.boolean().optional(),
});

type DigestInput = z.infer<typeof reqSchema>;

type DigestResponse = {
  overview: string;
  topPicks: Array<{ rank: number; symbol: string; reason: string }>;
  watchOut: Array<{ rank: number; symbol: string; reason: string }>;
  sectorHint?: string;
  marketCaveat?: string;
};

const cache = new Map<string, { value: DigestResponse; expires: number }>();
const CACHE_TTL = 24 * 60 * 60 * 1000;

function cacheKey(input: DigestInput): string {
  const sig = input.candidates.map(c => `${c.rank}:${c.symbol}:${c.sixCond}`).join('|');
  return `${input.market}:${input.direction}:${input.scanDate}:${sig}`;
}

// ── 檔案橋接路徑 ─────────────────────────────────────────────────────────
const BRIDGE_DIR = '/tmp/rockstock-zhu';
const QUESTION_FILE = path.join(BRIDGE_DIR, 'scan-question.json');
const ANSWER_FILE = path.join(BRIDGE_DIR, 'scan-answer.json');

const POLL_TIMEOUT_MS = 180_000;
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
        // Date.parse() 正確比較，避免 "Z" vs "+08:00" 字串比較失準
        if (parsed.timestamp) {
          const answerMs = Date.parse(parsed.timestamp);
          if (Number.isFinite(answerMs) && answerMs >= requestMs) {
            return parsed;
          }
        }
      } catch {
        // half-written
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

    // 寫候選清單給「朱老師專用」Claude Code session 跨檔比較
    await mkdir(BRIDGE_DIR, { recursive: true });
    // 刪掉舊 answer 杜絕殘留
    await unlink(ANSWER_FILE).catch(() => {});
    const requestTimestamp = new Date().toISOString();
    const questionPayload = { ...input, requestTimestamp, mode: 'scan' as const };
    await writeFile(QUESTION_FILE, JSON.stringify(questionPayload, null, 2), 'utf-8');

    // 自動切到朱老師 Terminal + 模擬打 /zhu Enter
    const trigger = await triggerZhuKeystroke();
    console.log(`[scan-digest] auto-trigger /zhu: ${trigger.ok ? 'OK' : 'fail — ' + trigger.detail}`);

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
    console.error('coach/scan-digest error:', err);
    const message = err instanceof Error ? err.message : 'digest 失敗';
    return Response.json({ error: message }, { status: 500 });
  }
}
