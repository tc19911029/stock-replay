import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import {
  getActiveStrategyServer,
  setActiveStrategyServer,
} from '@/lib/strategy/activeStrategyServer';
import {
  BUILT_IN_STRATEGIES,
  type StrategyConfig,
} from '@/lib/strategy/StrategyConfig';

export const runtime = 'nodejs';

const postSchema = z.object({
  strategyId: z.string().nullable(),
  customConfig: z.record(z.string(), z.unknown()).nullable().optional(),
});

/**
 * GET  /api/strategy/active — 回傳目前 server 端的 active strategy
 * POST /api/strategy/active — 設定 active strategy（UI 切換時呼叫）
 *
 * 這是讓 cron / ScanPipeline 能跟 UI 同步的關鍵 — server 端無法讀 localStorage，
 * 所以當 UI 切換策略時，必須打這支 API 把 ID 同步到 Blob/FS。
 */

export async function GET() {
  try {
    const strategy = await getActiveStrategyServer();
    return apiOk({
      strategyId: strategy.id,
      name: strategy.name,
      thresholds: strategy.thresholds,
    });
  } catch (err) {
    console.error('[strategy/active GET] error:', err);
    return apiError(String(err));
  }
}

export async function POST(req: NextRequest) {
  // 2026-05-08：加同源/cron token 守門，防匿名 curl 改 active strategy 跑壞 cron
  const { checkSameOriginOrCron } = await import('@/lib/api/sameOriginAuth');
  const denied = checkSameOriginOrCron(req);
  if (denied) return denied;

  const body = await req.json().catch(() => ({}));
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) return apiValidationError(parsed.error);

  const { strategyId, customConfig } = parsed.data;

  // Built-in 策略：驗證 ID 存在
  if (strategyId && !customConfig) {
    const found = BUILT_IN_STRATEGIES.find(s => s.id === strategyId);
    if (!found) return apiError(`未知策略 ID: ${strategyId}`, 400);
  }
  // Custom 策略：基本欄位驗證
  if (customConfig) {
    const c = customConfig as Partial<StrategyConfig>;
    if (!c.id || !c.thresholds) return apiError('customConfig 缺少 id 或 thresholds', 400);
  }

  try {
    await setActiveStrategyServer(
      strategyId,
      (customConfig as StrategyConfig | undefined) ?? null,
    );
    return apiOk({ saved: true, strategyId, isCustom: Boolean(customConfig) });
  } catch (err) {
    console.error('[strategy/active POST] error:', err);
    return apiError(String(err));
  }
}
