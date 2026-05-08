/**
 * v12 訊號統一介面（v12 Phase 1.4A 字母 mapping）
 *
 * 把既有 v11 detector（G/H/I）映射到 v12 字母系統（J/K/L），
 * 加 v12 metadata 標記 + 統一回傳結構。
 *
 * v11 → v12 字母對應：
 * - v11 G ABC 突破 → v12 J
 * - v11 H 過大量黑 K → v12 L
 * - v11 I K 線橫盤突破 → v12 K
 *
 * 既有 detector **不修**（向後相容）；本 module 純包裝。
 *
 * 書本依據：
 * - J ABC 突破：寶典 Part 11-1 第 6 位置 p.697
 * - K K 線橫盤：寶典 p.156-157「K 線橫盤原則」+ Part 11-1 第 5 位置 p.695
 * - L 過大量黑 K：寶典 Part 11-1 第 8 位置 p.698
 *
 * v12 議題：
 * - 議題 33 / 93：D/N/F/O 走 LockWatch 或觸發即進場（v12 J/K/L 屬多頭軌）
 * - 議題 47 / 73 / 79：J/K 自帶結構驗證，不套 pivot gate
 * - 議題 64 / 89：紅 K 已含漲停 + 跳空例外（既有 detector 已兼容書本）
 */

import type { CandleWithIndicators } from '../../types';

import { detectABCBreakout } from './abcBreakoutEntry';
import { detectBlackKBreakout } from './blackKBreakoutEntry';
import { detectKlineConsolidationBreakout } from './klineConsolidationBreakout';
import { detectLetterM } from './v12LetterM';
import { detectLetterN } from './v12LetterN';
import { detectLetterO } from './v12LetterO';
import { detectLetterP } from './v12LetterP';
import { detectLetterQ } from './v12LetterQ';

import type { MarketId } from '../scanner/types';

// ── v12 統一訊號回傳結構 ─────────────────────────────────────────────────

export type V12Letter =
  | 'A' // 六條件選股（基準）
  | 'B' // 回後買上漲（深回）
  | 'C' // 盤整突破
  | 'D' // 一字底
  | 'E' // 缺口續攻
  | 'F' // V 反轉
  | 'J' // ABC 突破（v11 G）
  | 'K' // K 線橫盤突破（v11 I）
  | 'L' // 過大量黑 K 高（v11 H）
  | 'M' // 突破軌道線（待實作）
  | 'N' // 型態確認（待實作）
  | 'O' // 打底完成（待實作）
  | 'P' // 高檔拉回（待實作）
  | 'Q'; // 三條均線戰法（獨立軌，待實作）

/** v12 訊號類別（議題 6 真突破分層）*/
export type V12SignalCategory =
  | 'pattern'    // 型態類（K/D/N/O）— 套 ×3% + 3 天 provisional
  | 'single-k'   // 單 K 類（B/C/J/L）— 不套 ×3%/provisional
  | 'gap'        // 缺口類（E）
  | 'reversal'   // 反轉類（F）
  | 'channel'    // 軌道類（M）
  | 'pullback'   // 拉回類（P）
  | 'system';    // 戰法軌（Q）

/** v12 軌道歸屬 */
export type V12Track =
  | 'long-trend'   // 多頭軌（過 Step 1 六條件）
  | 'reversal'     // 轉折軌（不過六條件，走 LockWatch）
  | 'system';      // 戰法軌（Q 獨立 SOP，跳 Step 1 但仍過 Step 0）

export interface V12SignalResult {
  /** 是否觸發 */
  triggered: boolean;
  /** v12 字母 */
  letter: V12Letter;
  /** 訊號類別 */
  category: V12SignalCategory;
  /** 軌道歸屬 */
  track: V12Track;
  /** 觸發日鎖定的突破點（用於 provisional 撤銷判定）*/
  triggerPrice?: number;
  /** 紅 K 實體百分比 */
  bodyPct?: number;
  /** 量比 vs 前日 */
  volumeRatio?: number;
  /** UI 顯示文字 */
  detail: string;
  /** schemaVersion 永遠 v12 */
  schemaVersion: 'v12';
  /** 訊號適用條件補充說明 */
  meta?: Record<string, unknown>;
}

// ── J ABC 突破（包裝 detectABCBreakout，v11 G）─────────────────────────────

/**
 * v12 J 訊號：ABC 突破
 *
 * 書本依據：寶典 Part 11-1 第 6 位置 p.697
 *   「多頭一波後 ABC 修正再攻」
 *
 * 訊號要件已含 4 個 pivot（前波高/A 底/B 反彈高/C 底），自帶結構驗證。
 * 議題 73：J 不套議題 47 pivot gate（自帶）。
 */
export function detectV12J(
  candles: CandleWithIndicators[],
  idx: number,
): V12SignalResult {
  const result = detectABCBreakout(candles, idx);

  if (!result) {
    return {
      triggered: false,
      letter: 'J',
      category: 'single-k',
      track: 'long-trend',
      detail: 'J ABC 突破未觸發',
      schemaVersion: 'v12',
    };
  }

  return {
    triggered: true,
    letter: 'J',
    category: 'single-k',
    track: 'long-trend',
    triggerPrice: result.trendlineValue,
    bodyPct: result.bodyPct,
    volumeRatio: result.volumeRatio,
    detail: `J ABC 突破：${result.detail}`,
    schemaVersion: 'v12',
    meta: {
      legAHigh: result.legAHigh,
      legALow: result.legALow,
      legBHigh: result.legBHigh,
      legCLow: result.legCLow,
      preEntryDays: result.preEntryDays,
    },
  };
}

// ── K K 線橫盤突破（包裝 detectKlineConsolidationBreakout，v11 I）─────────

/**
 * v12 K 訊號：K 線橫盤突破
 *
 * 書本依據：寶典 p.156-157「K 線橫盤原則」+ Part 11-1 第 5 位置 p.695
 *   「橫向 K 線超過 3 根以上 + 中長紅 K 收盤突破橫盤上頸線」
 *
 * 訊號要件已含「≥ 3 根橫盤 K 沒突破前 K 高/低」，自帶結構驗證。
 * 議題 79：K 不套 pivot gate（自帶）。
 *
 * 議題 6：K 是型態類，套 ×3% 真突破 + 3 天 provisional。
 */
export function detectV12K(
  candles: CandleWithIndicators[],
  idx: number,
): V12SignalResult {
  const result = detectKlineConsolidationBreakout(candles, idx);

  if (!result) {
    return {
      triggered: false,
      letter: 'K',
      category: 'pattern',
      track: 'long-trend',
      detail: 'K K 線橫盤突破未觸發',
      schemaVersion: 'v12',
    };
  }

  return {
    triggered: true,
    letter: 'K',
    category: 'pattern',
    track: 'long-trend',
    triggerPrice: result.rangeHigh,
    bodyPct: result.bodyPct,
    volumeRatio: result.volumeRatio,
    detail: `K K 線橫盤突破：${result.detail}`,
    schemaVersion: 'v12',
    meta: {
      anchorDate: result.anchorDate,
      anchorHigh: result.anchorHigh,
      anchorLow: result.anchorLow,
      anchorBodyPct: result.anchorBodyPct,
      consolidationDays: result.consolidationDays,
      rangeHigh: result.rangeHigh,
      rangeLow: result.rangeLow,
      rangeWidthPct: result.rangeWidthPct,
    },
  };
}

// ── L 過大量黑 K 高（包裝 detectBlackKBreakout，v11 H）────────────────────

/**
 * v12 L 訊號：過大量黑 K 高
 *
 * 書本依據：寶典 Part 11-1 第 8 位置 p.698
 *   「多頭一波後大量黑 K 跌破前低/MA5，3 日內紅 K 突破黑 K 最高」
 *
 * 議題 47：L 加 pivot gate（最近 1 pivot high + 1 pivot low）。
 * 議題 77：L 的「大量黑 K」識別已含跌停例外（既有 detector 兼容）。
 */
export function detectV12L(
  candles: CandleWithIndicators[],
  idx: number,
): V12SignalResult {
  const result = detectBlackKBreakout(candles, idx);

  if (!result) {
    return {
      triggered: false,
      letter: 'L',
      category: 'single-k',
      track: 'long-trend',
      detail: 'L 過大量黑 K 高未觸發',
      schemaVersion: 'v12',
    };
  }

  return {
    triggered: true,
    letter: 'L',
    category: 'single-k',
    track: 'long-trend',
    triggerPrice: result.blackKHigh,
    bodyPct: result.bodyPct,
    volumeRatio: result.volumeRatio,
    detail: `L 過大量黑 K 高：${result.detail}`,
    schemaVersion: 'v12',
    meta: {
      blackKHigh: result.blackKHigh,
      blackKVolumeRatio: result.blackKVolumeRatio,
      daysSinceBlackK: result.daysSinceBlackK,
    },
  };
}

// ── 統一入口：依字母 dispatch ─────────────────────────────────────────────

// ── 字母 P 高檔拉回（v12 Phase 1.4B 新建）─────────────────────────────────

export function detectV12P(
  candles: CandleWithIndicators[],
  idx: number,
  market: MarketId = 'TW',
  symbol = '',
): V12SignalResult {
  const result = detectLetterP(candles, idx, market, symbol);

  if (!result.triggered) {
    return {
      triggered: false,
      letter: 'P',
      category: 'pullback',
      track: 'long-trend',
      detail: result.detail,
      schemaVersion: 'v12',
    };
  }

  return {
    triggered: true,
    letter: 'P',
    category: 'pullback',
    track: 'long-trend',
    triggerPrice: result.triggerPrice,
    bodyPct: result.bodyPct,
    volumeRatio: result.volumeRatio,
    detail: result.detail,
    schemaVersion: 'v12',
    meta: {
      pullbackDays: result.pullbackDays,
      prevSwingHigh: result.prevSwingHigh,
    },
  };
}

// ── 字母 M 突破軌道線（v12 Phase 1.4B 新建）───────────────────────────────

export function detectV12M(
  candles: CandleWithIndicators[],
  idx: number,
  market: MarketId = 'TW',
  symbol = '',
): V12SignalResult {
  const result = detectLetterM(candles, idx, market, symbol);

  if (!result.triggered) {
    return {
      triggered: false,
      letter: 'M',
      category: 'channel',
      track: 'long-trend',
      detail: result.detail,
      schemaVersion: 'v12',
    };
  }

  return {
    triggered: true,
    letter: 'M',
    category: 'channel',
    track: 'long-trend',
    triggerPrice: result.channelValue,
    bodyPct: result.bodyPct,
    volumeRatio: result.volumeRatio,
    detail: result.detail,
    schemaVersion: 'v12',
    meta: {
      channelValue: result.channelValue,
      breakoutThreshold: result.breakoutThreshold,
      supportLow1: result.supportLow1Price,
      supportLow2: result.supportLow2Price,
      channelAnchor: result.channelAnchorPrice,
    },
  };
}

// ── 字母 O 打底完成（v12 Phase 1.4B 新建）─────────────────────────────────

export function detectV12O(
  candles: CandleWithIndicators[],
  idx: number,
  market: MarketId = 'TW',
  symbol = '',
): V12SignalResult {
  const result = detectLetterO(candles, idx, market, symbol);

  if (!result.triggered) {
    return {
      triggered: false,
      letter: 'O',
      category: 'pattern',
      track: 'reversal',
      detail: result.detail,
      schemaVersion: 'v12',
    };
  }

  return {
    triggered: true,
    letter: 'O',
    category: 'pattern',
    track: 'reversal',
    triggerPrice: result.triggerPrice,
    bodyPct: result.bodyPct,
    volumeRatio: result.volumeRatio,
    detail: result.detail,
    schemaVersion: 'v12',
    meta: {
      breakoutThreshold: result.breakoutThreshold,
      baseLow: result.baseLow,
      baseRangeLow: result.baseRangeLow,
      hadHighVolume: result.hadHighVolume,
      aboveMA60: result.aboveMA60,  // 加分項：站上季線可長多
    },
  };
}

// ── 字母 N 型態確認（v12 Phase 1.4B 新建）─────────────────────────────────

export function detectV12N(
  candles: CandleWithIndicators[],
  idx: number,
  market: MarketId = 'TW',
  symbol = '',
): V12SignalResult {
  const result = detectLetterN(candles, idx, market, symbol);

  if (!result.triggered) {
    return {
      triggered: false,
      letter: 'N',
      category: 'pattern',
      track: 'reversal',
      detail: result.detail,
      schemaVersion: 'v12',
    };
  }

  return {
    triggered: true,
    letter: 'N',
    category: 'pattern',
    track: 'reversal',
    triggerPrice: result.necklinePrice,
    bodyPct: result.bodyPct,
    volumeRatio: result.volumeRatio,
    detail: result.detail,
    schemaVersion: 'v12',
    meta: {
      patternType: result.patternType,
      achievementRate: result.achievementRate,
      necklinePrice: result.necklinePrice,
      breakoutThreshold: result.breakoutThreshold,
      patternTargetPrice: result.patternTargetPrice,
      structureBrokenPrice: result.structureBrokenPrice,
    },
  };
}

// ── 字母 Q 三條均線戰法（v12 Phase 1.4B 新建，獨立軌）────────────────────

export function detectV12Q(
  candles: CandleWithIndicators[],
  idx: number,
  market: MarketId = 'TW',
  symbol = '',
): V12SignalResult {
  const result = detectLetterQ(candles, idx, market, symbol);

  if (!result.triggered) {
    return {
      triggered: false,
      letter: 'Q',
      category: 'system',
      track: 'system',
      detail: result.detail,
      schemaVersion: 'v12',
    };
  }

  return {
    triggered: true,
    letter: 'Q',
    category: 'system',
    track: 'system',
    bodyPct: result.bodyPct,
    detail: result.detail,
    schemaVersion: 'v12',
    meta: {
      stopLossMA: result.stopLossMA,
      ma3: result.ma3,
      ma10: result.ma10,
      ma24: result.ma24,
      goldenCrossToday: result.goldenCrossToday,
      ma24Up: result.ma24Up,
    },
  };
}

// ── 統一入口 ─────────────────────────────────────────────────────────────

/**
 * 統一入口：依 v12 字母呼叫對應 detector
 *
 * Phase 1.4A：J/K/L（包裝既有）
 * Phase 1.4B：M/N/O/P/Q（新建）
 *
 * 尚未實作：A/B/C/D/E/F（既有 v11 detector，後續 Phase 1.5 串接時統一處理）
 */
export function detectV12Signal(
  letter: V12Letter,
  candles: CandleWithIndicators[],
  idx: number,
  market: MarketId = 'TW',
  symbol = '',
): V12SignalResult {
  switch (letter) {
    case 'J': return detectV12J(candles, idx);
    case 'K': return detectV12K(candles, idx);
    case 'L': return detectV12L(candles, idx);
    case 'M': return detectV12M(candles, idx, market, symbol);
    case 'N': return detectV12N(candles, idx, market, symbol);
    case 'O': return detectV12O(candles, idx, market, symbol);
    case 'P': return detectV12P(candles, idx, market, symbol);
    case 'Q': return detectV12Q(candles, idx, market, symbol);
    default:
      return {
        triggered: false,
        letter,
        category: 'single-k',
        track: 'long-trend',
        detail: `${letter} 訊號將於 Phase 1.5 ScanPipeline 串接時整合既有 v11 detector`,
        schemaVersion: 'v12',
      };
  }
}
