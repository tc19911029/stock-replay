/**
 * 成交額排名索引檔
 *
 * 用途：每天收盤後預計算每支股票的 20 日均成交額（close × volume），
 * 輸出前 N 大成交額的股票清單，供掃描器過濾股票池。
 *
 * 為何用索引檔而非即時計算：
 * - 掃描時讀 1900+ 支 L1 算均線，太慢
 * - 索引檔幾 KB，讀取瞬間完成
 * - 早盤 L2 即時成交額累積不夠，排名不穩定
 *
 * 回測根據（2026-04-16 確認）：
 *   前 500 + MTF≥3 + 六條件總分+漲幅 = 3.5 個月 +238.6%
 *   （見 project_tw_ultimate_backtest_result.md）
 */

import { promises as fs } from 'fs';
import path from 'path';
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';

const IS_VERCEL = process.env.VERCEL === '1';
const INDEX_DIR = path.join(process.cwd(), 'data', 'turnover-rank');
const AVG_WINDOW = 20;
const MIN_VALID_DAYS = 5;

// ── Blob/FS 統一讀寫（與 CandleStorageAdapter 同模式）────────────────────

function blobKey(market: 'TW' | 'CN'): string {
  return `turnover-rank/${market}.json`;
}

async function readIndexRaw(market: 'TW' | 'CN'): Promise<string | null> {
  if (IS_VERCEL) {
    try {
      const { get } = await import('@vercel/blob');
      const result = await get(blobKey(market), { access: 'private' });
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
    return await fs.readFile(path.join(INDEX_DIR, `${market}.json`), 'utf-8');
  } catch {
    return null;
  }
}

async function writeIndexRaw(market: 'TW' | 'CN', data: string): Promise<void> {
  if (IS_VERCEL) {
    const { put } = await import('@vercel/blob');
    await put(blobKey(market), data, {
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  } else {
    const { atomicFsPut } = await import('@/lib/storage/atomicFsPut');
    await fs.mkdir(INDEX_DIR, { recursive: true });
    await atomicFsPut(path.join(INDEX_DIR, `${market}.json`), data);
  }
}

export interface TurnoverRankIndex {
  market: 'TW' | 'CN';
  date: string;            // YYYY-MM-DD，索引產生時的市場日期
  generatedAt: string;     // ISO timestamp
  topN: number;
  /** 排序過的代碼清單（含 .TW/.TWO/.SS/.SZ 後綴） */
  symbols: string[];
}

/**
 * 從 L1 candle 資料計算成交額排名並寫入索引檔
 *
 * @param market   市場
 * @param stocks   候選股票清單（通常由 scanner.getStockList() 取得）
 * @param topN     前 N 名（預設 500）
 * @param timezone 用於決定索引檔日期，預設由 market 推導
 */
export async function buildTurnoverRank(
  market: 'TW' | 'CN',
  stocks: { symbol: string }[],
  topN: number = 500,
): Promise<TurnoverRankIndex> {
  const rankings: { symbol: string; avgTurnover: number }[] = [];

  // 並行讀取（避免過度併發，限制 30）
  const CONCURRENCY = 30;
  for (let i = 0; i < stocks.length; i += CONCURRENCY) {
    const batch = stocks.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(async ({ symbol }) => {
        // 檔名以完整 symbol（含 .TW/.TWO/.SS/.SZ 後綴）儲存
        const file = await readCandleFile(symbol, market);
        if (!file || file.candles.length < MIN_VALID_DAYS) return null;

        // 取最近 AVG_WINDOW 根
        const recent = file.candles.slice(-AVG_WINDOW);
        let sum = 0;
        let count = 0;
        for (const c of recent) {
          const close = c.close ?? 0;
          const vol = c.volume ?? 0;
          if (close > 0 && vol > 0) {
            sum += close * vol;
            count++;
          }
        }
        if (count < MIN_VALID_DAYS) return null;

        return { symbol, avgTurnover: sum / count };
      }),
    );

    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value) rankings.push(r.value);
    }
  }

  rankings.sort((a, b) => b.avgTurnover - a.avgTurnover);
  const top = rankings.slice(0, topN);

  const today = new Date().toLocaleString('sv-SE', {
    timeZone: market === 'TW' ? 'Asia/Taipei' : 'Asia/Shanghai',
  }).split(' ')[0];

  const index: TurnoverRankIndex = {
    market,
    date: today,
    generatedAt: new Date().toISOString(),
    topN,
    symbols: top.map(r => r.symbol),
  };

  await writeIndexRaw(market, JSON.stringify(index, null, 2));
  return index;
}

/**
 * 讀取成交額排名索引檔
 *
 * @returns 索引物件（含 Set 快速查詢）或 null（檔案不存在/讀取失敗）
 */
export async function readTurnoverRank(
  market: 'TW' | 'CN',
): Promise<{ symbols: Set<string>; ranks: Map<string, number>; date: string; topN: number } | null> {
  try {
    const raw = await readIndexRaw(market);
    if (!raw) return null;
    const index: TurnoverRankIndex = JSON.parse(raw);
    const ranks = new Map<string, number>();
    index.symbols.forEach((sym, i) => ranks.set(sym, i + 1));
    return {
      symbols: new Set(index.symbols),
      ranks,
      date: index.date,
      topN: index.topN,
    };
  } catch {
    return null;
  }
}

/**
 * 計算指定日期當下的成交額排名（不寫檔，回傳 Set）
 *
 * 用於歷史 L4 backfill — 需要模擬「當時的」前 N 大成交額。
 * 對每支股票，取 asOfDate（含）往前最多 20 根 K 棒計算均值。
 *
 * @param asOfDate YYYY-MM-DD 基準日期（含）
 */
export async function computeTurnoverRankAsOfDate(
  market: 'TW' | 'CN',
  stocks: { symbol: string }[],
  asOfDate: string,
  topN: number = 500,
): Promise<Map<string, number>> {
  const rankings: { symbol: string; avgTurnover: number }[] = [];
  const CONCURRENCY = 30;

  for (let i = 0; i < stocks.length; i += CONCURRENCY) {
    const batch = stocks.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(async ({ symbol }) => {
        const file = await readCandleFile(symbol, market);
        if (!file || file.candles.length < MIN_VALID_DAYS) return null;

        // 找到 asOfDate 在序列中的位置（包含該日）
        const idx = file.candles.findIndex(c => c.date.slice(0, 10) > asOfDate);
        // endIdx = 首個 date > asOfDate 的 index，即「切到 asOfDate 為止」
        const endIdx = idx === -1 ? file.candles.length : idx;
        if (endIdx < MIN_VALID_DAYS) return null;

        const startIdx = Math.max(0, endIdx - AVG_WINDOW);
        const window = file.candles.slice(startIdx, endIdx);

        let sum = 0;
        let count = 0;
        for (const c of window) {
          const close = c.close ?? 0;
          const vol = c.volume ?? 0;
          if (close > 0 && vol > 0) {
            sum += close * vol;
            count++;
          }
        }
        if (count < MIN_VALID_DAYS) return null;

        return { symbol, avgTurnover: sum / count };
      }),
    );

    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value) rankings.push(r.value);
    }
  }

  rankings.sort((a, b) => b.avgTurnover - a.avgTurnover);
  const map = new Map<string, number>();
  rankings.slice(0, topN).forEach((r, i) => map.set(r.symbol, i + 1));
  return map;
}
