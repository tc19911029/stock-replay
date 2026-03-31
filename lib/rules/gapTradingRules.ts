/**
 * 朱家泓《抓住K線 獲利無限》第6篇 — K線缺口操作規則
 * 5 條缺口操作秘訣
 */
import { TradingRule, RuleSignal } from '@/types';
import {
  gapUp, gapDown, isLongRedCandle, isLongBlackCandle,
  halfPrice,
} from './ruleUtils';

/** 秘訣1：缺口之上見長紅 — 向上跳空配合長紅，拉回做多 */
export const gapUpLongRed: TradingRule = {
  id: 'gap-up-long-red',
  name: '缺口之上見長紅（拉回做多）',
  description: '向上跳空缺口出現長紅，股價回跌不破缺口上沿價',
  evaluate(candles, index): RuleSignal | null {
    if (index < 3) return null;

    // 找最近10根內的向上跳空缺口
    for (let g = index; g >= Math.max(1, index - 10); g--) {
      const prev = candles[g - 1];
      const gapCandle = candles[g];
      if (!gapUp(prev, gapCandle)) continue;

      // 缺口當天或後面出現長紅
      if (!isLongRedCandle(gapCandle) && g !== index) continue;

      // 如果缺口不是今天，檢查後續收盤都沒有跌破上沿價（gapCandle.low）
      const upperEdge = gapCandle.low;
      let gapHeld = true;
      for (let k = g + 1; k <= index; k++) {
        if (candles[k].close < upperEdge) {
          gapHeld = false;
          break;
        }
      }
      if (!gapHeld) continue;

      // 當前K是長紅，或在缺口上方高處橫盤
      const c = candles[index];
      const isAtGapDay = g === index;
      const isConsolidating = !isAtGapDay && c.close >= halfPrice(gapCandle) && c.close > c.open;

      if (isAtGapDay && isLongRedCandle(c)) {
        return {
          type: 'BUY',
          label: '缺口長紅做多',
          description: `向上跳空缺口配合長紅K(${c.close.toFixed(2)})，多頭強力表現`,
          reason: '【朱家泓《抓住K線》第6篇 秘訣1】缺口之上見長紅，必有漲幅。向上跳空缺口出現長紅是多頭強力的表現，股價只要回跌不破缺口上沿價，以做多方向為主，拉回做多。高處橫盤整理最容易發動的時間在橫盤的第1、3、5、8、13日。',
          ruleId: this.id,
        };
      }

      if (isConsolidating) {
        const daysAfterGap = index - g;
        const isFibDay = [1, 3, 5, 8, 13].includes(daysAfterGap);
        return {
          type: 'WATCH',
          label: '缺口上方整理',
          description: `缺口(${gapCandle.date})後第${daysAfterGap}天，股價維持在缺口上方強勢整理`,
          reason: [
            '【朱家泓《抓住K線》第6篇 秘訣1】缺口之上見長紅後，後續在長紅收盤價之上橫盤是強勢整理，隨時都會上漲。',
            isFibDay ? `今天是橫盤第${daysAfterGap}天，為費波南係數日，最容易發動上漲。` : '',
          ].filter(Boolean).join('\n'),
          ruleId: this.id,
        };
      }
    }
    return null;
  },
};

/** 秘訣2：缺口之下見長黑 — 向下跳空配合長黑，反彈做空 */
export const gapDownLongBlack: TradingRule = {
  id: 'gap-down-long-black',
  name: '缺口之下見長黑（反彈做空）',
  description: '向下跳空缺口出現長黑，股價反彈不破缺口下沿價',
  evaluate(candles, index): RuleSignal | null {
    if (index < 3) return null;

    for (let g = index; g >= Math.max(1, index - 10); g--) {
      const prev = candles[g - 1];
      const gapCandle = candles[g];
      if (!gapDown(prev, gapCandle)) continue;

      if (!isLongBlackCandle(gapCandle) && g !== index) continue;

      const lowerEdge = gapCandle.high;
      let gapHeld = true;
      for (let k = g + 1; k <= index; k++) {
        if (candles[k].close > lowerEdge) {
          gapHeld = false;
          break;
        }
      }
      if (!gapHeld) continue;

      const c = candles[index];
      if (g === index && isLongBlackCandle(c)) {
        return {
          type: 'SELL',
          label: '缺口長黑做空',
          description: `向下跳空缺口配合長黑K(${c.close.toFixed(2)})，空頭強力表現`,
          reason: '【朱家泓《抓住K線》第6篇 秘訣2】缺口之下見長黑，必有跌幅。向下跳空缺口出現長黑是空頭強力的表現，股價只要反彈不破缺口下沿價，以做空方向為主，反彈做空。',
          ruleId: this.id,
        };
      }
    }
    return null;
  },
};

/** 秘訣5-1：三日二缺口向上 — 連續跳空強勢做多 */
export const threeDayTwoGapsUp: TradingRule = {
  id: 'gap-three-day-two-gaps-up',
  name: '三日二缺口向上（強勢大漲）',
  description: '連續3日出現2個向上跳空缺口',
  evaluate(candles, index): RuleSignal | null {
    if (index < 3) return null;

    // 檢查最近3根K線中是否有2個向上跳空
    let gapCount = 0;
    for (let i = index; i >= Math.max(1, index - 2); i--) {
      if (gapUp(candles[i - 1], candles[i])) gapCount++;
    }
    if (gapCount < 2) return null;

    return {
      type: 'BUY',
      label: '三日二缺口漲',
      description: `近3日出現${gapCount}個向上跳空缺口，主力強力做多`,
      reason: [
        '【朱家泓《抓住K線》第6篇 秘訣5】三日二缺口向上要大漲。',
        '多頭打底時出現上漲連3紅K且是2日2缺口，是一支強勢多頭股票，要鎖股做多。',
        '多頭上漲的關鍵起漲位置，連續3日向上出現2個跳空缺口，是主力強力做多的宣示，只要缺口沒有被回補，股價容易大漲。',
        '注意：多頭上漲到高檔出現3日2缺口，同時爆大量，要特別注意股價不漲或下跌以及向上缺口是否被回補。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 秘訣5-2：三日二缺口向下 — 連續跳空強勢做空 */
export const threeDayTwoGapsDown: TradingRule = {
  id: 'gap-three-day-two-gaps-down',
  name: '三日二缺口向下（強勢大跌）',
  description: '連續3日出現2個向下跳空缺口',
  evaluate(candles, index): RuleSignal | null {
    if (index < 3) return null;

    let gapCount = 0;
    for (let i = index; i >= Math.max(1, index - 2); i--) {
      if (gapDown(candles[i - 1], candles[i])) gapCount++;
    }
    if (gapCount < 2) return null;

    return {
      type: 'SELL',
      label: '三日二缺口跌',
      description: `近3日出現${gapCount}個向下跳空缺口，主力強力做空`,
      reason: [
        '【朱家泓《抓住K線》第6篇 秘訣5】三日二缺口向下要大跌。',
        '空頭做頭時出現下跌連3黑K且是3日2缺口，是一支弱勢空頭股票，要鎖股做空。',
        '空頭下跌的位置，連續3日向下出現2個跳空缺口，是主力強力做空的宣示，只要缺口沒有被回補，股價容易大跌。',
        '注意：空頭下跌到低檔出現3日2缺口，同時爆大量，要特別注意股價容易反彈。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 重點5：島狀反轉 — 左右兩側都有缺口的孤島型態 */
export const islandReversal: TradingRule = {
  id: 'gap-island-reversal',
  name: '島狀反轉（強烈反轉）',
  description: '股價左右兩側都有缺口，形成孤島，強烈反轉訊號',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;

    // 情境1：高檔島狀反轉（先向上跳空，然後向下跳空）
    // 找近10根內是否有向上跳空
    for (let g = index - 1; g >= Math.max(1, index - 15); g--) {
      if (!gapUp(candles[g - 1], candles[g])) continue;

      // 在向上跳空之後，當前是否出現向下跳空
      if (!gapDown(candles[index - 1], candles[index])) continue;

      // 中間的K線形成「島」（至少1根）
      const islandDays = index - g;
      if (islandDays < 1) continue;

      return {
        type: 'SELL',
        label: '高檔島狀反轉',
        description: `上跳空(${candles[g].date}) → ${islandDays}日孤島 → 下跳空(${candles[index].date})`,
        reason: [
          '【朱家泓《抓住K線》第6篇 重點5】島狀反轉不常出現，一旦出現在高檔會是大跌走勢的前兆。',
          `底部盤整日期${islandDays}天，盤整日期越多，日後的行情越大。`,
          '島狀反轉是必殺做空的好機會，反轉力道很強。',
        ].join('\n'),
        ruleId: this.id,
      };
    }

    // 情境2：底部島狀反轉（先向下跳空，然後向上跳空）
    for (let g = index - 1; g >= Math.max(1, index - 15); g--) {
      if (!gapDown(candles[g - 1], candles[g])) continue;

      if (!gapUp(candles[index - 1], candles[index])) continue;

      const islandDays = index - g;
      if (islandDays < 1) continue;

      return {
        type: 'BUY',
        label: '底部島狀反轉',
        description: `下跳空(${candles[g].date}) → ${islandDays}日孤島 → 上跳空(${candles[index].date})`,
        reason: [
          '【朱家泓《抓住K線》第6篇 重點5】底部出現島狀反轉是大漲的訊號，應把握做多的好機會。',
          `底部盤整日期${islandDays}天，盤整日期越多，日後的行情越大。`,
          '島狀反轉的結構可能只有一根K線就反轉，也可能較多天的盤整後反轉。',
        ].join('\n'),
        ruleId: this.id,
      };
    }

    return null;
  },
};

/** 全部 5 條缺口操作規則 */
export const GAP_TRADING_RULES: TradingRule[] = [
  gapUpLongRed,
  gapDownLongBlack,
  threeDayTwoGapsUp,
  threeDayTwoGapsDown,
  islandReversal,
];
