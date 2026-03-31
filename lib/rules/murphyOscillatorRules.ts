// ═══════════════════════════════════════════════════════════════
// Murphy《金融市場技術分析》第10章
// 擺動指數規則 — KD背離、MACD柱狀圖、RSI趨勢內涵、動力指數、ROC
// ═══════════════════════════════════════════════════════════════

import { TradingRule, RuleSignal, CandleWithIndicators } from '@/types';
import { findSwingHighs, findSwingLows } from './ruleUtils';

// ── 規則 ──────────────────────────────────────────────────────────────────────

/**
 * KD 看漲背離
 * Murphy 第10章：價格創新低但 %K 未創新低，底部可能形成
 */
export const kdBullishDivergence: TradingRule = {
  id: 'murphy-kd-bullish-div',
  name: 'KD 看漲背離',
  description: '價格創新低但隨機指數（KD）未跟隨破底',
  evaluate(candles, index): RuleSignal | null {
    if (index < 30) return null;
    const c = candles[index];
    if (c.kdK == null || c.kdD == null) return null;

    // 找近40根的兩個價格低點
    const priceLows = findSwingLows(candles, index, 40, 2);
    if (priceLows.length < 2) return null;

    const prev = priceLows[priceLows.length - 2];
    const recent = priceLows[priceLows.length - 1];

    // 條件1：價格底底低
    if (recent.price >= prev.price) return null;

    // 條件2：KD 底底高（在兩個低點處比較 kdK）
    const prevKd = candles[prev.idx]?.kdK;
    const recentKd = candles[recent.idx]?.kdK;
    if (prevKd == null || recentKd == null) return null;
    if (recentKd <= prevKd) return null;

    // 條件3：KD 在超賣區（< 30）或剛離開
    if (recentKd > 40) return null;

    return {
      type: 'BUY',
      label: 'KD 看漲背離',
      description: `價格低點 ${prev.price.toFixed(2)}→${recent.price.toFixed(2)} 創新低，但 KD ${prevKd.toFixed(0)}→${recentKd.toFixed(0)} 底部抬高`,
      reason: [
        '【出處】Murphy《金融市場技術分析》第10章 — 擺動指數和相反意見理論',
        '原理：隨機指數（KD）由喬治·萊恩發明，衡量收盤價在近期價格區間中的位置。',
        '當價格創新低但 KD 拒絕跟隨（看漲背離），表示下跌動能正在衰減。',
        '背離信號在 KD 處於超賣區域（< 20）時最有效。',
        '操作：等待 %K 上穿 %D 作為進場確認信號。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/**
 * KD 看跌背離
 * Murphy 第10章：價格創新高但 %K 未創新高
 */
export const kdBearishDivergence: TradingRule = {
  id: 'murphy-kd-bearish-div',
  name: 'KD 看跌背離',
  description: '價格創新高但隨機指數（KD）未跟隨創新高',
  evaluate(candles, index): RuleSignal | null {
    if (index < 30) return null;
    const c = candles[index];
    if (c.kdK == null || c.kdD == null) return null;

    const priceHighs = findSwingHighs(candles, index, 40, 2);
    if (priceHighs.length < 2) return null;

    const prev = priceHighs[priceHighs.length - 2];
    const recent = priceHighs[priceHighs.length - 1];

    // 條件1：價格頭頭高
    if (recent.price <= prev.price) return null;

    // 條件2：KD 頭頭低
    const prevKd = candles[prev.idx]?.kdK;
    const recentKd = candles[recent.idx]?.kdK;
    if (prevKd == null || recentKd == null) return null;
    if (recentKd >= prevKd) return null;

    // 條件3：KD 在超買區（> 70）
    if (recentKd < 60) return null;

    return {
      type: 'SELL',
      label: 'KD 看跌背離',
      description: `價格高點 ${prev.price.toFixed(2)}→${recent.price.toFixed(2)} 創新高，但 KD ${prevKd.toFixed(0)}→${recentKd.toFixed(0)} 頂部下降`,
      reason: [
        '【出處】Murphy《金融市場技術分析》第10章 — 擺動指數和相反意見理論',
        '原理：價格創新高但 KD 無法跟隨（看跌背離），表示上漲動能正在衰減。',
        '背離信號在 KD 處於超買區域（> 80）時最有效。',
        '操作：等待 %K 下穿 %D 作為出場確認信號。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/**
 * MACD 柱狀圖縮短警告
 * Murphy 第10章：MACD 柱狀圖開始縮短，預示即將交叉
 */
export const macdHistogramShrink: TradingRule = {
  id: 'murphy-macd-hist-shrink',
  name: 'MACD 柱狀圖縮短',
  description: 'MACD 柱狀圖連續縮短，預示 MACD 即將交叉',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const c = candles[index];
    if (c.macdOSC == null) return null;

    // 取最近5根的 MACD 柱狀圖
    const hist: number[] = [];
    for (let i = index - 4; i <= index; i++) {
      const h = candles[i]?.macdOSC;
      if (h == null) return null;
      hist.push(h);
    }

    // 情況1：正柱狀圖連續3根縮短（看跌預警）
    if (hist[4] > 0 && hist[3] > 0 && hist[2] > 0) {
      if (hist[2] > hist[3] && hist[3] > hist[4]) {
        return {
          type: 'WATCH',
          label: 'MACD柱縮短（多轉空）',
          description: `MACD 正柱連續3根縮短 ${hist[2].toFixed(2)}→${hist[3].toFixed(2)}→${hist[4].toFixed(2)}`,
          reason: [
            '【出處】Murphy《金融市場技術分析》第10章 — MACD',
            '原理：MACD 柱狀圖 = MACD 線與信號線的差值。',
            '柱狀圖開始縮短意味著 MACD 線正在向信號線靠攏，即將交叉。',
            '柱狀圖的變化比 MACD 線本身更早發出信號。',
            '操作：正柱縮短是多頭動能減弱的警告，應收緊止損。',
          ].join('\n'),
          ruleId: this.id,
        };
      }
    }

    // 情況2：負柱狀圖連續3根縮短（看漲預警）
    if (hist[4] < 0 && hist[3] < 0 && hist[2] < 0) {
      if (hist[2] < hist[3] && hist[3] < hist[4]) {
        return {
          type: 'WATCH',
          label: 'MACD柱縮短（空轉多）',
          description: `MACD 負柱連續3根縮短 ${hist[2].toFixed(2)}→${hist[3].toFixed(2)}→${hist[4].toFixed(2)}`,
          reason: [
            '【出處】Murphy《金融市場技術分析》第10章 — MACD',
            '原理：負的 MACD 柱狀圖開始縮短，表示空頭動能正在減弱。',
            'MACD 即將形成黃金交叉的前兆。',
            '操作：負柱縮短是底部可能形成的早期信號，可開始關注買入機會。',
          ].join('\n'),
          ruleId: this.id,
        };
      }
    }

    return null;
  },
};

/**
 * RSI 強勢趨勢修正
 * Murphy 第10章：在強勢上升趨勢中，RSI 超買不一定是賣出信號
 */
export const rsiTrendContext: TradingRule = {
  id: 'murphy-rsi-trend-context',
  name: 'RSI 趨勢修正',
  description: '強勢上升趨勢中 RSI 超買區回落至50附近為買入機會',
  evaluate(candles, index): RuleSignal | null {
    if (index < 30) return null;
    const c = candles[index];
    if (c.rsi14 == null || c.ma20 == null || c.ma60 == null) return null;

    // 條件1：強勢上升趨勢（MA20 > MA60 且兩者都上揚）
    if (c.ma20 <= c.ma60) return null;
    const prevMa20 = candles[index - 5]?.ma20;
    const prevMa60 = candles[index - 5]?.ma60;
    if (prevMa20 == null || prevMa60 == null) return null;
    if (c.ma20 <= prevMa20 || c.ma60 <= prevMa60) return null;

    // 條件2：RSI 從超買區回落到 40-55 區間（非超賣）
    if (c.rsi14 < 40 || c.rsi14 > 55) return null;

    // 條件3：前10根曾有 RSI > 70（之前處於超買）
    let wasOverbought = false;
    for (let i = index - 10; i < index; i++) {
      if (i >= 0 && candles[i].rsi14 != null && candles[i].rsi14! > 70) {
        wasOverbought = true;
        break;
      }
    }
    if (!wasOverbought) return null;

    // 條件4：價格仍在 MA20 附近（正常回調而非崩跌）
    const deviation = (c.close - c.ma20) / c.ma20;
    if (Math.abs(deviation) > 0.05) return null;

    return {
      type: 'BUY',
      label: 'RSI 趨勢回調買點',
      description: `強勢趨勢中 RSI 從超買回落至 ${c.rsi14.toFixed(0)}，接近 MA20 支撐`,
      reason: [
        '【出處】Murphy《金融市場技術分析》第10章 — 擺動指數和相反意見理論',
        '原理：Murphy 強調，在強勢趨勢市場中，擺動指數會長時間處於極端區域。',
        '此時 RSI 超買不代表應該賣出，反而當 RSI 回落至50附近時是買入機會。',
        '這是 Murphy 的關鍵觀點：趨勢方向優先，擺動指數信號需配合趨勢解讀。',
        '操作：在確認的上升趨勢中，RSI 回落至40-55區間可考慮加碼。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/**
 * ROC 極端值反轉
 * Murphy 第10章：變化速度指數達到極端值時的反轉信號
 */
export const rocExtreme: TradingRule = {
  id: 'murphy-roc-extreme',
  name: 'ROC 極端值反轉',
  description: 'ROC（變化速度指數）達到極端超買/超賣區域',
  evaluate(candles, index): RuleSignal | null {
    if (index < 20) return null;
    const c = candles[index];
    if (c.roc10 == null) return null;

    // 計算近60根 ROC 的標準差來判斷極端值
    const rocs: number[] = [];
    for (let i = Math.max(0, index - 59); i <= index; i++) {
      const r = candles[i]?.roc10;
      if (r != null) rocs.push(r);
    }
    if (rocs.length < 30) return null;

    const mean = rocs.reduce((a, b) => a + b, 0) / rocs.length;
    const variance = rocs.reduce((a, b) => a + (b - mean) ** 2, 0) / rocs.length;
    const stdDev = Math.sqrt(variance);
    if (stdDev === 0) return null;

    const zScore = (c.roc10 - mean) / stdDev;

    // 超賣反轉（z < -2）
    if (zScore < -2 && c.close > c.open) {
      return {
        type: 'WATCH',
        label: 'ROC 超賣極端',
        description: `ROC(10) = ${c.roc10.toFixed(2)}%，偏離均值 ${zScore.toFixed(1)} 個標準差，極度超賣`,
        reason: [
          '【出處】Murphy《金融市場技術分析》第10章 — 擺動指數',
          '原理：變化速度指數（ROC）計算當前價格與N日前價格的百分比變化。',
          '當 ROC 達到歷史極端值（超過2個標準差），短期反轉概率增加。',
          '操作：ROC 極端超賣配合收紅，可能是短期反彈的機會。但需等待確認。',
        ].join('\n'),
        ruleId: this.id,
      };
    }

    // 超買反轉（z > 2）
    if (zScore > 2 && c.close < c.open) {
      return {
        type: 'WATCH',
        label: 'ROC 超買極端',
        description: `ROC(10) = ${c.roc10.toFixed(2)}%，偏離均值 ${zScore.toFixed(1)} 個標準差，極度超買`,
        reason: [
          '【出處】Murphy《金融市場技術分析》第10章 — 擺動指數',
          '原理：ROC 達到極端超買，短期回調概率增加。',
          '操作：ROC 極端超買配合收黑，應考慮獲利了結或收緊止損。',
        ].join('\n'),
        ruleId: this.id,
      };
    }

    return null;
  },
};

/**
 * 動力指數零線交叉
 * Murphy 第10章：動力指數穿越零線為趨勢確認信號
 */
export const momentumZeroCross: TradingRule = {
  id: 'murphy-momentum-zero-cross',
  name: '動力指數零線交叉',
  description: 'ROC 穿越零線確認趨勢方向轉變',
  evaluate(candles, index): RuleSignal | null {
    if (index < 2) return null;
    const c = candles[index];
    const prev = candles[index - 1];
    if (c.roc10 == null || prev.roc10 == null) return null;

    // 向上穿越零線
    if (prev.roc10 < 0 && c.roc10 >= 0 && c.close > c.open) {
      return {
        type: 'WATCH',
        label: '動力指數轉正',
        description: `ROC(10) 從 ${prev.roc10.toFixed(2)}% 向上穿越零線至 ${c.roc10.toFixed(2)}%`,
        reason: [
          '【出處】Murphy《金融市場技術分析》第10章 — 擺動指數',
          '原理：動力指數（Momentum/ROC）穿越零線意味著當前價格已高於N日前。',
          '向上穿越零線是中期趨勢轉為多頭的確認信號。',
          '操作：配合其他趨勢工具確認後，可考慮做多。',
        ].join('\n'),
        ruleId: this.id,
      };
    }

    // 向下穿越零線
    if (prev.roc10 > 0 && c.roc10 <= 0 && c.close < c.open) {
      return {
        type: 'WATCH',
        label: '動力指數轉負',
        description: `ROC(10) 從 ${prev.roc10.toFixed(2)}% 向下穿越零線至 ${c.roc10.toFixed(2)}%`,
        reason: [
          '【出處】Murphy《金融市場技術分析》第10章 — 擺動指數',
          '原理：動力指數向下穿越零線意味著當前價格已低於N日前。',
          '向下穿越零線是中期趨勢轉為空頭的確認信號。',
          '操作：配合趨勢線突破等確認後，應考慮減碼或出場。',
        ].join('\n'),
        ruleId: this.id,
      };
    }

    return null;
  },
};

// ── 匯出 ──────────────────────────────────────────────────────────────────────

export const MURPHY_OSCILLATOR_RULES: TradingRule[] = [
  kdBullishDivergence,
  kdBearishDivergence,
  macdHistogramShrink,
  rsiTrendContext,
  rocExtreme,
  momentumZeroCross,
];
