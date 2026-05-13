/**
 * v12 Step 4 操作紀律（v12 Phase 1.9）
 *
 * 書本依據：
 * - 5 步驟 步驟 4 第 5-6 章 K 線/均線操作（p.252-280）
 * - 寶典 Part 11-2 短線 20 守則 #5/#6（B/P MA5 +10% 切換）
 * - 抓線圖 第 4 篇 第 6 章 智慧 K 線戰法 p.245-249
 * - 寶典「操作三線」MA5-10 / MA20 / MA60（短/中/長 3 個層次）
 *
 * v12 議題：
 * - 衝突 α：Step 5 ① 寶典 #5/#6 覆寫 Step 4 ② 對 B/P MA5 邏輯
 * - 衝突 β：Step 4 ③ 升級長線後所有訊號統一 MA20
 * - Step 4 ① 智慧 K 線：跌破前一日最低 → 出場
 * - Step 4 ② 短線均線：MA5（B/P）/ MA10（其餘多頭軌）
 * - Step 4 ③ 長線均線：手動升級 MA20（獲利 ≥ 10%）
 * - Step 4 ④ 超長線：手動升級 MA60（獲利 ≥ 30%，2026-05-09 新增三階升級）
 *
 * 操作模式：
 * - 'short'：短線（MA5/MA10 跟隨）
 * - 'long'：長線（升級到 MA20 跟隨）
 *
 * 0513 ABCDE E：'wave' / 'super-long' 已砍
 * - wave：fall-through 跟 short 一樣、無書本依據、誤導用戶
 * - super-long：「升 MA60 / 獲利 ≥ 30%」書本沒寫且 UI 無入口；對齊書本砍除
 */

import type { CandleWithIndicators } from '../../types';
import { PROFIT_TARGET_RULE_PCT } from '../analysis/bookThresholds';

import type { V12Letter } from '../analysis/v12Signals';

export type OperationMode = 'short' | 'long';

// ── Step 4 ① K 線轉折出場（智慧 K 線戰法）──────────────────────────────

/**
 * 智慧 K 線戰法（書本依據：抓線圖 p.245）
 *
 * 多頭做多 SOP：
 * - 進場：收盤前確認股價突破前一日最高點
 * - 續抱：收盤前沒跌破前一日最低點
 * - 出場：收盤前確認跌破前一日最低點
 *
 * 適用條件（書本明寫）：
 * - 單邊市場（detectTrend = 多頭）
 * - 角度 > 45°（純書本不量化，純概念）
 * - 盤整不適用（書本明寫）
 */
export function checkKLineExit(
  todayCandle: CandleWithIndicators,
  yesterdayCandle: CandleWithIndicators,
  trendStateToday: '多頭' | '空頭' | '盤整',
): { shouldExit: boolean; reason?: string } {
  // 盤整時不啟用智慧 K 線戰法
  if (trendStateToday !== '多頭') {
    return { shouldExit: false };
  }

  // 收盤跌破前一日最低 → 出場
  if (todayCandle.close < yesterdayCandle.low) {
    return {
      shouldExit: true,
      reason: `收盤 ${todayCandle.close.toFixed(2)} 跌破前一日最低 ${yesterdayCandle.low.toFixed(2)}（智慧 K 線出場法 / 抓住線圖第 4 篇第 6 章 p.245）`,
    };
  }

  return { shouldExit: false };
}

// ── Step 4 ② 短線均線跟隨（衝突 α 對 B/P MA5 特殊處理）────────────────

/**
 * 短線均線出場判定
 *
 * 衝突 α 修正（議題 Step 5 ①）：
 * - **B / P 訊號**（用 MA5）：< 10% 續抱（不停利），≥ 10% 才停利（寶典 #5/#6）
 * - **其他訊號**（C/E/J/K/L/M 用 MA10）：跌破即出場（一般紀律）
 *
 * @param closeToday 今日收盤價
 * @param maValueToday 對應均線今日值
 * @param letter v12 訊號字母
 * @param entryPrice 用戶實際進場成本價（議題 92）
 */
export function checkMAExit(
  closeToday: number,
  maValueToday: number,
  letter: V12Letter,
  entryPrice: number,
): { shouldExit: boolean; reason?: string } {
  // 沒跌破均線 → 不出場
  if (closeToday >= maValueToday) {
    return { shouldExit: false };
  }

  // ── 衝突 α：B/P 用 MA5 + 寶典 #5/#6 切換 ──
  // 0513 ABCDE D：10% 改 import PROFIT_TARGET_RULE_PCT 統一書本守則 #5/#6
  if (letter === 'B' || letter === 'P') {
    const profitPct = (closeToday - entryPrice) / entryPrice;
    if (profitPct < PROFIT_TARGET_RULE_PCT) {
      // 累計獲利 < 10%：即使跌破 MA5 也續抱（寶典 #5）
      return {
        shouldExit: false,
        reason: `B/P 進階紀律 #5：獲利 ${(profitPct * 100).toFixed(2)}% < ${(PROFIT_TARGET_RULE_PCT * 100).toFixed(0)}%，跌破 MA5 仍續抱`,
      };
    }
    // ≥ 10%：跌破 MA5 → 停利
    return {
      shouldExit: true,
      reason: `B/P 進階紀律 #6：獲利 ≥ ${(PROFIT_TARGET_RULE_PCT * 100).toFixed(0)}%，跌破 MA5 停利`,
    };
  }

  // ── 其他訊號：跌破均線即出場 ──
  return {
    shouldExit: true,
    reason: `收盤 ${closeToday.toFixed(2)} 跌破操作均線 ${maValueToday.toFixed(2)}（書本短線守則 #6）`,
  };
}

// ── Step 4 ③ 升級長線（衝突 β：升級後所有訊號統一 MA20）────────────────

/**
 * 升級長線判定
 *
 * 議題 Step 4 ③：用戶獲利 ≥ 10% 後 UI 提供切換按鈕（手動升級）。
 * 升級後**所有訊號統一切到 MA20**（衝突 β 修正）。
 *
 * @param currentClose 當前收盤
 * @param entryPrice 進場價
 * @param currentMode 當前操作模式
 * @returns 是否可升級長線
 */
export function canUpgradeToLongTerm(
  currentClose: number,
  entryPrice: number,
  currentMode: OperationMode,
): { canUpgrade: boolean; profitPct: number } {
  const profitPct = (currentClose - entryPrice) / entryPrice;
  return {
    canUpgrade: profitPct >= 0.10 && currentMode === 'short',
    profitPct,
  };
}

// ── Step 4 ④ 升級超長線（2026-05-09 新增三階升級）─────────────────────

/**
 * 升級超長線判定
 *
 * 寶典「操作三線」MA60 = 超長線。獲利 ≥ 30% 後 UI 提供切換按鈕（手動升級）。
 * 升級後所有訊號統一切到 MA60（除 Q 戰法保持 MA10）。
 *
 * 必須先 short → long → super-long（或從 short 直接 super-long 也可）。
 *
 * @returns 是否可升級超長線
 */
export function canUpgradeToSuperLong(
  currentClose: number,
  entryPrice: number,
  currentMode: OperationMode,
): { canUpgrade: boolean; profitPct: number } {
  const profitPct = (currentClose - entryPrice) / entryPrice;
  // ⚠️ 自創 padding（書本沒明寫量化）— 0513 ABCDE D 標自創
  // 30% 是「升級超長線」門檻，書本只說「達高檔」沒明寫百分比
  // 未來搬到 bookThresholds.ts SUPER_LONG_UPGRADE_PCT
  return {
    canUpgrade: profitPct >= 0.30 && (currentMode === 'short' || currentMode === 'long'),
    profitPct,
  };
}

// ── 操作模式對應均線 ─────────────────────────────────────────────────────

/**
 * 依操作模式 + 字母回傳實際跟隨的均線
 *
 * 衝突 β：升級長線後所有訊號統一 MA20
 * 三階升級（2026-05-09）：超長線統一 MA60（除 Q 戰法保持 MA10）
 */
export function getOperationMA(
  letter: V12Letter,
  mode: OperationMode,
): 'MA3' | 'MA5' | 'MA10' | 'MA20' | null {
  // Q 戰法獨立軌：永遠用 MA10（不論 mode）
  if (letter === 'Q') return 'MA10';

  // 升級長線 → 統一 MA20（衝突 β；0513 ABCDE E：super-long 已砍）
  if (mode === 'long') return 'MA20';

  // 短線模式（mode='short'）：依字母對應
  // 0513 ABCDE C3：對齊 letterSOP.operatingMA + SIGNAL_TO_TRAILING_MA，cross-source test 強制驗
  if (letter === 'F') return 'MA3';
  if (letter === 'A' || letter === 'B' || letter === 'P') return 'MA5';
  if (letter === 'D' || letter === 'J' || letter === 'O') return 'MA20';
  return 'MA10';
}
