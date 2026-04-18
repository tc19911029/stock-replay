/**
 * Single Source of Truth: 面板實際顯示的選股邏輯
 *
 * 一個純函式，三方共用：
 * - 前端 `store/backtestStore.ts` 的 MTF toggle 過濾
 * - 回測腳本 `scripts/backtest-*.ts` 的最終 pick 判定
 * - 合約測試 `__tests__/contracts/scan-parity.test.ts` 的 oracle
 *
 * ScanPipeline 已保證輸入的 results 都通過：
 *   - 前 500 成交額
 *   - 六條件 ≥ 5 分
 *   - 10 大戒律（checkLongProhibitions）
 *   - 淘汰法 R1-R11（evaluateElimination）
 *
 * 本函式只負責面板 UI 層追加的過濾 + 排序。改動前請先閱讀 `CLAUDE.md` 第 10 條。
 */
import type { StockScanResult } from '@/lib/scanner/types';

export interface PanelFilterOptions {
  /** 是否開啟 MTF 長線保護（等同 App 面板「長線保護短線」toggle） */
  useMultiTimeframe: boolean;
}

/**
 * 面板 MTF toggle 門檻 — 後端 mtfScore ≥ 3 即通過。
 * 對齊 `lib/strategy/StrategyConfig.ts` 的 `ZHU_OPTIMIZED.thresholds.mtfMinScore`。
 */
export const PANEL_MTF_MIN_SCORE = 3;

/**
 * 對 scan session 的 results 套用面板顯示規則。
 * @param results ScanPipeline 產生、已通過六條件+戒律+淘汰法的候選
 * @param options 面板切換狀態
 */
export function applyPanelFilter(
  results: readonly StockScanResult[],
  options: PanelFilterOptions,
): StockScanResult[] {
  let filtered = [...results];

  if (options.useMultiTimeframe) {
    filtered = filtered.filter(r => (r.mtfScore ?? 0) >= PANEL_MTF_MIN_SCORE);
  }

  // 排序：漲幅 desc 為主鍵（2026-04-19 回測驗證：漲幅在 Top500 全期冠軍）
  // 同分以六條件總分次要
  filtered.sort((a, b) => {
    const d1 = (b.changePercent ?? 0) - (a.changePercent ?? 0);
    if (d1 !== 0) return d1;
    return (b.sixConditionsScore ?? 0) - (a.sixConditionsScore ?? 0);
  });

  return filtered;
}

/**
 * 取第一名 — B1 買入策略（all-in 排名第一）專用。
 * 回傳 null 代表當日沒有候選可買。
 */
export function panelTopPick(
  results: readonly StockScanResult[],
  options: PanelFilterOptions,
): StockScanResult | null {
  const filtered = applyPanelFilter(results, options);
  return filtered.length > 0 ? filtered[0] : null;
}
