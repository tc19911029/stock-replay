/**
 * GET /api/scanner/market-trend?market=TW|CN&date=YYYY-MM-DD
 *
 * 即時取得大盤「真實」趨勢（純 detectTrend 結果），給 UI banner / 條件面板 / 走圖
 * 三邊統一顯示用。**不含**「乖離過大降級」「短期走弱降級」這種掃描專用副作用
 * （那條邏輯走 getMarketScanRegime 只給 minScore 用）。
 *
 * 為什麼要這個 endpoint：banner 原本讀 saved scan session 的 marketTrend，
 * 但 saved session 是過去 cron 用舊代碼寫的（含降級）。改 getMarketTrend 後，
 * 已經寫好的 session 不會自動回填。Banner 改 fetch 這個 endpoint 即時計算，
 * 保證每次打開頁面都用最新代碼算 → trend 跟走圖/條件面板永遠一致。
 */
import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import type { MarketId } from '@/lib/scanner/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const market = req.nextUrl.searchParams.get('market') as MarketId | null;
  const date = req.nextUrl.searchParams.get('date') ?? undefined;
  if (!market || !['TW', 'CN'].includes(market)) {
    return apiError('market must be TW or CN', 400);
  }

  try {
    const scanner = market === 'TW'
      ? new (await import('@/lib/scanner/TaiwanScanner')).TaiwanScanner()
      : new (await import('@/lib/scanner/ChinaScanner')).ChinaScanner();

    const trend = await scanner.getMarketTrend(date);
    return apiOk({
      market,
      date: date ?? null,
      trend,
    });
  } catch (err) {
    console.error('[market-trend]', err);
    return apiError(`failed: ${String(err).slice(0, 200)}`);
  }
}
