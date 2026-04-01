/**
 * longTermSopRules.ts — 朱家泓長線操作 SOP 8 條
 * 來源：《活用技術分析寶典》Part 11, p.712-713
 *
 * 長線 8 條規則分為選股（3 條）和操作（5 條）：
 * 選股1: 月線大量中長紅K突破下降切線，反彈站上MA20
 * 選股2: 週線多頭，均線3線多排，底部放大量
 * 選股3: 日線多頭，均線4線多排，底部多頭確認後起漲
 * 操作1: 日線多頭進場 — 收盤突破MA5+前日高+漲幅2%+
 * 操作2: 停損設進場價5% (由 BacktestEngine 處理，此處不重複)
 * 操作3: 「頭頭低」出場
 * 操作4: 沒跌破停損續抱 (由 BacktestEngine 處理)
 * 操作5: 漲幅>10%+破MA20停利 / 漲幅>20%+急漲+大量黑K出場
 */

import { TradingRule, CandleWithIndicators } from '@/types';
import {
  isBullishMAAlignment,
} from '@/lib/indicators';
import {
  isLongRedCandle,
  isLongBlackCandle,
  isUptrendWave,
} from './ruleUtils';

// ── 選股1: 月線大量紅K突破下降切線，站上 MA20 ────────────────────────────────

export const longTermSelectMonthly: TradingRule = {
  id: 'long-term-select-monthly',
  name: '長線選股：月線突破下降切線',
  description: '月線大量中長紅K突破下降切線，反彈站上MA20',
  evaluate(candles: CandleWithIndicators[], index: number) {
    if (index < 20) return null;
    const c = candles[index];
    const prev = candles[index - 1];

    if (c.close <= c.open) return null;
    if (!isLongRedCandle(c)) return null;
    if (c.avgVol5 == null || c.volume < c.avgVol5 * 1.5) return null;
    if (c.ma20 == null || c.close <= c.ma20) return null;
    if (prev.ma20 == null || prev.close > prev.ma20) return null;

    const prev10 = candles.slice(Math.max(0, index - 10), index);
    const firstHalf = Math.max(...prev10.slice(0, 5).map(x => x.high));
    const secondHalf = Math.max(...prev10.slice(5).map(x => x.high));
    if (firstHalf <= secondHalf * 1.01) return null;

    return {
      type: 'BUY' as const,
      label: '長線選股1',
      description: '大量紅K突破下降切線，站上月線',
      reason: '長線選股1: 大量紅K突破下降切線，反彈站上月線(MA20)',
      ruleId: this.id,
    };
  },
};

// ── 選股2: 週線多頭，均線3線多排，底部放大量 ──────────────────────────────

export const longTermSelectWeekly: TradingRule = {
  id: 'long-term-select-weekly',
  name: '長線選股：週線多頭+均線排列',
  description: '週線多頭，均線3線多排，底部放大量',
  evaluate(candles: CandleWithIndicators[], index: number) {
    if (index < 20) return null;
    const c = candles[index];

    if (!isBullishMAAlignment(c)) return null;
    const prevMA20 = candles[index - 5]?.ma20;
    if (c.ma20 == null || prevMA20 == null || c.ma20 <= prevMA20) return null;

    const recent5 = candles.slice(Math.max(0, index - 5), index + 1);
    const hasVolExpansion = recent5.some(
      x => x.avgVol5 != null && x.avgVol5 > 0 && x.volume > x.avgVol5 * 1.5
    );
    if (!hasVolExpansion) return null;

    const high60 = Math.max(...candles.slice(Math.max(0, index - 60), index).map(x => x.high));
    if (high60 > 0 && c.close > high60 * 0.85) return null;

    return {
      type: 'BUY' as const,
      label: '長線選股2',
      description: '週線多頭+均線3線多排+底部放大量',
      reason: '長線選股2: 均線多排+MA20向上+底部放大量+距高點>15%',
      ruleId: this.id,
    };
  },
};

// ── 選股3: 日線多頭，均線4線多排，底部確認起漲 ──────────────────────────────

export const longTermSelectDaily: TradingRule = {
  id: 'long-term-select-daily',
  name: '長線選股：日線多頭確認起漲',
  description: '日線多頭，均線4線多排，底部多頭確認後起漲',
  evaluate(candles: CandleWithIndicators[], index: number) {
    if (index < 60) return null;
    const c = candles[index];

    if (!isBullishMAAlignment(c)) return null;
    if (c.ma60 == null) return null;
    const prevMA60 = candles[index - 10]?.ma60;
    if (prevMA60 == null || c.ma60 <= prevMA60) return null;
    if (!isUptrendWave(candles, index)) return null;
    if (c.close <= c.open) return null;

    return {
      type: 'BUY' as const,
      label: '長線選股3',
      description: '日線多頭+均線4線多排+底底高確認起漲',
      reason: '長線選股3: 均線4線多排(含MA60向上)+底底高+紅K',
      ruleId: this.id,
    };
  },
};

// ── 操作1: 日線多頭進場 — 突破MA5+前日高+漲幅2%+ ──────────────────────────

export const longTermEntry: TradingRule = {
  id: 'long-term-entry',
  name: '長線進場：突破MA5+前高+漲2%',
  description: '日線多頭進場：收盤突破MA5、前日高點、漲幅2%以上',
  evaluate(candles: CandleWithIndicators[], index: number) {
    if (index < 20) return null;
    const c = candles[index];
    const prev = candles[index - 1];

    if (!isBullishMAAlignment(c)) return null;
    if (c.ma5 == null || c.close <= c.ma5) return null;
    if (c.close <= prev.high) return null;
    const changePct = (c.close - c.open) / c.open;
    if (changePct < 0.02) return null;
    if (c.avgVol5 == null || c.volume < c.avgVol5 * 1.3) return null;

    return {
      type: 'BUY' as const,
      label: '長線操作1',
      description: '收盤突破MA5+前日高+漲2%+量增，進場',
      reason: '長線操作1: 多頭趨勢中收盤突破MA5、前日高、漲幅>2%、量>1.3x',
      ruleId: this.id,
    };
  },
};

// ── 操作3: 頭頭低出場 ──────────────────────────────────────────────────────

export const longTermHeadLowerExit: TradingRule = {
  id: 'long-term-head-lower-exit',
  name: '長線出場：頭頭低',
  description: '頭頭低確認趨勢轉弱，出場',
  evaluate(candles: CandleWithIndicators[], index: number) {
    if (index < 20) return null;
    const c = candles[index];

    const lookback = candles.slice(Math.max(0, index - 20), index + 1);
    const highs = lookback.map(x => x.high);
    const half = Math.floor(highs.length / 2);
    const firstHigh = Math.max(...highs.slice(0, half));
    const secondHigh = Math.max(...highs.slice(half));

    if (secondHigh >= firstHigh * 0.998) return null;
    const recent5Low = Math.min(...candles.slice(Math.max(0, index - 5), index).map(x => x.low));
    if (c.close >= recent5Low) return null;

    return {
      type: 'SELL' as const,
      label: '長線操作3',
      description: '頭頭低確認+破近期低，出場',
      reason: '長線操作3: 近20日頭頭低+收盤破近5日最低，趨勢轉弱出場',
      ruleId: this.id,
    };
  },
};

// ── 操作5: 漲幅>10%+破MA20停利 / 漲幅>20%+大量黑K出場 ────────────────────

export const longTermProfitTake: TradingRule = {
  id: 'long-term-profit-take',
  name: '長線停利：漲10%破月線/漲20%大量黑K',
  description: '漲幅>10%跌破MA20停利，或漲幅>20%出現大量黑K出場',
  evaluate(candles: CandleWithIndicators[], index: number) {
    if (index < 20) return null;
    const c = candles[index];

    const low60 = Math.min(...candles.slice(Math.max(0, index - 60), index).map(x => x.low));
    if (low60 <= 0) return null;
    const gainPct = (c.close - low60) / low60;

    if (gainPct > 0.10 && c.ma20 != null && c.close < c.ma20) {
      return {
        type: 'SELL' as const,
        label: '長線操作5A',
        description: `漲幅${(gainPct * 100).toFixed(0)}%+跌破月線，停利出場`,
        reason: `長線操作5A: 漲幅${(gainPct * 100).toFixed(0)}%後跌破MA20停利`,
        ruleId: this.id,
      };
    }

    if (gainPct > 0.20 && isLongBlackCandle(c)) {
      if (c.avgVol5 != null && c.volume > c.avgVol5 * 2) {
        return {
          type: 'SELL' as const,
          label: '長線操作5B',
          description: `漲幅${(gainPct * 100).toFixed(0)}%+大量長黑K，出場`,
          reason: `長線操作5B: 漲幅${(gainPct * 100).toFixed(0)}%+大量黑K出場`,
          ruleId: this.id,
        };
      }
    }

    return null;
  },
};

// ── 操作7: 出場後可做第2波 ──────────────────────────────────────────────────

export const longTermSecondWaveEntry: TradingRule = {
  id: 'long-term-second-wave',
  name: '長線第2波：修正後再進場',
  description: '出場後漲幅未超50%，符合日線進場條件可做第2波',
  evaluate(candles: CandleWithIndicators[], index: number) {
    if (index < 30) return null;
    const c = candles[index];

    if (!isBullishMAAlignment(c)) return null;

    const recent20 = candles.slice(Math.max(0, index - 20), index);
    const peakIdx = recent20.reduce((best, x, i) => x.high > recent20[best].high ? i : best, 0);
    const troughIdx = recent20.slice(peakIdx).reduce(
      (best, x, i) => x.low < recent20[peakIdx + best].low ? i : best, 0
    ) + peakIdx;
    if (troughIdx <= peakIdx) return null;

    const peak = recent20[peakIdx].high;
    const trough = recent20[troughIdx].low;
    if (trough <= 0 || peak <= 0) return null;
    if (peak / trough - 1 > 0.50) return null;

    if (!isLongRedCandle(c)) return null;
    const consolidationHigh = Math.max(...candles.slice(Math.max(0, index - 5), index).map(x => x.high));
    if (c.close <= consolidationHigh) return null;

    return {
      type: 'ADD' as const,
      label: '長線操作7',
      description: '第1波修正後再起漲，加碼做第2波',
      reason: '長線操作7: 漲幅未超50%，修正後均線多排+紅K突破，可做第2波',
      ruleId: this.id,
    };
  },
};

// ── 操作8: 漲約一倍後不做長線 ─────────────────────────────────────────────

export const longTermDoubledWarning: TradingRule = {
  id: 'long-term-doubled-warning',
  name: '長線警示：漲幅超100%不再操作',
  description: '股價上漲約一倍後不再做長線操作',
  evaluate(candles: CandleWithIndicators[], index: number) {
    if (index < 60) return null;
    const c = candles[index];

    const low120 = Math.min(...candles.slice(Math.max(0, index - 120), index).map(x => x.low));
    if (low120 <= 0) return null;
    const gainPct = (c.close - low120) / low120;

    if (gainPct >= 1.0) {
      return {
        type: 'SELL' as const,
        label: '長線操作8',
        description: `漲幅${(gainPct * 100).toFixed(0)}%已達一倍`,
        reason: `長線操作8: 漲幅${(gainPct * 100).toFixed(0)}%，股價上漲約1倍後不再做長線`,
        ruleId: this.id,
      };
    }

    return null;
  },
};

// ── 導出 ──────────────────────────────────────────────────────────────────────

export const LONG_TERM_SOP_RULES: TradingRule[] = [
  longTermSelectMonthly,
  longTermSelectWeekly,
  longTermSelectDaily,
  longTermEntry,
  longTermHeadLowerExit,
  longTermProfitTake,
  longTermSecondWaveEntry,
  longTermDoubledWarning,
];
