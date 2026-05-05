/**
 * 失敗重試 + Gap 自動修復 — 完整數據管道
 *
 * GET /api/cron/retry-failed?market=TW
 * GET /api/cron/retry-failed?market=CN
 * GET /api/cron/retry-failed?market=TW&staleDays=1   ← 延遲重試（抓昨天數據的）
 *
 * Phase 1: 重試失敗 + 過期股票（多來源 fallback）
 * Phase 2: 自動修復 gap 股票（多來源 fallback）
 * Phase 3: 重新生成校驗報告
 *
 * 超時預算管理：120s 總預算，Phase 1 用 70%，Phase 2 用剩餘的 20%。
 */

import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { loadVerifyReport } from '@/lib/datasource/DownloadVerifier';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { TaiwanScanner } from '@/lib/scanner/TaiwanScanner';
import { ChinaScanner } from '@/lib/scanner/ChinaScanner';
import { saveLocalCandles } from '@/lib/datasource/LocalCandleStore';
import { detectCandleGaps } from '@/lib/datasource/validateCandles';
import { eodhdHistProvider } from '@/lib/datasource/EODHDHistProvider';
import { twseHistProvider } from '@/lib/datasource/TWSEHistProvider';
import { tencentHistProvider } from '@/lib/datasource/TencentHistProvider';
import { yahooProvider } from '@/lib/datasource/YahooDataProvider';
import type { Candle } from '@/types';

export const runtime = 'nodejs';
export const maxDuration = 120;

const TOTAL_BUDGET_MS = 110_000; // 110s（留 10s 給 re-verify）
const PHASE1_BUDGET_RATIO = 0.70; // Phase 1 用 70% 預算
const PHASE2_BUDGET_RATIO = 0.90; // Phase 2 用到 90%，剩 10% 給 re-verify
const MAX_RETRY = 70;             // Phase 1 最多 70 檔
const MAX_GAP_REPAIR = 30;        // Phase 2 最多 30 檔
const DELAY_MS = 1500;
const MIN_CANDLE_COUNT = 30;      // 少於 30 根 K 線視為無效
const PER_FETCH_TIMEOUT_MS = 25_000; // 單支 fetch 最多 25s（含所有 fallback），避免拖垮整個 cron

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ── 多來源 fallback 下載 ────────────────────────────────────────────────────

type MarketType = 'TW' | 'CN';

interface FetchResult {
  candles: Candle[];
  source: string;
}

/**
 * 嘗試多個 API 來源下載 K 線，第一個成功就返回
 *
 * TW: Scanner(FinMind) → EODHD → TWSE → Yahoo
 * CN: Scanner(EastMoney) → Tencent → EODHD
 */
async function fetchWithFallback(
  symbol: string,
  market: MarketType,
  scanner: TaiwanScanner | ChinaScanner,
): Promise<FetchResult> {
  // 第一層：Scanner 預設 provider
  try {
    const candles = await scanner.fetchCandles(symbol);
    if (candles.length >= MIN_CANDLE_COUNT) {
      return { candles, source: market === 'TW' ? 'FinMind' : 'EastMoney' };
    }
  } catch {
    // 繼續 fallback
  }

  if (market === 'TW') {
    // 第二層：EODHD
    try {
      const candles = await eodhdHistProvider.getHistoricalCandles(symbol, '2y');
      if (candles.length >= MIN_CANDLE_COUNT) {
        return { candles, source: 'EODHD' };
      }
    } catch { /* continue */ }

    // 第三層：TWSE
    try {
      const candles = await twseHistProvider.getHistoricalCandles(symbol, '2y');
      if (candles.length >= MIN_CANDLE_COUNT) {
        return { candles, source: 'TWSE' };
      }
    } catch { /* continue */ }

    // 第四層：Yahoo
    try {
      const candles = await yahooProvider.getHistoricalCandles(symbol, '2y');
      if (candles.length >= MIN_CANDLE_COUNT) {
        return { candles, source: 'Yahoo' };
      }
    } catch { /* continue */ }
  } else {
    // CN 第二層：Tencent
    try {
      const candles = await tencentHistProvider.getHistoricalCandles(symbol, '2y');
      if (candles.length >= MIN_CANDLE_COUNT) {
        return { candles, source: 'Tencent' };
      }
    } catch { /* continue */ }

    // CN 第三層：EODHD
    try {
      const candles = await eodhdHistProvider.getHistoricalCandles(symbol, '2y');
      if (candles.length >= MIN_CANDLE_COUNT) {
        return { candles, source: 'EODHD' };
      }
    } catch { /* continue */ }
  }

  return { candles: [], source: 'none' };
}

/** 包一層整體 timeout 的 fetchWithFallback，避免單支拖垮整個 cron */
async function fetchWithFallbackTimed(
  symbol: string,
  market: MarketType,
  scanner: TaiwanScanner | ChinaScanner,
): Promise<FetchResult> {
  const timeoutPromise = new Promise<FetchResult>((_, reject) =>
    setTimeout(() => reject(new Error('per-fetch timeout')), PER_FETCH_TIMEOUT_MS),
  );
  try {
    return await Promise.race([fetchWithFallback(symbol, market, scanner), timeoutPromise]);
  } catch {
    return { candles: [], source: 'timeout' };
  }
}

// ── 主路由 ──────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const authDenied = checkCronAuth(req);
  if (authDenied) return authDenied;

  const market = req.nextUrl.searchParams.get('market') as MarketType | null;
  if (market !== 'TW' && market !== 'CN') {
    return apiError('market must be TW or CN', 400);
  }

  // staleDays 參數：延遲重試用 1（抓「下載到了但是昨天數據」的情況）
  const staleDaysParam = req.nextUrl.searchParams.get('staleDays');
  const staleDays = staleDaysParam ? parseInt(staleDaysParam, 10) : 3;

  const startTime = Date.now();
  const lastTradingDate = getLastTradingDay(market);

  // 讀取校驗報告
  const report = await loadVerifyReport(market, lastTradingDate);
  if (!report) {
    return apiOk({ market, message: '找不到校驗報告，無需重試', retried: 0 });
  }

  const scanner = market === 'CN' ? new ChinaScanner() : new TaiwanScanner();

  // ═══ Phase 1: 重試失敗 + 過期股票 ═══════════════════════════════════════
  const retrySet = new Set<string>(report.failedSymbols);
  for (const s of report.staleDetails) {
    // staleDays 參數控制：延遲重試時用 1，只抓落後 ≥1 天的
    if (s.daysBehind >= staleDays) {
      retrySet.add(s.symbol);
    }
  }

  const retryList = Array.from(retrySet).slice(0, MAX_RETRY);
  console.info(
    `[retry-failed] ${market} Phase 1: 重試 ${retryList.length} 檔` +
    `（失敗 ${report.failedSymbols.length}，過期 ${report.staleDetails.length}，staleDays≥${staleDays}）`
  );

  let phase1Succeeded = 0;
  let phase1Failed = 0;
  const phase1Sources: Record<string, number> = {};

  for (const symbol of retryList) {
    // 超時預算檢查
    if (Date.now() - startTime > TOTAL_BUDGET_MS * PHASE1_BUDGET_RATIO) {
      console.warn(`[retry-failed] Phase 1 超時預算用盡，已處理 ${phase1Succeeded + phase1Failed}/${retryList.length}`);
      break;
    }

    try {
      const { candles, source } = await fetchWithFallbackTimed(symbol, market, scanner);
      if (candles.length >= MIN_CANDLE_COUNT) {
        await saveLocalCandles(symbol, market, candles);
        phase1Succeeded++;
        phase1Sources[source] = (phase1Sources[source] || 0) + 1;
      } else {
        phase1Failed++;
      }
    } catch {
      phase1Failed++;
    }
    await sleep(DELAY_MS);
  }

  console.info(
    `[retry-failed] ${market} Phase 1 完成: ${phase1Succeeded} 成功, ${phase1Failed} 失敗` +
    ` | 來源: ${JSON.stringify(phase1Sources)}`
  );

  // ═══ Phase 2: Gap 自動修復 ═══════════════════════════════════════════════
  let phase2Succeeded = 0;
  let phase2Failed = 0;
  let phase2StillGap = 0;
  const phase2Sources: Record<string, number> = {};

  const gapSymbols = (report.gapDetails || [])
    .map(g => g.symbol)
    .filter(s => !retrySet.has(s)) // 排除 Phase 1 已處理的
    .slice(0, MAX_GAP_REPAIR);

  if (gapSymbols.length > 0 && Date.now() - startTime < TOTAL_BUDGET_MS * PHASE2_BUDGET_RATIO) {
    console.info(`[retry-failed] ${market} Phase 2: 修復 ${gapSymbols.length} 檔 gap 股票`);

    for (const symbol of gapSymbols) {
      // 超時預算檢查
      if (Date.now() - startTime > TOTAL_BUDGET_MS * PHASE2_BUDGET_RATIO) {
        console.warn(`[retry-failed] Phase 2 超時預算用盡，已處理 ${phase2Succeeded + phase2Failed + phase2StillGap}/${gapSymbols.length}`);
        break;
      }

      try {
        const { candles, source } = await fetchWithFallbackTimed(symbol, market, scanner);
        if (candles.length >= MIN_CANDLE_COUNT) {
          // 驗證 gap 是否消除
          const remainingGaps = detectCandleGaps(candles, 15, market);
          if (remainingGaps.length === 0) {
            await saveLocalCandles(symbol, market, candles);
            phase2Succeeded++;
            phase2Sources[source] = (phase2Sources[source] || 0) + 1;
          } else {
            // 有新數據但 gap 仍存在（資料源本身缺漏）
            await saveLocalCandles(symbol, market, candles);
            phase2StillGap++;
          }
        } else {
          phase2Failed++;
        }
      } catch {
        phase2Failed++;
      }
      await sleep(DELAY_MS);
    }

    console.info(
      `[retry-failed] ${market} Phase 2 完成: ${phase2Succeeded} 修復, ${phase2StillGap} 仍有gap, ${phase2Failed} 失敗` +
      ` | 來源: ${JSON.stringify(phase2Sources)}`
    );
  } else if (gapSymbols.length > 0) {
    console.warn(`[retry-failed] ${market} Phase 2 跳過（預算不足或無 gap 股票）`);
  }

  // Phase 3（全量 verifyDownload）已移除：
  // - CN 3150 支 / TW 2000 支全量 Blob 讀取需 100-160s，超過 120s maxDuration
  // - download-candles-batch 最後一批本來就會跑 verifyDownload，無需在此重複
  // - 回傳修復前的 health 作為參考基準即可

  const budgetUsedPct = Math.round((Date.now() - startTime) / TOTAL_BUDGET_MS * 100);

  return apiOk({
    market,
    staleDays,
    phase1: {
      retryList: retryList.length,
      succeeded: phase1Succeeded,
      failed: phase1Failed,
      sources: phase1Sources,
    },
    phase2: {
      gapList: gapSymbols.length,
      succeeded: phase2Succeeded,
      stillGap: phase2StillGap,
      failed: phase2Failed,
      sources: phase2Sources,
    },
    baseHealth: report.health, // 修復前的 health（新 health 由 download-candles-batch 最後一批更新）
    budgetUsedPct,
  });
}
