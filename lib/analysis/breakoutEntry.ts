/**
 * 突破進場偵測
 *
 * B 買法：回後買上漲（detectBreakoutEntry，pullback_buy subType）
 * C 買法：盤整突破（detectConsolidationBreakout，consolidation_breakout subType）
 *
 * 朱家泓《做對5個實戰步驟》p.40：
 *   位置 1 盤整突破（C）：前置盤整（<15% 區間）+ 突破上頸線 + 量 + 紅K
 *   位置 2 回後買上漲（B）：多頭回檔不破前低 + 再突破前波高 + 量 + 紅K
 *
 * 共同扳機：大量長紅 K 突破前高
 * 差異：前置狀態（盤整 vs 多頭回檔）+ 停損位置
 *
 * Phase 3（2026-04-20 並列買法架構）
 * 2026-04-21 拆分：B=回後買上漲、C=盤整突破，各自獨立 export
 */

import type { CandleWithIndicators } from '@/types';
import { detectPullbackBuy, detectRangeBreakout } from '@/lib/analysis/highWinPositions';

export type BreakoutSubType = 'consolidation_breakout' | 'pullback_buy';

export interface BreakoutEntryResult {
  isBreakout: boolean;
  subType: BreakoutSubType;
  breakoutPrice: number;      // 被突破的前高
  bodyPct: number;
  volumeRatio: number;
  /** subType=consolidation_breakout 時的盤整低點（停損參考） */
  consolidationLow?: number;
  /** subType=pullback_buy 時的前波低點（停損參考） */
  prevSwingLow?: number;
  /** 盤整天數或回檔天數 */
  preEntryDays: number;
  detail: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// C 買法：盤整突破（獨立 export）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 盤整突破偵測（C 買法）
 *
 * 寶典 p.37 ② + Part 4 p.299「狹幅盤整 5-6 天」+ Part 7 p.488 攻擊量
 *
 * 2026-05-09 統一 detector：C 買法跟 ③ 加分 tag 都呼叫 detectRangeBreakout 共用邏輯。
 * 含 11 條 gate（盤整結構 + 6 天 + tightness ≤ 15% + 首次突破 + 紅K2% + 量1.3x + 收盤突破上頸線）。
 */
export function detectConsolidationBreakout(
  candles: CandleWithIndicators[],
  idx: number,
): BreakoutEntryResult | null {
  const r = detectRangeBreakout(candles, idx);
  if (!r) return null;

  return {
    isBreakout: true,
    subType: 'consolidation_breakout',
    breakoutPrice: r.upperNecklineToday,
    bodyPct: r.bodyPct,
    volumeRatio: r.volumeRatio,
    consolidationLow: r.lowerNecklineToday,
    preEntryDays: r.preEntryDays,
    detail: `盤整突破（${r.preEntryDays}天盤整 ${r.lowerNecklineToday.toFixed(1)}~${r.upperNecklineToday.toFixed(1)}→突破+實體${r.bodyPct.toFixed(2)}%+量×${r.volumeRatio.toFixed(2)}）`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// B 買法：回後買上漲（主入口，只做 pullback_buy）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 回後買上漲偵測（B 買法）
 *
 * 寶典 p.37 + p.238「回後買上漲是指上升走勢中回檔後再次上漲時買進」：
 *   多頭回檔**不破前低** + 站回 MA5 + 站回後守 MA5 + 帶量中長紅K + 突破前一日最高
 *
 * 2026-05-10 放寬時序：站回 MA5 與放量突破允許跨 K 棒（站回當日 / 隔 1-2 日皆可），
 * 涵蓋「T-2<MA5, T-1 站回但無量, T 才補量突破前 K 高」的真實型態。
 */
export function detectBreakoutEntry(
  candles: CandleWithIndicators[],
  idx: number,
): BreakoutEntryResult | null {
  const pb = detectPullbackBuy(candles, idx);
  if (!pb) return null;

  const reclaimNote = pb.barsSinceReclaim === 0
    ? '今日站回MA5'
    : `站回MA5+${pb.barsSinceReclaim}日`;

  return {
    isBreakout: true,
    subType: 'pullback_buy',
    breakoutPrice: pb.breakoutPrice,
    bodyPct: pb.bodyPct,
    volumeRatio: pb.volumeRatio,
    prevSwingLow: pb.prevSwingLow,
    preEntryDays: pb.pullbackDays,
    detail: `回後買上漲（多頭+${reclaimNote}+守MA5+不破前低${pb.prevSwingLow.toFixed(2)}+紅K實體${pb.bodyPct.toFixed(2)}%+量×${pb.volumeRatio.toFixed(2)}+突破前K高${pb.breakoutPrice.toFixed(1)}）`,
  };
}
