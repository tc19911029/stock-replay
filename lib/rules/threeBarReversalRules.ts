/**
 * 朱家泓《抓住K線 獲利無限》第4篇 — 3根K線看轉折
 * 高檔轉折向下 3 種 + 低檔轉折向上 3 種 = 6 條規則
 * 包含變化組合（雙星、雙肩、群星）
 */
import { TradingRule, RuleSignal } from '@/types';
import {
  isMedLongRed, isMedLongBlack, isSmallCandle, isDoji,
  isUptrendWave, isDowntrendWave,
} from './ruleUtils';

// ═══════════════════════════════════════════
// 高檔 3 根 K 線轉折向下（第4篇 Ch1-2）
// ═══════════════════════════════════════════

/** 高檔夜星（含孤島夜星）— 紅K + 星 + 黑K，高檔轉折最基本型態 */
export const eveningStarHigh: TradingRule = {
  id: 'zhu-evening-star-high',
  name: '高檔夜星轉折',
  description: '中長紅K + 變盤線(星) + 中長黑K，上漲高點反轉向下',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const c0 = candles[index - 2]; // 紅K
    const c1 = candles[index - 1]; // 星（變盤線）
    const c2 = candles[index];     // 黑K

    if (!isMedLongRed(c0)) return null;
    if (!isSmallCandle(c1) && !isDoji(c1)) return null;
    if (!isMedLongBlack(c2)) return null;

    // 黑K收盤要深入紅K實體（至少到1/2）
    const redHalf = (c0.open + c0.close) / 2;
    if (c2.close > redHalf) return null;

    // 需在高檔
    if (!isUptrendWave(candles, index - 2, 8)) return null;

    // 檢查是否為孤島夜星（星與左右都有跳空缺口）
    const isIsland = c1.low > c0.high && c1.low > c2.high;

    return {
      type: 'SELL',
      label: isIsland ? '孤島夜星反轉' : '高檔夜星反轉',
      description: `紅K(${c0.close.toFixed(2)}) + ${isDoji(c1) ? '十字星' : '星線'} + 黑K(${c2.close.toFixed(2)})`,
      reason: [
        `【朱家泓《抓住K線》第4篇 Ch1】${isIsland ? '孤島夜星是最強烈的轉折訊號' : '夜星轉折是股價上漲轉折向下的基本型態'}。`,
        '多頭上漲在高檔是轉折向下的訊號，股價要回檔。空頭反彈出現夜星，反彈結束股價繼續下跌。',
        isDoji(c1) ? '中間是十字星，多空交戰後空方勝出，反轉力道更強。' : '',
        '夜星的中長黑K線低點如果被上漲的紅K線收盤突破，轉折向下的結構就會被破壞。',
      ].filter(Boolean).join('\n'),
      ruleId: this.id,
    };
  },
};

/** 高檔母子變盤 — 長紅K後連續2根以上小K被包住，再出現長黑 */
export const bearishMotherSonTransition: TradingRule = {
  id: 'zhu-bearish-mother-son-transition',
  name: '高檔母子變盤',
  description: '長紅K後出現母子懷抱，再出現長黑K跌破，變盤反轉確認',
  evaluate(candles, index): RuleSignal | null {
    if (index < 4) return null;
    const black = candles[index]; // 當前：長黑確認

    if (!isMedLongBlack(black)) return null;

    // 往前找母子懷抱結構
    for (let gap = 2; gap <= 4; gap++) {
      if (index - gap < 0) break;
      const mother = candles[index - gap]; // 母線：長紅
      if (!isMedLongRed(mother)) continue;

      // 中間的K線都要被母線包住
      let allInside = true;
      for (let m = index - gap + 1; m < index; m++) {
        const mid = candles[m];
        if (mid.high > mother.high || mid.low < mother.low) {
          allInside = false;
          break;
        }
      }
      if (!allInside) continue;

      // 黑K要跌破母線低點
      if (black.close > mother.low) continue;

      // 需在高檔
      if (!isUptrendWave(candles, index - gap, 8)) continue;

      const starCount = gap - 1;
      return {
        type: 'SELL',
        label: '高檔母子變盤',
        description: `長紅(${mother.close.toFixed(2)}) + ${starCount}根懷抱K + 長黑跌破(${black.close.toFixed(2)})`,
        reason: [
          '【朱家泓《抓住K線》第4篇 Ch2】高檔母子變盤是變盤反轉的確認型態。',
          `母線長紅K後出現${starCount}根被包住的小K，代表多空開始拉鋸，',
          '最後長黑K跌破母線低點，確認空方取得主控權。`,
          starCount >= 2 ? '懷抱的小K越多，蓄積的能量越大，一旦跌破反轉力道越強。' : '',
        ].filter(Boolean).join('\n'),
        ruleId: this.id,
      };
    }
    return null;
  },
};

/** 高檔雙星變盤（含群星變盤）— 長紅K後連續2根以上變盤星線 + 長黑K */
export const bearishDoubleStarTransition: TradingRule = {
  id: 'zhu-bearish-double-star',
  name: '高檔雙星變盤',
  description: '長紅K後連續出現2根以上變盤線/十字線，再出現長黑K',
  evaluate(candles, index): RuleSignal | null {
    if (index < 4) return null;
    const black = candles[index];
    if (!isMedLongBlack(black)) return null;

    // 往前找：長紅 + 連續變盤線 + 當前長黑
    for (let gap = 3; gap <= 6; gap++) {
      if (index - gap < 0) break;
      const red = candles[index - gap];
      if (!isMedLongRed(red)) continue;

      // 中間要都是小K或十字線
      let starCount = 0;
      let allSmall = true;
      for (let m = index - gap + 1; m < index; m++) {
        const mid = candles[m];
        if (isSmallCandle(mid) || isDoji(mid)) {
          starCount++;
        } else {
          allSmall = false;
          break;
        }
      }
      if (!allSmall || starCount < 2) continue;

      // 需在高檔
      if (!isUptrendWave(candles, index - gap, 8)) continue;

      const patternName = starCount === 2 ? '雙星變盤' : `${starCount}星變盤（群星變盤）`;
      return {
        type: 'SELL',
        label: patternName,
        description: `長紅(${red.close.toFixed(2)}) + ${starCount}顆星 + 長黑(${black.close.toFixed(2)})`,
        reason: [
          `【朱家泓《抓住K線》第4篇 Ch2】高檔${patternName}是轉折向下的強烈訊號。`,
          '出現在多頭上漲高檔，如果同時爆大量，反轉更明顯，多單要立刻出場。',
          starCount > 2 ? `群星${starCount}顆，空方蓄積能量越大，下跌力道越強。` : '',
          '在多頭回檔時出現此組合，股價將繼續下跌。',
        ].filter(Boolean).join('\n'),
        ruleId: this.id,
      };
    }
    return null;
  },
};

// ═══════════════════════════════════════════
// 低檔 3 根 K 線轉折向上（第4篇 Ch3-4）
// ═══════════════════════════════════════════

/** 低檔晨星（含孤島晨星）— 黑K + 星 + 紅K，低檔轉折最基本型態 */
export const morningStarLow: TradingRule = {
  id: 'zhu-morning-star-low',
  name: '低檔晨星轉折',
  description: '中長黑K + 變盤線(星) + 中長紅K，下跌低點反轉向上',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const c0 = candles[index - 2]; // 黑K
    const c1 = candles[index - 1]; // 星（變盤線）
    const c2 = candles[index];     // 紅K

    if (!isMedLongBlack(c0)) return null;
    if (!isSmallCandle(c1) && !isDoji(c1)) return null;
    if (!isMedLongRed(c2)) return null;

    // 紅K收盤要深入黑K實體（至少到1/2）
    const blackHalf = (c0.open + c0.close) / 2;
    if (c2.close < blackHalf) return null;

    // 需在低檔
    if (!isDowntrendWave(candles, index - 2, 8)) return null;

    const isIsland = c1.high < c0.low && c1.high < c2.low;

    return {
      type: 'BUY',
      label: isIsland ? '孤島晨星反轉' : '低檔晨星反轉',
      description: `黑K(${c0.close.toFixed(2)}) + ${isDoji(c1) ? '十字星' : '星線'} + 紅K(${c2.close.toFixed(2)})`,
      reason: [
        `【朱家泓《抓住K線》第4篇 Ch3】${isIsland ? '孤島晨星是最強烈的向上轉折訊號' : '晨星轉折是股價下跌轉折向上的基本型態'}。`,
        '下跌低檔出現晨星組合，同時爆大量，轉折向上的機率大大提高，上漲力道強。',
        isDoji(c1) ? '中間是十字星，多空交戰後多方勝出，反轉力道更強。' : '',
        '晨星轉折的組合如果上漲中長紅K線低點被下跌的黑K線跌破，轉折向上的結構就會被破壞。',
        '運用費波南係數注意變盤線第1、3、5、8、13、21日的K線轉折走勢。',
      ].filter(Boolean).join('\n'),
      ruleId: this.id,
    };
  },
};

/** 低檔母子變盤 — 長黑K後連續小K被包住，再出現長紅 */
export const bullishMotherSonTransition: TradingRule = {
  id: 'zhu-bullish-mother-son-transition',
  name: '低檔母子變盤',
  description: '長黑K後出現母子懷抱，再出現長紅K突破，變盤反轉確認',
  evaluate(candles, index): RuleSignal | null {
    if (index < 4) return null;
    const red = candles[index];
    if (!isMedLongRed(red)) return null;

    for (let gap = 2; gap <= 4; gap++) {
      if (index - gap < 0) break;
      const mother = candles[index - gap];
      if (!isMedLongBlack(mother)) continue;

      let allInside = true;
      for (let m = index - gap + 1; m < index; m++) {
        const mid = candles[m];
        if (mid.high > mother.high || mid.low < mother.low) {
          allInside = false;
          break;
        }
      }
      if (!allInside) continue;

      if (red.close < mother.high) continue;

      if (!isDowntrendWave(candles, index - gap, 8)) continue;

      const starCount = gap - 1;
      return {
        type: 'BUY',
        label: '低檔母子變盤',
        description: `長黑(${mother.close.toFixed(2)}) + ${starCount}根懷抱K + 長紅突破(${red.close.toFixed(2)})`,
        reason: [
          `【朱家泓《抓住K線》第4篇 Ch4】低檔母子變盤是止跌反轉的確認型態。`,
          `母線長黑K後出現${starCount}根被包住的小K，代表空頭下跌力道減弱。`,
          '最後長紅K突破母線高點，確認多方取得主控權。',
          starCount >= 2 ? '懷抱的小K越多，多方蓄積越久，一旦突破上漲力道越強。' : '',
        ].filter(Boolean).join('\n'),
        ruleId: this.id,
      };
    }
    return null;
  },
};

/** 低檔雙星變盤（含雙肩變盤、群星變盤）— 長黑K後連續2根以上變盤星線 + 長紅K */
export const bullishDoubleStarTransition: TradingRule = {
  id: 'zhu-bullish-double-star',
  name: '低檔雙星變盤',
  description: '長黑K後連續出現2根以上變盤線/十字線，再出現長紅K',
  evaluate(candles, index): RuleSignal | null {
    if (index < 4) return null;
    const red = candles[index];
    if (!isMedLongRed(red)) return null;

    for (let gap = 3; gap <= 8; gap++) {
      if (index - gap < 0) break;
      const black = candles[index - gap];
      if (!isMedLongBlack(black)) continue;

      let starCount = 0;
      let allSmall = true;
      for (let m = index - gap + 1; m < index; m++) {
        const mid = candles[m];
        if (isSmallCandle(mid) || isDoji(mid)) {
          starCount++;
        } else {
          allSmall = false;
          break;
        }
      }
      if (!allSmall || starCount < 2) continue;

      if (!isDowntrendWave(candles, index - gap, 8)) continue;

      let patternName: string;
      if (starCount === 2) {
        patternName = '雙星變盤';
      } else if (starCount <= 4) {
        patternName = '雙肩變盤';
      } else {
        patternName = `群星變盤(${starCount}星)`;
      }

      return {
        type: 'BUY',
        label: `低檔${patternName}`,
        description: `長黑(${black.close.toFixed(2)}) + ${starCount}顆星 + 長紅(${red.close.toFixed(2)})`,
        reason: [
          `【朱家泓《抓住K線》第4篇 Ch4】低檔${patternName}是轉折向上的訊號。`,
          '如果同時低檔出現大量或爆大量，反轉更明顯，空單要回補。',
          `群星${starCount}顆，多方控盤時間至少${starCount}天，上漲力道越強。`,
          '在多頭回檔時出現此組合，將繼續上漲，要把握做多。',
          '晨星轉折的中長紅K線低點如果被下跌的黑K線跌破，轉折向上的結構就會被破壞。',
        ].join('\n'),
        ruleId: this.id,
      };
    }
    return null;
  },
};

export const THREE_BAR_REVERSAL_RULES: TradingRule[] = [
  eveningStarHigh,
  bearishMotherSonTransition,
  bearishDoubleStarTransition,
  morningStarLow,
  bullishMotherSonTransition,
  bullishDoubleStarTransition,
];
