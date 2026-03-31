// ═══════════════════════════════════════════════════════════════
// Murphy《金融市場技術分析》第2章、第17-18章
// 市場結構規則 — 道氏理論驗證、相對力度分析、多指標同步確認
// ═══════════════════════════════════════════════════════════════

import { TradingRule, RuleSignal } from '@/types';
import {
  findSwingHighs, findSwingLows, isMaTrendingUp, isMaTrendingDown,
  isVolumeBreakout,
} from './ruleUtils';

// ── 規則 ──────────────────────────────────────────────────────────────────────

/**
 * 道氏理論 — 趨勢三階段辨識（積累→公眾參與→分散）
 * Murphy 第2章：識別當前處於趨勢的哪個階段
 */
export const dowTheoryPhase: TradingRule = {
  id: 'murphy-dow-phase',
  name: '道氏理論趨勢階段',
  description: '根據價格結構和成交量判斷當前處於趨勢的哪個階段',
  evaluate(candles, index): RuleSignal | null {
    if (index < 60) return null;
    const c = candles[index];

    // 分析近60根的結構
    const highs = findSwingHighs(candles, index, 60, 3);
    const lows = findSwingLows(candles, index, 60, 3);
    if (highs.length < 2 || lows.length < 2) return null;

    // 判斷趨勢方向
    const lastTwoHighs = highs.slice(-2);
    const lastTwoLows = lows.slice(-2);
    const isUptrend = lastTwoHighs[1].price > lastTwoHighs[0].price &&
                      lastTwoLows[1].price > lastTwoLows[0].price;
    const isDowntrend = lastTwoHighs[1].price < lastTwoHighs[0].price &&
                        lastTwoLows[1].price < lastTwoLows[0].price;

    if (!isUptrend && !isDowntrend) return null;

    if (isUptrend) {
      // 判斷是否在第三階段（分散）：量能異常放大 + 加速上漲
      const recentVolHigh = c.avgVol5 != null && c.avgVol20 != null &&
                            c.avgVol5 > c.avgVol20 * 1.8;
      const accel = index >= 10 &&
        ((c.close - candles[index - 5].close) / candles[index - 5].close) >
        ((candles[index - 5].close - candles[index - 10].close) / candles[index - 10].close) * 1.5;

      if (recentVolHigh && accel) {
        return {
          type: 'WATCH',
          label: '道氏第三階段（分散）',
          description: '上升趨勢可能進入第三階段：加速上漲伴隨異常放量，聰明資金可能在出貨',
          reason: [
            '【出處】Murphy《金融市場技術分析》第2章 — 道氏理論',
            '原理：道氏理論將主要趨勢分為三個階段。',
            '第一階段（積累）：聰明資金悄悄買入，大多數人仍然看跌。',
            '第二階段（公眾參與）：趨勢跟蹤者入場，價格加速上漲。',
            '第三階段（分散）：公眾蜂擁入場，聰明資金開始出貨。',
            '當前特徵符合第三階段：加速上漲＋異常放量。',
            '操作：第三階段應逐步減碼，不宜追高。',
          ].join('\n'),
          ruleId: this.id,
        };
      }
    }

    if (isDowntrend) {
      // 判斷是否在底部積累階段：量能萎縮 + 價格波動收窄
      const lowVol = c.avgVol5 != null && c.avgVol20 != null &&
                     c.avgVol5 < c.avgVol20 * 0.6;
      // 近10根的價格區間收窄
      let rangeNarrow = false;
      if (index >= 10) {
        let maxH = -Infinity, minL = Infinity;
        for (let i = index - 9; i <= index; i++) {
          if (candles[i].high > maxH) maxH = candles[i].high;
          if (candles[i].low < minL) minL = candles[i].low;
        }
        rangeNarrow = (maxH - minL) / minL < 0.08;
      }

      if (lowVol && rangeNarrow) {
        return {
          type: 'WATCH',
          label: '道氏第一階段（積累）',
          description: '下降趨勢末端出現量縮價穩，可能為聰明資金開始積累',
          reason: [
            '【出處】Murphy《金融市場技術分析》第2章 — 道氏理論',
            '原理：積累階段發生在下降趨勢的末端，是新的上升趨勢的起點。',
            '特徵：成交量顯著萎縮，價格不再創新低，波動幅度收窄。',
            '此時聰明的投資者在大多數人仍然看跌時開始悄悄買入。',
            '操作：積累階段的買入風險較低，但需要耐心等待突破確認。',
          ].join('\n'),
          ruleId: this.id,
        };
      }
    }

    return null;
  },
};

/**
 * 多指標同步確認（Murphy 綜合分析清單）
 * Murphy 第19章：多項技術工具同時發出同方向信號
 */
export const murphyMultiConfirm: TradingRule = {
  id: 'murphy-multi-confirm',
  name: 'Murphy 多指標確認',
  description: '多個技術分析工具同時發出同方向信號，增強信號可靠性',
  evaluate(candles, index): RuleSignal | null {
    if (index < 30) return null;
    const c = candles[index];

    let bullishSignals = 0;
    let bearishSignals = 0;
    const bullDetails: string[] = [];
    const bearDetails: string[] = [];

    // 1. 趨勢方向（MA20 & MA60）
    if (c.ma20 != null && c.ma60 != null) {
      if (c.ma20 > c.ma60 && isMaTrendingUp(candles, index, 'ma20')) {
        bullishSignals++;
        bullDetails.push('MA20>MA60上揚');
      }
      if (c.ma20 < c.ma60 && isMaTrendingDown(candles, index, 'ma20')) {
        bearishSignals++;
        bearDetails.push('MA20<MA60下彎');
      }
    }

    // 2. 價格與均線關係
    if (c.ma20 != null) {
      if (c.close > c.ma20) { bullishSignals++; bullDetails.push('收在MA20上'); }
      else { bearishSignals++; bearDetails.push('收在MA20下'); }
    }

    // 3. MACD 方向
    if (c.macdOSC != null) {
      if (c.macdOSC > 0) { bullishSignals++; bullDetails.push('MACD柱為正'); }
      else { bearishSignals++; bearDetails.push('MACD柱為負'); }
    }

    // 4. RSI 區間
    if (c.rsi14 != null) {
      if (c.rsi14 > 50) { bullishSignals++; bullDetails.push(`RSI=${c.rsi14.toFixed(0)}>50`); }
      else { bearishSignals++; bearDetails.push(`RSI=${c.rsi14.toFixed(0)}<50`); }
    }

    // 5. KD 方向
    if (c.kdK != null && c.kdD != null) {
      if (c.kdK > c.kdD) { bullishSignals++; bullDetails.push('K>D'); }
      else { bearishSignals++; bearDetails.push('K<D'); }
    }

    // 6. 成交量確認
    if (isVolumeBreakout(c, 1.3)) {
      if (c.close > c.open) { bullishSignals++; bullDetails.push('帶量收紅'); }
      else { bearishSignals++; bearDetails.push('帶量收黑'); }
    }

    // 需至少5個指標同方向
    if (bullishSignals >= 5) {
      return {
        type: 'BUY',
        label: 'Murphy 多指標共振（多）',
        description: `${bullishSignals} 項技術指標同步看多：${bullDetails.join('、')}`,
        reason: [
          '【出處】Murphy《金融市場技術分析》第19章 — 全書大會串',
          '原理：Murphy 強調應該綜合運用多種技術工具，而非依賴單一指標。',
          '當趨勢方向、均線、擺動指數、成交量等多項工具同時指向同一方向時，',
          '信號的可靠性大幅提升。這正是 Murphy 技術分析清單的核心精神。',
          '操作：多指標同步確認時，可以更有信心地順勢操作。',
        ].join('\n'),
        ruleId: this.id,
      };
    }

    if (bearishSignals >= 5) {
      return {
        type: 'SELL',
        label: 'Murphy 多指標共振（空）',
        description: `${bearishSignals} 項技術指標同步看空：${bearDetails.join('、')}`,
        reason: [
          '【出處】Murphy《金融市場技術分析》第19章 — 全書大會串',
          '原理：多項技術工具同時指向空頭方向，信號可靠性高。',
          'Murphy 的分析清單要求從多個維度確認市場狀態。',
          '操作：多指標同步看空時，應考慮減碼或出場。',
        ].join('\n'),
        ruleId: this.id,
      };
    }

    return null;
  },
};

/**
 * 道氏理論 — 交易量驗證趨勢
 * Murphy 第2章：上升趨勢中量增價漲/量縮價跌為健康，反之為警告
 */
export const dowVolumeConfirmation: TradingRule = {
  id: 'murphy-dow-vol-confirm',
  name: '道氏量價驗證',
  description: '根據道氏理論檢驗交易量是否正確驗證當前趨勢',
  evaluate(candles, index): RuleSignal | null {
    if (index < 20) return null;
    const c = candles[index];
    if (c.ma20 == null) return null;

    // 判斷趨勢方向
    const isUptrend = c.close > c.ma20 && isMaTrendingUp(candles, index, 'ma20');
    const isDowntrend = c.close < c.ma20 && isMaTrendingDown(candles, index, 'ma20');
    if (!isUptrend && !isDowntrend) return null;

    // 分析近10根的上漲日和下跌日的平均成交量
    let upDayVol = 0, upDayCount = 0;
    let downDayVol = 0, downDayCount = 0;
    for (let i = index - 9; i <= index; i++) {
      if (i < 1) continue;
      if (candles[i].close > candles[i - 1].close) {
        upDayVol += candles[i].volume;
        upDayCount++;
      } else if (candles[i].close < candles[i - 1].close) {
        downDayVol += candles[i].volume;
        downDayCount++;
      }
    }

    if (upDayCount === 0 || downDayCount === 0) return null;
    const avgUpVol = upDayVol / upDayCount;
    const avgDownVol = downDayVol / downDayCount;

    if (isUptrend) {
      // 不健康：下跌日平均成交量 > 上漲日（量價背離）
      if (avgDownVol > avgUpVol * 1.3) {
        return {
          type: 'WATCH',
          label: '道氏量價不驗證',
          description: `上升趨勢中，下跌日均量(${(avgDownVol / 1000).toFixed(0)}K) > 上漲日均量(${(avgUpVol / 1000).toFixed(0)}K)，趨勢不健康`,
          reason: [
            '【出處】Murphy《金融市場技術分析》第2章 — 道氏理論',
            '原理：道氏理論要求交易量必須驗證趨勢。',
            '在上升趨勢中，上漲日的成交量應大於下跌日。',
            '如果下跌日的成交量反而更大，表示賣壓重於買壓，趨勢可能不牢靠。',
            '操作：量價不驗證是趨勢減弱的早期信號，應提高警覺。',
          ].join('\n'),
          ruleId: this.id,
        };
      }
    }

    if (isDowntrend) {
      // 下降趨勢中反彈量大於下跌量 = 底部可能形成
      if (avgUpVol > avgDownVol * 1.3) {
        return {
          type: 'WATCH',
          label: '道氏量價底部信號',
          description: `下降趨勢中，反彈日均量(${(avgUpVol / 1000).toFixed(0)}K) > 下跌日均量(${(avgDownVol / 1000).toFixed(0)}K)，買盤進入`,
          reason: [
            '【出處】Murphy《金融市場技術分析》第2章 — 道氏理論',
            '原理：在下降趨勢中，如果反彈日的成交量超過下跌日，',
            '表示買方力量正在增強，底部可能正在形成。',
            '操作：量價結構改善是底部的早期信號，可開始留意買入機會。',
          ].join('\n'),
          ruleId: this.id,
        };
      }
    }

    return null;
  },
};

// ── 匯出 ──────────────────────────────────────────────────────────────────────

export const MURPHY_MARKET_RULES: TradingRule[] = [
  dowTheoryPhase,
  murphyMultiConfirm,
  dowVolumeConfirmation,
];
