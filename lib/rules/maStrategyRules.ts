// ═══════════════════════════════════════════════════════════════
// 朱家泓《抓住線圖 股民變股神》
// 均線戰法：一條均線（MA20）、三條均線（MA3/MA10/MA24）、二條均線（MA10/MA24）
// ═══════════════════════════════════════════════════════════════

import { TradingRule, RuleSignal } from '@/types';
import { crossedBelow } from '@/lib/indicators';
import { isLongRedCandle, isMaTrendingUp, isHigherLow } from './ruleUtils';

// ── 戰法2：一條均線戰法（MA20）──────────────────────────────────────────────

/** 一條均線戰法買進：底底高 + 暴量紅K站上MA20 + MA20上揚 */
export const singleMa20Buy: TradingRule = {
  id: 'single-ma20-buy',
  name: '一條均線戰法買進（MA20）',
  description: '低檔打底完成出現暴量紅K站上MA20，且MA20走平或上揚，買進',
  evaluate(candles, index): RuleSignal | null {
    if (index < 20) return null;
    const c = candles[index];
    const prev = candles[index - 1];
    if (c.ma20 == null || prev.ma20 == null) return null;

    // 1. 今日收盤站上 MA20
    if (c.close <= c.ma20) return null;
    // 2. 前日收盤在 MA20 以下（突破確認）
    if (prev.close > prev.ma20) return null;
    // 3. 長紅K線
    if (!isLongRedCandle(c)) return null;
    // 4. 帶量（>= 5日均量 1.5倍）
    const avgVol = c.avgVol5;
    if (avgVol != null && c.volume < avgVol * 1.5) return null;
    // 5. MA20 走平或上揚
    if (!isMaTrendingUp(candles, index, 'ma20', 3) && c.ma20 < candles[index - 3].ma20!) return null;
    // 6. 底底高型態（加分但不強制）
    const hasHigherLow = isHigherLow(candles, index, 20);

    return {
      type: 'BUY',
      label: '一條均線買進',
      description: `暴量紅K站上MA20(${c.ma20.toFixed(2)})，MA20上揚${hasHigherLow ? '＋底底高' : ''}`,
      reason: [
        '【朱家泓《抓住線圖》第7章 一條均線戰法】',
        '做多進場：低檔打底完成出現暴大量上漲的紅K線，股價站上20日均線之上，且均線走平或上揚，買進。',
        '續抱：收盤股價沒有跌破20日均線時，續抱。',
        '出場：收盤前確認股價跌破20日均線時，出場。',
        '停損：進場後，守20日均線。',
        hasHigherLow ? '【底底高確認】已出現底底高型態，多頭走勢要確認。' : '',
        '【建議】採用10日或20日均線為宜，不要用太短或太長的均線。',
      ].filter(Boolean).join('\n'),
      ruleId: this.id,
    };
  },
};

/** 一條均線戰法賣出：收盤跌破MA20 */
export const singleMa20Sell: TradingRule = {
  id: 'single-ma20-sell',
  name: '一條均線戰法賣出（跌破MA20）',
  description: '收盤確認股價跌破20日均線，出場',
  evaluate(candles, index): RuleSignal | null {
    if (index < 1) return null;
    if (!crossedBelow(candles, index, 'ma20')) return null;
    const c = candles[index];

    return {
      type: 'SELL',
      label: '一條均線賣出',
      description: `收盤 ${c.close.toFixed(2)} 跌破 MA20(${c.ma20?.toFixed(2)})`,
      reason: [
        '【朱家泓《抓住線圖》第7章 一條均線戰法】',
        '出場：收盤前確認股價跌破20日均線時，出場。',
        '上漲行進中跌破20日均線後出場，當股價再站上20日均線，且20日均線仍持續向上時，繼續做多。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

// ── 戰法3：三條均線戰法（MA3/MA10/MA24）──────────────────────────────────────

/** 三條均線戰法買進：MA3/MA10黃金交叉 + 價在MA24上 + MA24向上 */
export const tripleMaBuy: TradingRule = {
  id: 'triple-ma-golden-cross-buy',
  name: '三條均線戰法買進（MA3/MA10黃金交叉）',
  description: 'MA3與MA10出現黃金交叉，股價在MA24之上且MA24向上，買進',
  evaluate(candles, index): RuleSignal | null {
    if (index < 24) return null;
    const c = candles[index];
    const prev = candles[index - 1];
    if (c.ma3 == null || c.ma10 == null || c.ma24 == null) return null;
    if (prev.ma3 == null || prev.ma10 == null) return null;

    // 1. MA3/MA10 黃金交叉（今日 MA3 > MA10，前日 MA3 <= MA10）
    const goldenCross = prev.ma3 <= prev.ma10 && c.ma3 > c.ma10;
    if (!goldenCross) return null;
    // 2. 股價在 MA24 之上
    if (c.close <= c.ma24) return null;
    // 3. MA24 向上
    if (!isMaTrendingUp(candles, index, 'ma24', 5)) return null;
    // 4. 收盤價站上 MA3
    if (c.close <= c.ma3) return null;

    return {
      type: 'BUY',
      label: '三條均線買進',
      description: `MA3(${c.ma3.toFixed(2)})↑穿MA10(${c.ma10.toFixed(2)})，價在MA24(${c.ma24.toFixed(2)})上`,
      reason: [
        '【朱家泓《抓住線圖》第8章 三條均線戰法】',
        '做多進場：當3日均線與10日均線出現黃金交叉，股價在24日均線之上，且24日均線向上，當股價站上3日均線時，買進。',
        '續抱：在3日均線與10日均線沒有出現死亡交叉前，續抱。',
        '出場：收盤前確認3日均線與10日均線出現死亡交叉，股價跌破3日均線時，出場。',
        '停損：進場後，守10日均線。',
        '趨勢：股價在24日均線之上，且均線保持上揚，趨勢為多頭，順勢做多。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 三條均線戰法賣出：MA3/MA10死亡交叉 + 跌破MA3 */
export const tripleMaSell: TradingRule = {
  id: 'triple-ma-death-cross-sell',
  name: '三條均線戰法賣出（MA3/MA10死亡交叉）',
  description: 'MA3與MA10出現死亡交叉，股價跌破MA3，出場',
  evaluate(candles, index): RuleSignal | null {
    if (index < 24) return null;
    const c = candles[index];
    const prev = candles[index - 1];
    if (c.ma3 == null || c.ma10 == null || prev.ma3 == null || prev.ma10 == null) return null;

    // MA3/MA10 死亡交叉
    const deathCross = prev.ma3 >= prev.ma10 && c.ma3 < c.ma10;
    if (!deathCross) return null;
    // 股價跌破 MA3
    if (c.close >= c.ma3) return null;

    return {
      type: 'SELL',
      label: '三條均線賣出',
      description: `MA3(${c.ma3.toFixed(2)})↓穿MA10(${c.ma10.toFixed(2)})，跌破MA3`,
      reason: [
        '【朱家泓《抓住線圖》第8章 三條均線戰法】',
        '出場：收盤前確認3日均線與10日均線出現死亡交叉，股價跌破3日均線時，出場。',
        '停損：進場後，守10日均線。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

// ── 戰法4：二條均線戰法（MA10/MA24）──────────────────────────────────────────

/** 二條均線戰法買進：底底高 + 站上MA10/MA24 + 雙線上揚 */
export const dualMaBuy: TradingRule = {
  id: 'dual-ma10-ma24-buy',
  name: '二條均線戰法買進（MA10+MA24）',
  description: '底底高盤整有量突破，站上MA10及MA24，雙線上揚',
  evaluate(candles, index): RuleSignal | null {
    if (index < 24) return null;
    const c = candles[index];
    const prev = candles[index - 1];
    const ma10 = c.ma10;
    const ma24 = c.ma24;
    if (ma10 == null || ma24 == null) return null;

    // 1. 站上兩條均線
    if (c.close <= ma10 || c.close <= ma24) return null;
    // 2. 前日至少有一條在下方（突破確認）
    if (prev.ma10 != null && prev.close > prev.ma10 && prev.ma24 != null && prev.close > prev.ma24) return null;
    // 3. 兩條均線上揚
    if (!isMaTrendingUp(candles, index, 'ma10', 3)) return null;
    if (!isMaTrendingUp(candles, index, 'ma24', 5)) return null;
    // 4. 帶量
    const avgVol = c.avgVol5;
    if (avgVol != null && c.volume < avgVol * 1.3) return null;
    // 5. 長紅K
    if (!isLongRedCandle(c)) return null;

    return {
      type: 'BUY',
      label: '二條均線買進',
      description: `帶量紅K站上MA10(${ma10.toFixed(2)})及MA24(${ma24.toFixed(2)})，雙線上揚`,
      reason: [
        '【朱家泓《抓住線圖》第11章 二條均線戰法（短線攻擊）】',
        '進場：低檔打底有量突破，站上MA10及MA24均線，且兩條均線上揚。',
        '操作目標：走勢明確時，每次獲利達到10%以上。',
        '出場：K線出場訊號出現，或獲利超過10%時出場。',
        '停損：進場後，守10日均線。',
        '此方法屬於波段交易，要在走勢確認時介入，均以收盤價確認。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 二條均線戰法賣出：跌破MA10 */
export const dualMaSell: TradingRule = {
  id: 'dual-ma10-ma24-sell',
  name: '二條均線戰法賣出（跌破MA10）',
  description: '收盤跌破10日均線，出場',
  evaluate(candles, index): RuleSignal | null {
    if (index < 1) return null;
    if (!crossedBelow(candles, index, 'ma10')) return null;
    const c = candles[index];

    return {
      type: 'SELL',
      label: '二條均線賣出',
      description: `收盤 ${c.close.toFixed(2)} 跌破 MA10(${c.ma10?.toFixed(2)})`,
      reason: [
        '【朱家泓《抓住線圖》第11章 二條均線戰法】',
        '出場：K線出現出場訊號，或收盤跌破10日均線。',
        '高檔跌破10日均線，價量背離，出場。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};
