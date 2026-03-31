/**
 * winnerPatternRules.ts — 朱家泓《活用技術分析寶典》40年精華
 * 33 種贏家圖像 (Part 12, P771-825)
 *
 * 15 種 K 線多轉空秘笈圖 — 做多警示/出場信號
 * 18 種 K 線空轉多秘笈圖 — 做多進場信號
 */

import { CandleWithIndicators } from '@/types';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface PatternSignal {
  id: string;
  name: string;
  direction: 'bearish' | 'bullish';
  confidence: number;  // 0-100
  description: string;
}

export interface WinnerPatternResult {
  bearishPatterns: PatternSignal[];
  bullishPatterns: PatternSignal[];
  /** 綜合調整分：bearish 扣分 / bullish 加分 */
  compositeAdjust: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function bodyPct(c: CandleWithIndicators): number {
  return c.open > 0 ? Math.abs(c.close - c.open) / c.open : 0;
}

function isRed(c: CandleWithIndicators): boolean { return c.close > c.open; }
function isBlack(c: CandleWithIndicators): boolean { return c.close < c.open; }
function isLongRed(c: CandleWithIndicators): boolean { return isRed(c) && bodyPct(c) >= 0.02; }
function isLongBlack(c: CandleWithIndicators): boolean { return isBlack(c) && bodyPct(c) >= 0.02; }

function upperShadow(c: CandleWithIndicators): number {
  return c.high - Math.max(c.open, c.close);
}

function bodySize(c: CandleWithIndicators): number {
  return Math.abs(c.close - c.open);
}

function isHighVolume(c: CandleWithIndicators, mult = 1.5): boolean {
  return c.avgVol5 != null && c.avgVol5 > 0 && c.volume >= c.avgVol5 * mult;
}

/** 是否在高檔位置 (close > MA20 * 1.10) */
function isAtHighLevel(c: CandleWithIndicators): boolean {
  return c.ma20 != null && c.ma20 > 0 && c.close > c.ma20 * 1.10;
}

/** 是否在低檔位置 (close < MA20 * 0.95) */
function isAtLowLevel(c: CandleWithIndicators): boolean {
  return c.ma20 != null && c.ma20 > 0 && c.close < c.ma20 * 0.95;
}

function get(candles: CandleWithIndicators[], idx: number, offset: number): CandleWithIndicators | null {
  const i = idx + offset;
  return i >= 0 && i < candles.length ? candles[i] : null;
}

// ── 15 種 K 線多轉空秘笈圖 ──────────────────────────────────────────────────

function bearish01_highVolLongBlackReversal(
  candles: CandleWithIndicators[], idx: number,
): PatternSignal | null {
  const c = candles[idx];
  if (!isAtHighLevel(c) || !isLongBlack(c) || !isHighVolume(c, 2.0)) return null;
  const prev = get(candles, idx, -1);
  if (!prev || !isRed(prev)) return null;
  return {
    id: 'bear01', name: '高檔大量長黑一日反轉',
    direction: 'bearish', confidence: 85,
    description: '高檔出現爆大量長黑K，一日反轉做頭',
  };
}

function bearish02_highLongUpperShadow(
  candles: CandleWithIndicators[], idx: number,
): PatternSignal | null {
  const c = candles[idx];
  if (!isAtHighLevel(c)) return null;
  const upper = upperShadow(c);
  const body = bodySize(c);
  if (upper < body * 2 || !isHighVolume(c, 1.5)) return null;
  return {
    id: 'bear02', name: '高檔長上影線變盤',
    direction: 'bearish', confidence: 75,
    description: '高檔出現長上影線（影線 > 實體2倍），遇壓反轉',
  };
}

function bearish03_bearishEngulfing(
  candles: CandleWithIndicators[], idx: number,
): PatternSignal | null {
  const c = candles[idx];
  const prev = get(candles, idx, -1);
  if (!prev || !isAtHighLevel(c)) return null;
  if (!isLongBlack(c) || !isRed(prev)) return null;
  if (c.open < prev.close || c.close > prev.open) return null;
  // 黑K完全包覆前日紅K
  if (c.open >= prev.close && c.close <= prev.open) {
    return {
      id: 'bear03', name: '高檔黑K吞噬紅K',
      direction: 'bearish', confidence: 80,
      description: '空方覆蓋：黑K完全包覆前日紅K',
    };
  }
  return null;
}

function bearish04_twoHighVolDaysBreak(
  candles: CandleWithIndicators[], idx: number,
): PatternSignal | null {
  const c = candles[idx];
  const d1 = get(candles, idx, -1);
  const d2 = get(candles, idx, -2);
  if (!d1 || !d2 || !isAtHighLevel(c)) return null;
  if (!isHighVolume(d1, 2.0) || !isHighVolume(d2, 2.0)) return null;
  if (!isLongBlack(c)) return null;
  if (c.close < Math.min(d1.low, d2.low)) {
    return {
      id: 'bear04', name: '高檔連2日大量被黑K跌破',
      direction: 'bearish', confidence: 80,
      description: '連續2日爆大量後，長黑K跌破雙日低點',
    };
  }
  return null;
}

function bearish05_threeHighVolDaysBreak(
  candles: CandleWithIndicators[], idx: number,
): PatternSignal | null {
  const c = candles[idx];
  const d1 = get(candles, idx, -1);
  const d2 = get(candles, idx, -2);
  const d3 = get(candles, idx, -3);
  if (!d1 || !d2 || !d3 || !isAtHighLevel(c)) return null;
  if (!isHighVolume(d1, 1.8) || !isHighVolume(d2, 1.8) || !isHighVolume(d3, 1.8)) return null;
  if (!isLongBlack(c) && !isBlack(c)) return null;
  return {
    id: 'bear05', name: '暴量3日反轉',
    direction: 'bearish', confidence: 85,
    description: '高檔連3日大量後出現黑K，爆量出貨完成',
  };
}

function bearish06_gapDownBlack(
  candles: CandleWithIndicators[], idx: number,
): PatternSignal | null {
  const c = candles[idx];
  const prev = get(candles, idx, -1);
  if (!prev || !isAtHighLevel(prev)) return null;
  if (c.open >= prev.low) return null; // 無跳空
  if (!isBlack(c)) return null;
  return {
    id: 'bear06', name: '高檔跳空黑K',
    direction: 'bearish', confidence: 75,
    description: '高檔跳空開低收黑，空方強勢壓制',
  };
}

function bearish07_volumePriceDivergence(
  candles: CandleWithIndicators[], idx: number,
): PatternSignal | null {
  if (idx < 10) return null;
  const c = candles[idx];
  if (!isAtHighLevel(c)) return null;
  // 價格創新高但MACD OSC走低
  const prev5 = candles.slice(idx - 5, idx);
  const priceNewHigh = c.high >= Math.max(...prev5.map(x => x.high));
  const oscDeclining = c.macdOSC != null && prev5[0]?.macdOSC != null
    && c.macdOSC < prev5[0].macdOSC;
  if (priceNewHigh && oscDeclining) {
    return {
      id: 'bear07', name: '多頭上漲量價背離',
      direction: 'bearish', confidence: 70,
      description: '價格創新高但MACD柱狀體走低，動能衰退',
    };
  }
  return null;
}

function bearish08_threeUpperShadows(
  candles: CandleWithIndicators[], idx: number,
): PatternSignal | null {
  if (idx < 3) return null;
  const d1 = candles[idx - 2], d2 = candles[idx - 1], d3 = candles[idx];
  if (!isAtHighLevel(d3)) return null;
  const check = (c: CandleWithIndicators) => {
    const us = upperShadow(c);
    const bs = bodySize(c);
    return us > bs * 1.5; // 上影線 > 實體1.5倍
  };
  if (check(d1) && check(d2) && check(d3)) {
    return {
      id: 'bear08', name: '連3天長上影線',
      direction: 'bearish', confidence: 80,
      description: '大敵當前：連續3天出現長上影線，主力出貨',
    };
  }
  return null;
}

function bearish09_oneStarTwoYang(
  candles: CandleWithIndicators[], idx: number,
): PatternSignal | null {
  // 一星二陽：兩根紅K中間夾一根十字星，然後長紅跌破
  if (idx < 3) return null;
  const d1 = candles[idx - 2], d2 = candles[idx - 1], d3 = candles[idx];
  if (!isRed(d1) || !isAtHighLevel(d3)) return null;
  const d2BodyPct = bodyPct(d2);
  if (d2BodyPct > 0.01) return null; // 不是十字星
  if (!isLongBlack(d3)) return null;
  if (d3.close < d1.open) {
    return {
      id: 'bear09', name: '一星二陽破紅K',
      direction: 'bearish', confidence: 75,
      description: '高檔一星二陽後長黑跌破，近日易大跌',
    };
  }
  return null;
}

function bearish10_eveningStar(
  candles: CandleWithIndicators[], idx: number,
): PatternSignal | null {
  if (idx < 2) return null;
  const d1 = candles[idx - 2], d2 = candles[idx - 1], d3 = candles[idx];
  if (!isAtHighLevel(d2)) return null;
  if (!isLongRed(d1)) return null;
  if (bodyPct(d2) > 0.01) return null; // 中間要是小實體或十字星
  if (d2.low > d1.close) { /* 有跳空更強 */ }
  if (!isLongBlack(d3)) return null;
  if (d3.close < d1.close) {
    return {
      id: 'bear10', name: '夜星 Evening Star',
      direction: 'bearish', confidence: 85,
      description: '空方主控：長紅+星+長黑，經典反轉',
    };
  }
  return null;
}

function bearish11_highLevelConsolidation(
  candles: CandleWithIndicators[], idx: number,
): PatternSignal | null {
  if (idx < 15) return null;
  const c = candles[idx];
  if (!isAtHighLevel(c)) return null;
  // 高檔盤整超過10天
  const lookback = candles.slice(idx - 12, idx);
  const closes = lookback.map(x => x.close);
  const maxC = Math.max(...closes);
  const minC = Math.min(...closes);
  if (minC <= 0) return null;
  const range = (maxC - minC) / minC;
  if (range > 0.05) return null; // 波動太大不算久盤
  if (isBlack(c) && c.close < minC) {
    return {
      id: 'bear11', name: '上漲高檔久盤必跌',
      direction: 'bearish', confidence: 70,
      description: '高檔盤整超過10天後跌破，久盤必跌',
    };
  }
  return null;
}

function bearish12_highVolNoRise(
  candles: CandleWithIndicators[], idx: number,
): PatternSignal | null {
  const c = candles[idx];
  if (!isAtHighLevel(c) || !isHighVolume(c, 2.0)) return null;
  const changePct = (c.close - c.open) / c.open;
  if (changePct > -0.005 && changePct < 0.01) {
    return {
      id: 'bear12', name: '多頭大量不漲',
      direction: 'bearish', confidence: 70,
      description: '口訣1：多頭大量不漲，股價要回檔',
    };
  }
  return null;
}

function bearish13_noCallbackOverhigh(
  candles: CandleWithIndicators[], idx: number,
): PatternSignal | null {
  if (idx < 10) return null;
  const c = candles[idx];
  if (!isAtHighLevel(c)) return null;
  // 連續上漲5天以上不回檔
  let streak = 0;
  for (let i = idx; i >= Math.max(0, idx - 7); i--) {
    if (isRed(candles[i])) streak++;
    else break;
  }
  if (streak >= 5) {
    const totalGain = (c.close - candles[idx - streak + 1].open) / candles[idx - streak + 1].open;
    if (totalGain > 0.15) {
      return {
        id: 'bear13', name: '多頭該回不回過高',
        direction: 'bearish', confidence: 65,
        description: '連漲5天以上且漲幅>15%，末升段警示',
      };
    }
  }
  return null;
}

function bearish14_highVolLongRedDistribution(
  candles: CandleWithIndicators[], idx: number,
): PatternSignal | null {
  const c = candles[idx];
  if (!isAtHighLevel(c) || !isLongRed(c) || !isHighVolume(c, 3.0)) return null;
  // 漲幅已超過MA20 15%以上 + 天量（3倍均量）
  if (c.ma20 != null && c.ma20 > 0 && (c.close - c.ma20) / c.ma20 > 0.15) {
    return {
      id: 'bear14', name: '高檔爆量長紅',
      direction: 'bearish', confidence: 60,
      description: '高檔天量長紅K，可能是主力拉高出貨',
    };
  }
  return null;
}

function bearish15_highVolAtResistanceNoRise(
  candles: CandleWithIndicators[], idx: number,
): PatternSignal | null {
  if (idx < 20) return null;
  const c = candles[idx];
  if (!isHighVolume(c, 1.8)) return null;
  // 接近前高壓力但不漲
  const prev20High = Math.max(...candles.slice(idx - 20, idx).map(x => x.high));
  const nearResistance = prev20High > 0 && Math.abs(c.high - prev20High) / prev20High < 0.02;
  if (nearResistance && !isLongRed(c)) {
    return {
      id: 'bear15', name: '關前放大量不漲',
      direction: 'bearish', confidence: 70,
      description: '口訣11：關前放大量股價不漲，要回檔',
    };
  }
  return null;
}

// ── 18 種 K 線空轉多秘笈圖 ──────────────────────────────────────────────────

function bullish01_lowVolLongRed(
  candles: CandleWithIndicators[], idx: number,
): PatternSignal | null {
  const c = candles[idx];
  if (!isAtLowLevel(c) || !isLongRed(c) || !isHighVolume(c, 1.5)) return null;
  return {
    id: 'bull01', name: '低檔大量長紅K',
    direction: 'bullish', confidence: 75,
    description: '低檔出現爆量長紅K，空方力竭多方反攻',
  };
}

function bullish02_breakCutlineOverHigh(
  candles: CandleWithIndicators[], idx: number,
): PatternSignal | null {
  if (idx < 20) return null;
  const c = candles[idx];
  if (!isLongRed(c) || !isHighVolume(c)) return null;
  // 突破前高（前20天高點）
  const prev20High = Math.max(...candles.slice(idx - 20, idx).map(x => x.high));
  if (c.close > prev20High) {
    // 之前有下跌趨勢（從更高的高點下來）
    const prev40High = idx >= 40
      ? Math.max(...candles.slice(idx - 40, idx - 20).map(x => x.high))
      : prev20High;
    if (prev40High > prev20High) {
      return {
        id: 'bull02', name: '破切反彈過高大漲',
        direction: 'bullish', confidence: 80,
        description: '突破前波高點且之前有下降切線突破',
      };
    }
  }
  return null;
}

function bullish03_piercingLine(
  candles: CandleWithIndicators[], idx: number,
): PatternSignal | null {
  const c = candles[idx];
  const prev = get(candles, idx, -1);
  if (!prev || !isAtLowLevel(c)) return null;
  if (!isLongBlack(prev) || !isLongRed(c)) return null;
  // 紅K開低但收在黑K實體50%以上
  if (c.open < prev.close && c.close > (prev.open + prev.close) / 2) {
    return {
      id: 'bull03', name: '貫穿線',
      direction: 'bullish', confidence: 75,
      description: '低檔紅K貫穿前日黑K 50%以上，反轉信號',
    };
  }
  return null;
}

function bullish04_morningStar(
  candles: CandleWithIndicators[], idx: number,
): PatternSignal | null {
  if (idx < 2) return null;
  const d1 = candles[idx - 2], d2 = candles[idx - 1], d3 = candles[idx];
  if (!isAtLowLevel(d2)) return null;
  if (!isLongBlack(d1)) return null;
  if (bodyPct(d2) > 0.01) return null;
  if (!isLongRed(d3)) return null;
  if (d3.close > d1.open) {
    return {
      id: 'bull04', name: '晨星 Morning Star',
      direction: 'bullish', confidence: 85,
      description: '多方主控：長黑+星+長紅，經典反轉',
    };
  }
  return null;
}

function bullish05_bottomBreakout(
  candles: CandleWithIndicators[], idx: number,
): PatternSignal | null {
  if (idx < 20) return null;
  const c = candles[idx];
  if (!isLongRed(c) || !isHighVolume(c, 1.5)) return null;
  // 底部盤整後突破
  const lookback = candles.slice(idx - 15, idx);
  const closes = lookback.map(x => x.close);
  const maxC = Math.max(...closes);
  const minC = Math.min(...closes);
  if (minC <= 0) return null;
  if ((maxC - minC) / minC > 0.10) return null; // 不算盤整
  if (c.close > maxC) {
    return {
      id: 'bull05', name: '底部盤整突破',
      direction: 'bullish', confidence: 80,
      description: '低檔盤整超過10天後大量紅K突破',
    };
  }
  return null;
}

function bullish06_maClusterBreakout(
  candles: CandleWithIndicators[], idx: number,
): PatternSignal | null {
  if (idx < 5) return null;
  const c = candles[idx];
  const prev = get(candles, idx, -1);
  if (!prev || !isLongRed(c) || !isHighVolume(c, 1.5)) return null;
  const { ma5, ma10, ma20 } = prev;
  if (ma5 == null || ma10 == null || ma20 == null) return null;
  const maxMA = Math.max(ma5, ma10, ma20);
  const minMA = Math.min(ma5, ma10, ma20);
  if (minMA <= 0 || (maxMA - minMA) / minMA > 0.025) return null;
  if (c.close > maxMA) {
    return {
      id: 'bull06', name: '均線糾結突破',
      direction: 'bullish', confidence: 85,
      description: '均線糾結後大量紅K向上突破，起漲開始',
    };
  }
  return null;
}

function bullish07_doubleBottomBreak(
  candles: CandleWithIndicators[], idx: number,
): PatternSignal | null {
  if (idx < 30) return null;
  const c = candles[idx];
  if (!isLongRed(c) || !isHighVolume(c, 1.5)) return null;
  // 簡化雙底偵測：找前30天的兩個低點
  const lookback = candles.slice(idx - 30, idx);
  const lows = lookback.map(x => x.low);
  const globalLow = Math.min(...lows);
  if (globalLow <= 0) return null;
  // 找兩個離底部2%以內的低點區域
  const lowZones: number[] = [];
  for (let i = 0; i < lows.length; i++) {
    if (lows[i] <= globalLow * 1.02) {
      if (lowZones.length === 0 || i - lowZones[lowZones.length - 1] > 5) {
        lowZones.push(i);
      }
    }
  }
  if (lowZones.length >= 2) {
    const neckline = Math.max(...lookback.slice(lowZones[0], lowZones[1]).map(x => x.high));
    if (c.close > neckline) {
      return {
        id: 'bull07', name: '雙盤底大量突破',
        direction: 'bullish', confidence: 80,
        description: '雙底（W底）大量突破頸線',
      };
    }
  }
  return null;
}

function bullish08_bounceAboveMA20Consolidation(
  candles: CandleWithIndicators[], idx: number,
): PatternSignal | null {
  if (idx < 15) return null;
  const c = candles[idx];
  if (!isLongRed(c) || !isHighVolume(c, 1.3)) return null;
  if (c.ma20 == null || c.close <= c.ma20) return null;
  // 過去10天在月線上方橫盤
  const lookback = candles.slice(idx - 10, idx);
  const allAboveMA20 = lookback.every(x => x.ma20 != null && x.close > x.ma20 * 0.98);
  if (!allAboveMA20) return null;
  const closes = lookback.map(x => x.close);
  const range = (Math.max(...closes) - Math.min(...closes)) / Math.min(...closes);
  if (range < 0.06) {
    return {
      id: 'bull08', name: '月線上盤整突破',
      direction: 'bullish', confidence: 75,
      description: '空頭反彈後在月線上橫盤，大量突破',
    };
  }
  return null;
}

function bullish09_oneStarTwoYin(
  candles: CandleWithIndicators[], idx: number,
): PatternSignal | null {
  if (idx < 3) return null;
  const d1 = candles[idx - 2], d2 = candles[idx - 1], d3 = candles[idx];
  if (!isBlack(d1) || !isAtLowLevel(d3)) return null;
  if (bodyPct(d2) > 0.01) return null;
  if (!isLongRed(d3) && d3.close <= d1.close) return null;
  if (d3.close > d1.open) {
    return {
      id: 'bull09', name: '一星二陰破黑K',
      direction: 'bullish', confidence: 75,
      description: '口訣10：一星二陰長黑突破，近日易大漲',
    };
  }
  return null;
}

function bullish10_doubleLegConfirm(
  candles: CandleWithIndicators[], idx: number,
): PatternSignal | null {
  if (idx < 20) return null;
  const c = candles[idx];
  if (!isLongRed(c)) return null;
  // 底部兩支腳：找前20天有兩個接近的低點
  const lookback = candles.slice(idx - 20, idx);
  const lows = lookback.map(x => x.low);
  const minLow = Math.min(...lows);
  if (minLow <= 0) return null;
  const nearLows = lows.filter(l => l <= minLow * 1.03);
  if (nearLows.length >= 2 && c.close > Math.max(...lookback.map(x => x.close))) {
    return {
      id: 'bull10', name: '底部2支腳確認',
      direction: 'bullish', confidence: 75,
      description: '底部出現2支腳支撐後紅K突破',
    };
  }
  return null;
}

function bullish11_lowLevelConsolidation(
  candles: CandleWithIndicators[], idx: number,
): PatternSignal | null {
  if (idx < 15) return null;
  const c = candles[idx];
  if (!isAtLowLevel(c) || !isLongRed(c)) return null;
  const lookback = candles.slice(idx - 12, idx);
  const closes = lookback.map(x => x.close);
  const range = (Math.max(...closes) - Math.min(...closes)) / Math.min(...closes);
  if (range > 0.05) return null;
  if (c.close > Math.max(...closes)) {
    return {
      id: 'bull11', name: '下跌低檔久盤必漲',
      direction: 'bullish', confidence: 70,
      description: '口訣12：低檔盤整超過10天後紅K突破',
    };
  }
  return null;
}

function bullish12_highVolNoFall(
  candles: CandleWithIndicators[], idx: number,
): PatternSignal | null {
  const c = candles[idx];
  if (!isAtLowLevel(c) || !isHighVolume(c, 2.0)) return null;
  const changePct = (c.close - c.open) / c.open;
  if (changePct > -0.005 && changePct < 0.01) {
    return {
      id: 'bull12', name: '空頭大量不跌',
      direction: 'bullish', confidence: 65,
      description: '口訣2：空頭大量不跌，股價要反彈',
    };
  }
  return null;
}

function bullish13_bearishNewsNoFall(
  candles: CandleWithIndicators[], idx: number,
): PatternSignal | null {
  // 空頭利空不跌 — 用量價推斷：下跌趨勢中出現大量但收紅
  const c = candles[idx];
  if (!isAtLowLevel(c)) return null;
  if (isRed(c) && isHighVolume(c, 2.0)) {
    const prev = get(candles, idx, -1);
    if (prev && isBlack(prev)) {
      return {
        id: 'bull13', name: '空頭利空不跌',
        direction: 'bullish', confidence: 65,
        description: '口訣4：空頭利空不跌，主力進場築底',
      };
    }
  }
  return null;
}

function bullish14_fakeBreakdownRealUp(
  candles: CandleWithIndicators[], idx: number,
): PatternSignal | null {
  if (idx < 10) return null;
  const c = candles[idx];
  if (!isLongRed(c) || !isHighVolume(c, 1.5)) return null;
  const lookback = candles.slice(idx - 10, idx - 2);
  if (lookback.length < 5) return null;
  const lows = lookback.map(x => x.low);
  const supportLow = Math.min(...lows);
  // 前1-2天跌破支撐
  const d1 = get(candles, idx, -1);
  const d2 = get(candles, idx, -2);
  const brokeDown = (d1 && d1.low < supportLow) || (d2 && d2.low < supportLow);
  if (brokeDown && c.close > supportLow) {
    return {
      id: 'bull14', name: '假跌破真上漲',
      direction: 'bullish', confidence: 80,
      description: '跌破支撐後迅速收回，誘空後反轉',
    };
  }
  return null;
}

function bullish15_strongResumeAfterPullback(
  candles: CandleWithIndicators[], idx: number,
): PatternSignal | null {
  if (idx < 5) return null;
  const c = candles[idx];
  if (!isLongRed(c) || !isHighVolume(c, 1.3)) return null;
  const d1 = get(candles, idx, -1);
  const d2 = get(candles, idx, -2);
  if (!d1) return null;
  const pullback = isBlack(d1) || (d2 && isBlack(d2));
  if (!pullback) return null;
  // 回檔前是上漲
  const d3 = get(candles, idx, -3);
  const d4 = get(candles, idx, -4);
  if (d3 && d4 && isRed(d3) && isRed(d4)) {
    if (c.close > d1.high) {
      return {
        id: 'bull15', name: '強勢股回檔續攻',
        direction: 'bullish', confidence: 75,
        description: '回檔1-2天後大量紅K突破黑K高點',
      };
    }
  }
  return null;
}

function bullish16_abcCorrectionBreak(
  candles: CandleWithIndicators[], idx: number,
): PatternSignal | null {
  if (idx < 15) return null;
  const c = candles[idx];
  if (!isLongRed(c) || !isHighVolume(c, 1.3)) return null;
  if (c.ma20 == null || c.close < c.ma20) return null;
  // 前面有一波上漲後的ABC修正（簡化：前5-15天有下跌趨勢）
  const lookback = candles.slice(idx - 10, idx);
  const highs = lookback.map(x => x.high);
  const declining = highs[0] > highs[Math.floor(highs.length / 2)];
  if (declining && c.close > Math.max(...lookback.map(x => x.high))) {
    return {
      id: 'bull16', name: 'ABC修正完成突破',
      direction: 'bullish', confidence: 75,
      description: '多頭ABC修正後大量紅K突破前高',
    };
  }
  return null;
}

function bullish17_patternConfirmBreak(
  candles: CandleWithIndicators[], idx: number,
): PatternSignal | null {
  // 型態確認 — 底部型態完成後的突破 (W底/頭肩底/三角收斂)
  // 簡化：底底高 + 突破前高 + 大量
  if (idx < 20) return null;
  const c = candles[idx];
  if (!isLongRed(c) || !isHighVolume(c, 1.5)) return null;
  // 找底底高
  const lows10 = candles.slice(idx - 10, idx - 5).map(x => x.low);
  const lows5 = candles.slice(idx - 5, idx).map(x => x.low);
  const firstLow = Math.min(...lows10);
  const secondLow = Math.min(...lows5);
  if (secondLow > firstLow * 1.01) {
    const neckline = Math.max(...candles.slice(idx - 10, idx).map(x => x.high));
    if (c.close > neckline) {
      return {
        id: 'bull17', name: '型態確認突破',
        direction: 'bullish', confidence: 80,
        description: '底部型態（底底高）完成後大量突破頸線',
      };
    }
  }
  return null;
}

function bullish18_bigBlackThenBigRedBreak(
  candles: CandleWithIndicators[], idx: number,
): PatternSignal | null {
  if (idx < 3) return null;
  const c = candles[idx];
  if (!isLongRed(c) || !isHighVolume(c, 1.5)) return null;
  // 前1-3天有大量長黑K
  for (let offset = -1; offset >= -3; offset--) {
    const prev = get(candles, idx, offset);
    if (prev && isLongBlack(prev) && isHighVolume(prev, 1.5)) {
      if (c.close > prev.high) {
        return {
          id: 'bull18', name: '大量黑K後大量紅K突破',
          direction: 'bullish', confidence: 80,
          description: '大量長黑後迅速大量長紅突破其高點',
        };
      }
    }
  }
  return null;
}

// ── Main Evaluator ──────────────────────────────────────────────────────────────

const BEARISH_CHECKS = [
  bearish01_highVolLongBlackReversal,
  bearish02_highLongUpperShadow,
  bearish03_bearishEngulfing,
  bearish04_twoHighVolDaysBreak,
  bearish05_threeHighVolDaysBreak,
  bearish06_gapDownBlack,
  bearish07_volumePriceDivergence,
  bearish08_threeUpperShadows,
  bearish09_oneStarTwoYang,
  bearish10_eveningStar,
  bearish11_highLevelConsolidation,
  bearish12_highVolNoRise,
  bearish13_noCallbackOverhigh,
  bearish14_highVolLongRedDistribution,
  bearish15_highVolAtResistanceNoRise,
];

const BULLISH_CHECKS = [
  bullish01_lowVolLongRed,
  bullish02_breakCutlineOverHigh,
  bullish03_piercingLine,
  bullish04_morningStar,
  bullish05_bottomBreakout,
  bullish06_maClusterBreakout,
  bullish07_doubleBottomBreak,
  bullish08_bounceAboveMA20Consolidation,
  bullish09_oneStarTwoYin,
  bullish10_doubleLegConfirm,
  bullish11_lowLevelConsolidation,
  bullish12_highVolNoFall,
  bullish13_bearishNewsNoFall,
  bullish14_fakeBreakdownRealUp,
  bullish15_strongResumeAfterPullback,
  bullish16_abcCorrectionBreak,
  bullish17_patternConfirmBreak,
  bullish18_bigBlackThenBigRedBreak,
];

/**
 * 評估 33 種贏家圖像
 */
export function evaluateWinnerPatterns(
  candles: CandleWithIndicators[],
  idx: number,
): WinnerPatternResult {
  const bearishPatterns: PatternSignal[] = [];
  const bullishPatterns: PatternSignal[] = [];

  for (const check of BEARISH_CHECKS) {
    try {
      const sig = check(candles, idx);
      if (sig) bearishPatterns.push(sig);
    } catch { /* skip on error */ }
  }

  for (const check of BULLISH_CHECKS) {
    try {
      const sig = check(candles, idx);
      if (sig) bullishPatterns.push(sig);
    } catch { /* skip on error */ }
  }

  // 綜合調整分：bearish 扣分，bullish 加分
  const bearishPenalty = bearishPatterns.reduce((s, p) => s + p.confidence * 0.05, 0);
  const bullishBonus = bullishPatterns.reduce((s, p) => s + p.confidence * 0.05, 0);
  const compositeAdjust = Math.round(
    Math.min(bullishBonus, 15) - Math.min(bearishPenalty, 15)
  );

  return { bearishPatterns, bullishPatterns, compositeAdjust };
}
