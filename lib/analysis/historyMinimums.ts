/**
 * V12 detector 最少歷史天數 — 0513 ABCDE D-MEDIUM
 *
 * 為什麼集中：之前 v12LetterM/N/O/P/Q 各自寫 `if (idx < 30)` 等 magic number，
 * 沒書本依據；改字母 detector 時要一一找。集中到此檔加 JSDoc 對照書本。
 *
 * 通則：detector 必須有「足夠歷史」才能正確算 MA / pivots / 型態。
 * 不同字母對應不同最少天數：
 * - 純結構（M/N/O）：30 天為合理上界（足以形成 pivot + 算 MA20）
 * - 高勝率位置（P）：21 天（MA20 完整 + 1 根回測）
 * - 戰法（Q）：25 天（三均 MA3+MA10+MA24 完整）
 *
 * ⚠️ 自創 padding（書本沒明寫量化）— 0513 標自創
 * 書本只說「需要足夠歷史」沒明寫天數；30/25/21 是工程經驗值，
 * 改值前需確認 detector 內部最大 lookback（如 findPivots(8)、MA60 計算）跟此值不衝突。
 */

/** M 突破軌道線：需 2 個 confirmed pivot low + MA10 trailing */
export const M_MIN_HISTORY = 30;

/** N 型態確認：需完整 25 種底部型態 pivots（findPivots 最大 lookback ~10）+ MA20 */
export const N_MIN_HISTORY = 30;

/** O 打底完成：需 detectTrend 完整 20 天 + 反轉確認 buffer */
export const O_MIN_HISTORY = 30;

/** P 高檔拉回：需 MA20 完整 + 拉回 1-2 天 buffer */
export const P_MIN_HISTORY = 21;

/** Q 三均戰法：需 MA3+MA10+MA24 完整 + 1 天突破 buffer */
export const Q_MIN_HISTORY = 25;

/** highWinRateEntry 一字底：盤整 ≥ 40 天 + MA20 buffer */
export const FLATBOTTOM_MIN_HISTORY = 60;

/** gapAnalysis：跳空判定需 20 天 ATR / avgVol */
export const GAP_ANALYSIS_MIN_HISTORY = 20;

/** blackKBreakoutEntry：需 MA20 完整 + 黑 K lookback */
export const BLACKK_BREAKOUT_MIN_HISTORY = 21;
