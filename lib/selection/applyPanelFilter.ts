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
 * 對 scan session 的 results 套用面板顯示規則。
 * @param results ScanPipeline 產生、已通過六條件+戒律+淘汰法的候選
 * @param options 面板切換狀態
 */
export function applyPanelFilter(
  results: readonly StockScanResult[],
  options: PanelFilterOptions,
): StockScanResult[] {
  let filtered = [...results];

  // MTF gate：週線前5全過（①趨勢②均線③位置④量⑤K線）才算通過
  // 使用 mtfWeeklyPass 而非舊 4 分制 mtfScore >= 3，避免只過①②⑥+月就誤入
  if (options.useMultiTimeframe) {
    filtered = filtered.filter(r => r.mtfWeeklyPass === true);
  }

  filtered.sort(panelSortCompare);

  return filtered;
}

/**
 * 面板排序比較器 — 三方共用（applyPanelFilter / backtest-run / UI BacktestSection）
 *
 * 主鍵：漲幅 desc（2026-04-19 回測驗證：漲幅在 Top500 全期冠軍）
 * 次鍵：六條件總分 desc
 *
 * 改這個比較器等於改 UI 顯示 top N + 回測 top N + UI 排序，三方同步動。
 */
export function panelSortCompare(a: StockScanResult, b: StockScanResult): number {
  const d1 = (b.changePercent ?? 0) - (a.changePercent ?? 0);
  if (d1 !== 0) return d1;
  return (b.sixConditionsScore ?? 0) - (a.sixConditionsScore ?? 0);
}

/**
 * 面板排序 key — 數值型 key 給 backtest-run 的 sortFn 用（越大越優先）。
 * 與 panelSortCompare 等價：changePercent 為主，六條件總分為次。
 * 用 changePercent + sixCon/1000 把次鍵壓到尾數，不會影響主鍵排名。
 */
export function panelSortKey(r: Pick<StockScanResult, 'changePercent' | 'sixConditionsScore'>): number {
  return (r.changePercent ?? 0) + (r.sixConditionsScore ?? 0) / 1000;
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
