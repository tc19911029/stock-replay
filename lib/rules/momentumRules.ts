// ═══════════════════════════════════════════════════════════════
// 朱家泓《抓住線圖 股民變股神》
// 飆股戰法 + 續勢戰法 + Fibonacci 回檔幅度強弱
// ═══════════════════════════════════════════════════════════════

import { TradingRule, RuleSignal } from '@/types';
import { recentHigh } from '@/lib/indicators';
import {
  isLongRedCandle, maConvergence,
  isHigherLow, fibRetracementLevel, findSwingHigh, findSwingLow,
} from './ruleUtils';

// ── 戰法5：飆股戰法 ─────────────────────────────────────────────────────────

/** 飆股戰法突破：8條件評分制 */
export const surgeStockBreakout: TradingRule = {
  id: 'surge-stock-breakout',
  name: '飆股戰法（盤整突破）',
  description: '經過長期盤整、底部漸高、均線糾結、帶量突破頸線的飆股條件',
  evaluate(candles, index): RuleSignal | null {
    if (index < 60) return null;
    const c = candles[index];

    let score = 0;
    const details: string[] = [];

    // 條件1：經過長期盤整（2~3個月≈40~60日），BB帶寬窄
    const recentBW: number[] = [];
    for (let i = Math.max(0, index - 40); i < index; i++) {
      if (candles[i].bbBandwidth != null) recentBW.push(candles[i].bbBandwidth!);
    }
    if (recentBW.length > 20) {
      const avgBW = recentBW.reduce((a, b) => a + b, 0) / recentBW.length;
      if (avgBW < 0.15) { score++; details.push('長期盤整(BB窄)'); }
    }

    // 條件2：底部漸高
    if (isHigherLow(candles, index, 60)) { score++; details.push('底部漸高'); }

    // 條件3：盤整期出現草叢吸貨量（量低於均量，偶爾小量突增）
    let lowVolDays = 0;
    for (let i = Math.max(0, index - 40); i < index; i++) {
      const avgV = candles[i].avgVol20;
      if (avgV != null && candles[i].volume < avgV * 0.8) lowVolDays++;
    }
    if (lowVolDays > 20) { score++; details.push('草叢量吸貨'); }

    // 條件4：突破頸線（突破近60日最高點）
    const neckline = recentHigh(candles, index, 60);
    if (c.close > neckline) { score++; details.push(`突破頸線${neckline.toFixed(2)}`); }

    // 條件5：均線糾結（ma5/ma10/ma20差距<2.5%）
    const conv = maConvergence(c);
    if (conv != null && conv < 0.025) { score++; details.push(`均線糾結${(conv * 100).toFixed(1)}%`); }

    // 條件6：帶量突破（量>=20日均量2倍）
    const avgVol20 = c.avgVol20;
    if (avgVol20 != null && c.volume >= avgVol20 * 2) { score++; details.push(`爆量${(c.volume / avgVol20).toFixed(1)}x`); }

    // 條件7：長紅K線
    if (isLongRedCandle(c)) { score++; details.push('長紅K'); }

    // 條件8：站上所有短中期均線
    if (c.ma5 != null && c.ma10 != null && c.ma20 != null &&
        c.close > c.ma5 && c.close > c.ma10 && c.close > c.ma20) {
      score++; details.push('站上均線');
    }

    // 至少達到 5/8 分才觸發
    if (score < 5) return null;

    return {
      type: 'BUY',
      label: `飆股突破(${score}/8)`,
      description: `飆股條件 ${score}/8 達標：${details.join('、')}`,
      reason: [
        '【朱家泓《抓住線圖》第12章 飆股戰法】',
        '飆股8種圖形條件：經過長期盤整(2~3個月)、底部漸高、盤整期出現草叢吸貨量、突破頸線帶量發動、發動前短中長期均線糾結、發動時力道夠強量價均佳、短期上檔無壓。',
        '操作目標：機會確認時，短時間獲利50%，甚至倍數以上。',
        '飆股戰法以用在中小型股為原則，並不適合大型股。',
        '【13項教戰守則】以個人資料庫鎖股及當日盤中即時出現的強勢股為標的；開盤後9:00~9:10內強勢拉向漲停的個股為第一優先追進。',
        '【操作心法】膽大心細，進場不對在小賠時就要立刻出場。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 飆股賣出：跌破前日低點 */
export const surgeStockExit: TradingRule = {
  id: 'surge-stock-exit',
  name: '飆股賣出（跌破前日低點）',
  description: '收盤跌破前一日K線最低點，飆股出場',
  evaluate(candles, index): RuleSignal | null {
    if (index < 2) return null;
    const c = candles[index];
    const prev = candles[index - 1];
    // 只在近期有大漲的情況下才觸發（近20日漲幅>15%）
    if (index < 20) return null;
    const recentGain = (c.close - candles[index - 20].close) / candles[index - 20].close;
    if (recentGain < 0.15) return null;

    if (c.close >= prev.low) return null;

    return {
      type: 'SELL',
      label: '飆股出場',
      description: `收盤 ${c.close.toFixed(2)} 跌破前日低點 ${prev.low.toFixed(2)}（近20日漲${(recentGain * 100).toFixed(1)}%）`,
      reason: [
        '【朱家泓《抓住線圖》第12章 飆股戰法調整術】',
        '續抱及停利出場條件：',
        '(1) 未跌破上升趨勢線可續抱；跌破上升趨勢線停利出場。',
        '(2) 未破前一日低價（K線順勢法）可續抱；跌破前一日低價停利出場。',
        '(3) 未跌破3日均線可續抱；跌破3日均線停利出場。',
        '操作飆股要集中精神注意盤中變化，當股價轉弱時就立刻出場。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

// ── 戰法6：續勢戰法 ─────────────────────────────────────────────────────────

/** 續勢戰法買進：前波大漲後回檔完成，突破近期高點 */
export const momentumContinuationBuy: TradingRule = {
  id: 'momentum-continuation-buy',
  name: '續勢戰法買進（波浪2/3進場）',
  description: '前波漲幅>20%後回檔0.382~0.618，底底高確認後突破近期高點',
  evaluate(candles, index): RuleSignal | null {
    if (index < 30) return null;
    const c = candles[index];

    // 找前波 swing high（近60日最高）和更早的 swing low
    const swingHigh = findSwingHigh(candles, index, 60);
    const swingLow = findSwingLow(candles, index, 60);
    if (swingHigh == null || swingLow == null) return null;

    // 前波漲幅需 > 20%
    const surgeRange = swingHigh - swingLow;
    const surgePct = surgeRange / swingLow;
    if (surgePct < 0.20) return null;

    // 目前價格應在回檔區間（低於 swing high）
    if (c.close >= swingHigh) return null;

    // 回檔幅度在 0.382~0.618 之間
    const fib = fibRetracementLevel(swingHigh, swingLow, c.close);
    if (fib.grade === 'strong' && c.close > swingHigh * 0.95) return null; // 回檔太淺不算

    // 底底高確認
    if (!isHigherLow(candles, index, 15)) return null;

    // 突破近5日高點（啟動訊號）
    const recentH = recentHigh(candles, index, 5);
    if (c.close <= recentH) return null;
    if (!isLongRedCandle(c)) return null;

    return {
      type: 'BUY',
      label: `續勢買進(${fib.grade === 'strong' ? '強' : fib.grade === 'normal' ? '正常' : '弱'}回檔)`,
      description: `前波漲${(surgePct * 100).toFixed(0)}%，回檔至${fib.level}位(${fib.grade === 'strong' ? '強勢' : fib.grade === 'normal' ? '正常' : '弱勢'})，底底高後突破近期高`,
      reason: [
        '【朱家泓《抓住線圖》第13章 續勢戰法】',
        '依據波浪理論，90%的飆股不會只飆漲初升段一波就結束，往往在拉回洗盤修正之後，還有很大的續飆機會。',
        '續勢方法就是跟隨初升段已經表態的強勢飆股，繼續做後面的主升段、末升段。',
        `回檔幅度判斷：${fib.level === 0.382 ? '強勢回檔(0.382)，容易過前高' : fib.level === 0.5 ? '正常回檔(0.5)，前高附近可能盤整' : '弱勢回檔(0.618)，前高不容易過'}`,
        '先決條件是大盤要處於大多頭格局，當盤面上飆股輩出時，專心鎖定此類飆股，抓住機會。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

// ── 補充：Fibonacci 回檔幅度強弱判斷 ─────────────────────────────────────────

/** 回檔幅度強弱判斷 */
export const fibRetracementGrade: TradingRule = {
  id: 'fib-retracement-grade',
  name: '回檔幅度強弱判斷',
  description: '判斷多頭回檔深度：0.382=強勢、0.5=正常、0.618=弱勢',
  evaluate(candles, index): RuleSignal | null {
    if (index < 20) return null;
    const c = candles[index];

    // 只在回檔中觸發（今日低於近20日高點，且近20日曾有一段上漲）
    const swingHigh = findSwingHigh(candles, index, 20);
    const swingLow = findSwingLow(candles, index, 40);
    if (swingHigh == null || swingLow == null) return null;

    const range = swingHigh - swingLow;
    if (range / swingLow < 0.10) return null; // 漲幅<10%不值得分析

    // 目前在回檔中
    if (c.close >= swingHigh) return null;
    if (c.close <= swingLow) return null;

    const fib = fibRetracementLevel(swingHigh, swingLow, c.close);

    // 只在回檔到關鍵位附近時報告
    const retracement = (swingHigh - c.close) / range;
    if (retracement < 0.30 || retracement > 0.70) return null;

    const gradeLabel = fib.grade === 'strong' ? '強勢回檔' : fib.grade === 'normal' ? '正常回檔' : '弱勢回檔';

    return {
      type: 'WATCH',
      label: gradeLabel,
      description: `回檔至 ${fib.level} 位（${(retracement * 100).toFixed(1)}%），${gradeLabel}`,
      reason: [
        '【朱家泓《抓住線圖》第3章 從圖形看出股票上漲強弱度】',
        `回檔幅度：${(retracement * 100).toFixed(1)}%，接近 Fibonacci ${fib.level} 水平。`,
        fib.grade === 'strong'
          ? '強勢回檔(0.382)：下跌幅度最小，上面壓力也最小，容易過前面高點，繼續多頭走勢。強勢回檔的股票走勢最強。'
          : fib.grade === 'normal'
            ? '正常回檔(0.5)：下跌幅度中等，往上攻擊時容易在接近前面高點時稍做盤整消化賣壓後再過前高。一般多頭的表現。'
            : '弱勢回檔(0.618)：下跌修正幅度太大，上面造成很大套牢壓力，前面高點不容易過。弱勢多頭的表現。',
        '【選股原則】做多選強勢回檔的股票（最會漲的），不是回檔最多、股價最低的最好。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};
