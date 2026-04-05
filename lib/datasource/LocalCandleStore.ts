/**
 * LocalCandleStore — 本地 K 線檔案存取
 *
 * 每檔股票存一個 JSON 檔：data/candles/{market}/{symbol}.json
 * 只存原始 OHLCV，讀取時即時計算技術指標（指標參數可能會改）
 *
 * 架構：
 *   cron 收盤後下載 → saveLocalCandles()
 *   掃描時讀取     → loadLocalCandles() → computeIndicators()
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import type { Candle, CandleWithIndicators } from '@/types';
import { computeIndicators } from '@/lib/indicators';

/** 本地數據根目錄 */
const DATA_ROOT = path.join(process.cwd(), 'data', 'candles');

interface LocalCandleFile {
  symbol: string;
  lastDate: string;
  updatedAt: string;
  candles: Candle[];
}

function getFilePath(symbol: string, market: 'TW' | 'CN'): string {
  return path.join(DATA_ROOT, market, `${symbol}.json`);
}

/**
 * 讀取本地 K 線檔案並計算指標
 * @returns CandleWithIndicators[] 或 null（檔案不存在/讀取失敗）
 */
export async function loadLocalCandles(
  symbol: string,
  market: 'TW' | 'CN',
): Promise<CandleWithIndicators[] | null> {
  const filePath = getFilePath(symbol, market);
  try {
    const raw = await readFile(filePath, 'utf-8');
    const data: LocalCandleFile = JSON.parse(raw);
    if (!data.candles || data.candles.length === 0) return null;
    return computeIndicators(data.candles);
  } catch {
    return null; // 檔案不存在或格式錯誤
  }
}

/**
 * 讀取本地 K 線，只回傳數據涵蓋到 asOfDate 的結果
 * 如果本地數據的 lastDate < asOfDate，表示數據不夠新，回傳 null
 */
export async function loadLocalCandlesForDate(
  symbol: string,
  market: 'TW' | 'CN',
  asOfDate: string,
): Promise<CandleWithIndicators[] | null> {
  const filePath = getFilePath(symbol, market);
  try {
    const raw = await readFile(filePath, 'utf-8');
    const data: LocalCandleFile = JSON.parse(raw);
    if (!data.candles || data.candles.length === 0) return null;

    // 本地數據最後日期必須 >= asOfDate
    if (data.lastDate < asOfDate) return null;

    // 截取到 asOfDate 為止的 K 線
    const filtered = data.candles.filter(c => c.date <= asOfDate);
    if (filtered.length === 0) return null;

    return computeIndicators(filtered);
  } catch {
    return null;
  }
}

/**
 * 將原始 K 線存到本地檔案
 * candles 應為原始 OHLCV（不含指標）
 */
export async function saveLocalCandles(
  symbol: string,
  market: 'TW' | 'CN',
  candles: Candle[],
): Promise<void> {
  if (candles.length === 0) return;

  const dir = path.join(DATA_ROOT, market);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  // 只保留原始 OHLCV 欄位
  const stripped: Candle[] = candles.map(c => ({
    date: c.date,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }));

  const lastDate = stripped[stripped.length - 1].date;

  const data: LocalCandleFile = {
    symbol,
    lastDate,
    updatedAt: new Date().toISOString(),
    candles: stripped,
  };

  const filePath = getFilePath(symbol, market);
  await writeFile(filePath, JSON.stringify(data), 'utf-8');
}

/**
 * 檢查本地檔案是否存在且數據足夠新
 */
export async function isLocalDataFresh(
  symbol: string,
  market: 'TW' | 'CN',
  asOfDate: string,
): Promise<boolean> {
  const filePath = getFilePath(symbol, market);
  try {
    const raw = await readFile(filePath, 'utf-8');
    const data: LocalCandleFile = JSON.parse(raw);
    return data.lastDate >= asOfDate;
  } catch {
    return false;
  }
}

/**
 * 計算兩個日期之間的交易日數（跳過週六日）
 * dateA 必須 <= dateB，回傳 0 表示同一天
 */
function businessDaysBetween(dateA: string, dateB: string): number {
  if (dateA >= dateB) return 0;
  const a = new Date(dateA + 'T00:00:00');
  const b = new Date(dateB + 'T00:00:00');
  let count = 0;
  const cursor = new Date(a);
  cursor.setDate(cursor.getDate() + 1); // start from day after dateA
  while (cursor <= b) {
    const dow = cursor.getDay();
    if (dow !== 0 && dow !== 6) count++;
    cursor.setDate(cursor.getDate() + 1);
  }
  return count;
}

/**
 * 讀取本地 K 線，允許一定的交易日容忍度
 * 當 lastDate 與 asOfDate 差距在 toleranceDays 個交易日以內時，
 * 仍回傳可用數據（截取到 lastDate 為止）
 *
 * 數學依據：60-120 日均線差 2-5 天的影響 < 0.1%，對策略篩選無實質影響
 */
export async function loadLocalCandlesWithTolerance(
  symbol: string,
  market: 'TW' | 'CN',
  asOfDate: string,
  toleranceDays = 5,
): Promise<{ candles: CandleWithIndicators[]; staleDays: number } | null> {
  const filePath = getFilePath(symbol, market);
  try {
    const raw = await readFile(filePath, 'utf-8');
    const data: LocalCandleFile = JSON.parse(raw);
    if (!data.candles || data.candles.length === 0) return null;

    // 完全覆蓋 → staleDays = 0
    if (data.lastDate >= asOfDate) {
      const filtered = data.candles.filter(c => c.date <= asOfDate);
      if (filtered.length === 0) return null;
      return { candles: computeIndicators(filtered), staleDays: 0 };
    }

    // 差距在容忍範圍內 → 使用截至 lastDate 的數據
    const gap = businessDaysBetween(data.lastDate, asOfDate);
    if (gap <= toleranceDays) {
      // 回傳所有可用 K 線（已經是到 lastDate 為止）
      return { candles: computeIndicators(data.candles), staleDays: gap };
    }

    return null; // 數據太舊
  } catch {
    return null;
  }
}

/** 取得已下載的股票數量（統計用） */
export function getLocalCandleDir(market: 'TW' | 'CN'): string {
  return path.join(DATA_ROOT, market);
}

/**
 * 批量檢查多支股票的本地資料新鮮度
 * 回傳 { fresh: string[], stale: string[], missing: string[] }
 */
export async function batchCheckFreshness(
  symbols: string[],
  market: 'TW' | 'CN',
  asOfDate: string,
  toleranceDays = 3,
): Promise<{ fresh: string[]; stale: string[]; missing: string[] }> {
  const fresh: string[] = [];
  const stale: string[] = [];
  const missing: string[] = [];

  // 並行讀取所有檔案（I/O bound，不需限流）
  const BATCH_SIZE = 50;
  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const batch = symbols.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (symbol) => {
        const filePath = getFilePath(symbol, market);
        try {
          const raw = await readFile(filePath, 'utf-8');
          const data: LocalCandleFile = JSON.parse(raw);
          if (!data.candles || data.candles.length === 0) return { symbol, status: 'missing' as const };

          if (data.lastDate >= asOfDate) {
            return { symbol, status: 'fresh' as const };
          }

          const gap = businessDaysBetween(data.lastDate, asOfDate);
          if (gap <= toleranceDays) {
            return { symbol, status: 'stale' as const };
          }

          return { symbol, status: 'missing' as const };
        } catch {
          return { symbol, status: 'missing' as const };
        }
      }),
    );

    for (const r of results) {
      if (r.status === 'fulfilled') {
        if (r.value.status === 'fresh') fresh.push(r.value.symbol);
        else if (r.value.status === 'stale') stale.push(r.value.symbol);
        else missing.push(r.value.symbol);
      } else {
        // Promise 失敗視為 missing（不應該發生，allSettled 內部 catch 了）
      }
    }
  }

  return { fresh, stale, missing };
}
