/**
 * GET /api/portfolio/v12-signals?symbol=X&market=TW&entryPrice=Y&buyDate=Z&triggerSignal=W&operationMode=short
 *
 * 對單一持倉計算 v12 Step 3-5 訊號：
 * - Step 3 停損：當前停損價 + 方法
 * - Step 4 操作：對應均線 + 是否該出場
 * - Step 5 停利：獲利目標 / K 棒訊號
 *
 * 設計原則：純讀取，不修改 portfolio 狀態。前端再決定是否實際出場。
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import { loadLocalCandlesWithTolerance } from '@/lib/datasource/LocalCandleStore';
import { detectTrend } from '@/lib/analysis/trendAnalysis';
import { calcKLineStopLoss } from '@/lib/sell/v12StopLoss';
import { checkKLineExit, checkMAExit, getOperationMA, canUpgradeToLongTerm } from '@/lib/sell/v12Operation';
import { checkTakeProfitTargets, detectKBarExitSignal } from '@/lib/sell/v12TakeProfit';
import { getTickSize } from '@/lib/utils/tickSize';
import type { V12Letter } from '@/lib/analysis/v12Signals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  symbol: z.string().min(1),
  market: z.enum(['TW', 'CN']).default('TW'),
  entryPrice: z.coerce.number().positive(),
  buyDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  triggerSignal: z.enum(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q']).optional(),
  operationMode: z.enum(['short', 'long', 'wave']).default('short'),
  patternTargetPrice: z.coerce.number().optional(),
});

export async function GET(req: NextRequest) {
  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return apiValidationError(parsed.error);
  const { symbol, market, entryPrice, buyDate, triggerSignal, operationMode, patternTargetPrice } = parsed.data;

  try {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
    const result = await loadLocalCandlesWithTolerance(symbol, market, today, 5);
    if (!result || result.candles.length === 0) {
      return apiError(`無法載入 ${symbol} K 線`, 404);
    }
    const candles = result.candles;
    const lastIdx = candles.length - 1;
    const today_c = candles[lastIdx];
    const yesterday_c = candles[lastIdx - 1];
    if (!today_c || !yesterday_c) {
      return apiError(`K 線不足 (count=${candles.length}, lastIdx=${lastIdx}, hasToday=${!!today_c}, hasYesterday=${!!yesterday_c})`, 404);
    }

    // 找到買進日 K 棒（用於 Step 3 K 線三段式）
    const entryIdx = candles.findIndex((c) => c.date === buyDate);
    const entryKbar = entryIdx >= 0 ? candles[entryIdx] : today_c;

    const tickSize = getTickSize(entryPrice, market);
    const trendState = detectTrend(candles, lastIdx);

    // 視為 v11 資料的 holding 沒有 triggerSignal，預設用 'B'（最常見）
    const letter = (triggerSignal ?? 'B') as V12Letter;

    // ── Step 3 停損（K 線三段式或對應方法）──
    const klineStop = calcKLineStopLoss(entryKbar, tickSize);
    const absoluteFloor = entryPrice * 0.9; // 10% 絕對下限
    const stopLossPrice = Math.max(klineStop, absoluteFloor);
    const profitPct = (today_c.close - entryPrice) / entryPrice;

    // ── Step 4 操作 ──
    const operatingMA = getOperationMA(letter, operationMode);
    let maValue: number | null = null;
    if (operatingMA === 'MA3') maValue = today_c.ma3 ?? null;
    else if (operatingMA === 'MA5') maValue = today_c.ma5 ?? null;
    else if (operatingMA === 'MA10') maValue = today_c.ma10 ?? null;
    else if (operatingMA === 'MA20') maValue = today_c.ma20 ?? null;

    const klineExit = checkKLineExit(today_c, yesterday_c, trendState);
    const maExit = maValue != null
      ? checkMAExit(today_c.close, maValue, letter, entryPrice)
      : { shouldExit: false };
    const upgradeCheck = canUpgradeToLongTerm(today_c.close, entryPrice, operationMode);

    // ── Step 5 停利 ──
    const takeProfit = checkTakeProfitTargets({
      letter,
      entryPrice,
      todayClose: today_c.close,
      todayMA20: today_c.ma20 ?? null,
      patternTargetPrice,
    });
    const kbarSignal = yesterday_c
      ? detectKBarExitSignal({
          todayCandle: today_c,
          yesterdayCandle: yesterday_c,
          twoDaysAgoCandle: candles[lastIdx - 2],
          threeDaysAgoCandle: candles[lastIdx - 3],
          cumulativeProfit: profitPct,
          isEndPhase: false, // simplification — full impl would track this
        })
      : { triggered: false };

    return apiOk({
      symbol,
      market,
      letter,
      entryPrice,
      buyDate,
      operationMode,
      todayPrice: today_c.close,
      todayDate: today_c.date,
      profitPct: +profitPct.toFixed(4),
      profitAmount: +(today_c.close - entryPrice).toFixed(2),
      trendState,
      step3: {
        stopLossPrice: +stopLossPrice.toFixed(2),
        method: 'K 線三段式（書本步驟 3 ① 或對應方法）',
        absoluteFloor: +absoluteFloor.toFixed(2),
        klineStop: +klineStop.toFixed(2),
        slDistancePct: +((today_c.close - stopLossPrice) / today_c.close * 100).toFixed(2),
      },
      step4: {
        operatingMA: operatingMA ?? '無',
        operatingMAValue: maValue != null ? +maValue.toFixed(2) : null,
        klineExit,
        maExit,
        canUpgradeToLong: upgradeCheck.canUpgrade,
        upgradeProfitPct: +upgradeCheck.profitPct.toFixed(4),
      },
      step5: {
        takeProfit,
        kbarSignal,
      },
    });
  } catch (err) {
    console.error('[portfolio/v12-signals]', err);
    return apiError(`failed: ${String(err).slice(0, 200)}`);
  }
}
