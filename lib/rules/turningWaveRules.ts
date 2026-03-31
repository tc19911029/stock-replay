// ═══════════════════════════════════════════════════════════════
// 朱家泓《活用技術分析寶典》第2篇
// 轉折波系統 — 5/10/20日均線轉折波趨勢判斷
// ═══════════════════════════════════════════════════════════════

import { TradingRule, RuleSignal, CandleWithIndicators } from '@/types';

// ── 工具函數 ──────────────────────────────────────────────────────────────────

type MaKey = 'ma5' | 'ma10' | 'ma20';

interface TurningPoint {
  index: number;
  price: number;
  type: 'high' | 'low';
}

/**
 * 計算轉折波：以均線為基準，找出正價→負價的轉折高點和負價→正價的轉折低點
 * 書中定義：收盤 > MA = 正價（持有者賺錢）；收盤 < MA = 負價（持有者賠錢）
 */
function computeTurningPoints(
  candles: CandleWithIndicators[],
  endIndex: number,
  maKey: MaKey,
  lookback: number,
): TurningPoint[] {
  const points: TurningPoint[] = [];
  const start = Math.max(1, endIndex - lookback);

  let groupStart = start;
  let prevAbove: boolean | null = null;

  for (let i = start; i <= endIndex; i++) {
    const c = candles[i];
    const ma = c[maKey];
    if (ma == null) continue;

    const above = c.close > ma;

    if (prevAbove !== null && above !== prevAbove) {
      // 方向切換 → 從 groupStart 到 i 取轉折點
      if (prevAbove) {
        // 正價→負價：取群組最高點
        let maxHigh = -Infinity;
        let maxIdx = groupStart;
        for (let j = groupStart; j <= i; j++) {
          if (candles[j].high > maxHigh) {
            maxHigh = candles[j].high;
            maxIdx = j;
          }
        }
        points.push({ index: maxIdx, price: maxHigh, type: 'high' });
      } else {
        // 負價→正價：取群組最低點
        let minLow = Infinity;
        let minIdx = groupStart;
        for (let j = groupStart; j <= i; j++) {
          if (candles[j].low < minLow) {
            minLow = candles[j].low;
            minIdx = j;
          }
        }
        points.push({ index: minIdx, price: minLow, type: 'low' });
      }
      groupStart = i;
    }

    prevAbove = above;
  }

  return points;
}

/**
 * 從轉折波判斷趨勢：頭頭高+底底高=多頭，頭頭低+底底低=空頭
 */
function analyzeTrend(points: TurningPoint[]): 'bull' | 'bear' | 'neutral' {
  const highs = points.filter(p => p.type === 'high');
  const lows = points.filter(p => p.type === 'low');

  if (highs.length < 2 || lows.length < 2) return 'neutral';

  const lastH = highs[highs.length - 1];
  const prevH = highs[highs.length - 2];
  const lastL = lows[lows.length - 1];
  const prevL = lows[lows.length - 2];

  const higherHighs = lastH.price > prevH.price;
  const higherLows = lastL.price > prevL.price;
  const lowerHighs = lastH.price < prevH.price;
  const lowerLows = lastL.price < prevL.price;

  if (higherHighs && higherLows) return 'bull';
  if (lowerHighs && lowerLows) return 'bear';
  return 'neutral';
}

// ── 規則 ──────────────────────────────────────────────────────────────────────

/** 短線轉折波多頭確認：5日均線轉折波呈現頭頭高+底底高 */
export const shortTermTurningWaveBull: TradingRule = {
  id: 'zhu-turning-wave-5ma-bull',
  name: '短線轉折波多頭（5MA）',
  description: '5日均線轉折波呈現頭頭高、底底高的多頭架構',
  evaluate(candles, index): RuleSignal | null {
    if (index < 30) return null;
    const c = candles[index];
    if (c.ma5 == null) return null;

    const points = computeTurningPoints(candles, index, 'ma5', 40);
    const trend = analyzeTrend(points);
    if (trend !== 'bull') return null;

    // 額外條件：今日收盤在5MA之上 + 收紅K
    if (c.close <= c.ma5) return null;
    if (c.close <= c.open) return null;

    const highs = points.filter(p => p.type === 'high');
    const lows = points.filter(p => p.type === 'low');

    return {
      type: 'WATCH',
      label: '短線轉折波多頭',
      description: `5MA轉折波頭頭高(${highs[highs.length - 2]?.price.toFixed(1)}→${highs[highs.length - 1]?.price.toFixed(1)}) 底底高(${lows[lows.length - 2]?.price.toFixed(1)}→${lows[lows.length - 1]?.price.toFixed(1)})`,
      reason: [
        '【朱家泓《活用技術分析寶典》第2篇 轉折波】',
        '以5日均線為基準畫出的短線轉折波，呈現「頭頭高、底底高」的多頭架構。',
        '短線趨勢確認向上，可順勢做多。',
        '操作要點：回檔不破前低時，出現帶量紅K突破前高即為買點。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 短線轉折波空頭確認：5日均線轉折波呈現頭頭低+底底低 */
export const shortTermTurningWaveBear: TradingRule = {
  id: 'zhu-turning-wave-5ma-bear',
  name: '短線轉折波空頭（5MA）',
  description: '5日均線轉折波呈現頭頭低、底底低的空頭架構',
  evaluate(candles, index): RuleSignal | null {
    if (index < 30) return null;
    const c = candles[index];
    if (c.ma5 == null) return null;

    const points = computeTurningPoints(candles, index, 'ma5', 40);
    const trend = analyzeTrend(points);
    if (trend !== 'bear') return null;

    // 今日收盤在5MA之下 + 收黑K
    if (c.close >= c.ma5) return null;
    if (c.close >= c.open) return null;

    const highs = points.filter(p => p.type === 'high');
    const lows = points.filter(p => p.type === 'low');

    return {
      type: 'WATCH',
      label: '短線轉折波空頭',
      description: `5MA轉折波頭頭低(${highs[highs.length - 2]?.price.toFixed(1)}→${highs[highs.length - 1]?.price.toFixed(1)}) 底底低(${lows[lows.length - 2]?.price.toFixed(1)}→${lows[lows.length - 1]?.price.toFixed(1)})`,
      reason: [
        '【朱家泓《活用技術分析寶典》第2篇 轉折波】',
        '以5日均線為基準畫出的短線轉折波，呈現「頭頭低、底底低」的空頭架構。',
        '短線趨勢確認向下，應順勢做空或出場觀望。',
        '操作要點：反彈不過前高時，出現帶量黑K跌破前低即為賣點。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 中線轉折波多頭確認：10日均線轉折波 */
export const midTermTurningWaveBull: TradingRule = {
  id: 'zhu-turning-wave-10ma-bull',
  name: '中線轉折波多頭（10MA）',
  description: '10日均線轉折波呈現頭頭高、底底高的多頭架構',
  evaluate(candles, index): RuleSignal | null {
    if (index < 40) return null;
    const c = candles[index];
    if (c.ma10 == null) return null;

    const points = computeTurningPoints(candles, index, 'ma10', 60);
    const trend = analyzeTrend(points);
    if (trend !== 'bull') return null;

    if (c.close <= c.ma10) return null;

    return {
      type: 'WATCH',
      label: '中線轉折波多頭',
      description: `10MA轉折波確認中期多頭架構`,
      reason: [
        '【朱家泓《活用技術分析寶典》第2篇 10日均線轉折波】',
        '以10日均線為基準畫出的中線轉折波，呈現「頭頭高、底底高」的多頭架構。',
        '中期趨勢確認向上，波段做多的信心更強。',
        '可用此轉折波的高低點作為中期支撐與壓力參考。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 中線轉折波空頭確認 */
export const midTermTurningWaveBear: TradingRule = {
  id: 'zhu-turning-wave-10ma-bear',
  name: '中線轉折波空頭（10MA）',
  description: '10日均線轉折波呈現頭頭低、底底低的空頭架構',
  evaluate(candles, index): RuleSignal | null {
    if (index < 40) return null;
    const c = candles[index];
    if (c.ma10 == null) return null;

    const points = computeTurningPoints(candles, index, 'ma10', 60);
    const trend = analyzeTrend(points);
    if (trend !== 'bear') return null;

    if (c.close >= c.ma10) return null;

    return {
      type: 'WATCH',
      label: '中線轉折波空頭',
      description: `10MA轉折波確認中期空頭架構`,
      reason: [
        '【朱家泓《活用技術分析寶典》第2篇 10日均線轉折波】',
        '以10日均線為基準畫出的中線轉折波，呈現「頭頭低、底底低」的空頭架構。',
        '中期趨勢確認向下，不宜做多，應出場或做空。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 長線轉折波多頭確認：20日均線轉折波 */
export const longTermTurningWaveBull: TradingRule = {
  id: 'zhu-turning-wave-20ma-bull',
  name: '長線轉折波多頭（20MA）',
  description: '20日均線轉折波呈現頭頭高、底底高的多頭架構',
  evaluate(candles, index): RuleSignal | null {
    if (index < 60) return null;
    const c = candles[index];
    if (c.ma20 == null) return null;

    const points = computeTurningPoints(candles, index, 'ma20', 80);
    const trend = analyzeTrend(points);
    if (trend !== 'bull') return null;

    if (c.close <= c.ma20) return null;

    return {
      type: 'BUY',
      label: '長線轉折波多頭',
      description: `20MA轉折波確認長期多頭架構`,
      reason: [
        '【朱家泓《活用技術分析寶典》第2篇 20日均線轉折波】',
        '以20日均線為基準畫出的長線轉折波，呈現「頭頭高、底底高」的多頭架構。',
        '長期趨勢確認向上，是大波段做多的有力依據。',
        '操作要點：長線多頭+中線多頭+短線多頭三者共振時，為最強買入信號。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 長線轉折波空頭確認 */
export const longTermTurningWaveBear: TradingRule = {
  id: 'zhu-turning-wave-20ma-bear',
  name: '長線轉折波空頭（20MA）',
  description: '20日均線轉折波呈現頭頭低、底底低的空頭架構',
  evaluate(candles, index): RuleSignal | null {
    if (index < 60) return null;
    const c = candles[index];
    if (c.ma20 == null) return null;

    const points = computeTurningPoints(candles, index, 'ma20', 80);
    const trend = analyzeTrend(points);
    if (trend !== 'bear') return null;

    if (c.close >= c.ma20) return null;

    return {
      type: 'SELL',
      label: '長線轉折波空頭',
      description: `20MA轉折波確認長期空頭架構`,
      reason: [
        '【朱家泓《活用技術分析寶典》第2篇 20日均線轉折波】',
        '以20日均線為基準畫出的長線轉折波，呈現「頭頭低、底底低」的空頭架構。',
        '長期趨勢確認向下，絕對不宜做多，應全部出場或做空。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 三線轉折波共振多頭：5/10/20MA 轉折波同時為多頭 */
export const tripleWaveResonanceBull: TradingRule = {
  id: 'zhu-turning-wave-triple-bull',
  name: '三線轉折波共振多頭',
  description: '5/10/20日均線轉折波同時呈現多頭架構，趨勢最強',
  evaluate(candles, index): RuleSignal | null {
    if (index < 60) return null;
    const c = candles[index];
    if (c.ma5 == null || c.ma10 == null || c.ma20 == null) return null;

    const shortTrend = analyzeTrend(computeTurningPoints(candles, index, 'ma5', 40));
    const midTrend = analyzeTrend(computeTurningPoints(candles, index, 'ma10', 60));
    const longTrend = analyzeTrend(computeTurningPoints(candles, index, 'ma20', 80));

    if (shortTrend !== 'bull' || midTrend !== 'bull' || longTrend !== 'bull') return null;

    // 收盤在三線之上
    if (c.close <= c.ma5 || c.close <= c.ma10 || c.close <= c.ma20) return null;

    return {
      type: 'BUY',
      label: '三線轉折波共振多頭',
      description: `5/10/20MA轉折波全部確認多頭，趨勢極強`,
      reason: [
        '【朱家泓《活用技術分析寶典》第2篇 轉折波綜合應用】',
        '短線(5MA)、中線(10MA)、長線(20MA)轉折波全部呈現多頭架構。',
        '三線共振多頭是最強的趨勢確認，此時做多勝率最高。',
        '操作要點：回檔到10MA或20MA附近不破前低，即為最佳加碼位置。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 三線轉折波共振空頭 */
export const tripleWaveResonanceBear: TradingRule = {
  id: 'zhu-turning-wave-triple-bear',
  name: '三線轉折波共振空頭',
  description: '5/10/20日均線轉折波同時呈現空頭架構，趨勢最弱',
  evaluate(candles, index): RuleSignal | null {
    if (index < 60) return null;
    const c = candles[index];
    if (c.ma5 == null || c.ma10 == null || c.ma20 == null) return null;

    const shortTrend = analyzeTrend(computeTurningPoints(candles, index, 'ma5', 40));
    const midTrend = analyzeTrend(computeTurningPoints(candles, index, 'ma10', 60));
    const longTrend = analyzeTrend(computeTurningPoints(candles, index, 'ma20', 80));

    if (shortTrend !== 'bear' || midTrend !== 'bear' || longTrend !== 'bear') return null;

    if (c.close >= c.ma5 || c.close >= c.ma10 || c.close >= c.ma20) return null;

    return {
      type: 'SELL',
      label: '三線轉折波共振空頭',
      description: `5/10/20MA轉折波全部確認空頭，趨勢極弱`,
      reason: [
        '【朱家泓《活用技術分析寶典》第2篇 轉折波綜合應用】',
        '短線(5MA)、中線(10MA)、長線(20MA)轉折波全部呈現空頭架構。',
        '三線共振空頭是最弱的趨勢確認，絕對不宜做多。',
        '操作要點：持股者應立即出場，空手者不要搶反彈。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

export const TURNING_WAVE_RULES: TradingRule[] = [
  shortTermTurningWaveBull,
  shortTermTurningWaveBear,
  midTermTurningWaveBull,
  midTermTurningWaveBear,
  longTermTurningWaveBull,
  longTermTurningWaveBear,
  tripleWaveResonanceBull,
  tripleWaveResonanceBear,
];
