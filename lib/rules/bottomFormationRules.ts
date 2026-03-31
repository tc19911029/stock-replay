// ═══════════════════════════════════════════════════════════════
// 朱家泓《活用技術分析寶典》第2篇
// 底部型態偵測 — 黃金右腳、草叢量、均線打底確認
// ═══════════════════════════════════════════════════════════════

import { TradingRule, RuleSignal, CandleWithIndicators } from '@/types';
import {
  isLongRedCandle,
  isMaTrendingUp, bodyPct,
} from './ruleUtils';

// ── 工具函數 ──────────────────────────────────────────────────────────────────

/** 找 lookback 區間內的 swing lows（局部低點，需左右各1根更高） */
function findSwingLows(
  candles: CandleWithIndicators[], index: number, lookback: number,
): { idx: number; low: number }[] {
  const result: { idx: number; low: number }[] = [];
  const start = Math.max(2, index - lookback);
  for (let i = start; i <= index - 2; i++) {
    if (candles[i].low <= candles[i - 1].low && candles[i].low <= candles[i + 1].low) {
      result.push({ idx: i, low: candles[i].low });
    }
  }
  return result;
}

/** 找區間內的爆量日（成交量 >= 5日均量 * 倍數） */
function findVolumeSpikeIndices(
  candles: CandleWithIndicators[], startIdx: number, endIdx: number, multiplier: number,
): number[] {
  const spikes: number[] = [];
  for (let i = startIdx; i <= endIdx; i++) {
    const c = candles[i];
    if (c.avgVol5 != null && c.volume >= c.avgVol5 * multiplier) {
      spikes.push(i);
    }
  }
  return spikes;
}

// ── 規則 ──────────────────────────────────────────────────────────────────────

/**
 * 黃金右腳（第2支腳大量反彈）
 * 書中定義：空頭下跌後出現第1支腳大量反彈，接著回檔不破前低形成「底底高」的第2支腳，
 * 第2支腳通常也會出現大量，後續突破兩腳中間最高點即為多頭確認。
 */
export const goldenRightFoot: TradingRule = {
  id: 'zhu-golden-right-foot',
  name: '黃金右腳（底部確認）',
  description: '空頭下跌後出現底底高的雙腳打底，第2支腳（黃金右腳）確認反轉',
  evaluate(candles, index): RuleSignal | null {
    if (index < 40) return null;
    const c = candles[index];

    // 找近60根的 swing lows
    const swingLows = findSwingLows(candles, index, 60);
    if (swingLows.length < 2) return null;

    const foot1 = swingLows[swingLows.length - 2]; // 第1支腳
    const foot2 = swingLows[swingLows.length - 1]; // 第2支腳（黃金右腳）

    // 條件1：底底高（第2支腳高於第1支腳）
    if (foot2.low <= foot1.low) return null;

    // 條件2：兩腳間距至少5根K線
    if (foot2.idx - foot1.idx < 5) return null;

    // 條件3：第1支腳附近有大量（±2根內有爆量）
    const foot1Spikes = findVolumeSpikeIndices(
      candles, Math.max(0, foot1.idx - 2), Math.min(index, foot1.idx + 2), 1.8,
    );
    if (foot1Spikes.length === 0) return null;

    // 條件4：找兩腳之間的最高點作為頸線
    let neckline = -Infinity;
    for (let i = foot1.idx; i <= foot2.idx; i++) {
      neckline = Math.max(neckline, candles[i].high);
    }
    if (neckline === -Infinity) return null;

    // 條件5：今日帶量突破頸線
    if (c.close <= neckline) return null;
    if (!isLongRedCandle(c)) return null;
    if (c.avgVol5 != null && c.volume < c.avgVol5 * 1.2) return null;

    return {
      type: 'BUY',
      label: '黃金右腳突破',
      description: `雙腳底(${foot1.low.toFixed(1)}→${foot2.low.toFixed(1)}) 突破頸線${neckline.toFixed(1)}`,
      reason: [
        '【朱家泓《活用技術分析寶典》第2篇 多頭打底量價變化】',
        '空頭下跌後出現第1支腳大量反彈，回檔不破前低形成底底高的第2支腳（黃金右腳）。',
        '今日帶量突破兩腳中間最高點，趨勢反轉成多頭確認。',
        '操作要點：突破頸線後回檔不破頸線，為最佳加碼位置。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/**
 * 草叢量偵測（盤整中異常大量 = 主力進貨信號）
 * 書中定義：打底盤整中出現的異常大量，暫視為主力的進貨量。
 */
export const accumulationVolume: TradingRule = {
  id: 'zhu-accumulation-volume',
  name: '草叢量（主力進貨信號）',
  description: '盤整打底區間出現異常大量，疑似主力進貨',
  evaluate(candles, index): RuleSignal | null {
    if (index < 30) return null;
    const c = candles[index];

    // 條件1：位於盤整區（BB帶寬窄 or 近20日振幅小）
    if (c.bbBandwidth != null && c.bbBandwidth > 0.15) return null;

    // 條件2：股價在相對低檔（收盤 < MA60 或偏離MA20不超過5%）
    if (c.ma20 != null && c.close > c.ma20 * 1.05) return null;

    // 條件3：今日成交量 >= 20日均量 * 2（異常大量）
    if (c.avgVol20 == null || c.volume < c.avgVol20 * 2) return null;

    // 條件4：不是大跌（收盤不能跌超過3%，主力進貨不會殺太低）
    if (bodyPct(c) > 0.03 && c.close < c.open) return null;

    // 條件5：收在當日高低的上半部（多方較強）
    const halfLine = (c.high + c.low) / 2;
    if (c.close < halfLine) return null;

    const volRatio = (c.volume / c.avgVol20).toFixed(1);

    return {
      type: 'WATCH',
      label: '草叢量',
      description: `盤整低檔爆量${volRatio}倍，收在半分價之上，疑似主力進貨`,
      reason: [
        '【朱家泓《活用技術分析寶典》第2篇 多頭打底量價變化】',
        '打底盤整中出現的異常大量，暫視為主力的進貨量（也稱為草叢量）。',
        '後續注意：若均線開始由下彎轉為上揚，打底接近完成。',
        '當10均與20均形成多頭排列，可鎖股準備做多。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/**
 * 均線打底完成確認
 * 書中定義：打底盤整期間，10均與20均形成向上的多頭排列 → 打底接近完成
 */
export const maBottomConfirm: TradingRule = {
  id: 'zhu-ma-bottom-confirm',
  name: '均線打底完成（10MA/20MA多排）',
  description: '打底區10日均線與20日均線剛形成多頭排列，打底接近完成',
  evaluate(candles, index): RuleSignal | null {
    if (index < 40) return null;
    const c = candles[index];
    const prev = candles[index - 1];
    if (c.ma10 == null || c.ma20 == null || prev.ma10 == null || prev.ma20 == null) return null;

    // 條件1：今日 MA10 > MA20（多頭排列）
    if (c.ma10 <= c.ma20) return null;

    // 條件2：昨日 MA10 <= MA20（剛剛交叉）
    if (prev.ma10 > prev.ma20) return null;

    // 條件3：MA10 和 MA20 都在上揚
    if (!isMaTrendingUp(candles, index, 'ma10', 3)) return null;
    if (!isMaTrendingUp(candles, index, 'ma20', 5)) return null;

    // 條件4：股價在均線之上
    if (c.close < c.ma10) return null;

    // 條件5：近40根內有底底高（確認是打底不是下跌反彈）
    const swingLows = findSwingLows(candles, index, 40);
    if (swingLows.length < 2) return null;
    const l1 = swingLows[swingLows.length - 2];
    const l2 = swingLows[swingLows.length - 1];
    if (l2.low <= l1.low) return null;

    return {
      type: 'BUY',
      label: '均線打底完成',
      description: `10MA(${c.ma10.toFixed(1)})上穿20MA(${c.ma20.toFixed(1)})，底底高確認`,
      reason: [
        '【朱家泓《活用技術分析寶典》第2篇 多頭打底量價觀察】',
        '打底盤整期間，10均與20均形成向上的多頭排列，打底接近完成。',
        '配合底底高確認，可鎖股準備做短多。',
        '後續若突破60均形成4線多排，可做中長多。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/**
 * 半分價強弱判斷
 * 書中定義：K線第5要素（半分價=(最高+最低)/2），收盤在半分價之上=強勢，之下=弱勢
 */
export const halfPriceStrength: TradingRule = {
  id: 'zhu-half-price-strength',
  name: '半分價強弱轉換',
  description: '連續3日收盤從半分價下方轉至上方，多方轉強',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const c = candles[index];
    const p1 = candles[index - 1];
    const p2 = candles[index - 2];

    const hp = (c.high + c.low) / 2;
    const hp1 = (p1.high + p1.low) / 2;
    const hp2 = (p2.high + p2.low) / 2;

    // 前2日收盤在半分價之下，今日收盤在半分價之上 → 轉強
    const wasWeak = p2.close < hp2 && p1.close < hp1;
    const nowStrong = c.close > hp;

    if (!wasWeak || !nowStrong) return null;

    // 今日要收紅且有量
    if (c.close <= c.open) return null;
    if (c.avgVol5 != null && c.volume < c.avgVol5 * 0.8) return null;

    return {
      type: 'WATCH',
      label: '半分價轉強',
      description: `收盤${c.close.toFixed(1)}站上半分價${hp.toFixed(1)}，前2日均在半分價下`,
      reason: [
        '【朱家泓《活用技術分析寶典》第3篇 K線4+1要素】',
        'K線第5要素「半分價」=(最高+最低)/2。',
        '收盤在半分價之上屬於強勢區，之下屬於弱勢區。',
        '連續弱勢後今日轉強，多方力道正在恢復，留意後續發展。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

export const BOTTOM_FORMATION_RULES: TradingRule[] = [
  goldenRightFoot,
  accumulationVolume,
  maBottomConfirm,
  halfPriceStrength,
];
