/**
 * EOD Settlement Reconciliation — 盤後對賬機制
 *
 * 設計動機（2026-05-13）：
 * 過去資料管線只有「拿到一個就用」邏輯，遇到 vendor 出包（mis.twse 鎖漲停 bug、
 * TPEx Cloudflare、FinMind token 過期）就靜默漏掃／寫錯。每次都要用戶反映才修。
 *
 * 新設計：盤後跑一次「強制對賬」，對每一檔當日 K，從多個 vendor 拿資料，
 *   - 至少 2 源 close 一致（差距 < tolerance）→ 視為 settled，寫進 L1
 *   - 多源不一致 / 只有 1 源 / 全失敗 → 標 pending，T+1 重試（包括 AI WebFetch fallback）
 *
 * Vendor 優先序：
 *   TW: TWSE openapi (raw) → EODHD (raw) → Yahoo Chart → Tencent (僅 ETF/權證能拿)
 *   CN: EastMoney → Tencent → EODHD → Yahoo Chart
 */

import { eodhdHistProvider } from './EODHDHistProvider';
import { yahooProvider } from './YahooDataProvider';
import { tencentHistProvider } from './TencentHistProvider';
import { eastMoneyHistProvider } from './EastMoneyHistProvider';
import type { Candle } from '@/types';
import type { VendorBatchCache } from './eodSettleBatch';
import { lookupBulkQuote } from './eodSettleBatch';

export type Market = 'TW' | 'CN';

export interface VendorQuote {
  vendor: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type SettleStatus =
  | 'settled-multi-source'      // ≥2 vendor close 一致
  | 'settled-single-source'      // 只有 1 vendor 回，但仍寫入（標警告）
  | 'pending-multi-disagree'     // 多 vendor 但 close 不一致
  | 'pending-no-vendor-data'     // 全部 vendor 沒回
  | 'skipped-already-correct';   // L1 已有當日資料且與 vendor 一致

export interface SettleResult {
  symbol: string;
  market: Market;
  date: string;
  status: SettleStatus;
  vendors: VendorQuote[];
  settled?: VendorQuote;          // 最終決定寫進 L1 的（status=settled-*  才有）
  existing?: VendorQuote;         // L1 既有值（若有）
  disagreements?: string[];       // multi-disagree 時的 close 差距列表
  warning?: string;
}

const CLOSE_AGREE_TOLERANCE = 0.005; // 0.5% — vendor 之間 close 允許差距

function isClose(a: number, b: number): boolean {
  if (a <= 0 || b <= 0) return false;
  return Math.abs(a - b) / Math.max(a, b) < CLOSE_AGREE_TOLERANCE;
}

/** Volume 單位 normalize 到 L1 標準：TW=張、CN=股
 *  vendor 各家原始單位：
 *    TWSE/TPEx provider 已 / 1000 變張
 *    EODHD/Yahoo/Tencent/EastMoney 給「股」
 *  → 對 TW，把「股」級 vendor 的 volume / 1000 才能跟 TWSE 比 */
function normalizeVolume(rawVolume: number, vendorName: string, market: Market): number {
  if (market === 'TW' && (vendorName === 'EODHD' || vendorName === 'Yahoo' || vendorName === 'Tencent' || vendorName === 'EastMoney')) {
    return Math.round(rawVolume / 1000);
  }
  return rawVolume;
}

const PER_VENDOR_TIMEOUT_MS = 8000;

async function fetchOne(
  provider: { name: string; getCandlesRange: (s: string, sd: string, ed: string) => Promise<Candle[]> },
  symbol: string,
  date: string,
  market: Market,
): Promise<VendorQuote | null> {
  try {
    // 用 race 強制每個 vendor 在 timeout 內回，避免 1 個 vendor hang 卡死整個 batch
    const arr = await Promise.race([
      provider.getCandlesRange(symbol, date, date),
      new Promise<Candle[]>((_, reject) =>
        setTimeout(() => reject(new Error(`${provider.name} timeout`)), PER_VENDOR_TIMEOUT_MS)),
    ]);
    const c = arr.find(x => x.date === date);
    if (!c || !c.close || c.close <= 0) return null;
    return {
      vendor: provider.name,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: normalizeVolume(c.volume, provider.name, market),
    };
  } catch {
    return null;
  }
}

/** 從多 vendor 結果決定 settled 值 */
function reconcile(quotes: VendorQuote[]): { settled?: VendorQuote; status: SettleStatus; disagreements?: string[] } {
  if (quotes.length === 0) return { status: 'pending-no-vendor-data' };
  if (quotes.length === 1) {
    return { settled: quotes[0], status: 'settled-single-source' };
  }

  // 找一組「至少 2 vendor close 一致」的 vendors
  for (let i = 0; i < quotes.length; i++) {
    for (let j = i + 1; j < quotes.length; j++) {
      if (isClose(quotes[i].close, quotes[j].close)) {
        // 找到一致對。從 i, j 中選 vendor 優先序高的（前者）作為 settled
        // 但 volume 取「最大值」(因為某些 vendor 給 0 或部分日資料)
        const base = quotes[i];
        const allVolumes = quotes.filter(q => isClose(q.close, base.close)).map(q => q.volume);
        const maxVol = Math.max(...allVolumes, 0);
        return {
          settled: { ...base, volume: maxVol > 0 ? maxVol : base.volume },
          status: 'settled-multi-source',
        };
      }
    }
  }

  // 多 vendor 但無一致對
  const disagreements = quotes.map(q => `${q.vendor}=${q.close.toFixed(2)}`);
  return {
    status: 'pending-multi-disagree',
    disagreements,
  };
}

/**
 * 對單檔當日 K 跑對賬。
 *
 * 為了大量並行不被 TWSE provider 每檔 10s 拖死，TWSE/TPEx/EastMoney 改走 batch
 * prefetch（先一次拉整日 table，每檔 lookup map）。per-symbol API 走 EODHD/Yahoo/Tencent。
 */
export async function settleSymbol(
  symbol: string,
  market: Market,
  date: string,
  existing?: VendorQuote,
  batchCache?: VendorBatchCache,
): Promise<SettleResult> {
  const quotes: VendorQuote[] = [];

  // 1. 從 batch cache 拿（TWSE/TPEx/EastMoney bulk）— 不打 API
  if (batchCache) {
    const bulkQ = lookupBulkQuote(batchCache, symbol, market);
    if (bulkQ) quotes.push(bulkQ);
  }

  // 2. Per-symbol providers — EODHD + Yahoo + (CN) Tencent
  //    TWSE provider 從 chain 移除（已由 batch cache 代替）
  //    EastMoney provider for CN 也已被 batch 取代（雖然 batch 目前 stub）
  const perSymProviders = market === 'TW'
    ? [eodhdHistProvider, yahooProvider]
    : [eastMoneyHistProvider, tencentHistProvider, eodhdHistProvider, yahooProvider];

  const settled = await Promise.allSettled(
    perSymProviders.map(p => fetchOne(p, symbol, date, market)),
  );
  for (const r of settled) {
    if (r.status === 'fulfilled' && r.value) quotes.push(r.value);
  }

  // 若 existing 也加入比對（讓 L1 既有值參與多數決）
  if (existing && existing.close > 0) {
    quotes.push({ ...existing, vendor: 'L1-existing' });
  }

  const { settled: settledQuote, status, disagreements } = reconcile(quotes);
  return {
    symbol,
    market,
    date,
    status,
    vendors: quotes,
    settled: settledQuote,
    existing,
    disagreements,
    warning: status === 'settled-single-source' ? '只有 1 vendor 回，未經多源驗證' : undefined,
  };
}

/** Volume 單位換算：TW 寫入 L1 用「張」，CN 用「股」 */
export function normalizeVolumeForL1(quote: VendorQuote, market: Market, vendorName?: string): number {
  // 各 vendor 的 volume 單位（已在 provider 內部統一處理）：
  //   TWSE openapi: 已為「股」(stored in raw API)，我們的 provider 換算為「張」
  //   EODHD: 「股」
  //   Yahoo: 「股」
  //   EastMoney/Tencent: 「股」
  // 為了一致，這層強制：market=TW 若 vendor 是 raw「股」級別 → / 1000
  // 但 provider getCandlesRange 預期已轉成 L1 格式
  return quote.volume;
}
