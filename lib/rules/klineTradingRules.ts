/**
 * 朱家泓《抓住K線 獲利無限》第7篇 — K線交易法
 * 多頭/空頭交易規則 + V形/倒V形反轉交易法
 */
import { TradingRule, RuleSignal } from '@/types';
import {
  isRedCandle, isBlackCandle,
  hasLongUpperShadow, hasLongLowerShadow,
  isDoji, isRising45,
} from './ruleUtils';

/** 訣竅4：多頭K線交易法進場 — 收盤突破前一日高點 */
export const bullKlineTradingEntry: TradingRule = {
  id: 'kline-trading-bull-entry',
  name: '多頭K線交易法進場',
  description: '強勢股收盤突破前一日高點，上升角度45度以上',
  evaluate(candles, index): RuleSignal | null {
    if (index < 6) return null;
    const c = candles[index];
    const prev = candles[index - 1];

    // 收盤突破前一日高點
    if (c.close <= prev.high) return null;
    // 需要收紅
    if (!isRedCandle(c)) return null;
    // 上升角度 >= 45度
    if (!isRising45(candles, index, 5)) return null;
    // 停損不能超過7%
    const stopLoss = c.low;
    const stopPct = (c.close - stopLoss) / c.close;
    if (stopPct > 0.07) return null;

    return {
      type: 'BUY',
      label: 'K線交易法買進',
      description: `收盤${c.close.toFixed(2)}突破前日高點${prev.high.toFixed(2)}，停損設${stopLoss.toFixed(2)}(${(stopPct * 100).toFixed(1)}%)`,
      reason: [
        '【朱家泓《抓住K線》第7篇 訣竅4】多頭K線交易法規則：',
        '進場：收盤前確認股價突破前一日高點時買進。',
        `停損：進場當日K線最低點${stopLoss.toFixed(2)}（不超過7%）。`,
        '續抱：每天收盤前檢視，沒有跌破前一日低點時續抱。',
        '出場：收盤前確認股價跌破前一日低點時出場。',
        '適用：多頭上漲強勢股（上升角度45度以上）、飆股、急跌後V形反彈。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 訣竅4：多頭K線交易法出場 — 收盤跌破前一日低點 */
export const bullKlineTradingExit: TradingRule = {
  id: 'kline-trading-bull-exit',
  name: '多頭K線交易法出場',
  description: '收盤跌破前一日K線低點，多單出場',
  evaluate(candles, index): RuleSignal | null {
    if (index < 6) return null;
    const c = candles[index];
    const prev = candles[index - 1];

    // 收盤跌破前一日低點
    if (c.close >= prev.low) return null;
    // 前面需要是上漲趨勢（才有多單需要出場）
    if (!isRising45(candles, index - 1, 5)) return null;

    return {
      type: 'SELL',
      label: 'K線交易法賣出',
      description: `收盤${c.close.toFixed(2)}跌破前日低點${prev.low.toFixed(2)}，多單出場`,
      reason: '【朱家泓《抓住K線》第7篇 訣竅4】K線交易法出場規則：收盤前確認股價跌破前一日低點時出場。K線交易法屬於短線交易，用日線操作，無論進出都以收盤價確認。',
      ruleId: this.id,
    };
  },
};

/** V形反轉：搶空頭急跌的反彈（4條件） */
export const vShapeReversalBuy: TradingRule = {
  id: 'kline-v-shape-reversal-buy',
  name: 'V形反轉搶反彈',
  description: '急殺>=3天跌>=15%，爆量止跌後收盤過前日高點',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const c = candles[index];

    // 條件4：過高 — 收盤突破前一日K線最高點
    const prev = candles[index - 1];
    if (c.close <= prev.high) return null;

    // 往前找急殺段：連續3天以上長黑或跳空跌停
    let crashDays = 0;
    let crashStartIdx = index - 1;
    for (let i = index - 1; i >= Math.max(0, index - 10); i--) {
      const bar = candles[i];
      if (isBlackCandle(bar) || bar.close < candles[Math.max(0, i - 1)].close) {
        crashDays++;
        crashStartIdx = i;
      } else {
        break;
      }
    }
    // 條件1：急殺 >= 3天
    if (crashDays < 3) return null;

    // 跌幅 >= 15%
    const crashStart = candles[Math.max(0, crashStartIdx - 1)];
    const crashEnd = candles[index - 1]; // 止跌前一天
    const dropPct = (crashStart.close - crashEnd.low) / crashStart.close;
    if (dropPct < 0.15) return null;

    // 條件2：爆量 — 低檔出現大量
    const avgVol = c.avgVol5 ?? c.avgVol20 ?? 0;
    let hasVolSpike = false;
    for (let i = index; i >= Math.max(0, index - 3); i--) {
      if (avgVol > 0 && candles[i].volume >= avgVol * 1.5) {
        hasVolSpike = true;
        break;
      }
    }
    if (!hasVolSpike) return null;

    // 條件3：止跌訊號 — 前一天出現止跌K線
    const stopBar = candles[index - 1];
    const isStopSignal =
      (isRedCandle(stopBar) && stopBar.open < stopBar.close) || // 開低走高紅K
      isDoji(stopBar) ||                                          // 十字線
      hasLongLowerShadow(stopBar);                               // 長下影線
    // 如果前一天不是明確止跌，當天本身也可以是止跌+過高
    if (!isStopSignal && !isRedCandle(c)) return null;

    const stopLoss = c.low;

    return {
      type: 'BUY',
      label: 'V形反轉搶反彈',
      description: `急殺${crashDays}天跌${(dropPct * 100).toFixed(1)}%後，爆量止跌，收盤${c.close.toFixed(2)}過前日高${prev.high.toFixed(2)}`,
      reason: [
        '【朱家泓《抓住K線》第7篇 V形反轉】搶反彈4條件全部符合：',
        `1. 急殺：連續${crashDays}天下跌，跌幅${(dropPct * 100).toFixed(1)}% (>=15%)`,
        '2. 爆量：低檔出現大量',
        '3. 止跌：出現止跌K線訊號',
        `4. 過高：收盤突破前一日K線最高點${prev.high.toFixed(2)}`,
        `停損設進場K線最低點${stopLoss.toFixed(2)}（不超過7%）。`,
        `反彈目標價：急跌起跌點附近。`,
        '出場：(1)收盤跌破上升急切線 (2)收盤跌破前日K線低點 (3)收盤跌破3日均線。',
        '注意：這是逆勢交易，必須嚴守停損及停利紀律！',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 倒V形反轉：搶多頭急漲的回檔（4條件） */
export const invertedVReversalSell: TradingRule = {
  id: 'kline-inverted-v-reversal-sell',
  name: '倒V形反轉搶回檔',
  description: '急漲>=3天漲>=15%，爆量止漲後收盤破前日低點',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const c = candles[index];

    // 條件4：破低 — 收盤跌破前一日K線最低點
    const prev = candles[index - 1];
    if (c.close >= prev.low) return null;

    // 往前找急漲段
    let surgeDays = 0;
    let surgeStartIdx = index - 1;
    for (let i = index - 1; i >= Math.max(0, index - 10); i--) {
      const bar = candles[i];
      if (isRedCandle(bar) || bar.close > candles[Math.max(0, i - 1)].close) {
        surgeDays++;
        surgeStartIdx = i;
      } else {
        break;
      }
    }
    if (surgeDays < 3) return null;

    const surgeStart = candles[Math.max(0, surgeStartIdx - 1)];
    const surgeEnd = candles[index - 1];
    const risePct = (surgeEnd.high - surgeStart.close) / surgeStart.close;
    if (risePct < 0.15) return null;

    // 條件2：爆量
    const avgVol = c.avgVol5 ?? c.avgVol20 ?? 0;
    let hasVolSpike = false;
    for (let i = index; i >= Math.max(0, index - 3); i--) {
      if (avgVol > 0 && candles[i].volume >= avgVol * 1.5) {
        hasVolSpike = true;
        break;
      }
    }
    if (!hasVolSpike) return null;

    // 條件3：止漲訊號
    const stopBar = candles[index - 1];
    const isStopSignal =
      (isBlackCandle(stopBar) && stopBar.open > stopBar.close) || // 開高走低黑K
      isDoji(stopBar) ||
      hasLongUpperShadow(stopBar);
    if (!isStopSignal && !isBlackCandle(c)) return null;

    const stopLoss = c.high;

    return {
      type: 'SELL',
      label: '倒V反轉搶回檔',
      description: `急漲${surgeDays}天漲${(risePct * 100).toFixed(1)}%後，爆量止漲，收盤${c.close.toFixed(2)}破前日低${prev.low.toFixed(2)}`,
      reason: [
        '【朱家泓《抓住K線》第7篇 倒V形反轉】搶回檔4條件全部符合：',
        `1. 急漲：連續${surgeDays}天上漲，漲幅${(risePct * 100).toFixed(1)}% (>=15%)`,
        '2. 爆量：高檔出現大量',
        '3. 止漲：出現止漲K線訊號',
        `4. 破低：收盤跌破前一日K線最低點${prev.low.toFixed(2)}`,
        `停損設進場K線最高點${stopLoss.toFixed(2)}（不超過7%）。`,
        `回檔目標價：急漲起漲點附近。`,
        '出場：(1)收盤突破下降急切線 (2)收盤突破前日K線高點 (3)收盤突破3日均線。',
        '注意：這是逆勢交易，必須嚴守停損及停利紀律！',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 全部 4 條 K 線交易法規則 */
export const KLINE_TRADING_RULES: TradingRule[] = [
  bullKlineTradingEntry,
  bullKlineTradingExit,
  vShapeReversalBuy,
  invertedVReversalSell,
];
