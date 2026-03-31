/**
 * 朱家泓《抓住K線 獲利無限》第5篇 — 行進中的K線組合
 * 上漲中 8 種 + 下跌中 7 種 = 15 條規則
 */
import { TradingRule, RuleSignal } from '@/types';
import {
  isLongRedCandle, isLongBlackCandle, isSmallCandle, isDoji,
  isRedCandle, isBlackCandle, hasLongUpperShadow, isMedLongRed, isMedLongBlack,
  gapUp, gapDown, isUptrendWave, isDowntrendWave, halfPrice,
} from './ruleUtils';

// ═══════════════════════════════════════════
// 上漲中的 K 線組合（第5篇第1章）
// ═══════════════════════════════════════════

/** 組合1：一星二陽 — 上漲中繼，後續還有高點 */
export const oneStarTwoYang: TradingRule = {
  id: 'kline-one-star-two-yang',
  name: '一星二陽（上漲中繼）',
  description: '中長紅K + 變盤線(星) + 中長紅K過高，上漲趨勢不變',
  evaluate(candles, index): RuleSignal | null {
    if (index < 4) return null;
    const c0 = candles[index - 2]; // 第1根：中長紅
    const c1 = candles[index - 1]; // 第2根：星（變盤線）
    const c2 = candles[index];     // 第3根：中長紅過高

    if (!isMedLongRed(c0)) return null;
    if (!isSmallCandle(c1)) return null;
    // 星的收盤不能跌破前一天K線最低點
    if (c1.close < c0.low) return null;
    if (!isMedLongRed(c2)) return null;
    // 第3根高點要過第1根高點
    if (c2.high <= c0.high) return null;
    // 需要在上漲趨勢中
    if (!isUptrendWave(candles, index, 8)) return null;

    return {
      type: 'BUY',
      label: '一星二陽續漲',
      description: `中長紅(${c0.close.toFixed(2)}) + 星線 + 中長紅過高(${c2.close.toFixed(2)})`,
      reason: '【朱家泓《抓住K線》第5篇 組合1】一星二陽是上漲中繼訊號，表示多方短暫休息後再攻，後續還有高點。注意：此訊號僅在多頭起攻位置有效，高檔出現則可能是夜星轉折。',
      ruleId: this.id,
    };
  },
};

/** 組合2：上升三法 — 回跌不破長紅低點，上漲中繼 */
export const risingThreeMethods: TradingRule = {
  id: 'kline-rising-three-methods',
  name: '上升三法（上漲中繼）',
  description: '長紅後回跌1~3根小K不破低，再長紅吞噬回跌K線',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const c = candles[index]; // 當前K線（應為長紅吞噬）

    if (!isMedLongRed(c)) return null;

    // 向前找：最近2~4根裡是否有「長紅 + 小K回跌不破低」的結構
    for (let gap = 2; gap <= 4; gap++) {
      if (index - gap < 0) break;
      const anchor = candles[index - gap]; // 前面的長紅
      if (!isMedLongRed(anchor)) continue;

      // 中間的K線都要是小K且收盤不破 anchor 低點
      let valid = true;
      let maxVolMid = 0;
      for (let m = index - gap + 1; m < index; m++) {
        const mid = candles[m];
        if (!isSmallCandle(mid) && !isDoji(mid)) { valid = false; break; }
        if (mid.close < anchor.low) { valid = false; break; }
        maxVolMid = Math.max(maxVolMid, mid.volume);
      }
      if (!valid) continue;

      // 當前長紅要吞噬中間小K，且收盤過 anchor 高點
      if (c.close <= anchor.high) continue;
      // 回跌小K要維持在 anchor 1/2 價之上（強勢整理）
      const anchorHalf = halfPrice(anchor);
      let allAboveHalf = true;
      for (let m = index - gap + 1; m < index; m++) {
        if (candles[m].close < anchorHalf) { allAboveHalf = false; break; }
      }

      return {
        type: 'BUY',
        label: '上升三法續漲',
        description: `長紅(${anchor.close.toFixed(2)}) → ${gap - 1}根小K回跌不破低 → 長紅吞噬(${c.close.toFixed(2)})`,
        reason: [
          '【朱家泓《抓住K線》第5篇 組合2】上升三法是經典上漲中繼型態，回跌是主力洗盤清籌碼。',
          allAboveHalf ? '回跌K線維持在長紅1/2價之上，屬強勢整理。' : '回跌K線跌入長紅下半部，整理力道偏弱。',
          '後面長紅K線低點不能被跌破，否則會破壞上升三法架構。',
        ].join('\n'),
        ruleId: this.id,
      };
    }
    return null;
  },
};

/** 組合3：三線反紅 — 回跌小K被長紅吞噬，續攻訊號 */
export const threeLineReverseRed: TradingRule = {
  id: 'kline-three-line-reverse-red',
  name: '三線反紅（多方強力表態）',
  description: '連續3根小紅黑回跌後出現1根長紅吞噬，成交量放大',
  evaluate(candles, index): RuleSignal | null {
    if (index < 4) return null;
    const c = candles[index];
    if (!isLongRedCandle(c)) return null;

    // 前面至少3根小K
    let smallCount = 0;
    let highestHigh = -Infinity;
    let lowestLow = Infinity;
    let maxVol = 0;
    for (let i = index - 1; i >= Math.max(0, index - 5); i--) {
      const prev = candles[i];
      if (isSmallCandle(prev) || isDoji(prev)) {
        smallCount++;
        highestHigh = Math.max(highestHigh, prev.high);
        lowestLow = Math.min(lowestLow, prev.low);
        maxVol = Math.max(maxVol, prev.volume);
      } else {
        break;
      }
    }
    if (smallCount < 3) return null;

    // 長紅收盤要突破前面小K最高點
    if (c.close <= highestHigh) return null;
    // 長紅成交量要大於前面小K最大量
    if (c.volume <= maxVol) return null;

    return {
      type: 'BUY',
      label: '三線反紅續攻',
      description: `${smallCount}根小K回跌後，長紅(${c.close.toFixed(2)})吞噬突破，量增確認`,
      reason: '【朱家泓《抓住K線》第5篇 組合3】三線反紅必須符合2個條件：(1)長紅收盤突破前面小K最高點；(2)成交量大於前面小K最高量。在多頭趨勢中短線拉回沒有跌破長紅低點，要找買點進場。',
      ruleId: this.id,
    };
  },
};

/** 組合4：連三紅 — 底底高連續紅K，多頭強勢 */
export const threeConsecutiveRed: TradingRule = {
  id: 'kline-three-consecutive-red',
  name: '連三紅（多頭強勢）',
  description: '連續3根底底高紅K線，多頭氣勢強',
  evaluate(candles, index): RuleSignal | null {
    if (index < 3) return null;
    const c0 = candles[index - 2];
    const c1 = candles[index - 1];
    const c2 = candles[index];

    // 三根都收紅
    if (!isRedCandle(c0) || !isRedCandle(c1) || !isRedCandle(c2)) return null;
    // 底底高：每根低點比前一根高
    if (c1.low <= c0.low || c2.low <= c1.low) return null;
    // 頭頭高：每根高點比前一根高
    if (c1.high <= c0.high || c2.high <= c1.high) return null;
    // 至少有一根是中長紅
    if (!isMedLongRed(c0) && !isMedLongRed(c1) && !isMedLongRed(c2)) return null;

    return {
      type: 'BUY',
      label: '連三紅強勢',
      description: `連續3根底底高紅K: ${c0.close.toFixed(2)} → ${c1.close.toFixed(2)} → ${c2.close.toFixed(2)}`,
      reason: '【朱家泓《抓住K線》第5篇 組合4】連三紅代表多方向上的企圖強，是多方力量的聚集。連續紅K數量越多，上漲力量越大。若出現在底部起漲位置配合大量跳空，是強勢多頭型態。',
      ruleId: this.id,
    };
  },
};

/** 組合5：紅黑紅 — 上漲中繼階梯式上升 */
export const redBlackRed: TradingRule = {
  id: 'kline-red-black-red',
  name: '紅黑紅（上漲中繼）',
  description: '上漲中出現紅K、黑K、紅K的階梯式上升',
  evaluate(candles, index): RuleSignal | null {
    if (index < 3) return null;
    const c0 = candles[index - 2];
    const c1 = candles[index - 1];
    const c2 = candles[index];

    if (!isRedCandle(c0) || !isBlackCandle(c1) || !isRedCandle(c2)) return null;
    // 頭頭高、底底高（階梯式上升）
    if (c1.high <= c0.high || c2.high <= c1.high) return null;
    if (c1.low <= c0.low || c2.low <= c1.low) return null;
    // 需要在上漲趨勢中
    if (!isUptrendWave(candles, index, 8)) return null;

    return {
      type: 'WATCH',
      label: '紅黑紅中繼',
      description: `上漲階梯: 紅(${c0.close.toFixed(2)}) → 黑(${c1.close.toFixed(2)}) → 紅(${c2.close.toFixed(2)})`,
      reason: '【朱家泓《抓住K線》第5篇 組合5】紅黑紅組合是上漲中繼，中間黑K是主力洗盤，不要因為1根黑K而被誤導。階梯式上升後續通常還有高點。',
      ruleId: this.id,
    };
  },
};

/** 組合6：碎步上漲 — 多根小K緩步走高 */
export const smallStepUp: TradingRule = {
  id: 'kline-small-step-up',
  name: '碎步上漲（蓄勢待發）',
  description: '連續5根以上小紅小黑K線維持小幅上漲',
  evaluate(candles, index): RuleSignal | null {
    if (index < 6) return null;

    let count = 0;
    for (let i = index; i >= Math.max(0, index - 9); i--) {
      if (isSmallCandle(candles[i]) || isDoji(candles[i])) {
        count++;
      } else {
        break;
      }
    }
    if (count < 5) return null;

    // 整體要微幅上漲
    const start = candles[index - count + 1];
    const end = candles[index];
    const change = (end.close - start.close) / start.close;
    if (change <= 0 || change > 0.05) return null; // 微幅上漲但不超過5%

    return {
      type: 'WATCH',
      label: '碎步上漲蓄勢',
      description: `連續${count}根小K緩步上漲 ${(change * 100).toFixed(1)}%，隨時可能發動大漲`,
      reason: '【朱家泓《抓住K線》第5篇 組合6】碎步上漲是主力慢慢吸籌的型態，隨時都可能發動大漲，出現中長紅K線的走勢。要把握上攻的機會進場。',
      ruleId: this.id,
    };
  },
};

/** 組合7：大敵當前 — 高檔連續紅K帶長上影線，出貨警示 */
export const majorResistanceAhead: TradingRule = {
  id: 'kline-major-resistance-ahead',
  name: '大敵當前（高檔出貨警示）',
  description: '上漲到高檔，連續紅K出現明顯上影線',
  evaluate(candles, index): RuleSignal | null {
    if (index < 4) return null;

    // 檢查最近3根是否都是紅K帶長上影線
    let shadowRedCount = 0;
    for (let i = index; i >= index - 2; i--) {
      const c = candles[i];
      if (isRedCandle(c) && hasLongUpperShadow(c)) {
        shadowRedCount++;
      }
    }
    if (shadowRedCount < 3) return null;

    // 需要在高檔位置（近20日相對高位）
    let isHighPos = true;
    for (let i = index - 3; i >= Math.max(0, index - 20); i--) {
      if (candles[i].high > candles[index].high) {
        isHighPos = false;
        break;
      }
    }
    if (!isHighPos) {
      // 如果不在高檔而在底部，這是測試壓力，不是大敵當前
      return null;
    }

    return {
      type: 'SELL',
      label: '大敵當前出貨',
      description: `高檔連續${shadowRedCount}根紅K帶長上影線，主力一邊拉高一邊出貨`,
      reason: '【朱家泓《抓住K線》第5篇 組合7】大敵當前出現在波段高檔末升段，連續紅K上影線越長，拉高出貨越明顯。若同時爆量或價量背離，千萬不要追高。注意：在底部起漲位置的連三紅帶上影線是主力測壓力，不要誤認。',
      ruleId: this.id,
    };
  },
};

/** 組合8：上缺回補 — 向上跳空後黑K回補缺口，轉折向下 */
export const upGapFilled: TradingRule = {
  id: 'kline-up-gap-filled',
  name: '上缺回補（轉折向下）',
  description: '向上跳空缺口後，出現黑K回補缺口',
  evaluate(candles, index): RuleSignal | null {
    if (index < 3) return null;

    // 找最近5根內是否有向上跳空
    for (let g = index - 1; g >= Math.max(1, index - 5); g--) {
      const prev = candles[g - 1];
      const gapCandle = candles[g];
      if (!gapUp(prev, gapCandle)) continue;

      // 當前K線收盤回補缺口（跌破缺口上沿 = gapCandle.low）
      const c = candles[index];
      if (c.close >= gapCandle.low) continue; // 沒回補
      if (!isBlackCandle(c)) continue;

      return {
        type: 'SELL',
        label: '上缺回補反轉',
        description: `向上跳空(${gapCandle.date})後，黑K收盤${c.close.toFixed(2)}回補缺口`,
        reason: '【朱家泓《抓住K線》第5篇 組合8】上缺回補是轉折向下的強烈訊號。多頭高檔出現爆量向上跳空後回補，該缺口成為竭盡缺口，趨勢反轉可能性大。空頭反彈出現此組合，反彈結束繼續下跌。',
        ruleId: this.id,
      };
    }
    return null;
  },
};

// ═══════════════════════════════════════════
// 下跌中的 K 線組合（第5篇第2章）
// ═══════════════════════════════════════════

/** 組合1：一星二陰 — 下跌中繼，後續還有低點 */
export const oneStarTwoYin: TradingRule = {
  id: 'kline-one-star-two-yin',
  name: '一星二陰（下跌中繼）',
  description: '中長黑K + 變盤線(星) + 中長黑K破低，下跌趨勢不變',
  evaluate(candles, index): RuleSignal | null {
    if (index < 4) return null;
    const c0 = candles[index - 2];
    const c1 = candles[index - 1];
    const c2 = candles[index];

    if (!isMedLongBlack(c0)) return null;
    if (!isSmallCandle(c1)) return null;
    // 星的收盤不能突破前一天K線最高點
    if (c1.close > c0.high) return null;
    if (!isMedLongBlack(c2)) return null;
    // 第3根低點要破第1根低點
    if (c2.low >= c0.low) return null;
    // 需要在下跌趨勢中
    if (!isDowntrendWave(candles, index, 8)) return null;

    return {
      type: 'SELL',
      label: '一星二陰續跌',
      description: `中長黑(${c0.close.toFixed(2)}) + 星線 + 中長黑破低(${c2.close.toFixed(2)})`,
      reason: '【朱家泓《抓住K線》第5篇 下跌組合1】一星二陰是下跌中繼訊號，空方主控向下格局。空頭起跌出現第1根中長黑K後次日休息，後面容易再下跌。注意：低檔出現長黑再出現變盤十字線，容易形成晨星向上轉折。',
      ruleId: this.id,
    };
  },
};

/** 組合2：下降三法 — 反彈不破長黑高點，下跌中繼 */
export const fallingThreeMethods: TradingRule = {
  id: 'kline-falling-three-methods',
  name: '下降三法（下跌中繼）',
  description: '長黑後反彈1~3根小K不破高，再長黑吞噬反彈K線',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const c = candles[index];
    if (!isMedLongBlack(c)) return null;

    for (let gap = 2; gap <= 4; gap++) {
      if (index - gap < 0) break;
      const anchor = candles[index - gap];
      if (!isMedLongBlack(anchor)) continue;

      let valid = true;
      for (let m = index - gap + 1; m < index; m++) {
        const mid = candles[m];
        if (!isSmallCandle(mid) && !isDoji(mid)) { valid = false; break; }
        if (mid.close > anchor.high) { valid = false; break; }
      }
      if (!valid) continue;

      if (c.close >= anchor.low) continue;

      const anchorHalf = halfPrice(anchor);
      let allBelowHalf = true;
      for (let m = index - gap + 1; m < index; m++) {
        if (candles[m].close > anchorHalf) { allBelowHalf = false; break; }
      }

      return {
        type: 'SELL',
        label: '下降三法續跌',
        description: `長黑(${anchor.close.toFixed(2)}) → ${gap - 1}根小K反彈不破高 → 長黑吞噬(${c.close.toFixed(2)})`,
        reason: [
          '【朱家泓《抓住K線》第5篇 下跌組合2】下降三法是下跌中繼型態，反彈是散戶低接，力道不強。',
          allBelowHalf ? '反彈K線維持在長黑1/2價之下，屬弱勢整理，隨時大跌。' : '反彈K線進入長黑上半部，但仍未突破高點。',
          '後面長黑K線高點不能被突破，否則會破壞下降三法架構。',
        ].join('\n'),
        ruleId: this.id,
      };
    }
    return null;
  },
};

/** 組合3：三線反黑 — 小紅K被長黑吞噬，反轉或續跌 */
export const threeLineReverseBlack: TradingRule = {
  id: 'kline-three-line-reverse-black',
  name: '三線反黑（空方強力表態）',
  description: '連續3根小紅K上漲後出現1根長黑吞噬，成交量放大',
  evaluate(candles, index): RuleSignal | null {
    if (index < 4) return null;
    const c = candles[index];
    if (!isLongBlackCandle(c)) return null;

    let smallCount = 0;
    let lowestLow = Infinity;
    let maxVol = 0;
    for (let i = index - 1; i >= Math.max(0, index - 5); i--) {
      const prev = candles[i];
      if (isSmallCandle(prev) || isDoji(prev)) {
        smallCount++;
        lowestLow = Math.min(lowestLow, prev.low);
        maxVol = Math.max(maxVol, prev.volume);
      } else {
        break;
      }
    }
    if (smallCount < 3) return null;

    if (c.close >= lowestLow) return null;
    if (c.volume <= maxVol) return null;

    return {
      type: 'SELL',
      label: '三線反黑反轉',
      description: `${smallCount}根小K上漲後，長黑(${c.close.toFixed(2)})吞噬跌破，量增確認`,
      reason: '【朱家泓《抓住K線》第5篇 下跌組合3】三線反黑必須符合2個條件：(1)長黑收盤跌破前面小K最低點；(2)下跌長黑成交量大於前面小K最高量。在多頭趨勢中短線反彈沒有突破長黑高點，很容易形成頭部做空。',
      ruleId: this.id,
    };
  },
};

/** 組合4：內困三黑 — 母子懷抱後跌破確認反轉 */
export const innerThreeBlack: TradingRule = {
  id: 'kline-inner-three-black',
  name: '內困三黑（變盤反轉確認）',
  description: '長紅 + 母子懷抱黑K + 跌破長紅低點的長黑',
  evaluate(candles, index): RuleSignal | null {
    if (index < 3) return null;
    const c0 = candles[index - 2]; // 長紅
    const c1 = candles[index - 1]; // 母子懷抱的黑K（被c0包住）
    const c2 = candles[index];     // 跌破長紅低點的長黑

    if (!isLongRedCandle(c0)) return null;
    // c1 被 c0 包住（母子懷抱）
    if (c1.high > c0.high || c1.low < c0.low) return null;
    if (!isBlackCandle(c1)) return null;
    // c2 跌破 c0 低點
    if (!isMedLongBlack(c2)) return null;
    if (c2.close >= c0.low) return null;

    return {
      type: 'SELL',
      label: '內困三黑反轉',
      description: `長紅(${c0.close.toFixed(2)}) → 母子懷抱黑K → 長黑跌破(${c2.close.toFixed(2)})`,
      reason: '【朱家泓《抓住K線》第5篇 下跌組合4】母子懷抱是變盤訊號，內困三黑是變盤反轉的確認。高檔長紅如果出現大量或爆量，次日形成母子懷抱，後續形成內困三黑的機率很高。長黑跌破長紅低點同時放大量，後續容易急跌。',
      ruleId: this.id,
    };
  },
};

/** 組合5：下跌黑紅黑 — 階梯式下跌，紅K是誘多 */
export const blackRedBlack: TradingRule = {
  id: 'kline-black-red-black',
  name: '下跌黑紅黑（下跌中繼）',
  description: '下跌中出現黑K、紅K、黑K的階梯式下跌',
  evaluate(candles, index): RuleSignal | null {
    if (index < 3) return null;
    const c0 = candles[index - 2];
    const c1 = candles[index - 1];
    const c2 = candles[index];

    if (!isBlackCandle(c0) || !isRedCandle(c1) || !isBlackCandle(c2)) return null;
    // 頭頭低、底底低（階梯式下跌）
    if (c1.high >= c0.high || c2.high >= c1.high) return null;
    if (c1.low >= c0.low || c2.low >= c1.low) return null;
    // 需要在下跌趨勢中
    if (!isDowntrendWave(candles, index, 8)) return null;

    return {
      type: 'SELL',
      label: '黑紅黑誘多',
      description: `下跌階梯: 黑(${c0.close.toFixed(2)}) → 紅(${c1.close.toFixed(2)}) → 黑(${c2.close.toFixed(2)})`,
      reason: '【朱家泓《抓住K線》第5篇 下跌組合5】下跌黑紅黑是繼續下跌的中繼走勢，是空方強勢的訊號。不要因為中間的1根紅K線而被誤導，小心是誘多陷阱。',
      ruleId: this.id,
    };
  },
};

/** 組合6：連三黑 — 頭頭低連續黑K，空方強勢 */
export const threeConsecutiveBlack: TradingRule = {
  id: 'kline-three-consecutive-black',
  name: '連三黑（空方強勢）',
  description: '3根連續頭頭低、底底低的黑K線',
  evaluate(candles, index): RuleSignal | null {
    if (index < 3) return null;
    const c0 = candles[index - 2];
    const c1 = candles[index - 1];
    const c2 = candles[index];

    if (!isBlackCandle(c0) || !isBlackCandle(c1) || !isBlackCandle(c2)) return null;
    if (c1.high >= c0.high || c2.high >= c1.high) return null;
    if (c1.low >= c0.low || c2.low >= c1.low) return null;
    if (!isMedLongBlack(c0) && !isMedLongBlack(c1) && !isMedLongBlack(c2)) return null;

    // 判斷位置
    const isHighArea = isUptrendWave(candles, Math.max(0, index - 5), 8);

    return {
      type: 'SELL',
      label: '連三黑空方強',
      description: `連續3根頭頭低黑K: ${c0.close.toFixed(2)} → ${c1.close.toFixed(2)} → ${c2.close.toFixed(2)}`,
      reason: [
        '【朱家泓《抓住K線》第5篇 下跌組合6】連三黑代表空方向下企圖強，是空方力量的聚集。',
        isHighArea
          ? '出現在高檔回檔，具下跌潛力，如再上漲無法突破連三黑最高點，應視為逃命波。'
          : '出現在空頭行進中，代表空方氣勢強，後續看跌。低檔連三黑若出現爆量或長下影線，要注意止跌回升的變盤線訊號。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 組合7：下缺回補 — 向下跳空後紅K回補缺口，轉折向上 */
export const downGapFilled: TradingRule = {
  id: 'kline-down-gap-filled',
  name: '下缺回補（轉折向上）',
  description: '向下跳空缺口後，出現紅K回補缺口',
  evaluate(candles, index): RuleSignal | null {
    if (index < 3) return null;

    for (let g = index - 1; g >= Math.max(1, index - 5); g--) {
      const prev = candles[g - 1];
      const gapCandle = candles[g];
      if (!gapDown(prev, gapCandle)) continue;

      const c = candles[index];
      if (c.close <= gapCandle.high) continue; // 沒回補
      if (!isRedCandle(c)) continue;

      return {
        type: 'BUY',
        label: '下缺回補反轉',
        description: `向下跳空(${gapCandle.date})後，紅K收盤${c.close.toFixed(2)}回補缺口`,
        reason: '【朱家泓《抓住K線》第5篇 下跌組合7】下缺回補是轉折向上的強烈訊號。空頭低檔出現爆量向下跳空後回補，該缺口成為竭盡缺口，趨勢反轉可能性大。多頭回檔出現此組合，回檔結束繼續上漲。',
        ruleId: this.id,
      };
    }
    return null;
  },
};

/** 全部 15 條行進中K線組合規則 */
export const KLINE_COMBO_RULES: TradingRule[] = [
  // 上漲中 8 種
  oneStarTwoYang,
  risingThreeMethods,
  threeLineReverseRed,
  threeConsecutiveRed,
  redBlackRed,
  smallStepUp,
  majorResistanceAhead,
  upGapFilled,
  // 下跌中 7 種
  oneStarTwoYin,
  fallingThreeMethods,
  threeLineReverseBlack,
  innerThreeBlack,
  blackRedBlack,
  threeConsecutiveBlack,
  downGapFilled,
];
