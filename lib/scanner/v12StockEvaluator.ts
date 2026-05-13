/**
 * v12 單檔股票一日評估（Phase 1.5 ScanPipeline 串接核心）
 *
 * 整合所有 v12 helpers/detectors 為單一入口，給既有 ScanPipeline 呼叫。
 *
 * 流程（v12 規格鎖定）：
 *
 *   Step 0：大盤過濾（議題 53）
 *     → 不過 → 全市場停止做多（caller 處理）
 *
 *   Step 1：六大判斷指標（議題 50/51/88 等）
 *     → coreScore ≥ 5 才入候選池
 *
 *   Step 2：訊號 dispatch（軌道分流）
 *     - 多頭軌（B/P/C/E/J/K/L/M）：過 Step 1 才評估
 *     - 轉折軌（D/F/N/O）：跳 Step 1 直接評估
 *     - 戰法軌（Q）：跳 Step 1 但仍過 Step 0
 *
 *   議題 47/55/99 pivot gate：B/P/C/L/M 加最近 pivot pair 檢查
 *   議題 84：F 不套「T 之後」邏輯
 *   議題 33/93：D/O 觸發即進場；F/N 走 LockWatch
 *
 * 不修既有 ScanPipeline.ts（向後相容），新功能由 caller 選用。
 */

import type { CandleWithIndicators } from '../../types';

import { detectTrend } from '../analysis/trendAnalysis';
import {
  detectV12J,
  detectV12K,
  detectV12L,
  detectV12M,
  detectV12N,
  detectV12O,
  detectV12P,
  detectV12Q,
  type V12Letter,
  type V12SignalResult,
} from '../analysis/v12Signals';
import { evaluateIndicatorV12, evaluateVolumeV12 } from '../analysis/v12Conditions';
import { evaluateMarketGate, type MarketGateResult } from './marketTrendGate';
import { REVERSAL_TRACK_LETTERS } from './buyMethodTracks';
import { detectTrendWithHistory } from '../analysis/detectTrendWithHistory';
import { checkPivotPairGate } from '../analysis/v12SignalGates';
import { detectEndPhase, detectSeasonLineResistance } from '../analysis/v12Conditions';
import type { MarketId } from './types';

// ── v12 評估結果 ─────────────────────────────────────────────────────────

export interface V12EvalInputs {
  /** 股票代號 */
  symbol: string;
  /** 股票名稱 */
  name: string;
  /** 市場 */
  market: MarketId;
  /** 個股 K 線（最新一日為當日）*/
  candles: CandleWithIndicators[];
  /** 大盤指數 K 線（議題 53 Step 0 用）*/
  indexCandles: CandleWithIndicators[];
  /** 評估時點 index（預設最後一根）*/
  index?: number;
  /** 啟用的訊號字母（預設全部）*/
  enabledLetters?: V12Letter[];
}

export interface V12EvalResult {
  symbol: string;
  name: string;
  market: MarketId;
  date: string;

  /** Step 0 大盤過濾結果 */
  marketGate: MarketGateResult;

  /** Step 1 六大條件 + score（已透過 v12 helpers 評估）*/
  step1: {
    /** 個股 trendState 跟 lastTrendUpDate */
    trendState: '多頭' | '空頭' | '盤整';
    lastTrendUpDate: string | null;
    /** 條件 ④ 量分等級（議題 88）*/
    volumeLevel?: 'normal' | 'climax';
    /** 條件 ⑥ 指標純書本 */
    indicatorPassed: boolean;
    kdDecliningWarning: boolean;
    /** 末升段 flag（議題 13）*/
    endPhaseFlag: boolean;
    /** 季線壓力警示（議題 27）*/
    seasonLineResistance: number | null;
  };

  /** Step 2 觸發的訊號（按字母）*/
  signals: V12SignalResult[];

  /** v12 schema version */
  schemaVersion: 'v12';
}

const ALL_LETTERS: V12Letter[] = [
  'B', 'C', 'D', 'E', 'F', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q',
];

const LONG_TREND_LETTERS = new Set<V12Letter>(['B', 'P', 'C', 'E', 'J', 'K', 'L', 'M']);
const REVERSAL_LETTERS = new Set<V12Letter>(REVERSAL_TRACK_LETTERS as readonly V12Letter[]);
const PIVOT_GATE_LETTERS = new Set<V12Letter>(['B', 'P', 'C', 'L', 'M']); // J/K 不套（自帶結構）

/**
 * v12 單檔股票評估
 *
 * 適用場景：盤中/盤後 cron 對每檔股票呼叫一次。
 *
 * 注意：本函數**不寫入 LockWatch / scan record**（caller 負責），
 * 只回傳評估結果。
 */
export function evaluateStockV12(inputs: V12EvalInputs): V12EvalResult {
  const { symbol, name, market, candles, indexCandles, enabledLetters } = inputs;
  const idx = inputs.index ?? candles.length - 1;
  const c = candles[idx];
  const date = c?.date ?? new Date().toISOString().split('T')[0];

  // ── Step 0：大盤過濾 ──
  const marketGate = evaluateMarketGate(indexCandles);

  // 個股 detectTrend 歷史
  const trendInfo = detectTrendWithHistory(candles, idx);

  // 條件 ⑤ 量分等級（議題 88）
  const prev = idx > 0 ? candles[idx - 1] : null;
  const volumeResult = evaluateVolumeV12(c, prev);

  // 條件 ⑥ 指標
  const indicatorResult = evaluateIndicatorV12(c, prev);

  // 末升段 flag（議題 13）
  const endPhaseResult = detectEndPhase(candles, idx);

  // 季線壓力警示（議題 27）
  const seasonLineResult = detectSeasonLineResistance(candles, idx);

  // ── Step 2：訊號 dispatch ──
  const targetLetters = enabledLetters ?? ALL_LETTERS;
  const signals: V12SignalResult[] = [];

  for (const letter of targetLetters) {
    // ── 軌道判定：不過 Step 0 → 多頭軌 + 戰法軌 全部不掃 ──
    const isLongTrend = LONG_TREND_LETTERS.has(letter);
    const isQ = letter === 'Q';
    const isReversal = REVERSAL_LETTERS.has(letter);

    // 多頭軌與戰法軌都需 Step 0 過
    if ((isLongTrend || isQ) && !marketGate.passed) {
      continue;
    }

    // 轉折軌（D/F/N/O）大盤翻空時 LockWatch 仍可累積（議題 71）
    // 但這裡只回觸發結果，LockWatch 寫入由 caller 決定

    // ── 議題 47/55/99 pivot gate（只對 B/P/C/L/M）──
    if (PIVOT_GATE_LETTERS.has(letter)) {
      const pivotGate = checkPivotPairGate(candles, idx);
      if (!pivotGate.passed) {
        continue;  // pivot 結構未成立 → 跳過
      }
    }

    // ── 多頭軌訊號需要個股是多頭 ──
    if (isLongTrend && trendInfo.state !== '多頭') {
      continue;
    }

    // ── dispatch 到對應 detector ──
    let result: V12SignalResult;
    switch (letter) {
      case 'J': result = detectV12J(candles, idx); break;
      case 'K': result = detectV12K(candles, idx); break;
      case 'L': result = detectV12L(candles, idx); break;
      case 'M': result = detectV12M(candles, idx, market, symbol); break;
      case 'N': result = detectV12N(candles, idx, market, symbol); break;
      case 'O': result = detectV12O(candles, idx, market, symbol); break;
      case 'P': result = detectV12P(candles, idx, market, symbol); break;
      case 'Q': result = detectV12Q(candles, idx, market, symbol); break;
      default:
        // B/C/D/E/F 仍走既有 v11 detector — 由 caller 處理（v11 detector 用 @/ alias）
        // 這裡跳過，等 caller 整合既有 v11 detector
        continue;
    }

    if (result.triggered) {
      signals.push(result);
    }
  }

  return {
    symbol,
    name,
    market,
    date,
    marketGate,
    step1: {
      trendState: trendInfo.state,
      lastTrendUpDate: trendInfo.lastTrendUpDate,
      volumeLevel: volumeResult.level,
      indicatorPassed: indicatorResult.passed,
      kdDecliningWarning: indicatorResult.kdDecliningWarning,
      endPhaseFlag: endPhaseResult.isEndPhase,
      seasonLineResistance: seasonLineResult.ma60Value,
    },
    signals,
    schemaVersion: 'v12',
  };
}

/**
 * 過濾出多頭軌觸發訊號（用於候選池）
 */
export function getLongTrendSignals(result: V12EvalResult): V12SignalResult[] {
  return result.signals.filter(s => s.track === 'long-trend');
}

/**
 * 過濾出轉折軌觸發訊號（用於 LockWatch 寫入）
 */
export function getReversalSignals(result: V12EvalResult): V12SignalResult[] {
  return result.signals.filter(s => s.track === 'reversal');
}

/**
 * 過濾出戰法軌觸發訊號（Q）
 */
export function getSystemSignals(result: V12EvalResult): V12SignalResult[] {
  return result.signals.filter(s => s.track === 'system');
}
