/**
 * v12 Step 3 停損實作（v12 Phase 1.8）
 *
 * 議題 S3-1（架構修正）：每訊號對應單一主停損方法（不取 max），
 *   避免進場日就觸發停損。書本 5 法本意是「擇一」不是「並用取最高」。
 *
 * 議題 S3-7：④ 10% 上限與 ⑥-4 合併為「10% 絕對下限」（SL ≥ entryPrice × 0.90）
 * 議題 S3-2：收盤跌破才停損（盤中 UI 警示但不強制）
 * 議題 S3-3：末升段切 trailing stop（recentHigh × 0.97）
 * 議題 S3-4：跳空缺口下殺立即市價出場
 *
 * 字母訊號 → 主停損方法對應（v12 規格鎖定）：
 * - B / P：① K 線戰法（紅 K low + 三段式）
 * - C：⑤ 盤整下緣
 * - E：⑤ 缺口下緣
 * - J：② pivot low（C 段底）
 * - K：⑤ 橫盤下緣
 * - L：① 黑 K low（突破日的黑 K）
 * - M：② pivot low（軌道下緣）
 * - D：⑤ 糾結期下緣
 * - F：② V 底 + 7% 上限
 * - N：⑤ 型態頸線
 * - O：⑤ 打底盤整下緣
 * - Q：MA10（戰法軌獨立 SOP）
 *
 * 共用：
 * - ④ 10% 絕對下限（議題 S3-7）
 * - ③ 移動停損（隨對應均線上揚取代主停損）
 * - ⑥ 5 條絕對停損（強制觸發）
 */

import type { CandleWithIndicators } from '../../types';

import type { V12Letter } from '../analysis/v12Signals';

// ── 字母 → 主停損方法 / 對應均線（議題 S3-1 + Step 3 ③）──────────────────

/** 主停損方法類型 */
export type PrimaryStopLossMethod =
  | 'red-k-low'        // ① 進場紅 K low（B/P/L）
  | 'pivot-low'        // ② pivot low（J/M/F）
  | 'support-level'    // ⑤ 結構支撐（C/E/K/D/N/O）
  | 'ma10';            // Q 戰法獨立

/** v12 訊號對應的主停損方法 */
export const SIGNAL_TO_PRIMARY_STOP: Record<V12Letter, PrimaryStopLossMethod> = {
  A: 'red-k-low',     // 六條件預選池本身不單獨進場，沿用 B
  B: 'red-k-low',
  P: 'red-k-low',
  C: 'support-level',
  E: 'support-level',
  J: 'pivot-low',
  K: 'support-level',
  L: 'red-k-low',     // L 用「黑 K low」(突破日的黑 K)
  M: 'pivot-low',
  D: 'support-level',
  F: 'pivot-low',     // F V 底
  N: 'support-level', // N 型態頸線
  O: 'support-level', // O 打底盤整下緣
  Q: 'ma10',          // Q 戰法獨立
};

/** v12 訊號對應的跟隨均線（Step 3 ③ + Step 4 ②/③）*/
export const SIGNAL_TO_TRAILING_MA: Record<V12Letter, 'MA5' | 'MA10' | 'MA20' | 'MA3' | null> = {
  A: 'MA5',           // 六條件用短線 MA5
  B: 'MA5',
  P: 'MA5',
  C: 'MA10',
  E: 'MA10',
  J: 'MA20',
  K: 'MA10',
  L: 'MA10',
  M: 'MA10',
  D: 'MA20',
  F: 'MA3',           // F V 反轉戰法明寫 3 日均線
  N: 'MA10',
  O: 'MA20',
  Q: 'MA10',          // Q 戰法停損點
};

/** v12 訊號對應的固定停損比例（議題 S3-7）*/
export const SIGNAL_TO_FIXED_STOP_PCT: Record<V12Letter, number> = {
  A: 0.05,            // 多頭軌 5%
  B: 0.05,
  P: 0.05,
  C: 0.05,
  E: 0.05,
  J: 0.05,
  K: 0.05,
  L: 0.05,
  M: 0.05,
  D: 0.10,            // 轉折軌 10%
  F: 0.07,            // F V 反轉戰法明寫上限 7%
  N: 0.10,
  O: 0.10,
  Q: 0.10,            // 戰法軌
};

// ── 三段式 K 線停損（① + Step 3 ① 細則）─────────────────────────────────

/**
 * 議題 S3-1：① K 線戰法三段式停損
 *
 * 進場紅 K 漲幅：
 * - 2% ~ 2.5%：紅 K 最低 - 2 ticks（放寬 2 碼）
 * - 2.5% ~ 5%：紅 K 最低（含下影線）
 * - ≥ 5%：紅 K 1/2 位置
 */
export function calcKLineStopLoss(
  entryKbar: { open: number; close: number; low: number; high: number },
  tickSize: number,
): number {
  const bodyPct = ((entryKbar.close - entryKbar.open) / entryKbar.open) * 100;
  const half = (entryKbar.open + entryKbar.close) / 2;

  if (bodyPct < 2.5) {
    // 弱紅 K：放寬 2 ticks
    return entryKbar.low - tickSize * 2;
  }
  if (bodyPct < 5) {
    // 中紅 K：守紅 K 最低
    return entryKbar.low;
  }
  // 強紅 K（≥ 5%）：守 1/2 位置
  return half;
}

// ── 主停損計算（議題 S3-1 單一主方法）────────────────────────────────────

export interface StopLossInputs {
  letter: V12Letter;
  entryPrice: number;
  entryKbar: { open: number; close: number; low: number; high: number };
  tickSize: number;
  /** 主停損方法所需資料（依方法不同）*/
  pivotLow?: number;        // J/M/F 用
  supportLevel?: number;    // C/K/D/N/O/E 用
  triggerKLow?: number;     // L 用：大量黑 K 那根的 low
  /** 議題 13 末升段 flag */
  isEndPhase?: boolean;
  /** 議題 S3-3 trailing stop 用：持倉中觀察到的最高 close */
  recentHigh?: number;
}

export interface StopLossResult {
  /** 實際停損點（已套絕對下限保護）*/
  stopLossPrice: number;
  /** 主停損方法 */
  primaryMethod: PrimaryStopLossMethod;
  /** 主停損點（未套絕對下限保護的原值）*/
  primarySL: number;
  /** 10% 絕對下限 */
  absoluteFloor: number;
  /** 是否觸發末升段 trailing */
  trailingActivated: boolean;
  /** 詳細描述 */
  detail: string;
}

/**
 * 計算進場日初始停損 SL_initial
 *
 * 議題 S3-1：每訊號用單一主方法（不取 max）
 * 議題 S3-7：套 10% 絕對下限保護
 */
export function calculateInitialStopLoss(inputs: StopLossInputs): StopLossResult {
  const { letter, entryPrice, entryKbar, tickSize } = inputs;
  const method = SIGNAL_TO_PRIMARY_STOP[letter];
  const fixedPct = SIGNAL_TO_FIXED_STOP_PCT[letter];
  const absoluteFloor = entryPrice * (1 - 0.10);  // 10% 絕對下限

  let primarySL = 0;
  let detail = '';

  switch (method) {
    case 'red-k-low':
      // ① K 線戰法（B/P/A）或 黑 K low（L）
      if (letter === 'L' && inputs.triggerKLow != null) {
        primarySL = inputs.triggerKLow;
        detail = `L 黑 K low: ${primarySL.toFixed(2)}`;
      } else {
        primarySL = calcKLineStopLoss(entryKbar, tickSize);
        detail = `① K 線三段式: ${primarySL.toFixed(2)}`;
      }
      break;

    case 'pivot-low':
      // ② pivot low（J/M/F）
      primarySL = inputs.pivotLow ?? entryKbar.low;
      detail = `② pivot low: ${primarySL.toFixed(2)}`;
      // F 戰法明寫 7% 上限
      if (letter === 'F') {
        const fLimit = entryPrice * (1 - 0.07);
        if (primarySL < fLimit) {
          primarySL = fLimit;
          detail = `② V 底 + 7% 上限: ${primarySL.toFixed(2)}`;
        }
      }
      break;

    case 'support-level':
      // ⑤ 結構支撐
      primarySL = inputs.supportLevel ?? entryKbar.low;
      detail = `⑤ 結構支撐: ${primarySL.toFixed(2)}`;
      break;

    case 'ma10':
      // Q 戰法守 MA10
      primarySL = inputs.supportLevel ?? entryKbar.low;
      detail = `Q 守 MA10: ${primarySL.toFixed(2)}`;
      break;
  }

  // 套固定停損比例（議題 S3-7：取較高的）— pct 換算為價格再 max
  const pctSL = entryPrice * (1 - fixedPct);
  if (pctSL > primarySL) {
    primarySL = pctSL;
    detail += ` → ${(fixedPct * 100).toFixed(1)}% 比例上拉至 ${primarySL.toFixed(2)}`;
  }

  // 議題 S3-7：套 10% 絕對下限保護
  const stopLossPrice = Math.max(primarySL, absoluteFloor);

  return {
    stopLossPrice,
    primaryMethod: method,
    primarySL,
    absoluteFloor,
    trailingActivated: false,
    detail,
  };
}

/**
 * 持倉中每日更新 SL（議題 S3-3 trailing stop + ③ 均線跟隨）
 */
export function updateStopLossDaily(
  inputs: StopLossInputs,
  today: CandleWithIndicators,
): StopLossResult {
  const initial = calculateInitialStopLoss(inputs);
  const { letter, entryPrice, isEndPhase, recentHigh } = inputs;

  // ── 末升段切 trailing stop（議題 S3-3）──
  if (isEndPhase && recentHigh != null) {
    const trailingSL = recentHigh * 0.97;  // 議題 S3-3 推薦 trailing 3%
    if (trailingSL > initial.stopLossPrice) {
      return {
        ...initial,
        stopLossPrice: trailingSL,
        trailingActivated: true,
        detail: `末升段 trailing：recentHigh=${recentHigh.toFixed(2)} × 0.97 = ${trailingSL.toFixed(2)}`,
      };
    }
  }

  // ── 跟隨均線上揚（③ 移動停損）──
  const trailingMA = SIGNAL_TO_TRAILING_MA[letter];
  if (trailingMA) {
    const maValue = today[trailingMA.toLowerCase() as 'ma5' | 'ma10' | 'ma20' | 'ma3'];
    if (maValue != null && maValue > initial.stopLossPrice) {
      return {
        ...initial,
        stopLossPrice: Math.max(maValue, entryPrice * 0.90),  // 仍套 10% 絕對下限
        detail: `${trailingMA} 跟隨上揚: ${maValue.toFixed(2)}`,
      };
    }
  }

  return initial;
}

// ── ⑥ 5 條絕對停損判定（議題 Step 3 ⑥ + S3-7 合併 ④/⑥-4）──────────────

export interface AbsoluteStopLossInputs {
  entryPrice: number;
  todayClose: number;
  trendStateToday: '多頭' | '空頭' | '盤整';
  trendStateYesterday?: '多頭' | '空頭' | '盤整';
  letter: V12Letter;
  /** C 訊號用：進場日盤整下緣 */
  consolidationLow?: number;
  /** F 訊號用：V 底最低 */
  vBottom?: number;
}

export interface AbsoluteStopLossResult {
  triggered: boolean;
  reason?:
    | 'broke-consolidation' // ⑥-1 跌破盤整區（C）
    | 'trend-flipped-down'  // ⑥-2 多頭翻空頭
    | 'loss-over-10pct'     // ⑥-4 跌幅 > 10%
    | 'broke-v-bottom';     // ⑥-5 F 跌破 V 底
  detail?: string;
}

/**
 * 議題 Step 3 ⑥：5 條絕對停損判定
 *
 * 觸發即強制出場（無視一般停損 ① ~ ⑤）。
 *
 * 注意：v12 階段 1 不做空，⑥-3 空頭翻多頭確認（做空版）不適用。
 */
export function checkAbsoluteStopLoss(inputs: AbsoluteStopLossInputs): AbsoluteStopLossResult {
  const {
    entryPrice,
    todayClose,
    trendStateToday,
    trendStateYesterday,
    letter,
    consolidationLow,
    vBottom,
  } = inputs;

  // ⑥-1：C 訊號進場後跌破盤整區
  if (letter === 'C' && consolidationLow != null && todayClose < consolidationLow) {
    return {
      triggered: true,
      reason: 'broke-consolidation',
      detail: `⑥-1 跌破盤整區: close=${todayClose.toFixed(2)} < ${consolidationLow.toFixed(2)}`,
    };
  }

  // ⑥-2：個股 detectTrend 翻空頭（昨日非空頭、今日空頭）
  if (
    trendStateToday === '空頭' &&
    trendStateYesterday != null &&
    trendStateYesterday !== '空頭'
  ) {
    return {
      triggered: true,
      reason: 'trend-flipped-down',
      detail: '⑥-2 多頭翻空頭確認',
    };
  }

  // ⑥-4：跌幅 > 10%（議題 S3-7 合併 ④/⑥-4）
  if (todayClose < entryPrice * 0.90) {
    return {
      triggered: true,
      reason: 'loss-over-10pct',
      detail: `⑥-4 跌幅 ${(((entryPrice - todayClose) / entryPrice) * 100).toFixed(2)}% > 10%`,
    };
  }

  // ⑥-5：F 跌破 V 底
  if (letter === 'F' && vBottom != null && todayClose < vBottom) {
    return {
      triggered: true,
      reason: 'broke-v-bottom',
      detail: `⑥-5 F 跌破 V 底: close=${todayClose.toFixed(2)} < ${vBottom.toFixed(2)}`,
    };
  }

  return { triggered: false };
}
