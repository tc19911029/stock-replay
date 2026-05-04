/**
 * Server-side Active Strategy Storage
 *
 * 把 UI 選擇的 active strategy 同步到 server（Blob on Vercel / FS local），
 * 讓 cron、ScanPipeline 等無法讀 localStorage 的入口也能用同一套策略。
 *
 * 儲存格式：
 *   - strategyId：built-in 策略用這個
 *   - customConfig：custom 策略時才寫，built-in 時為 null
 *
 * 為避免 race condition，寫入時 allowOverwrite=true。
 */

import { promises as fs } from 'fs';
import path from 'path';
import {
  BUILT_IN_STRATEGIES,
  ZHU_PURE_BOOK,
  type StrategyConfig,
} from './StrategyConfig';

const IS_VERCEL = process.env.VERCEL === '1';
const DATA_DIR = path.join(process.cwd(), 'data');
const LOCAL_FILE = path.join(DATA_DIR, 'active-strategy.json');
const BLOB_KEY = 'active-strategy.json';

interface StoredActiveStrategy {
  strategyId: string | null;
  customConfig: StrategyConfig | null;
  updatedAt: string;
}

async function readRaw(): Promise<string | null> {
  if (IS_VERCEL) {
    try {
      const { get } = await import('@vercel/blob');
      const result = await get(BLOB_KEY, { access: 'private' });
      if (!result || !result.stream) return null;
      const reader = result.stream.getReader();
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      return new TextDecoder().decode(Buffer.concat(chunks));
    } catch {
      return null;
    }
  }
  try {
    return await fs.readFile(LOCAL_FILE, 'utf-8');
  } catch {
    return null;
  }
}

async function writeRaw(data: string): Promise<void> {
  if (IS_VERCEL) {
    const { put } = await import('@vercel/blob');
    await put(BLOB_KEY, data, {
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  } else {
    const { atomicFsPut } = await import('@/lib/storage/atomicFsPut');
    await fs.mkdir(DATA_DIR, { recursive: true });
    await atomicFsPut(LOCAL_FILE, data);
  }
}

/**
 * 讀取 server-side 儲存的 active strategy。
 * 找不到 / 讀錯 / built-in id 失效 → 回傳 ZHU_PURE_BOOK。
 */
export async function getActiveStrategyServer(): Promise<StrategyConfig> {
  const raw = await readRaw();
  if (!raw) return ZHU_PURE_BOOK;

  try {
    const stored = JSON.parse(raw) as StoredActiveStrategy;
    if (stored.customConfig) return stored.customConfig;
    if (stored.strategyId) {
      const found = BUILT_IN_STRATEGIES.find(s => s.id === stored.strategyId);
      if (found) return found;
    }
  } catch {
    // fall through
  }
  return ZHU_PURE_BOOK;
}

/**
 * 寫入 server-side active strategy。
 * UI 切策略時由 /api/strategy/set 呼叫。
 */
export async function setActiveStrategyServer(
  strategyId: string | null,
  customConfig: StrategyConfig | null = null,
): Promise<void> {
  const payload: StoredActiveStrategy = {
    strategyId,
    customConfig,
    updatedAt: new Date().toISOString(),
  };
  await writeRaw(JSON.stringify(payload, null, 2));
}
