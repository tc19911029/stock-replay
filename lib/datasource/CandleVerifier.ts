/**
 * CandleVerifier — 核心比較引擎
 *
 * 純函式，無 I/O。將本地 K 線與參照來源逐日比對，
 * 回傳缺失日期、多餘日期、價格/成交量不一致等問題。
 */

import type { Candle } from '@/types';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ComparisonConfig {
  market: 'TW' | 'CN';
  /** 價格相對容差（預設 0.01 = 1%） */
  priceTolerancePct: number;
  /** 價格絕對容差（預設 0.05） */
  priceToleranceAbs: number;
  /** 成交量相對容差（TW 預設 0.15, CN 預設 0.10） */
  volumeTolerancePct: number;
  /** 驗證日期範圍 */
  dateRangeStart: string;
  dateRangeEnd: string;
}

export interface PriceMismatch {
  date: string;
  field: 'open' | 'high' | 'low' | 'close';
  local: number;
  reference: number;
  diffPct: number;
}

export interface VolumeMismatch {
  date: string;
  /** 本地原始值（TW=lots, CN=shares） */
  localRaw: number;
  /** 轉換成 shares 後的值 */
  localShares: number;
  /** 參照來源的 shares */
  reference: number;
  diffPct: number;
}

export interface ComparisonResult {
  symbol: string;
  /** 本地有但參照沒有的日期 */
  extraDates: string[];
  /** 參照有但本地沒有的日期 */
  missingDates: string[];
  priceMismatches: PriceMismatch[];
  volumeMismatches: VolumeMismatch[];
  /** 偵測到的分割/除權調整（已從 mismatch 中排除） */
  splitAdjustments: Array<{ date: string; ratio: number }>;
  /** 問題嚴重度 */
  severity: 'clean' | 'low' | 'medium' | 'high';
}

export interface VerificationReport {
  market: 'TW' | 'CN';
  dateRange: { from: string; to: string };
  generatedAt: string;
  summary: {
    totalStocks: number;
    stocksChecked: number;
    stocksWithIssues: number;
    stocksClean: number;
    stocksFailed: number;
    totalMissingDates: number;
    totalExtraDates: number;
    totalPriceMismatches: number;
    totalVolumeMismatches: number;
  };
  issues: ComparisonResult[];
  failures: Array<{ symbol: string; error: string }>;
}

// ── Default configs ──────────────────────────────────────────────────────────

export function defaultConfig(market: 'TW' | 'CN'): ComparisonConfig {
  return {
    market,
    priceTolerancePct: 0.01,
    priceToleranceAbs: 0.05,
    volumeTolerancePct: market === 'TW' ? 0.15 : 0.10,
    dateRangeStart: '2024-04-13',
    dateRangeEnd: '2026-04-13',
  };
}

// ── Core comparison ──────────────────────────────────────────────────────────

/**
 * 偵測分割/除權息調整：如果某日期所有 OHLC 的 local/ref 比率一致，
 * 表示參照來源（Yahoo）套用了調整，不算真正的 mismatch。
 *
 * Yahoo 的 "raw" OHLC 實際上是 split+dividend adjusted。
 * 常見比率：大的如 2, 4（分割）、小的如 1.02, 1.05（除息）。
 */
function detectAdjustmentRatio(local: Candle, ref: Candle): number | null {
  if (ref.close <= 0 || local.close <= 0) return null;
  if (ref.open <= 0 || local.open <= 0) return null;

  const ratioClose = local.close / ref.close;
  const ratioOpen = local.open / ref.open;
  const ratioHigh = local.high / ref.high;
  const ratioLow = local.low / ref.low;

  // 所有 4 個比率必須一致（容差 2%）
  const avg = (ratioClose + ratioOpen + ratioHigh + ratioLow) / 4;
  const allConsistent = [ratioClose, ratioOpen, ratioHigh, ratioLow].every(
    r => Math.abs(r - avg) / avg < 0.02,
  );

  if (!allConsistent) return null;

  // 比率必須偏離 1.0（超出正常容差 1%），才算調整
  if (Math.abs(avg - 1.0) < 0.01) return null;

  return +avg.toFixed(6);
}

/**
 * 比較本地 K 線與參照來源的 K 線，回傳差異。
 *
 * Yahoo Finance 會對歷史資料套用分割調整（split-adjusted），
 * 本函式會自動偵測並排除分割調整造成的假 mismatch。
 *
 * @param symbol 股票代碼
 * @param local 本地 K 線陣列
 * @param reference 參照來源 K 線陣列（成交量皆為 shares）
 * @param config 比較設定
 */
export function compareCandles(
  symbol: string,
  local: Candle[],
  reference: Candle[],
  config: ComparisonConfig,
): ComparisonResult {
  const { market, priceTolerancePct, priceToleranceAbs, volumeTolerancePct, dateRangeStart, dateRangeEnd } = config;

  // 篩選日期範圍
  const localInRange = local.filter(c => c.date >= dateRangeStart && c.date <= dateRangeEnd);
  const refInRange = reference.filter(c => c.date >= dateRangeStart && c.date <= dateRangeEnd);

  // 建立日期索引
  const localMap = new Map<string, Candle>();
  for (const c of localInRange) localMap.set(c.date, c);

  const refMap = new Map<string, Candle>();
  for (const c of refInRange) refMap.set(c.date, c);

  // 缺失與多餘日期
  const missingDates: string[] = [];
  const extraDates: string[] = [];

  for (const date of refMap.keys()) {
    if (!localMap.has(date)) missingDates.push(date);
  }
  for (const date of localMap.keys()) {
    if (!refMap.has(date)) extraDates.push(date);
  }

  missingDates.sort();
  extraDates.sort();

  // ── Phase 1: 偵測分割調整 ──
  // 先掃描所有共有日期，找出一致的分割比率
  const splitAdjustments: Array<{ date: string; ratio: number }> = [];
  const splitDates = new Set<string>();

  // 收集所有日期的 ratio
  const ratioMap = new Map<string, number>();
  for (const [date, localCandle] of localMap) {
    const refCandle = refMap.get(date);
    if (!refCandle) continue;
    const ratio = detectAdjustmentRatio(localCandle, refCandle);
    if (ratio !== null) ratioMap.set(date, ratio);
  }

  // 按 ratio 值分群（容差 3%）確認為調整
  if (ratioMap.size > 0) {
    const ratioClusters = new Map<number, string[]>();
    for (const [date, ratio] of ratioMap) {
      let foundCluster = false;
      for (const [clusterRatio, dates] of ratioClusters) {
        if (Math.abs(ratio - clusterRatio) / Math.abs(clusterRatio) < 0.03) {
          dates.push(date);
          foundCluster = true;
          break;
        }
      }
      if (!foundCluster) ratioClusters.set(ratio, [date]);
    }

    // ≥3 天有相同 ratio 才算調整（排除偶發巧合）
    for (const [ratio, dates] of ratioClusters) {
      if (dates.length >= 3) {
        for (const date of dates) {
          splitAdjustments.push({ date, ratio });
          splitDates.add(date);
        }
      }
    }
  }

  // ── Phase 2: 逐日比對 OHLCV（排除分割調整日期）──
  const priceMismatches: PriceMismatch[] = [];
  const volumeMismatches: VolumeMismatch[] = [];

  for (const [date, localCandle] of localMap) {
    const refCandle = refMap.get(date);
    if (!refCandle) continue;

    // 跳過已確認的分割調整日期
    if (splitDates.has(date)) continue;

    // 價格比對
    for (const field of ['open', 'high', 'low', 'close'] as const) {
      const lv = localCandle[field];
      const rv = refCandle[field];
      const absDiff = Math.abs(lv - rv);
      const pctDiff = rv !== 0 ? absDiff / Math.abs(rv) : (lv !== 0 ? 1 : 0);

      if (absDiff > priceToleranceAbs && pctDiff > priceTolerancePct) {
        priceMismatches.push({
          date,
          field,
          local: lv,
          reference: rv,
          diffPct: +(pctDiff * 100).toFixed(2),
        });
      }
    }

    // 成交量比對（TW: lots→shares 轉換）
    const localShares = market === 'TW' ? localCandle.volume * 1000 : localCandle.volume;
    const refShares = refCandle.volume;

    if (refShares > 0) {
      const volDiffPct = Math.abs(localShares - refShares) / refShares;
      if (volDiffPct > volumeTolerancePct && Math.abs(localShares - refShares) > 1000) {
        volumeMismatches.push({
          date,
          localRaw: localCandle.volume,
          localShares,
          reference: refShares,
          diffPct: +(volDiffPct * 100).toFixed(2),
        });
      }
    }
  }

  // 判斷嚴重度
  const severity = classifySeverity(missingDates.length, extraDates.length, priceMismatches.length, volumeMismatches.length);

  return { symbol, extraDates, missingDates, priceMismatches, volumeMismatches, splitAdjustments, severity };
}

function classifySeverity(
  missing: number,
  extra: number,
  priceM: number,
  volumeM: number,
): 'clean' | 'low' | 'medium' | 'high' {
  if (missing === 0 && extra === 0 && priceM === 0 && volumeM === 0) return 'clean';
  if (missing > 10 || priceM > 20) return 'high';
  if (missing > 3 || priceM > 5) return 'medium';
  return 'low';
}
