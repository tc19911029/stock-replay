/**
 * Edwards & Magee《股市趨勢技術分析》第9版 — 經典圖表型態規則
 *
 * 涵蓋書中定義的主要反轉型態與持續型態：
 * - 反轉型態：頭肩頂/底、雙重頂/底、三重頂/底、擴散型態、圓形底
 * - 持續型態：對稱三角形、上升/下降三角形、旗形、三角旗、楔形、矩形
 * - 複合型態：杯柄型態
 */
import { type TradingRule, type RuleSignal } from '@/types';
import {
  findSwingHighs, findSwingLows, SwingPoint,
  priceNear, linearRegression, isVolumeBreakout,
  priceChangePercent, isMaTrendingUp, isMaTrendingDown,
} from './ruleUtils';

// ─── 輔助：取得頸線價位 ───────────────────────────────────────────────────────

function necklineAt(p1: SwingPoint, p2: SwingPoint, targetIdx: number): number {
  if (p1.idx === p2.idx) return p1.price;
  const slope = (p2.price - p1.price) / (p2.idx - p1.idx);
  return p1.price + slope * (targetIdx - p1.idx);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. 頭肩頂 (Head & Shoulders Top) — 第7章
// ═══════════════════════════════════════════════════════════════════════════════

export const headAndShouldersTop: TradingRule = {
  id: 'em-head-shoulders-top',
  name: '頭肩頂 (Head & Shoulders Top)',
  description: '三個高點中間最高，左右肩接近等高，跌破頸線確認反轉',
  evaluate(candles, index): RuleSignal | null {
    if (index < 30) return null;

    const highs = findSwingHighs(candles, index, 60, 3);
    if (highs.length < 3) return null;

    // 在所有 swing highs 中找「頭」（最高點）
    const headIdx = highs.reduce((max, h, i) => h.price > highs[max].price ? i : max, 0);
    if (headIdx < 1 || headIdx >= highs.length - 1) return null;

    const head = highs[headIdx];
    const leftShoulder = highs[headIdx - 1];
    const rightShoulder = highs[headIdx + 1];

    // 左右肩必須低於頭部
    if (leftShoulder.price >= head.price || rightShoulder.price >= head.price) return null;
    // 左右肩接近等高（容差 5%）
    if (!priceNear(leftShoulder.price, rightShoulder.price, 0.05)) return null;
    // 頭部至少比肩膀高 3%
    const shoulderAvg = (leftShoulder.price + rightShoulder.price) / 2;
    if (head.price < shoulderAvg * 1.03) return null;

    // 找頸線：左肩與頭之間的低點、頭與右肩之間的低點
    const lows = findSwingLows(candles, index, 60, 2);
    const neckLeft = lows.find(l => l.idx > leftShoulder.idx && l.idx < head.idx);
    const neckRight = lows.find(l => l.idx > head.idx && l.idx < rightShoulder.idx);
    if (!neckLeft || !neckRight) return null;

    // 當前收盤跌破頸線
    const neckPrice = necklineAt(neckLeft, neckRight, index);
    const c = candles[index];
    if (c.close >= neckPrice) return null;

    const vol = isVolumeBreakout(c);
    return {
      type: vol ? 'SELL' : 'WATCH',
      label: '頭肩頂確認',
      description: `左肩(${leftShoulder.price.toFixed(2)}) → 頭(${head.price.toFixed(2)}) → 右肩(${rightShoulder.price.toFixed(2)})，收盤 ${c.close.toFixed(2)} 跌破頸線 ${neckPrice.toFixed(2)}`,
      reason: [
        '【Edwards & Magee《股市趨勢技術分析》第7章】頭肩頂是最可靠的反轉型態之一。',
        '當股價跌破由兩個谷底連成的頸線時，確認頂部反轉。',
        '目標價位＝頸線價 −（頭部價 − 頸線價）。',
        vol ? '帶量突破頸線，信號強度高。' : '注意：突破時成交量偏低，可能為假突破。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// 2. 頭肩底 (Head & Shoulders Bottom) — 第7章
// ═══════════════════════════════════════════════════════════════════════════════

export const headAndShouldersBottom: TradingRule = {
  id: 'em-head-shoulders-bottom',
  name: '頭肩底 (Head & Shoulders Bottom)',
  description: '三個低點中間最低，左右肩接近等低，突破頸線確認反轉',
  evaluate(candles, index): RuleSignal | null {
    if (index < 30) return null;

    const lows = findSwingLows(candles, index, 60, 3);
    if (lows.length < 3) return null;

    const headIdx = lows.reduce((min, l, i) => l.price < lows[min].price ? i : min, 0);
    if (headIdx < 1 || headIdx >= lows.length - 1) return null;

    const head = lows[headIdx];
    const leftShoulder = lows[headIdx - 1];
    const rightShoulder = lows[headIdx + 1];

    if (leftShoulder.price <= head.price || rightShoulder.price <= head.price) return null;
    if (!priceNear(leftShoulder.price, rightShoulder.price, 0.05)) return null;
    const shoulderAvg = (leftShoulder.price + rightShoulder.price) / 2;
    if (head.price > shoulderAvg * 0.97) return null;

    const highs = findSwingHighs(candles, index, 60, 2);
    const neckLeft = highs.find(h => h.idx > leftShoulder.idx && h.idx < head.idx);
    const neckRight = highs.find(h => h.idx > head.idx && h.idx < rightShoulder.idx);
    if (!neckLeft || !neckRight) return null;

    const neckPrice = necklineAt(neckLeft, neckRight, index);
    const c = candles[index];
    if (c.close <= neckPrice) return null;

    const vol = isVolumeBreakout(c);
    return {
      type: vol ? 'BUY' : 'WATCH',
      label: '頭肩底確認',
      description: `左肩(${leftShoulder.price.toFixed(2)}) → 頭(${head.price.toFixed(2)}) → 右肩(${rightShoulder.price.toFixed(2)})，收盤 ${c.close.toFixed(2)} 突破頸線 ${neckPrice.toFixed(2)}`,
      reason: [
        '【Edwards & Magee《股市趨勢技術分析》第7章】頭肩底是底部反轉的經典型態。',
        '右肩突破頸線時成交量放大是重要確認。',
        '目標價位＝頸線價 +（頸線價 − 頭部價）。',
        vol ? '帶量突破頸線，信號可靠。' : '注意：突破量能不足，建議等回測頸線再進場。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// 3. 雙重頂 / M頭 (Double Top) — 第8章
// ═══════════════════════════════════════════════════════════════════════════════

export const doubleTop: TradingRule = {
  id: 'em-double-top',
  name: '雙重頂 / M頭 (Double Top)',
  description: '兩個接近等高的高點，跌破中間谷底確認反轉',
  evaluate(candles, index): RuleSignal | null {
    if (index < 20) return null;

    const highs = findSwingHighs(candles, index, 40, 3);
    if (highs.length < 2) return null;

    // 取最後兩個 swing highs
    const h1 = highs[highs.length - 2];
    const h2 = highs[highs.length - 1];

    // 兩頂接近等高（容差 3%）
    if (!priceNear(h1.price, h2.price, 0.03)) return null;
    // 兩頂間隔至少 5 根 K 線
    if (h2.idx - h1.idx < 5) return null;

    // 找兩頂之間的最低點（頸線）
    let neckPrice = Infinity;
    for (let i = h1.idx + 1; i < h2.idx; i++) {
      if (candles[i].low < neckPrice) neckPrice = candles[i].low;
    }
    if (neckPrice === Infinity) return null;

    const c = candles[index];
    if (c.close >= neckPrice) return null;

    const vol = isVolumeBreakout(c);
    return {
      type: vol ? 'SELL' : 'WATCH',
      label: 'M頭確認',
      description: `第一頂(${h1.price.toFixed(2)}) 第二頂(${h2.price.toFixed(2)})，跌破頸線 ${neckPrice.toFixed(2)}`,
      reason: [
        '【Edwards & Magee《股市趨勢技術分析》第8章】雙重頂（M頭）是常見的頂部反轉型態。',
        '股價二次試探高點失敗後回落跌破中間谷底，確認反轉下跌。',
        '目標價位＝頸線 −（頂部均價 − 頸線）。',
        vol ? '帶量跌破，賣壓確認。' : '注意：跌破時量能不大，可能為假跌破。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// 4. 雙重底 / W底 (Double Bottom) — 第8章
// ═══════════════════════════════════════════════════════════════════════════════

export const doubleBottom: TradingRule = {
  id: 'em-double-bottom',
  name: '雙重底 / W底 (Double Bottom)',
  description: '兩個接近等低的低點，突破中間高點確認反轉',
  evaluate(candles, index): RuleSignal | null {
    if (index < 20) return null;

    const lows = findSwingLows(candles, index, 40, 3);
    if (lows.length < 2) return null;

    const l1 = lows[lows.length - 2];
    const l2 = lows[lows.length - 1];

    if (!priceNear(l1.price, l2.price, 0.03)) return null;
    if (l2.idx - l1.idx < 5) return null;

    let neckPrice = -Infinity;
    for (let i = l1.idx + 1; i < l2.idx; i++) {
      if (candles[i].high > neckPrice) neckPrice = candles[i].high;
    }
    if (neckPrice === -Infinity) return null;

    const c = candles[index];
    if (c.close <= neckPrice) return null;

    const vol = isVolumeBreakout(c);
    return {
      type: vol ? 'BUY' : 'WATCH',
      label: 'W底確認',
      description: `第一底(${l1.price.toFixed(2)}) 第二底(${l2.price.toFixed(2)})，突破頸線 ${neckPrice.toFixed(2)}`,
      reason: [
        '【Edwards & Magee《股市趨勢技術分析》第8章】雙重底（W底）是底部反轉的經典型態。',
        '第二次探底不破前低，隨後突破中間高點，確認反轉上漲。',
        '突破頸線時成交量放大是重要確認。',
        vol ? '帶量突破，多頭確認。' : '突破量不足，建議等回測頸線確認再進場。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// 5. 三重頂 (Triple Top) — 第8章
// ═══════════════════════════════════════════════════════════════════════════════

export const tripleTop: TradingRule = {
  id: 'em-triple-top',
  name: '三重頂 (Triple Top)',
  description: '三個接近等高的高點，跌破支撐確認反轉',
  evaluate(candles, index): RuleSignal | null {
    if (index < 30) return null;

    const highs = findSwingHighs(candles, index, 60, 3);
    if (highs.length < 3) return null;

    const h1 = highs[highs.length - 3];
    const h2 = highs[highs.length - 2];
    const h3 = highs[highs.length - 1];

    // 三頂接近等高（兩兩容差 4%）
    if (!priceNear(h1.price, h2.price, 0.04)) return null;
    if (!priceNear(h2.price, h3.price, 0.04)) return null;

    // 找支撐線：三頂之間兩個谷底的較低者
    let valley1 = Infinity, valley2 = Infinity;
    for (let i = h1.idx + 1; i < h2.idx; i++) {
      if (candles[i].low < valley1) valley1 = candles[i].low;
    }
    for (let i = h2.idx + 1; i < h3.idx; i++) {
      if (candles[i].low < valley2) valley2 = candles[i].low;
    }
    const support = Math.min(valley1, valley2);
    if (!isFinite(support)) return null;

    const c = candles[index];
    if (c.close >= support) return null;

    const vol = isVolumeBreakout(c);
    return {
      type: vol ? 'SELL' : 'WATCH',
      label: '三重頂確認',
      description: `三頂(${h1.price.toFixed(2)}, ${h2.price.toFixed(2)}, ${h3.price.toFixed(2)})，跌破支撐 ${support.toFixed(2)}`,
      reason: [
        '【Edwards & Magee《股市趨勢技術分析》第8章】三重頂比雙重頂更罕見但更可靠。',
        '股價三次試探高點均失敗，跌破底部支撐線後確認反轉。',
        '型態完成時間越長，後續行情越大。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// 6. 三重底 (Triple Bottom) — 第8章
// ═══════════════════════════════════════════════════════════════════════════════

export const tripleBottom: TradingRule = {
  id: 'em-triple-bottom',
  name: '三重底 (Triple Bottom)',
  description: '三個接近等低的低點，突破壓力確認反轉',
  evaluate(candles, index): RuleSignal | null {
    if (index < 30) return null;

    const lows = findSwingLows(candles, index, 60, 3);
    if (lows.length < 3) return null;

    const l1 = lows[lows.length - 3];
    const l2 = lows[lows.length - 2];
    const l3 = lows[lows.length - 1];

    if (!priceNear(l1.price, l2.price, 0.04)) return null;
    if (!priceNear(l2.price, l3.price, 0.04)) return null;

    let peak1 = -Infinity, peak2 = -Infinity;
    for (let i = l1.idx + 1; i < l2.idx; i++) {
      if (candles[i].high > peak1) peak1 = candles[i].high;
    }
    for (let i = l2.idx + 1; i < l3.idx; i++) {
      if (candles[i].high > peak2) peak2 = candles[i].high;
    }
    const resistance = Math.max(peak1, peak2);
    if (!isFinite(resistance)) return null;

    const c = candles[index];
    if (c.close <= resistance) return null;

    const vol = isVolumeBreakout(c);
    return {
      type: vol ? 'BUY' : 'WATCH',
      label: '三重底確認',
      description: `三底(${l1.price.toFixed(2)}, ${l2.price.toFixed(2)}, ${l3.price.toFixed(2)})，突破壓力 ${resistance.toFixed(2)}`,
      reason: [
        '【Edwards & Magee《股市趨勢技術分析》第8章】三重底是強力的底部反轉訊號。',
        '三次探底不破，加上突破頂部壓力線，確認多頭反轉。',
        '突破時成交量應明顯放大以確認信號有效性。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// 7. 對稱三角形 (Symmetrical Triangle) — 第9章
// ═══════════════════════════════════════════════════════════════════════════════

export const symmetricalTriangle: TradingRule = {
  id: 'em-symmetrical-triangle',
  name: '對稱三角形突破 (Symmetrical Triangle)',
  description: '高點遞降+低點遞升收斂，突破方向跟進',
  evaluate(candles, index): RuleSignal | null {
    if (index < 20) return null;

    const highs = findSwingHighs(candles, index, 40, 2);
    const lows = findSwingLows(candles, index, 40, 2);
    if (highs.length < 2 || lows.length < 2) return null;

    // 取最後 2-3 個 swing points
    const recentHighs = highs.slice(-3);
    const recentLows = lows.slice(-3);

    // 高點必須遞降
    const highReg = linearRegression(recentHighs.map(h => ({ x: h.idx, y: h.price })));
    if (highReg.slope >= 0) return null;

    // 低點必須遞升
    const lowReg = linearRegression(recentLows.map(l => ({ x: l.idx, y: l.price })));
    if (lowReg.slope <= 0) return null;

    // 收斂角度：上邊向下、下邊向上 → 對稱
    const upperLine = highReg.slope * index + highReg.intercept;
    const lowerLine = lowReg.slope * index + lowReg.intercept;

    // 三角形必須仍有空間（上線 > 下線）
    if (upperLine <= lowerLine) return null;

    const c = candles[index];
    const vol = isVolumeBreakout(c);

    // 向上突破
    if (c.close > upperLine) {
      return {
        type: vol ? 'BUY' : 'WATCH',
        label: '三角形向上突破',
        description: `對稱三角形收斂後向上突破，收盤 ${c.close.toFixed(2)} > 上邊線 ${upperLine.toFixed(2)}`,
        reason: [
          '【Edwards & Magee《股市趨勢技術分析》第9章】對稱三角形是中性型態，突破方向決定後續趨勢。',
          '向上突破應伴隨成交量放大。突破通常發生在三角形的 2/3 處（從起點到頂點）。',
          '目標價位＝突破點 + 三角形最寬處的高度。',
          vol ? '帶量突破，信號可靠。' : '注意：量能不足，可能為假突破。',
        ].join('\n'),
        ruleId: this.id,
      };
    }

    // 向下突破
    if (c.close < lowerLine) {
      return {
        type: vol ? 'SELL' : 'WATCH',
        label: '三角形向下突破',
        description: `對稱三角形收斂後向下突破，收盤 ${c.close.toFixed(2)} < 下邊線 ${lowerLine.toFixed(2)}`,
        reason: [
          '【Edwards & Magee《股市趨勢技術分析》第9章】對稱三角形向下突破，確認空頭。',
          '向下突破不一定需要大量（與向上突破不同），但後續反彈縮量更能確認。',
          vol ? '帶量跌破，賣壓確認。' : '量能偏低但方向明確，觀察後續走勢確認。',
        ].join('\n'),
        ruleId: this.id,
      };
    }

    return null;
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// 8. 上升三角形 (Ascending Triangle) — 第9章
// ═══════════════════════════════════════════════════════════════════════════════

export const ascendingTriangle: TradingRule = {
  id: 'em-ascending-triangle',
  name: '上升三角形突破 (Ascending Triangle)',
  description: '水平壓力線+遞升低點，向上突破為多頭信號',
  evaluate(candles, index): RuleSignal | null {
    if (index < 20) return null;

    const highs = findSwingHighs(candles, index, 40, 2);
    const lows = findSwingLows(candles, index, 40, 2);
    if (highs.length < 2 || lows.length < 2) return null;

    const recentHighs = highs.slice(-3);
    const recentLows = lows.slice(-3);

    // 高點接近水平（容差 2%）
    const highAvg = recentHighs.reduce((s, h) => s + h.price, 0) / recentHighs.length;
    const allHighsNearFlat = recentHighs.every(h => priceNear(h.price, highAvg, 0.02));
    if (!allHighsNearFlat) return null;

    // 低點遞升
    const lowReg = linearRegression(recentLows.map(l => ({ x: l.idx, y: l.price })));
    if (lowReg.slope <= 0) return null;

    const c = candles[index];
    if (c.close <= highAvg) return null;

    const vol = isVolumeBreakout(c);
    return {
      type: vol ? 'BUY' : 'WATCH',
      label: '上升三角形突破',
      description: `水平壓力 ${highAvg.toFixed(2)} 被突破，收盤 ${c.close.toFixed(2)}，低點持續墊高`,
      reason: [
        '【Edwards & Magee《股市趨勢技術分析》第9章】上升三角形是偏多的持續型態。',
        '買方力量持續增強（低點墊高），最終突破水平壓力線。',
        '突破時成交量應明顯放大，約 90% 的情況向上突破。',
        vol ? '帶量突破壓力線，多頭確認。' : '量能不足，等回測壓力線轉支撐再進場。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// 9. 下降三角形 (Descending Triangle) — 第9章
// ═══════════════════════════════════════════════════════════════════════════════

export const descendingTriangle: TradingRule = {
  id: 'em-descending-triangle',
  name: '下降三角形跌破 (Descending Triangle)',
  description: '水平支撐線+遞降高點，向下跌破為空頭信號',
  evaluate(candles, index): RuleSignal | null {
    if (index < 20) return null;

    const highs = findSwingHighs(candles, index, 40, 2);
    const lows = findSwingLows(candles, index, 40, 2);
    if (highs.length < 2 || lows.length < 2) return null;

    const recentHighs = highs.slice(-3);
    const recentLows = lows.slice(-3);

    // 低點接近水平
    const lowAvg = recentLows.reduce((s, l) => s + l.price, 0) / recentLows.length;
    const allLowsNearFlat = recentLows.every(l => priceNear(l.price, lowAvg, 0.02));
    if (!allLowsNearFlat) return null;

    // 高點遞降
    const highReg = linearRegression(recentHighs.map(h => ({ x: h.idx, y: h.price })));
    if (highReg.slope >= 0) return null;

    const c = candles[index];
    if (c.close >= lowAvg) return null;

    const vol = isVolumeBreakout(c);
    return {
      type: vol ? 'SELL' : 'WATCH',
      label: '下降三角形跌破',
      description: `水平支撐 ${lowAvg.toFixed(2)} 被跌破，收盤 ${c.close.toFixed(2)}，高點持續壓低`,
      reason: [
        '【Edwards & Magee《股市趨勢技術分析》第9章】下降三角形是偏空的型態。',
        '賣方力量持續增強（高點壓低），最終跌破水平支撐線。',
        '跌破支撐不一定需要大量，但後續反彈縮量是確認。',
        vol ? '帶量跌破支撐，空頭確認。' : '量能偏低，觀察是否為假跌破。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// 10. 旗形 — 多頭旗 (Bull Flag) — 第10章
// ═══════════════════════════════════════════════════════════════════════════════

export const bullFlag: TradingRule = {
  id: 'em-bull-flag',
  name: '多頭旗形突破 (Bull Flag)',
  description: '急漲後向下傾斜的平行通道整理，突破上邊線繼續上漲',
  evaluate(candles, index): RuleSignal | null {
    if (index < 15) return null;

    // 先確認前段急漲（lookback 5~15 根內漲幅 > 8%）
    let poleFound = false;
    let poleEnd = -1;
    for (let back = 5; back <= 15 && back <= index; back++) {
      const change = priceChangePercent(candles, index - 5, back - 5);
      if (change > 0.08) {
        poleFound = true;
        poleEnd = index - 5;
        break;
      }
    }
    if (!poleFound || poleEnd < 0) return null;

    // 旗面：poleEnd 到 index 之間的整理（向下傾斜）
    const flagCandles = candles.slice(poleEnd, index + 1);
    if (flagCandles.length < 3) return null;

    const flagHighs = flagCandles.map((c, i) => ({ x: i, y: c.high }));
    const flagLows = flagCandles.map((c, i) => ({ x: i, y: c.low }));
    const highReg = linearRegression(flagHighs);
    const lowReg = linearRegression(flagLows);

    // 旗面應向下傾斜（高點和低點都下降）
    if (highReg.slope >= 0 || lowReg.slope >= 0) return null;

    // 當前突破旗面上邊
    const upperBound = highReg.slope * (flagCandles.length - 1) + highReg.intercept;
    const c = candles[index];
    if (c.close <= upperBound) return null;

    const vol = isVolumeBreakout(c);
    return {
      type: vol ? 'BUY' : 'WATCH',
      label: '多頭旗形突破',
      description: `急漲後旗形整理 ${flagCandles.length} 天，收盤 ${c.close.toFixed(2)} 突破旗面上沿`,
      reason: [
        '【Edwards & Magee《股市趨勢技術分析》第10章】旗形是最可靠的持續型態之一。',
        '急漲（旗桿）後出現向下傾斜的短期整理（旗面），突破後通常延續原趨勢。',
        '目標價位＝突破點 + 旗桿長度。旗形整理時間通常為 1~3 週。',
        vol ? '帶量突破旗面，多頭延續確認。' : '量能偏低，注意假突破風險。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// 11. 旗形 — 空頭旗 (Bear Flag) — 第10章
// ═══════════════════════════════════════════════════════════════════════════════

export const bearFlag: TradingRule = {
  id: 'em-bear-flag',
  name: '空頭旗形跌破 (Bear Flag)',
  description: '急跌後向上傾斜的平行通道整理，跌破下邊線繼續下跌',
  evaluate(candles, index): RuleSignal | null {
    if (index < 15) return null;

    let poleFound = false;
    let poleEnd = -1;
    for (let back = 5; back <= 15 && back <= index; back++) {
      const change = priceChangePercent(candles, index - 5, back - 5);
      if (change < -0.08) {
        poleFound = true;
        poleEnd = index - 5;
        break;
      }
    }
    if (!poleFound || poleEnd < 0) return null;

    const flagCandles = candles.slice(poleEnd, index + 1);
    if (flagCandles.length < 3) return null;

    const flagHighs = flagCandles.map((c, i) => ({ x: i, y: c.high }));
    const flagLows = flagCandles.map((c, i) => ({ x: i, y: c.low }));
    const highReg = linearRegression(flagHighs);
    const lowReg = linearRegression(flagLows);

    // 旗面應向上傾斜
    if (highReg.slope <= 0 || lowReg.slope <= 0) return null;

    const lowerBound = lowReg.slope * (flagCandles.length - 1) + lowReg.intercept;
    const c = candles[index];
    if (c.close >= lowerBound) return null;

    const vol = isVolumeBreakout(c);
    return {
      type: vol ? 'SELL' : 'WATCH',
      label: '空頭旗形跌破',
      description: `急跌後旗形整理 ${flagCandles.length} 天，收盤 ${c.close.toFixed(2)} 跌破旗面下沿`,
      reason: [
        '【Edwards & Magee《股市趨勢技術分析》第10章】空頭旗形是下跌趨勢的持續型態。',
        '急跌（旗桿）後出現向上傾斜的短期反彈整理，跌破後延續下跌。',
        '目標價位＝跌破點 − 旗桿長度。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// 12. 上升楔形 (Rising Wedge) — 第10章
// ═══════════════════════════════════════════════════════════════════════════════

export const risingWedge: TradingRule = {
  id: 'em-rising-wedge',
  name: '上升楔形跌破 (Rising Wedge)',
  description: '高低點同步上升但收斂，跌破下邊線為看空信號',
  evaluate(candles, index): RuleSignal | null {
    if (index < 20) return null;

    const highs = findSwingHighs(candles, index, 40, 2);
    const lows = findSwingLows(candles, index, 40, 2);
    if (highs.length < 2 || lows.length < 2) return null;

    const highReg = linearRegression(highs.slice(-3).map(h => ({ x: h.idx, y: h.price })));
    const lowReg = linearRegression(lows.slice(-3).map(l => ({ x: l.idx, y: l.price })));

    // 兩條線都向上（上升楔形）
    if (highReg.slope <= 0 || lowReg.slope <= 0) return null;
    // 上邊線斜率小於下邊線斜率 → 收斂
    if (highReg.slope >= lowReg.slope) return null;

    const lowerLine = lowReg.slope * index + lowReg.intercept;
    const c = candles[index];
    if (c.close >= lowerLine) return null;

    const vol = isVolumeBreakout(c);
    return {
      type: vol ? 'SELL' : 'WATCH',
      label: '上升楔形跌破',
      description: `上升楔形收斂後跌破下邊線 ${lowerLine.toFixed(2)}，收盤 ${c.close.toFixed(2)}`,
      reason: [
        '【Edwards & Magee《股市趨勢技術分析》第10章】上升楔形是看空型態。',
        '雖然高低點都在上升，但漲勢逐漸疲弱（收斂），最終跌破下邊支撐線。',
        '上升楔形通常出現在空頭市場的反彈中，完成後恢復下跌。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// 13. 下降楔形 (Falling Wedge) — 第10章
// ═══════════════════════════════════════════════════════════════════════════════

export const fallingWedge: TradingRule = {
  id: 'em-falling-wedge',
  name: '下降楔形突破 (Falling Wedge)',
  description: '高低點同步下降但收斂，突破上邊線為看多信號',
  evaluate(candles, index): RuleSignal | null {
    if (index < 20) return null;

    const highs = findSwingHighs(candles, index, 40, 2);
    const lows = findSwingLows(candles, index, 40, 2);
    if (highs.length < 2 || lows.length < 2) return null;

    const highReg = linearRegression(highs.slice(-3).map(h => ({ x: h.idx, y: h.price })));
    const lowReg = linearRegression(lows.slice(-3).map(l => ({ x: l.idx, y: l.price })));

    // 兩條線都向下（下降楔形）
    if (highReg.slope >= 0 || lowReg.slope >= 0) return null;
    // 下邊線斜率的絕對值小於上邊線 → 收斂
    if (Math.abs(lowReg.slope) >= Math.abs(highReg.slope)) return null;

    const upperLine = highReg.slope * index + highReg.intercept;
    const c = candles[index];
    if (c.close <= upperLine) return null;

    const vol = isVolumeBreakout(c);
    return {
      type: vol ? 'BUY' : 'WATCH',
      label: '下降楔形突破',
      description: `下降楔形收斂後突破上邊線 ${upperLine.toFixed(2)}，收盤 ${c.close.toFixed(2)}`,
      reason: [
        '【Edwards & Magee《股市趨勢技術分析》第10章】下降楔形是看多型態。',
        '雖然高低點都在下降，但跌勢逐漸收斂，最終突破上邊壓力線。',
        '下降楔形通常出現在多頭市場的回檔中，完成後恢復上漲。',
        vol ? '帶量突破，多頭信號確認。' : '量能偏低，等回測確認再進場。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// 14. 矩形突破 (Rectangle) — 第10章
// ═══════════════════════════════════════════════════════════════════════════════

export const rectangleBreakout: TradingRule = {
  id: 'em-rectangle-breakout',
  name: '矩形突破 (Rectangle Breakout)',
  description: '水平支撐+壓力之間盤整，突破方向跟進',
  evaluate(candles, index): RuleSignal | null {
    if (index < 15) return null;

    const highs = findSwingHighs(candles, index, 40, 2);
    const lows = findSwingLows(candles, index, 40, 2);
    if (highs.length < 2 || lows.length < 2) return null;

    const recentHighs = highs.slice(-3);
    const recentLows = lows.slice(-3);

    // 高點接近水平
    const highAvg = recentHighs.reduce((s, h) => s + h.price, 0) / recentHighs.length;
    const allHighsFlat = recentHighs.every(h => priceNear(h.price, highAvg, 0.02));
    if (!allHighsFlat) return null;

    // 低點也接近水平
    const lowAvg = recentLows.reduce((s, l) => s + l.price, 0) / recentLows.length;
    const allLowsFlat = recentLows.every(l => priceNear(l.price, lowAvg, 0.02));
    if (!allLowsFlat) return null;

    // 矩形高度需要有意義（至少 3%）
    if ((highAvg - lowAvg) / lowAvg < 0.03) return null;

    const c = candles[index];
    const vol = isVolumeBreakout(c);

    if (c.close > highAvg) {
      return {
        type: vol ? 'BUY' : 'WATCH',
        label: '矩形向上突破',
        description: `矩形整理(${lowAvg.toFixed(2)}~${highAvg.toFixed(2)})向上突破，收盤 ${c.close.toFixed(2)}`,
        reason: [
          '【Edwards & Magee《股市趨勢技術分析》第10章】矩形是多空拉鋸的整理型態。',
          '突破方向通常延續先前趨勢。向上突破應伴隨量增。',
          '目標價位＝突破點 + 矩形高度。',
          vol ? '帶量突破壓力，多頭確認。' : '量能不足，警惕假突破。',
        ].join('\n'),
        ruleId: this.id,
      };
    }

    if (c.close < lowAvg) {
      return {
        type: vol ? 'SELL' : 'WATCH',
        label: '矩形向下跌破',
        description: `矩形整理(${lowAvg.toFixed(2)}~${highAvg.toFixed(2)})向下跌破，收盤 ${c.close.toFixed(2)}`,
        reason: [
          '【Edwards & Magee《股市趨勢技術分析》第10章】矩形向下跌破，空頭延續。',
          '目標價位＝跌破點 − 矩形高度。',
        ].join('\n'),
        ruleId: this.id,
      };
    }

    return null;
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// 15. 擴散型態 (Broadening Formation) — 第11章
// ═══════════════════════════════════════════════════════════════════════════════

export const broadeningTop: TradingRule = {
  id: 'em-broadening-top',
  name: '擴散頂部 (Broadening Top)',
  description: '高點越來越高+低點越來越低，市場不穩定的頂部警告',
  evaluate(candles, index): RuleSignal | null {
    if (index < 20) return null;

    const highs = findSwingHighs(candles, index, 40, 2);
    const lows = findSwingLows(candles, index, 40, 2);
    if (highs.length < 2 || lows.length < 2) return null;

    const recentHighs = highs.slice(-3);
    const recentLows = lows.slice(-3);

    // 高點遞增
    const highReg = linearRegression(recentHighs.map(h => ({ x: h.idx, y: h.price })));
    if (highReg.slope <= 0) return null;

    // 低點遞減
    const lowReg = linearRegression(recentLows.map(l => ({ x: l.idx, y: l.price })));
    if (lowReg.slope >= 0) return null;

    // 當前收盤跌破最近低點 → 確認
    const lastLow = recentLows[recentLows.length - 1];
    const c = candles[index];
    if (c.close >= lastLow.price) return null;

    return {
      type: 'SELL',
      label: '擴散頂部警告',
      description: `高點持續創新高但低點也持續創新低，市場極度不穩定，收盤 ${c.close.toFixed(2)} 跌破近期低點`,
      reason: [
        '【Edwards & Magee《股市趨勢技術分析》第11章】擴散型態代表市場失控、波動加劇。',
        '通常出現在多頭末期，是市場情緒極端不穩定的訊號。',
        '一旦跌破最近的低點，往往引發快速下跌。此型態較少出現在底部。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// 16. 圓形底 / 碟形底 (Rounding Bottom / Saucer) — 第9章
// ═══════════════════════════════════════════════════════════════════════════════

export const roundingBottom: TradingRule = {
  id: 'em-rounding-bottom',
  name: '圓形底 / 碟形底 (Rounding Bottom)',
  description: 'MA20 從下彎→走平→上揚，價格漸進回升，底部反轉',
  evaluate(candles, index): RuleSignal | null {
    if (index < 40) return null;

    // 階段1：20根前 MA20 下彎
    const wasDown = isMaTrendingDown(candles, index - 20, 'ma20', 5);
    // 階段2：10根前 MA20 走平（變化率很小）
    const ma20_10ago = candles[index - 10]?.ma20;
    const ma20_15ago = candles[index - 15]?.ma20;
    const isFlat = ma20_10ago != null && ma20_15ago != null &&
      Math.abs(ma20_10ago - ma20_15ago) / ma20_15ago < 0.005;
    // 階段3：當前 MA20 上揚
    const isUp = isMaTrendingUp(candles, index, 'ma20', 5);

    if (!wasDown || !isFlat || !isUp) return null;

    // 價格已站上 MA20
    const c = candles[index];
    if (c.ma20 == null || c.close <= c.ma20) return null;

    const vol = isVolumeBreakout(c);
    return {
      type: vol ? 'BUY' : 'WATCH',
      label: '圓形底成形',
      description: `MA20 從下彎→走平→上揚，價格站上 MA20(${c.ma20.toFixed(2)})，底部反轉`,
      reason: [
        '【Edwards & Magee《股市趨勢技術分析》第9章】圓形底（碟形底）是漸進式的底部反轉。',
        '成交量通常也呈碟形：在底部最低點量能最低，隨後隨價格上升而逐步放大。',
        '圓形底完成時間越長，後續上漲空間越大。',
        vol ? '量能配合放大，底部反轉確認。' : '量能尚未明顯放大，持續觀察。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// 全部 Edwards & Magee 經典型態規則
// ═══════════════════════════════════════════════════════════════════════════════

export const EDWARDS_MAGEE_RULES: TradingRule[] = [
  // 反轉型態
  headAndShouldersTop,
  headAndShouldersBottom,
  doubleTop,
  doubleBottom,
  tripleTop,
  tripleBottom,
  broadeningTop,
  roundingBottom,
  // 持續型態
  symmetricalTriangle,
  ascendingTriangle,
  descendingTriangle,
  bullFlag,
  bearFlag,
  risingWedge,
  fallingWedge,
  rectangleBreakout,
];
