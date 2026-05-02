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

import path from 'path';
import type { Candle, CandleWithIndicators } from '@/types';
import { computeIndicators } from '@/lib/indicators';
import { readCandleFile, writeCandleFile } from './CandleStorageAdapter';

/** 本地數據根目錄（getLocalCandleDir 等統計用途） */
const DATA_ROOT = path.join(process.cwd(), 'data', 'candles');

/**
 * 讀取本地 K 線檔案並計算指標
 * @returns CandleWithIndicators[] 或 null（檔案不存在/讀取失敗）
 */
export async function loadLocalCandles(
  symbol: string,
  market: 'TW' | 'CN',
): Promise<CandleWithIndicators[] | null> {
  try {
    const data = await readCandleFile(symbol, market);
    if (!data) return null;
    return computeIndicators(data.candles);
  } catch {
    return null;
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
  try {
    const data = await readCandleFile(symbol, market);
    if (!data) return null;

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
 * 取中位數（不 mutate 輸入）
 */
function medianOf(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * L1 寫入邊界 sanity check — 最後一根 bar volume 相對前 20 日中位數 > 30×
 * 即視為異常（單位錯誤、parse 錯誤、髒資料），砍掉該 bar 並回傳修剪後陣列。
 *
 * 背景：2026-04-21 append-today-from-snapshot × 100 bug 讓 589 檔 CN 4/20
 * volume 放大 100 倍；此 guard 確保日後類似離譜值無法穿過寫入層。
 */
function guardAgainstAnomalousLastBar(symbol: string, candles: Candle[]): Candle[] {
  if (candles.length < 21) return candles;
  const last = candles[candles.length - 1];
  if (last.volume <= 0) return candles;
  const window = candles.slice(-21, -1).map(b => b.volume).filter(v => v > 0);
  if (window.length < 5) return candles;
  const med = medianOf(window);
  if (med <= 0) return candles;
  if (last.volume > med * 30) {
    console.warn(
      `[L1 guard] ${symbol} ${last.date} volume=${last.volume} 超過前 20 日中位數 ${med} 的 30 倍，砍掉該 bar 不寫入（可能單位錯誤：手→股需先跑 normalize-cn-l1-volume.ts）`
    );
    return candles.slice(0, -1);
  }
  if (last.volume < med / 30) {
    console.warn(
      `[L1 guard] ${symbol} ${last.date} volume=${last.volume} 低於前 20 日中位數 ${med} 的 1/30，砍掉該 bar 不寫入（可能單位錯誤：股→手）`
    );
    return candles.slice(0, -1);
  }

  // OHLC 一致性：high >= close >= low 且 high >= open >= low
  // 違規代表盤中快照污染（快照時的 low/high 尚未反映最終收盤）
  if (last.high < last.close || last.low > last.close || last.high < last.open || last.low > last.open) {
    console.warn(
      `[L1 guard] ${symbol} ${last.date} OHLC 矛盾 (o=${last.open} h=${last.high} l=${last.low} c=${last.close})，砍掉該 bar 不寫入（盤中快照污染，收盤後再寫）`
    );
    return candles.slice(0, -1);
  }

  return candles;
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
  const safe = guardAgainstAnomalousLastBar(symbol, candles);
  if (safe.length === 0) return;
  await writeCandleFile(symbol, market, safe);
}

/**
 * 檢查本地檔案是否存在且數據足夠新
 */
export async function isLocalDataFresh(
  symbol: string,
  market: 'TW' | 'CN',
  asOfDate: string,
): Promise<boolean> {
  try {
    const data = await readCandleFile(symbol, market);
    if (!data) return false;
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
  try {
    const data = await readCandleFile(symbol, market);
    if (!data) return null;

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
        try {
          const data = await readCandleFile(symbol, market);
          if (!data) return { symbol, status: 'missing' as const };

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
      }
    }
  }

  return { fresh, stale, missing };
}
