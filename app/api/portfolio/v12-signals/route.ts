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
import { detectTrend, findPivots } from '@/lib/analysis/trendAnalysis';
import { calcKLineStopLoss, updateStopLossDaily, checkAbsoluteStopLoss, SIGNAL_TO_TRAILING_MA, SIGNAL_TO_FIXED_STOP_PCT } from '@/lib/sell/v12StopLoss';
import { checkKLineExit, checkMAExit, getOperationMA, canUpgradeToLongTerm } from '@/lib/sell/v12Operation';
import { checkTakeProfitTargets, detectKBarExitSignal } from '@/lib/sell/v12TakeProfit';
import { detectSellSignals } from '@/lib/analysis/sellSignals';
import { HIGH_DEVIATION_PCT } from '@/lib/analysis/bookThresholds';
import { getTickSize } from '@/lib/utils/tickSize';
import type { V12Letter } from '@/lib/analysis/v12Signals';
import { normalizeLetter } from '@/lib/scanner/buyMethodTracks';
import { createLogger } from '@/lib/logger';

const logger = createLogger('portfolio/v12-signals');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  symbol: z.string().min(1),
  market: z.enum(['TW', 'CN']).default('TW'),
  entryPrice: z.coerce.number().positive(),
  buyDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  triggerSignal: z.enum(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q']).optional(),
  // 0513 ABCDE E：'wave' 跟 'super-long' 都已砍（書本沒寫、UI 無入口）
  operationMode: z.enum(['short', 'long']).default('short'),
  patternTargetPrice: z.coerce.number().optional(),
  // v12 議題 13 / S3-3 末升段 trailing
  endPhaseTriggered: z.coerce.boolean().optional(),
  recentHigh: z.coerce.number().optional(),
  // v12 議題 ⑥-1 C 訊號用：進場日盤整下緣
  consolidationLow: z.coerce.number().optional(),
  // v12 議題 ⑥-5 F 訊號用：V 底
  vBottom: z.coerce.number().optional(),
  // 0513 M10：N 訊號型態結構失效價（頸線 × 0.97），用於 supportLevel + 絕對停損
  patternStopPrice: z.coerce.number().optional(),
});

export async function GET(req: NextRequest) {
  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return apiValidationError(parsed.error);
  const { symbol, market, entryPrice, buyDate, triggerSignal, operationMode, patternTargetPrice, endPhaseTriggered, recentHigh, consolidationLow, vBottom, patternStopPrice } = parsed.data;

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
    // 0513 C1 fix：v11 G/H/I 持倉透過 normalizeLetter 轉成 v12 J/L/K，
    // 避免 SIGNAL_TO_PRIMARY_STOP / SIGNAL_TO_FIXED_STOP_PCT / SIGNAL_TO_TRAILING_MA 查不到。
    const rawLetter = triggerSignal ?? 'B';
    const letter = normalizeLetter(rawLetter) as V12Letter;

    // ── Step 3 停損 — 持倉中用 updateStopLossDaily 走完整書本邏輯 ──
    // 含議題 S3-1 單一主方法、S3-3 末升段 trailing 3%、③ 均線跟隨上揚、S3-7 10% 絕對下限
    // M10：N 字母 supportLevel 用型態 stopPrice（頸線 × 0.97），其他字母用 consolidationLow fallback
    const supportLevel = letter === 'N' && patternStopPrice != null
      ? patternStopPrice
      : (consolidationLow ?? entryKbar.low);
    const slInputs = {
      letter,
      entryPrice,
      entryKbar,
      tickSize,
      isEndPhase: endPhaseTriggered,
      recentHigh,
      pivotLow: entryKbar.low,
      supportLevel,
      triggerKLow: entryKbar.low,
    };
    const slResult = updateStopLossDaily(slInputs, today_c);
    const klineStop = calcKLineStopLoss(entryKbar, tickSize);
    const stopLossPrice = slResult.stopLossPrice;
    const profitPct = (today_c.close - entryPrice) / entryPrice;

    // ── Step 3 ⑥ 5 條絕對停損（議題 Step 3 ⑥）──
    const yesterdayTrend = candles[lastIdx - 1] ? detectTrend(candles, lastIdx - 1) : '盤整';
    // M10：N 訊號的「型態結構失效」用 patternStopPrice，傳給 consolidationLow（checkAbsoluteStopLoss 統一名）
    const absoluteSL = checkAbsoluteStopLoss({
      entryPrice,
      todayClose: today_c.close,
      trendStateToday: trendState,
      trendStateYesterday: yesterdayTrend,
      letter,
      consolidationLow: letter === 'N' && patternStopPrice != null ? patternStopPrice : consolidationLow,
      vBottom,
    });

    // ── Step 4 操作 ──
    // v12 寶典 Step 5 ②（進階紀律）：乖離 ≥15% 切 MA5
    // 限定條件：
    //   1. 只對 B/P 訊號生效（寶典「回後買上漲」「高檔拉回」進階紀律 #5/#6）
    //   2. operationMode=long 時不覆寫（升級長線統一 MA20）
    //   3. Q/D/J/O 等有獨立 SOP 的字母不受影響
    let operatingMA = getOperationMA(letter, operationMode);
    let highDeviationOverride = false;
    const isAdvancedDisciplineLetter = letter === 'B' || letter === 'P';
    if (
      isAdvancedDisciplineLetter &&
      operationMode !== 'long' &&
      today_c.ma20 != null &&
      today_c.ma20 > 0
    ) {
      const deviation = (today_c.close - today_c.ma20) / today_c.ma20;
      if (deviation >= HIGH_DEVIATION_PCT) {
        operatingMA = 'MA5';
        highDeviationOverride = true;
      }
    }
    let maValue: number | null = null;
    if (operatingMA === 'MA3') maValue = today_c.ma3 ?? null;
    else if (operatingMA === 'MA5') maValue = today_c.ma5 ?? null;
    else if (operatingMA === 'MA10') maValue = today_c.ma10 ?? null;
    else if (operatingMA === 'MA20') maValue = today_c.ma20 ?? null;
    else if (operatingMA === 'MA60') maValue = today_c.ma60 ?? null;

    const klineExit = checkKLineExit(today_c, yesterday_c, trendState);
    const maExit = maValue != null
      ? checkMAExit(today_c.close, maValue, letter, entryPrice)
      : { shouldExit: false };
    const upgradeCheck = canUpgradeToLongTerm(today_c.close, entryPrice, operationMode);

    // ── Step 5 停利 ──
    // 找最近 confirmed pivot high 給「到達壓力」判定（書本 5 步驟步驟 5 第 4 章 #1）
    const recentPivots = findPivots(candles, lastIdx, 8, false);
    const recentPivotHigh = recentPivots.find(p => p.type === 'high')?.price;
    const takeProfit = checkTakeProfitTargets({
      letter,
      entryPrice,
      todayClose: today_c.close,
      todayMA20: today_c.ma20 ?? null,
      patternTargetPrice,
      recentPivotHigh,
    });
    const kbarSignal = yesterday_c
      ? detectKBarExitSignal({
          todayCandle: today_c,
          yesterdayCandle: yesterday_c,
          twoDaysAgoCandle: candles[lastIdx - 2],
          threeDaysAgoCandle: candles[lastIdx - 3],
          cumulativeProfit: profitPct,
          // 末升段觸發時啟用 高檔長上影 / 急漲反轉 偵測（書本「末升段」訊號）
          isEndPhase: endPhaseTriggered ?? false,
        })
      : { triggered: false };

    // ── 議題 C1：書本 9+ 條出場訊號完整清單 ──
    // 跟 SignalSummaryCard 共用 detectSellSignals，避免兩處邏輯飄移
    const triggeredSellSignals = detectSellSignals(candles, lastIdx).map((s) => ({
      type: s.type,
      label: s.label,
      detail: s.detail,
      severity: s.severity,
    }));

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
        method: slResult.detail,
        primaryMethod: slResult.primaryMethod,
        absoluteFloor: +slResult.absoluteFloor.toFixed(2),
        klineStop: +klineStop.toFixed(2),
        trailingActivated: slResult.trailingActivated,
        slDistancePct: +((today_c.close - stopLossPrice) / today_c.close * 100).toFixed(2),
        // 字母對應的 trailing MA（用戶 UI 顯示用，2026-05-09 新增）
        trailingMA: SIGNAL_TO_TRAILING_MA[letter],
        // 字母對應的固定停損 % 上限（5% / 7% / 10%）
        fixedPct: SIGNAL_TO_FIXED_STOP_PCT[letter],
        // ⑥ 5 條絕對停損 — 觸發即強制出場
        absoluteStopLoss: {
          triggered: absoluteSL.triggered,
          reason: absoluteSL.reason,
          detail: absoluteSL.detail,
        },
      },
      step4: {
        operatingMA: operatingMA ?? '無',
        operatingMAValue: maValue != null ? +maValue.toFixed(2) : null,
        klineExit,
        maExit,
        canUpgradeToLong: upgradeCheck.canUpgrade,
        upgradeProfitPct: +upgradeCheck.profitPct.toFixed(4),
        // 議題 Step 5 ②：乖離 ≥15% 自動覆寫對應均線為 MA5（不直接停利）
        highDeviationOverride,
      },
      step5: {
        takeProfit,
        kbarSignal,
        triggeredSellSignals,
      },
    });
  } catch (err) {
    logger.error('failed', err);
    return apiError(`failed: ${String(err).slice(0, 200)}`);
  }
}
