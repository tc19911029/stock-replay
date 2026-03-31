/**
 * 朱家泓《抓住K線 獲利無限》第3篇 — 2根K線看轉折
 * 高檔轉折向下 4 種 + 低檔轉折向上 4 種 = 8 條規則
 */
import { TradingRule, RuleSignal } from '@/types';
import {
  bodyPct, isMedLongRed, isMedLongBlack, isRedCandle, isBlackCandle,
  isUptrendWave, isDowntrendWave,
} from './ruleUtils';

// ═══════════════════════════════════════════
// 高檔 2 根 K 線轉折向下（第3篇 Ch1-2）
// ═══════════════════════════════════════════

/** 烏雲蓋頂（高檔覆蓋）— 紅K後黑K開高收低，深入紅K實體但未吞噬 */
export const darkCloudCover: TradingRule = {
  id: 'zhu-dark-cloud-cover',
  name: '烏雲蓋頂（高檔覆蓋）',
  description: '上漲到高檔，紅K後出現開高走低的黑K，收盤深入紅K實體1/2以下',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const red = candles[index - 1];
    const black = candles[index];

    if (!isMedLongRed(red)) return null;
    if (!isBlackCandle(black)) return null;
    if (bodyPct(black) < 0.015) return null;
    // 黑K開盤高於紅K最高價
    if (black.open <= red.high) return null;
    // 黑K收盤深入紅K實體，但未跌破紅K開盤（否則就是吞噬）
    const redHalf = (red.open + red.close) / 2;
    if (black.close > redHalf) return null;   // 沒深入1/2，訊號弱
    if (black.close <= red.open) return null;  // 跌破=吞噬，由其他規則處理
    // 需在高檔
    if (!isUptrendWave(candles, index - 1, 8)) return null;

    return {
      type: 'SELL',
      label: '烏雲蓋頂轉折',
      description: `紅K(${red.close.toFixed(2)})後黑K開高${black.open.toFixed(2)}收低${black.close.toFixed(2)}，深入紅K實體1/2`,
      reason: [
        '【朱家泓《抓住K線》第3篇 高檔覆蓋】烏雲蓋頂是高檔轉折向下的強烈訊號。',
        '黑K收盤越深入紅K實體，反轉的可能性越高。',
        '如果覆蓋當日或前1~2日出現大量，反轉訊號越強。',
        '出現覆蓋後，這2根K線的最高點H和最低點L是重要壓力及支撐觀察點。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 高檔長黑吞噬 — 黑K完全包覆前一日紅K */
export const bearishEngulfingHigh: TradingRule = {
  id: 'zhu-bearish-engulfing-high',
  name: '高檔長黑吞噬',
  description: '上漲到高檔，黑K開高收低完全包覆前一日紅K實體',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const red = candles[index - 1];
    const black = candles[index];

    if (!isRedCandle(red)) return null;
    if (!isMedLongBlack(black)) return null;
    // 黑K實體完全包覆紅K實體
    if (black.open < red.close || black.close > red.open) return null;
    // 需在高檔
    if (!isUptrendWave(candles, index - 1, 8)) return null;

    return {
      type: 'SELL',
      label: '高檔長黑吞噬',
      description: `黑K(${black.open.toFixed(2)}→${black.close.toFixed(2)})完全吞噬紅K(${red.open.toFixed(2)}→${red.close.toFixed(2)})`,
      reason: [
        '【朱家泓《抓住K線》第3篇 高檔吞噬】長黑吞噬是5組向下雙K線轉折訊號中最強的組合。',
        '被吞噬的紅K線越小，吞噬的黑K線越長，轉折力道越強。',
        '吞噬當日或前一日出現大量或窒息量，反轉訊號越強。',
        '一根黑K線一次吞噬前面2~3根紅K線高點（也稱3線反黑），反轉越強。',
        '多單要立刻出場。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 高檔母子懷抱 — 長紅K後出現被包住的小K線 */
export const bearishHaramiHigh: TradingRule = {
  id: 'zhu-bearish-harami-high',
  name: '高檔母子懷抱（變盤警示）',
  description: '上漲到高檔，長紅K後出現不過高也不破低的小K線',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const mother = candles[index - 1]; // 母線：長紅
    const child = candles[index];       // 子線：被包住的小K

    if (!isMedLongRed(mother)) return null;
    // 子線被母線完全包住
    if (child.high > mother.high || child.low < mother.low) return null;
    // 子線實體要小
    if (bodyPct(child) > 0.02) return null;
    // 需在高檔
    if (!isUptrendWave(candles, index - 1, 8)) return null;

    const isChildDoji = bodyPct(child) < 0.005;

    return {
      type: 'WATCH',
      label: '高檔母子懷抱',
      description: `長紅(${mother.close.toFixed(2)})後出現${isChildDoji ? '十字線' : '小K'}被完全包住，變盤警示`,
      reason: [
        '【朱家泓《抓住K線》第3篇 高檔懷抱】母子懷抱代表多空開始不安定，走勢突然變得不確定。',
        '母線長紅K線的最高點與最低點是重要觀察位置，向上突破最高點多方反轉掌控主動權，向下跌破最低點空方繼續主導下跌。',
        isChildDoji ? '子線是十字線，反轉力道大於一般母子懷抱，是強力反轉訊號！容易形成高檔夜星轉折。' : '',
        '次日開盤位置很重要，開高容易向上反轉，開低容易下跌。',
      ].filter(Boolean).join('\n'),
      ruleId: this.id,
    };
  },
};

/** 高檔長黑貫穿 — 黑K開高收低，收盤突破前一日紅K實體高點 */
export const bearishPiercingHigh: TradingRule = {
  id: 'zhu-bearish-piercing-high',
  name: '高檔長黑貫穿（一路向下）',
  description: '上漲到高檔，黑K開盤即跌，收盤跌破前一日紅K實體高點',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const red = candles[index - 1];
    const black = candles[index];

    if (!isMedLongRed(red)) return null;
    if (!isMedLongBlack(black)) return null;
    // 黑K收盤跌破紅K的開盤價（實體高點=收盤，低點=開盤）
    if (black.close > red.open) return null;
    // 需在高檔
    if (!isUptrendWave(candles, index - 1, 8)) return null;

    return {
      type: 'SELL',
      label: '高檔長黑貫穿',
      description: `黑K(${black.close.toFixed(2)})貫穿前日紅K(開盤${red.open.toFixed(2)})，多空易位`,
      reason: [
        '【朱家泓《抓住K線》第3篇 高檔貫穿】長黑貫穿代表多方當天向下貫穿，多空主控權產生易位。',
        '貫穿的黑K線越長，轉折力道越強。',
        '貫穿當日或前一日出現大量，反轉訊號越強。',
        '配合大量，容易一日反轉。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

// ═══════════════════════════════════════════
// 低檔 2 根 K 線轉折向上（第3篇 Ch3-4）
// ═══════════════════════════════════════════

/** 旭日東升（低檔覆蓋）— 黑K後紅K開低收高，深入黑K實體但未吞噬 */
export const risingSun: TradingRule = {
  id: 'zhu-rising-sun',
  name: '旭日東升（低檔覆蓋）',
  description: '下跌到低檔，黑K後出現開低走高的紅K，收盤深入黑K實體1/2以上',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const black = candles[index - 1];
    const red = candles[index];

    if (!isMedLongBlack(black)) return null;
    if (!isRedCandle(red)) return null;
    if (bodyPct(red) < 0.015) return null;
    // 紅K開盤低於黑K最低價
    if (red.open >= black.low) return null;
    // 紅K收盤深入黑K實體1/2以上
    const blackHalf = (black.open + black.close) / 2;
    if (red.close < blackHalf) return null;    // 沒過1/2，訊號弱
    if (red.close >= black.open) return null;  // 突破=吞噬
    // 需在低檔
    if (!isDowntrendWave(candles, index - 1, 8)) return null;

    return {
      type: 'BUY',
      label: '旭日東升轉折',
      description: `黑K(${black.close.toFixed(2)})後紅K開低${red.open.toFixed(2)}收高${red.close.toFixed(2)}，深入黑K實體1/2`,
      reason: [
        '【朱家泓《抓住K線》第3篇 低檔覆蓋】旭日東升是低檔止跌的K線訊號，要注意是否會轉折向上。',
        '紅K收盤越深入黑K實體，反轉向上的可能性越高。如果突破黑K實體高點，就形成長紅吞噬。',
        '覆蓋的2根K線如有爆大量情形，更容易反轉向上。',
        '出現覆蓋後，走勢出現在H與L之間的橫向盤整，通常多為打底訊號。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 低檔長紅吞噬 — 紅K完全包覆前一日黑K */
export const bullishEngulfingLow: TradingRule = {
  id: 'zhu-bullish-engulfing-low',
  name: '低檔長紅吞噬（主力吸貨）',
  description: '下跌到低檔，紅K開低收高完全包覆前一日黑K實體',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const black = candles[index - 1];
    const red = candles[index];

    if (!isBlackCandle(black)) return null;
    if (!isMedLongRed(red)) return null;
    // 紅K實體完全包覆黑K實體
    if (red.open > black.close || red.close < black.open) return null;
    // 需在低檔
    if (!isDowntrendWave(candles, index - 1, 8)) return null;

    // 檢查是否一次吞噬多根（3線反紅）
    let engulfedCount = 1;
    for (let i = index - 2; i >= Math.max(0, index - 4); i--) {
      if (red.close >= candles[i].high && red.open <= candles[i].low) {
        engulfedCount++;
      } else {
        break;
      }
    }

    return {
      type: 'BUY',
      label: '低檔長紅吞噬',
      description: `紅K(${red.open.toFixed(2)}→${red.close.toFixed(2)})吞噬${engulfedCount > 1 ? engulfedCount + '根' : ''}黑K`,
      reason: [
        '【朱家泓《抓住K線》第3篇 低檔吞噬】長紅吞噬是5組向上雙K線轉折訊號中最強的組合，空單要立刻回補。',
        '被吞噬的黑K越小，吞噬的紅K越長，轉折力道越強。',
        engulfedCount > 1 ? `一根紅K一次吞噬前面${engulfedCount}根K線（3線反紅），反轉越強。` : '',
        '低檔出現爆量長紅吞噬K線後上漲反彈一段，日後再下跌，長紅吞噬的K線會形成重大支撐，容易形成底底高的底部型態。',
      ].filter(Boolean).join('\n'),
      ruleId: this.id,
    };
  },
};

/** 低檔母子懷抱 — 長黑K後出現被包住的小K線 */
export const bullishHaramiLow: TradingRule = {
  id: 'zhu-bullish-harami-low',
  name: '低檔母子懷抱（止跌警示）',
  description: '下跌到低檔，長黑K後出現不過高也不破低的小K線',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const mother = candles[index - 1];
    const child = candles[index];

    if (!isMedLongBlack(mother)) return null;
    if (child.high > mother.high || child.low < mother.low) return null;
    if (bodyPct(child) > 0.02) return null;
    if (!isDowntrendWave(candles, index - 1, 8)) return null;

    const isChildDoji = bodyPct(child) < 0.005;

    return {
      type: 'WATCH',
      label: '低檔母子懷抱',
      description: `長黑(${mother.close.toFixed(2)})後出現${isChildDoji ? '十字線' : '小K'}被完全包住，止跌警示`,
      reason: [
        '【朱家泓《抓住K線》第3篇 低檔懷抱】母子懷抱代表下跌走勢突然變得不確定，空頭下跌力道減弱。',
        '母線長黑K線的最高點是重要觀察位置，向上突破最高點代表多方反轉掌控主動權。',
        isChildDoji ? '子線是十字線，反轉力道大於一般母子懷抱，是強力反轉訊號！容易形成低檔晨星轉折。' : '',
        '出現母子懷抱，次日開盤位置很重要，開高容易向上反轉，開低容易下跌。',
      ].filter(Boolean).join('\n'),
      ruleId: this.id,
    };
  },
};

/** 低檔長紅貫穿 — 紅K開低收高，收盤突破前一日黑K實體高點 */
export const bullishPiercingLow: TradingRule = {
  id: 'zhu-bullish-piercing-low',
  name: '低檔長紅貫穿（一路向上）',
  description: '下跌到低檔，紅K開盤即漲，收盤突破前一日黑K實體高點',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const black = candles[index - 1];
    const red = candles[index];

    if (!isMedLongBlack(black)) return null;
    if (!isMedLongRed(red)) return null;
    // 紅K收盤突破黑K的開盤價（黑K實體高點=開盤）
    if (red.close < black.open) return null;
    // 需在低檔
    if (!isDowntrendWave(candles, index - 1, 8)) return null;

    return {
      type: 'BUY',
      label: '低檔長紅貫穿',
      description: `紅K(${red.close.toFixed(2)})貫穿前日黑K(開盤${black.open.toFixed(2)})，多空易位`,
      reason: [
        '【朱家泓《抓住K線》第3篇 低檔貫穿】長紅貫穿代表多方當天向上貫穿，多空主控權產生易位。',
        '貫穿的紅K線越長，轉折力道越強。',
        '貫穿當日或前一日出現大量，反轉訊號越強，轉折向上機率越高。',
        '短線連續下跌或急跌獲利達15%以上，出現長紅貫穿，一日反轉的機率很高。',
        '低檔出現爆量長紅貫穿K線後反彈，日後再下跌，長紅貫穿的K線會形成重大支撐，容易形成底底高的底部型態。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

export const TWO_BAR_REVERSAL_RULES: TradingRule[] = [
  darkCloudCover,
  bearishEngulfingHigh,
  bearishHaramiHigh,
  bearishPiercingHigh,
  risingSun,
  bullishEngulfingLow,
  bullishHaramiLow,
  bullishPiercingLow,
];
