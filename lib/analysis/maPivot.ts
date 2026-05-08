/**
 * 均線 pivot 識別（v12 議題 27 / 97）
 *
 * 用於判斷 MA「上揚」/「下彎」 — 純書本本意（趨勢動詞）：
 * - 上揚 = MA 最近一次 pivot low 已過 + close > pivot low 對應 MA 值
 * - 下彎 = MA 最近一次 pivot high 已過 + close < pivot high 對應 MA 值
 *
 * 跟「today ≥ yesterday」（單日對比）相比更穩健 —
 * 一日震盪不會誤判趨勢方向，符合書本「上揚 / 下彎」是「持續上升 / 下降」的本意。
 *
 * 適用範圍：
 * - 個股季線（MA60）下彎判定
 * - 大盤月線（MA20）上揚判定（議題 97）
 * - 條件 ④ 均線「向上」判定
 */

export interface MAPivot {
  /** pivot 對應的索引（在 MA 陣列中的位置）*/
  index: number;
  /** pivot 對應的 MA 值 */
  value: number;
  /** pivot 類型 */
  type: 'high' | 'low';
}

export interface MAPivotResult {
  /** 是否上揚 */
  isUp: boolean;
  /** 是否下彎 */
  isDown: boolean;
  /** 最近的 pivot low（找到才有） */
  recentPivotLow?: MAPivot;
  /** 最近的 pivot high（找到才有） */
  recentPivotHigh?: MAPivot;
}

/**
 * 在 MA 陣列中尋找最近的 pivot（轉折點）
 *
 * 採用簡單規則：連續 N 根（預設 3）都比中間根低/高 → 確認 pivot。
 *
 * @param maValues MA 值陣列（時間序，舊到新）
 * @param window pivot 確認窗口（兩側各 N 根）
 * @returns 最近的 pivot low 與 pivot high（若有）
 */
export function findRecentMAPivots(
  maValues: ReadonlyArray<number>,
  window = 3,
): { lastLow?: MAPivot; lastHigh?: MAPivot } {
  if (maValues.length < window * 2 + 1) {
    return {};
  }

  let lastLow: MAPivot | undefined;
  let lastHigh: MAPivot | undefined;

  // 從新到舊掃描，找最近的 pivot
  for (let i = maValues.length - window - 1; i >= window; i--) {
    const center = maValues[i];

    // 檢查左右 window 根
    let isPivotLow = true;
    let isPivotHigh = true;
    for (let j = 1; j <= window; j++) {
      if (maValues[i - j] <= center) isPivotLow = false;
      if (maValues[i + j] <= center) isPivotLow = false;
      if (maValues[i - j] >= center) isPivotHigh = false;
      if (maValues[i + j] >= center) isPivotHigh = false;
    }

    if (isPivotLow && !lastLow) {
      lastLow = { index: i, value: center, type: 'low' };
    }
    if (isPivotHigh && !lastHigh) {
      lastHigh = { index: i, value: center, type: 'high' };
    }

    if (lastLow && lastHigh) break;
  }

  return { lastLow, lastHigh };
}

/**
 * 判定 MA 是否「上揚」（純書本「持續上升」本意）
 *
 * @param maValues MA 值陣列（舊到新）
 * @param window pivot 確認窗口
 */
export function isMAUp(
  maValues: ReadonlyArray<number>,
  window = 3,
): boolean {
  if (maValues.length < 2) return false;

  const { lastLow, lastHigh } = findRecentMAPivots(maValues, window);
  const lastIdx = maValues.length - 1;
  const todayMA = maValues[lastIdx];

  // 沒有 pivot low → 用簡單對比 fallback
  if (!lastLow) {
    return todayMA >= maValues[lastIdx - 1];
  }

  // 上揚 = 最近 pivot low 之後 MA 持續高於 pivot low
  if (todayMA <= lastLow.value) return false;

  // 若 pivot high 比 pivot low 更近（最近一次轉折是高點）→ 已開始下彎
  if (lastHigh && lastHigh.index > lastLow.index) {
    return todayMA > lastHigh.value;
  }

  return true;
}

/**
 * 判定 MA 是否「下彎」（純書本「持續下降」本意）
 */
export function isMADown(
  maValues: ReadonlyArray<number>,
  window = 3,
): boolean {
  if (maValues.length < 2) return false;

  const { lastLow, lastHigh } = findRecentMAPivots(maValues, window);
  const lastIdx = maValues.length - 1;
  const todayMA = maValues[lastIdx];

  if (!lastHigh) {
    return todayMA < maValues[lastIdx - 1];
  }

  if (todayMA >= lastHigh.value) return false;

  if (lastLow && lastLow.index > lastHigh.index) {
    return todayMA < lastLow.value;
  }

  return true;
}

/**
 * 完整方向判定
 */
export function getMADirection(
  maValues: ReadonlyArray<number>,
  window = 3,
): MAPivotResult {
  const { lastLow, lastHigh } = findRecentMAPivots(maValues, window);
  return {
    isUp: isMAUp(maValues, window),
    isDown: isMADown(maValues, window),
    recentPivotLow: lastLow,
    recentPivotHigh: lastHigh,
  };
}
