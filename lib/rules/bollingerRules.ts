import { TradingRule, RuleSignal } from '@/types';

// ═══════════════════════════════════════════════════════════════
//  布林通道規則
// ═══════════════════════════════════════════════════════════════

/** 布林壓縮突破（向上） — Bollinger Squeeze Breakout Up */
export const bollingerSqueezeUp: TradingRule = {
  id: 'bollinger-squeeze-up',
  name: '布林壓縮突破（向上）',
  description: '帶寬收至近20根最窄後，放量突破上軌',
  evaluate(candles, index): RuleSignal | null {
    if (index < 20) return null;
    const c = candles[index];
    if (c.bbBandwidth == null || c.bbUpper == null || c.bbPercentB == null) return null;
    if (c.avgVol20 == null || c.volume == null) return null;

    // 找近20根的最小帶寬
    let minBW = Infinity;
    for (let i = index - 19; i < index; i++) {
      const bw = candles[i].bbBandwidth;
      if (bw != null && bw < minBW) minBW = bw;
    }
    if (minBW === Infinity) return null;

    // 前一根帶寬接近最低（<最低*1.1），代表剛經歷壓縮
    const prev = candles[index - 1];
    if (prev.bbBandwidth == null) return null;
    const wasSqueezing = prev.bbBandwidth <= minBW * 1.1;
    if (!wasSqueezing) return null;

    // 當前 %B > 1 代表突破上軌
    const breakingUp = c.bbPercentB > 1;
    // 量能放大（>1.5倍20日均量）
    const volumeSurge = c.volume > c.avgVol20 * 1.5;

    if (!breakingUp || !volumeSurge) return null;

    return {
      type: 'BUY',
      label: '布林壓縮突破↑',
      description: `帶寬由壓縮(${prev.bbBandwidth.toFixed(3)})擴張，%B=${c.bbPercentB.toFixed(2)}突破上軌，量比=${(c.volume / c.avgVol20).toFixed(1)}倍`,
      reason: [
        '【布林壓縮原理】帶寬收至極窄代表波動率降至極低，市場在「蓄力」。統計上壓縮後必出大行情。',
        '【放量突破確認】突破上軌且成交量顯著放大，代表真實的多方力量推動，非假突破。',
        '【操作建議】壓縮後的突破通常是波段行情的起點，可順勢進場。但若後續K線無法站穩上軌，需快速停損。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 布林壓縮跌破（向下） — Bollinger Squeeze Breakout Down */
export const bollingerSqueezeDown: TradingRule = {
  id: 'bollinger-squeeze-down',
  name: '布林壓縮跌破（向下）',
  description: '帶寬收至近20根最窄後，放量跌破下軌',
  evaluate(candles, index): RuleSignal | null {
    if (index < 20) return null;
    const c = candles[index];
    if (c.bbBandwidth == null || c.bbLower == null || c.bbPercentB == null) return null;
    if (c.avgVol20 == null || c.volume == null) return null;

    let minBW = Infinity;
    for (let i = index - 19; i < index; i++) {
      const bw = candles[i].bbBandwidth;
      if (bw != null && bw < minBW) minBW = bw;
    }
    if (minBW === Infinity) return null;

    const prev = candles[index - 1];
    if (prev.bbBandwidth == null) return null;
    const wasSqueezing = prev.bbBandwidth <= minBW * 1.1;
    if (!wasSqueezing) return null;

    const breakingDown = c.bbPercentB < 0;
    const volumeSurge = c.volume > c.avgVol20 * 1.5;

    if (!breakingDown || !volumeSurge) return null;

    return {
      type: 'SELL',
      label: '布林壓縮跌破↓',
      description: `帶寬由壓縮(${prev.bbBandwidth.toFixed(3)})擴張，%B=${c.bbPercentB.toFixed(2)}跌破下軌，量比=${(c.volume / c.avgVol20).toFixed(1)}倍`,
      reason: [
        '【布林壓縮原理】帶寬極窄後的方向性突破，向下跌破代表空方主導。',
        '【放量下殺確認】跌破下軌且量能放大，代表真實的賣壓。持有者應考慮停損。',
        '【操作建議】壓縮後向下突破的下跌幅度通常較大，不宜搶反彈。等帶寬重新收窄或價格站回中軌再觀察。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

export const BOLLINGER_RULES: TradingRule[] = [
  bollingerSqueezeUp, bollingerSqueezeDown,
];
