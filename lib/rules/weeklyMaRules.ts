// ═══════════════════════════════════════════════════════════════
// 朱家泓《抓住線圖 股民變股神》
// 戰法7：20週均線交易法（以MA100近似20週均線）
// ═══════════════════════════════════════════════════════════════

import { TradingRule, RuleSignal } from '@/types';
import { crossedBelow } from '@/lib/indicators';
import { isLongRedCandle, isMaTrendingUp, isHigherLow } from './ruleUtils';

/** 20週均線戰法買進：站上MA100 + MA100上揚 + 底底高 */
export const weeklyMa20Buy: TradingRule = {
  id: 'weekly-ma20-buy',
  name: '20週均線戰法買進',
  description: '低檔打底完成，股價站上20週均線（MA100），且均線上揚',
  evaluate(candles, index): RuleSignal | null {
    if (index < 100) return null;
    const c = candles[index];
    if (c.ma100 == null) return null;

    // 1. 今日站上 MA100
    if (c.close <= c.ma100) return null;
    // 2. 前日在 MA100 以下（突破確認）
    const prev = candles[index - 1];
    if (prev.ma100 == null || prev.close > prev.ma100) return null;
    // 3. MA100 走平或上揚
    if (!isMaTrendingUp(candles, index, 'ma100', 5)) return null;
    // 4. 帶量紅K
    if (!isLongRedCandle(c)) return null;
    const avgVol = c.avgVol5;
    if (avgVol != null && c.volume < avgVol * 1.3) return null;
    // 5. 底底高型態加分
    const hasHL = isHigherLow(candles, index, 30);

    return {
      type: 'BUY',
      label: '20週均線買進',
      description: `帶量紅K站上MA100(${c.ma100.toFixed(2)})，MA100上揚${hasHL ? '＋底底高' : ''}`,
      reason: [
        '【朱家泓《抓住線圖》第5章 20週均線交易法】',
        '月線圖突破下降切線 → 週線站上20週均線 → 日線找買進點。',
        '進場：多頭型態完成（底底高），暴大量上漲紅K線站上20週均線，均線上揚，買進。',
        '續抱：收盤股價沒有跌破20週均線時，續抱。',
        '出場：收盤確認股價跌破20週均線時，出場。',
        '【長波段操作】此戰法適合長波段操作，用長期均線可以做到波段獲利。不會賠大錢。',
        '【加碼時機】盤整末端靠近20週均線、乖離率7%以內時可加碼。',
        '實例：京元電11個月獲利181%、宏達電15個月獲利226%。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 20週均線戰法賣出：跌破MA100 */
export const weeklyMa20Sell: TradingRule = {
  id: 'weekly-ma20-sell',
  name: '20週均線戰法賣出（跌破20週均）',
  description: '收盤跌破20週均線（MA100），出場',
  evaluate(candles, index): RuleSignal | null {
    if (index < 1) return null;
    if (!crossedBelow(candles, index, 'ma100')) return null;
    const c = candles[index];

    return {
      type: 'SELL',
      label: '20週均線賣出',
      description: `收盤 ${c.close.toFixed(2)} 跌破 MA100(${c.ma100?.toFixed(2)})`,
      reason: [
        '【朱家泓《抓住線圖》第5章 20週均線交易法】',
        '出場：收盤確認股價跌破20週均線時，出場。',
        '上漲行進中跌破20週均線後出場，當股價再站上20週均線，且均線仍持續向上時，繼續做多。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 20週均線附近加碼：乖離7%內 + 紅K有撐 */
export const weeklyMa20Add: TradingRule = {
  id: 'weekly-ma20-add-near-support',
  name: '20週均線附近加碼（7%乖離內）',
  description: '股價在20週均線上方7%乖離內回檔有撐，出現紅K可加碼',
  evaluate(candles, index): RuleSignal | null {
    if (index < 100) return null;
    const c = candles[index];
    if (c.ma100 == null) return null;

    // 1. 股價在 MA100 上方
    if (c.close <= c.ma100) return null;
    // 2. 乖離率在 7% 以內
    const dev = (c.close - c.ma100) / c.ma100;
    if (dev > 0.07) return null;
    // 3. MA100 仍在上揚
    if (!isMaTrendingUp(candles, index, 'ma100', 5)) return null;
    // 4. 今日為紅K（回檔有撐的反彈）
    if (c.close <= c.open) return null;
    // 5. 前日曾回檔接近 MA100
    const prev = candles[index - 1];
    if (prev.ma100 == null) return null;
    const prevDev = (prev.close - prev.ma100) / prev.ma100;
    if (prevDev > 0.05) return null; // 前日離MA100太遠不算回檔

    return {
      type: 'ADD',
      label: '20週均線加碼',
      description: `回檔至MA100附近（乖離${(dev * 100).toFixed(1)}%），紅K有撐`,
      reason: [
        '【朱家泓《抓住線圖》第5章 20週均線交易法】',
        '加碼時機：盤整末端靠近20週均線附近，乖離率在7%以內時可加碼。',
        '在多頭行進中回檔到20週均線附近有撐，是很好的加碼位置。',
        '停損：守20週均線。跌破即出場。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};
