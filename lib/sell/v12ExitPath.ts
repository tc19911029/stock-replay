/**
 * v12 出場後路徑分流（v12 Phase 1.11）
 *
 * 衝突 ζ（跨 Step 整體一致性檢查）：依出場原因 + 賺/虧分流
 *
 * 路徑：
 * - **議題 28 再進場**：跳 Step 1，直接看 Step 2 訊號（趨勢未變即可）
 *   - 適用：Step 3 停損 + 虧錢出場
 *   - 書本：5 步驟 p.275「趨勢沒改變，停利後繼續操作原方向」
 *
 * - **議題 22 完整評估**：回 Step 1+2 完整流程
 *   - 適用：Step 5 停利 + 賺錢出場（紀律/獲利目標/K 棒訊號）
 *   - 書本：5 步驟 p.55「停利結束後，回到步驟 1 選股」
 *
 * 路徑判定（議題 ζ 最終版）：
 *
 * | 出場條件 | 賺錢狀態 | 路徑 |
 * | 跌破均線（虧）| close < entryPrice | 議題 28 再進場 |
 * | 跌破均線（賺）| close ≥ entryPrice | 議題 22 完整評估 |
 * | Step 5 ② 達 10%/乖離/型態目標價 | 必賺 | 議題 22 完整評估 |
 * | Step 5 ③ K 棒訊號 | 必賺（啟用條件 > 0%）| 議題 22 完整評估 |
 * | Step 3 ⑥ 絕對停損 | 通常虧 | 議題 28 再進場 |
 *
 * 衝突 E：再進場仍過 Step 0 大盤過濾（書本「進場做多前提」對所有進場）
 * 議題 56：再進場不限天數（純書本，移除原 maxBarsAfterExit: 10）
 */

export type ExitReason =
  | 'stop-loss-ma'           // 跌破均線（Step 4 ②/③）
  | 'stop-loss-trend'        // 跌破趨勢策略 pivot low
  | 'stop-loss-support'      // 跌破支撐
  | 'absolute-stop-trend'    // ⑥-2 多頭翻空頭
  | 'absolute-stop-10pct'    // ⑥-4 跌幅 > 10%
  | 'absolute-stop-consol'   // ⑥-1 C 跌破盤整
  | 'absolute-stop-vbottom'  // ⑥-5 F 跌破 V 底
  | 'take-profit-target'     // ② 達型態目標價
  | 'take-profit-discipline' // ① 紀律停利（賺錢時跌破均線）
  | 'k-bar-signal';          // ③ K 棒訊號

export type ReentryPath =
  | 'reentry-skip-step1'   // 議題 28：跳 Step 1，看 Step 2 訊號
  | 'full-reevaluation';   // 議題 22：回 Step 1+2 完整評估

export interface ExitPathInputs {
  exitReason: ExitReason;
  exitPrice: number;
  entryPrice: number;
}

export interface ExitPathResult {
  path: ReentryPath;
  /** 是否賺錢出場 */
  isProfit: boolean;
  /** 損益百分比 */
  pnlPct: number;
  /** 出場分類標籤（議題 ζ：UI 顯示用）*/
  classification: 'stop-loss' | 'take-profit';
  /** 路徑說明 */
  detail: string;
}

/**
 * 出場後路徑分流判定
 *
 * 議題 ζ 衝突（跨 Step 整體一致性檢查）：
 * - 賺錢出場 → 議題 22 完整評估
 * - 虧錢出場 → 議題 28 再進場（跳 Step 1）
 *
 * 注意：再進場時仍需過 Step 0 大盤過濾（衝突 E）。
 */
export function determineExitPath(inputs: ExitPathInputs): ExitPathResult {
  const { exitReason, exitPrice, entryPrice } = inputs;
  const pnlPct = (exitPrice - entryPrice) / entryPrice;
  const isProfit = exitPrice >= entryPrice;

  // ── Step 5 停利類型（必賺）→ 議題 22 完整評估 ──
  if (
    exitReason === 'take-profit-target' ||
    exitReason === 'k-bar-signal'
  ) {
    return {
      path: 'full-reevaluation',
      isProfit: true,
      pnlPct,
      classification: 'take-profit',
      detail: `Step 5 停利出場 → 議題 22 完整評估（回 Step 1+2 重新選股）`,
    };
  }

  // ── 紀律停利（跌破均線但賺錢）→ 議題 22 完整評估 ──
  if (exitReason === 'take-profit-discipline' || (exitReason === 'stop-loss-ma' && isProfit)) {
    return {
      path: 'full-reevaluation',
      isProfit: true,
      pnlPct,
      classification: 'take-profit',
      detail: `紀律停利（${(pnlPct * 100).toFixed(2)}%）→ 議題 22 完整評估`,
    };
  }

  // ── 一般停損（虧錢）→ 議題 28 再進場 ──
  return {
    path: 'reentry-skip-step1',
    isProfit: false,
    pnlPct,
    classification: 'stop-loss',
    detail: `${exitReason}（${(pnlPct * 100).toFixed(2)}%）→ 議題 28 再進場（跳 Step 1，仍過 Step 0）`,
  };
}

// ── 再進場條件檢查（議題 28 + 衝突 E）────────────────────────────────────

export interface ReentryCheckInputs {
  /** 個股當前 trend state */
  stockTrend: '多頭' | '空頭' | '盤整';
  /** Step 0 大盤是否過（衝突 E：再進場仍過 Step 0）*/
  marketGatePassed: boolean;
  /** 當前是否已站回對應均線 */
  reclaimedMA: boolean;
}

export interface ReentryCheckResult {
  canReenter: boolean;
  blockReason?:
    | 'stock-trend-changed'  // 個股趨勢已改變（議題 56）
    | 'market-gate-blocked'  // 大盤過濾失敗（衝突 E）
    | 'ma-not-reclaimed';    // 均線未站回
  detail?: string;
}

/**
 * 議題 28 再進場條件
 *
 * 純書本邏輯（議題 56）：
 * - 趨勢仍多頭（未發生反轉）
 * - 站回對應均線
 * - **仍過 Step 0 大盤過濾**（衝突 E）
 * - **不限天數**（書本沒寫期限，移除 maxBarsAfterExit: 10）
 */
export function checkReentryConditions(inputs: ReentryCheckInputs): ReentryCheckResult {
  const { stockTrend, marketGatePassed, reclaimedMA } = inputs;

  if (stockTrend !== '多頭') {
    return {
      canReenter: false,
      blockReason: 'stock-trend-changed',
      detail: '個股 detectTrend 已非多頭，不再進場',
    };
  }

  if (!marketGatePassed) {
    return {
      canReenter: false,
      blockReason: 'market-gate-blocked',
      detail: '衝突 E：再進場仍過 Step 0 大盤過濾，目前大盤未過',
    };
  }

  if (!reclaimedMA) {
    return {
      canReenter: false,
      blockReason: 'ma-not-reclaimed',
      detail: '尚未站回對應均線',
    };
  }

  return {
    canReenter: true,
    detail: '議題 28 再進場條件成立（趨勢未變 + 站回均線 + Step 0 過）',
  };
}
