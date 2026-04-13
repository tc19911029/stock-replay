/**
 * POST /api/scanner/coarse — 第一級全市場粗掃
 *
 * 使用 Layer 2 盤中快照（單一檔案）進行快速篩選，
 * 不讀逐檔 Blob candle files。
 *
 * 效能目標: < 3 秒（含手機網路環境）
 *
 * 回傳候選清單，前端再用 /api/scanner/chunk 進行精掃。
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import {
  readIntradaySnapshot,
  refreshIntradaySnapshot,
  isSnapshotFresh,
  readMABase,
} from '@/lib/datasource/IntradayCache';
import { coarseScan } from '@/lib/scanner/CoarseScanner';
import { isMarketOpen, getLastTradingDay } from '@/lib/datasource/marketHours';

export const runtime = 'nodejs';
export const maxDuration = 30; // 粗掃應 < 10 秒

const schema = z.object({
  market: z.enum(['TW', 'CN']),
  direction: z.enum(['long', 'short']).default('long'),
  /** 快照最大允許年齡（秒），超過就自動刷新。預設 180 (3 分鐘) */
  maxSnapshotAgeSec: z.number().optional().default(180),
});

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return apiValidationError(parsed.error);
  }

  const { market, direction, maxSnapshotAgeSec } = parsed.data;

  try {
    // ── 判斷目標日期 ──
    const marketOpen = isMarketOpen(market);
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: market === 'TW' ? 'Asia/Taipei' : 'Asia/Shanghai',
    }).format(new Date());

    // 盤中用今天，盤後用上一個交易日
    const targetDate = marketOpen ? today : getLastTradingDay(market);

    // ── 讀取或刷新盤中快照 ──
    let snapshot = await readIntradaySnapshot(market, targetDate);

    let snapshotFresh = true;
    if (!isSnapshotFresh(snapshot, maxSnapshotAgeSec * 1000)) {
      // 快照太舊或不存在，嘗試刷新
      // 只在盤中才刷新（盤後用已存的快照）
      if (marketOpen) {
        try {
          snapshot = await refreshIntradaySnapshot(market);
        } catch {
          // 刷新失敗：用舊的 snapshot（帶 staleness warning）
          // 不要因為 snapshot 不夠新就阻擋整個掃描
          snapshotFresh = false;
        }
      } else if (!snapshot) {
        // 盤後且無快照：嘗試用收盤資料生成
        // 先嘗試讀取，如果沒有就直接回傳空
        // 盤後且無快照：給出具體原因和預估恢復時間
        const nextOpen = market === 'TW' ? '明天 09:00 (台股開盤)' : '明天 09:30 (陸股開盤)';
        return apiError(
          `${market} 尚無盤中快照。原因：目前非開盤時段且尚未產生快照。` +
          `建議：請切換到「歷史紀錄」查看收盤後掃描結果，或等待 ${nextOpen} 後重試。`,
          404,
        );
      }
    }

    if (!snapshot || snapshot.count === 0) {
      return apiError(
        `${market} 盤中快照為空。可能原因：API 暫時無回應或市場休市。建議：稍等 2-3 分鐘後重試。`,
        404,
      );
    }

    // ── 讀取 MA Base（歷史尾端快取）──
    // 嘗試當天和前一天的 MA Base
    let maBase = await readMABase(market, targetDate);
    if (!maBase) {
      // 嘗試前一個交易日
      const prevDate = getLastTradingDay(market);
      if (prevDate !== targetDate) {
        maBase = await readMABase(market, prevDate);
      }
    }
    // MA Base 可能不存在（第一次使用），粗掃仍可進行（只是沒有 MA 過濾）

    // ── 執行粗掃 ──
    const result = coarseScan(snapshot, maBase, { direction });

    const snapshotAgeSeconds = Math.round(
      (Date.now() - new Date(snapshot.updatedAt).getTime()) / 1000,
    );

    return apiOk({
      ...result,
      maBaseAvailable: !!maBase,
      snapshotDate: snapshot.date,
      snapshotUpdatedAt: snapshot.updatedAt,
      snapshotFresh,
      /** 快照距今秒數，前端可顯示「數據延遲 X 分鐘」 */
      snapshotAgeSeconds,
    });
  } catch (err) {
    console.error('[scanner/coarse] error:', err);
    const msg = err instanceof Error ? err.message : String(err);
    const isRateLimit = msg.includes('429') || msg.includes('rate') || msg.includes('limit');
    const isTimeout = msg.includes('timeout') || msg.includes('ETIMEDOUT') || msg.includes('abort');
    if (isRateLimit) {
      return apiError('API 請求過於頻繁（限流中）。建議：等待 1-2 分鐘後重試。', 429);
    }
    if (isTimeout) {
      return apiError('即時報價 API 回應逾時。建議：等待 30 秒後重試，或切換到歷史紀錄查看。', 504);
    }
    return apiError(`粗掃異常：${msg.slice(0, 100)}。建議：重試一次，若持續失敗請切換到歷史紀錄。`);
  }
}
