/**
 * Step 0 大盤過濾 — 進場做多的最高前提（v12 Phase 1.1）
 *
 * 書本依據：寶典 p.687 章 10-5「股市交易工作重點 — 進場做多的前提」⭐
 *
 *   「1. 大盤站上月線多頭，股價在月線之上，月線上揚。」
 *
 * v12 議題對應：
 * - 議題 53：補入 Step 0 大盤過濾（書本明寫但 v11 沒做）
 * - 議題 63：「月線」= MA20 日線（不是月 K MA1，bug 修正）
 * - 議題 97：「上揚」用 MA pivot 判斷（不是 today ≥ yesterday）
 * - 議題 66/99：大盤需有「最近 1 pivot high + 1 pivot low」結構
 * - 議題 68：TW 用 ^TWII / CN 用 000001.SS
 * - 議題 69：抖動 UI banner 顯示
 * - 議題 71：F V 反轉 LockWatch 升級進場需此 gate 過
 *
 * Step 0.1 不過 → 全市場停止做多（個股六條件根本不評估）。
 * Step 0.2/0.3（類股/龍頭/題材）暫不實作（Phase 2 補入）。
 */

import type { CandleWithIndicators } from '@/types';

import { detectTrendWithHistory, hasRecentPivotPair } from '../analysis/detectTrendWithHistory';
import { isMAUp } from '../analysis/maPivot';
import type { MarketId } from './types';

// ── 大盤指數對應（議題 68）─────────────────────────────────────────────────

/**
 * 各市場的大盤指數代碼
 *
 * 書本依據：記憶 0424「大盤指數改用加權/上證」+ 議題 68
 */
export const MARKET_INDEX_SYMBOL: Record<MarketId, string> = {
  TW: '^TWII',         // 台灣加權指數
  CN: '000001.SS',     // 上證指數
};

// ── Step 0.1 大盤多頭過濾 ─────────────────────────────────────────────────

export interface MarketGateResult {
  /** 是否過 Step 0.1 大盤過濾（pass = 全市場可做多）*/
  passed: boolean;

  /** 大盤當前趨勢狀態 */
  trendState: '多頭' | '空頭' | '盤整';

  /** 大盤翻多事件日（議題 21 多頭軌訊號觀察期用）*/
  marketTrendUpDate: string | null;

  /** 詳細不過原因（passed=false 時填）*/
  blockReason?:
    | 'data-insufficient'      // 大盤資料不足（< 20 根 K）
    | 'trend-not-bullish'      // detectTrend ≠ 多頭
    | 'price-below-ma20'       // close < MA20（不在月線上）
    | 'ma20-not-rising'        // MA20 沒上揚（pivot 判斷）
    | 'pivot-pair-missing';    // 大盤缺最近 pivot pair（剛翻多 < 10-15 天）

  /** 用於 UI banner（議題 69）*/
  bannerText: string;

  /** 大盤 close ≥ MA20 嗎（議題 63）*/
  isAboveMA20: boolean;

  /** MA20 上揚嗎（議題 97 pivot 判斷）*/
  isMA20Up: boolean;

  /** 大盤是否已有最近 pivot pair（議題 66/99）*/
  hasPivotPair: boolean;
}

/**
 * Step 0.1 大盤過濾判定
 *
 * 全市場掃描前先呼叫此函數，false → 不掃個股（停止做多）。
 *
 * @param indexCandles 大盤指數 K 線（含 indicators，至少需 ma20）
 * @returns 過濾結果
 */
export function evaluateMarketGate(
  indexCandles: ReadonlyArray<CandleWithIndicators>,
): MarketGateResult {
  const empty: MarketGateResult = {
    passed: false,
    trendState: '盤整',
    marketTrendUpDate: null,
    blockReason: 'data-insufficient',
    bannerText: '⚠️ 大盤資料不足，停止做多',
    isAboveMA20: false,
    isMA20Up: false,
    hasPivotPair: false,
  };

  if (indexCandles.length < 20) return empty;

  const lastIdx = indexCandles.length - 1;
  const last = indexCandles[lastIdx];
  if (!last || last.ma20 == null) return empty;

  // ── 1. detectTrend = 多頭 ──────────────────────────────────────────
  const trendInfo = detectTrendWithHistory(indexCandles, lastIdx);

  if (trendInfo.state !== '多頭') {
    return {
      passed: false,
      trendState: trendInfo.state,
      marketTrendUpDate: trendInfo.lastTrendUpDate,
      blockReason: 'trend-not-bullish',
      bannerText: trendInfo.state === '空頭'
        ? '📉 大盤空頭，全市場停止做多'
        : '↔️ 大盤盤整，等待方向確認',
      isAboveMA20: last.close >= last.ma20,
      isMA20Up: false,
      hasPivotPair: false,
    };
  }

  // ── 2. close ≥ MA20 日線（議題 63 修正：月線 = MA20 日線，不是月 K MA1）──
  const isAboveMA20 = last.close >= last.ma20;
  if (!isAboveMA20) {
    return {
      passed: false,
      trendState: trendInfo.state,
      marketTrendUpDate: trendInfo.lastTrendUpDate,
      blockReason: 'price-below-ma20',
      bannerText: '⚠️ 大盤雖多頭但 close < MA20，等回站上',
      isAboveMA20: false,
      isMA20Up: false,
      hasPivotPair: false,
    };
  }

  // ── 3. MA20 上揚（議題 97 pivot 判斷，非 today ≥ yesterday）──
  const ma20Series = indexCandles
    .slice(Math.max(0, lastIdx - 60), lastIdx + 1)
    .map(c => c.ma20)
    .filter((v): v is number => v != null);

  const isMA20Up_ = isMAUp(ma20Series, 3);
  if (!isMA20Up_) {
    return {
      passed: false,
      trendState: trendInfo.state,
      marketTrendUpDate: trendInfo.lastTrendUpDate,
      blockReason: 'ma20-not-rising',
      bannerText: '⚠️ 大盤 MA20 沒持續上揚，等趨勢確認',
      isAboveMA20: true,
      isMA20Up: false,
      hasPivotPair: false,
    };
  }

  // ── 4. 大盤 pivot gate（議題 66/99：最近 pivot pair 已成立）──
  const hasPivot = hasRecentPivotPair(indexCandles, lastIdx);
  if (!hasPivot) {
    return {
      passed: false,
      trendState: trendInfo.state,
      marketTrendUpDate: trendInfo.lastTrendUpDate,
      blockReason: 'pivot-pair-missing',
      bannerText: '⏳ 等待大盤多頭結構建立（pivot 形成中）',
      isAboveMA20: true,
      isMA20Up: true,
      hasPivotPair: false,
    };
  }

  // ── 全部過 ───────────────────────────────────────────────────────
  return {
    passed: true,
    trendState: '多頭',
    marketTrendUpDate: trendInfo.lastTrendUpDate,
    bannerText: '📈 大盤多頭結構成立，可做多',
    isAboveMA20: true,
    isMA20Up: true,
    hasPivotPair: true,
  };
}
