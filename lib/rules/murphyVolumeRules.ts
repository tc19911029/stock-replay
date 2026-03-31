// ═══════════════════════════════════════════════════════════════
// Murphy《金融市場技術分析》第7章
// 量價驗證規則 — OBV背離、量能萎縮、天量見頂、底部放量、價量背離
// ═══════════════════════════════════════════════════════════════

import { TradingRule, RuleSignal, CandleWithIndicators } from '@/types';
import { isLongRedCandle, findSwingHigh } from './ruleUtils';

// ── 工具函數 ──────────────────────────────────────────────────────────────────

/** 計算簡易 OBV（相對值，從 lookback 起點開始累計） */
function computeObv(candles: CandleWithIndicators[], index: number, lookback: number): number[] {
  const start = Math.max(1, index - lookback + 1);
  const obvValues: number[] = [0];
  for (let i = start; i <= index; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const prevObv = obvValues[obvValues.length - 1];
    if (curr.close > prev.close) {
      obvValues.push(prevObv + curr.volume);
    } else if (curr.close < prev.close) {
      obvValues.push(prevObv - curr.volume);
    } else {
      obvValues.push(prevObv);
    }
  }
  return obvValues;
}

// ── 規則 ──────────────────────────────────────────────────────────────────────

/**
 * OBV 趨勢背離（看跌）
 * Murphy 第7章：價格創新高但 OBV 未創新高，暗示上漲動能不足
 */
export const obvBearishDivergence: TradingRule = {
  id: 'murphy-obv-bearish-div',
  name: 'OBV 看跌背離',
  description: '價格創近期新高但 OBV 未能同步創新高',
  evaluate(candles, index): RuleSignal | null {
    if (index < 30) return null;
    const c = candles[index];

    // 計算近30根的 OBV
    const obv = computeObv(candles, index, 30);
    if (obv.length < 20) return null;

    // 條件1：價格在近20根創新高（或接近新高）
    let priceHighest = true;
    for (let i = index - 20; i < index; i++) {
      if (i >= 0 && candles[i].high > c.high) { priceHighest = false; break; }
    }
    if (!priceHighest) return null;

    // 條件2：OBV 的最高點出現在 10 根前而非當前
    const obvLen = obv.length;
    const currentObv = obv[obvLen - 1];
    let obvMax = currentObv;
    let obvMaxAge = 0;
    for (let i = obvLen - 11; i < obvLen - 1; i++) {
      if (i >= 0 && obv[i] > obvMax) {
        obvMax = obv[i];
        obvMaxAge = obvLen - 1 - i;
      }
    }
    // OBV 高點在 5+ 根前，且當前 OBV 明顯低於高點
    if (obvMaxAge < 5) return null;
    // 使用 OBV 區間的 10% 作為閾值（避免負值乘法錯誤）
    const obvRange = Math.max(...obv) - Math.min(...obv);
    if (obvRange === 0) return null;
    if (obvMax - currentObv < obvRange * 0.1) return null;

    return {
      type: 'WATCH',
      label: 'OBV 看跌背離',
      description: `價格創近期新高 ${c.high.toFixed(2)}，但 OBV 已下滑，量能不支持上漲`,
      reason: [
        '【出處】Murphy《金融市場技術分析》第7章 — 交易量和持倉量',
        '原理：權衡交易量（OBV）由格蘭維爾發明，累計上漲日交易量並扣除下跌日交易量。',
        '當價格創新高但 OBV 未能跟隨，表示上漲缺乏真正的買盤支持。',
        'OBV 的趨勢方向比具體數值更重要。',
        '操作：OBV 背離為趨勢減弱的早期警告，應提高警覺，考慮減碼。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/**
 * OBV 看漲背離
 * Murphy 第7章：價格創新低但 OBV 未創新低，底部可能形成
 */
export const obvBullishDivergence: TradingRule = {
  id: 'murphy-obv-bullish-div',
  name: 'OBV 看漲背離',
  description: '價格創近期新低但 OBV 未同步創新低',
  evaluate(candles, index): RuleSignal | null {
    if (index < 30) return null;
    const c = candles[index];

    const obv = computeObv(candles, index, 30);
    if (obv.length < 20) return null;

    // 條件1：價格在近20根創新低
    let priceLowest = true;
    for (let i = index - 20; i < index; i++) {
      if (i >= 0 && candles[i].low < c.low) { priceLowest = false; break; }
    }
    if (!priceLowest) return null;

    // 條件2：OBV 的最低點出現在 5+ 根前，當前 OBV 高於之前低點
    const obvLen = obv.length;
    const currentObv = obv[obvLen - 1];
    let obvMin = currentObv;
    for (let i = obvLen - 16; i < obvLen - 1; i++) {
      if (i >= 0 && obv[i] < obvMin) obvMin = obv[i];
    }
    // 使用 OBV 區間的 10% 作為閾值（避免負值乘法錯誤）
    const obvRange = Math.max(...obv) - Math.min(...obv);
    if (obvRange === 0) return null;
    if (currentObv - obvMin < obvRange * 0.1) return null;

    return {
      type: 'WATCH',
      label: 'OBV 看漲背離',
      description: `價格創近期新低 ${c.low.toFixed(2)}，但 OBV 未跟隨破底，買盤開始進入`,
      reason: [
        '【出處】Murphy《金融市場技術分析》第7章 — 交易量和持倉量',
        '原理：價格下跌但 OBV 拒絕跟隨，表示下跌缺乏真正的賣壓。',
        '聰明的資金可能正在底部悄悄吸籌。',
        '操作：OBV 看漲背離是底部可能形成的早期信號，可開始留意買入機會。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/**
 * 量能萎縮見頂警告
 * Murphy 第7章：上升趨勢中成交量逐日萎縮，趨勢後繼乏力
 */
export const volumeShrinkageTop: TradingRule = {
  id: 'murphy-vol-shrinkage-top',
  name: '量能萎縮見頂警告',
  description: '上漲過程中連續多日成交量萎縮，趨勢動能不足',
  evaluate(candles, index): RuleSignal | null {
    if (index < 20) return null;
    const c = candles[index];

    // 條件1：價格在高位（近20根最高附近）
    const swingHigh = findSwingHigh(candles, index, 20);
    if (swingHigh == null) return null;
    if (c.close < swingHigh * 0.95) return null;

    // 條件2：近5日持續上漲或高位盤旋
    let upDays = 0;
    for (let i = index - 4; i <= index; i++) {
      if (i >= 0 && candles[i].close >= candles[i - 1]?.close) upDays++;
    }
    if (upDays < 3) return null;

    // 條件3：成交量連續 3 日遞減
    if (index < 3) return null;
    const vol3 = candles[index].volume;
    const vol2 = candles[index - 1].volume;
    const vol1 = candles[index - 2].volume;
    if (!(vol1 > vol2 && vol2 > vol3)) return null;

    // 條件4：當日成交量低於5日均量的70%
    if (c.avgVol5 == null || c.volume >= c.avgVol5 * 0.7) return null;

    return {
      type: 'WATCH',
      label: '量縮見頂警告',
      description: `高位連漲但量能連續3日萎縮，當日量僅均量 ${((c.volume / (c.avgVol5 ?? 1)) * 100).toFixed(0)}%`,
      reason: [
        '【出處】Murphy《金融市場技術分析》第7章 — 交易量和持倉量',
        '原理：在上升趨勢中，交易量應隨價格上漲而放大。',
        '如果價格持續上漲但成交量逐日萎縮，表示買盤力道正在減弱。',
        '交易量領先於價格 — 量能的減少往往先於價格的轉折。',
        '操作：量縮上漲是趨勢即將反轉的早期警告，應提高警覺並收緊止損。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/**
 * 天量見頂（量能高潮）
 * Murphy 第7章：高位出現異常巨量，通常是分配行為的標誌
 */
export const volumeClimaxTop: TradingRule = {
  id: 'murphy-vol-climax-top',
  name: '天量見頂',
  description: '高位出現3倍以上均量的異常大量，可能為頂部分配',
  evaluate(candles, index): RuleSignal | null {
    if (index < 20) return null;
    const c = candles[index];

    // 條件1：在高位（近20根最高的前5%以內）
    const swingHigh = findSwingHigh(candles, index, 20);
    if (swingHigh == null) return null;
    if (c.high < swingHigh * 0.97) return null;

    // 條件2：成交量為20日均量的3倍以上
    if (c.avgVol20 == null || c.avgVol20 === 0) return null;
    const volRatio = c.volume / c.avgVol20;
    if (volRatio < 3.0) return null;

    // 條件3：出現長上影線或收黑（賣壓明顯）
    const hasSellingPressure =
      (c.high - Math.max(c.open, c.close)) > Math.abs(c.close - c.open) ||
      c.close < c.open;
    if (!hasSellingPressure) return null;

    return {
      type: 'SELL',
      label: '天量見頂',
      description: `高位出現 ${volRatio.toFixed(1)} 倍均量，伴隨賣壓信號`,
      reason: [
        '【出處】Murphy《金融市場技術分析》第7章 — 交易量和持倉量',
        '原理：在漲勢的最後階段，交易量突然放大到極端水平（量能高潮），',
        '通常是大戶在高位分配（出貨）的表現。',
        '這種「天量天價」的組合往往標誌著至少短期頂部。',
        '操作：天量見頂是強烈的賣出信號，應立即獲利了結或設緊密止損。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/**
 * 底部放量反彈確認
 * Murphy 第7章：長期下跌後出現放量陽線，可能是底部反轉信號
 */
export const bottomVolumeReversal: TradingRule = {
  id: 'murphy-bottom-vol-reversal',
  name: '底部放量反彈',
  description: '長期下跌後出現帶量長紅，可能為底部反轉信號',
  evaluate(candles, index): RuleSignal | null {
    if (index < 30) return null;
    const c = candles[index];

    // 條件1：之前有明顯下跌（近30根跌幅 > 15%）
    const price30ago = candles[index - 30]?.close;
    if (price30ago == null) return null;
    const decline = (price30ago - c.close) / price30ago;
    if (decline < 0.15) return null;

    // 條件2：當日收長紅
    if (!isLongRedCandle(c)) return null;

    // 條件3：成交量為5日均量的2倍以上
    if (c.avgVol5 == null || c.volume < c.avgVol5 * 2) return null;

    // 條件4：價格在 MA20 下方（確實在低位）
    if (c.ma20 != null && c.close > c.ma20) return null;

    return {
      type: 'WATCH',
      label: '底部放量反彈',
      description: `下跌 ${(decline * 100).toFixed(1)}% 後出現帶量長紅（${((c.volume / (c.avgVol5 ?? 1)) * 100).toFixed(0)}% 均量）`,
      reason: [
        '【出處】Murphy《金融市場技術分析》第7章 — 交易量和持倉量',
        '原理：在長期下跌後，突然出現異常放大的成交量配合陽線，',
        '可能是底部恐慌性拋售結束、聰明資金開始吸籌的信號。',
        '底部的成交量放大對應的是賣壓竭盡和新買盤進入。',
        '操作：底部放量反彈為潛在底部信號，但需等待後續確認。不宜重倉。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

// ── 匯出 ──────────────────────────────────────────────────────────────────────

export const MURPHY_VOLUME_RULES: TradingRule[] = [
  obvBearishDivergence,
  obvBullishDivergence,
  volumeShrinkageTop,
  volumeClimaxTop,
  bottomVolumeReversal,
];
