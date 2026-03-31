import { TradingRule, RuleSignal } from '@/types';

// ═══════════════════════════════════════════════════════════════
//  ⑤ MACD 規則
// ═══════════════════════════════════════════════════════════════

/** MACD黃金交叉（OSC綠轉紅）*/
export const macdGoldenCross: TradingRule = {
  id: 'macd-golden-cross',
  name: 'MACD 黃金交叉（OSC綠轉紅）',
  description: 'DIF由下往上穿越MACD，OSC由負轉正',
  evaluate(candles, index): RuleSignal | null {
    if (index < 1) return null;
    const c = candles[index];
    const prev = candles[index - 1];
    if (c.macdDIF == null || c.macdSignal == null || prev.macdDIF == null || prev.macdSignal == null) return null;
    const crossed = prev.macdDIF <= prev.macdSignal && c.macdDIF > c.macdSignal;
    if (!crossed) return null;
    const aboveZero = c.macdDIF > 0;
    return {
      type: 'BUY',
      label: aboveZero ? 'MACD金叉買進（0軸上）' : 'MACD金叉買進（0軸下）',
      description: `DIF(${c.macdDIF}) 上穿 MACD(${c.macdSignal})，OSC由負轉正（綠轉紅柱）`,
      reason: [
        '【書中MACD規則】「OSC（柱狀圖）由綠柱轉紅柱」是書中多頭確認的指標條件之一，與波浪型態、均線共同判斷。',
        '【書中進場條件5項之⑤】「MACD：OSC由綠轉紅（或紅柱增加）」——多頭選股條件明確包含此項。',
        aboveZero
          ? '【0軸上方的黃金交叉】「DIF、MACD兩線在0軸之上視為多頭格局」——0軸上方的金叉是最強買訊，代表中長期趨勢也偏多，勝率最高。'
          : '【0軸下方需謹慎】目前兩線在0軸下方，中期趨勢仍偏空。此金叉可能是空頭中的反彈訊號，不宜重倉，輕倉試多為主。',
        '【與K線配合使用】朱家泓反覆強調MACD只是確認指標，要與K線型態（紅K過前高）、均線（多頭排列）共振才有高勝率。',
        '【書中停利SOP】MACD轉死叉（OSC由紅轉綠）時，搭配K線跌破MA5，是停利出場的時機。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** MACD死亡交叉 */
export const macdDeathCross: TradingRule = {
  id: 'macd-death-cross',
  name: 'MACD 死亡交叉（OSC紅轉綠）',
  description: 'DIF由上往下穿越MACD，OSC由正轉負',
  evaluate(candles, index): RuleSignal | null {
    if (index < 1) return null;
    const c = candles[index];
    const prev = candles[index - 1];
    if (c.macdDIF == null || c.macdSignal == null || prev.macdDIF == null || prev.macdSignal == null) return null;
    const crossed = prev.macdDIF >= prev.macdSignal && c.macdDIF < c.macdSignal;
    if (!crossed) return null;
    const aboveZero = c.macdDIF > 0;
    return {
      type: 'WATCH',
      label: aboveZero ? 'MACD死叉（高位警示）' : 'MACD死叉（空頭加速）',
      description: `DIF(${c.macdDIF}) 下穿 MACD(${c.macdSignal})，OSC由正轉負（紅轉綠柱）`,
      reason: [
        '【書中MACD規則】「OSC由紅柱轉綠柱」是空頭確認的指標條件，與波浪型態、均線共同判斷，是做空或停利的訊號。',
        aboveZero
          ? '【高位死叉特別危險】DIF仍在0軸上方，代表中期仍多，但短線動能已轉弱。若同時K線出現長黑或跌破MA5，應考慮停利或減碼。書中：「高檔出現MACD指標多方動能背離，要隨時準備停利。」'
          : '【空頭加速訊號】DIF和MACD均在0軸下方的死叉，代表空方動能持續擴大，書中明確指出此時「做空操作」，停損設在進場K線最高點。',
        '【書中空頭進場條件之⑤】「MACD：OSC由紅柱轉綠柱（或綠柱延長）」——是做空選股的必要條件之一。',
        '【多單持有者】若手中有多單，MACD死叉搭配K線跌破均線，應按停損紀律出場。「任何操作方法，一定要把停損放在最優先位置。」',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** MACD高檔背離 */
export const macdBullishDivergence: TradingRule = {
  id: 'macd-bearish-divergence',
  name: 'MACD高檔多方動能背離',
  description: '股價創新高，但MACD OSC未創新高（頭頭低），動能衰竭',
  evaluate(candles, index): RuleSignal | null {
    if (index < 10) return null;
    const c = candles[index];
    // 找前一個局部高點
    let prevHighIdx = -1;
    for (let i = index - 3; i >= Math.max(1, index - 15); i--) {
      if (candles[i].close > candles[i - 1].close && candles[i].close > candles[i + 1]?.close) {
        prevHighIdx = i;
        break;
      }
    }
    if (prevHighIdx < 0) return null;
    const prev = candles[prevHighIdx];
    // 股價新高，但OSC未新高
    const priceNewHigh = c.close > prev.close;
    const oscDivergence = c.macdOSC != null && prev.macdOSC != null && c.macdOSC < prev.macdOSC;
    if (!priceNewHigh || !oscDivergence) return null;
    const isHighLevel = c.ma20 != null && c.close > c.ma20 * 1.08;
    if (!isHighLevel) return null;
    return {
      type: 'WATCH',
      label: 'MACD高檔背離',
      description: `股價創新高 ${c.close}，但MACD OSC(${c.macdOSC?.toFixed(3)}) < 前高時OSC(${prev.macdOSC?.toFixed(3)})，動能衰竭警示`,
      reason: [
        '【書中背離定義】「多頭高檔的MACD柱狀體背離，代表多頭上漲時多方動能減弱，股價容易回檔修正。」',
        '【停利時機】書中說：「此時若手上有多單，要隨時準備停利出場，多單也暫且別再進場。」高檔背離是重要的停利警訊，不是買入時機。',
        '【二度背離更危險】「多頭高檔出現二度MACD背離，就要非常謹慎」——若之前已出現過一次背離，本次為二度背離，風險更高。',
        '【如何確認反轉】高檔背離後，觀察是否出現：①爆量長黑K ②跌破MA5 ③均線開始死叉。三項中出現任兩項，代表反轉機率大，應立即停利出場。',
        '【書中引述案例】「股價已從約20元漲到40元，開始出現高檔指標背離，而且是MACD、KD雙指標二度背離，此時若手上有多單，要隨時準備停利出場。」',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

// ═══════════════════════════════════════════════════════════════
//  ⑥ KD 規則
// ═══════════════════════════════════════════════════════════════

/** KD低檔黃金交叉 */
export const kdOversoldBounce: TradingRule = {
  id: 'kd-oversold-bounce',
  name: 'KD低檔黃金交叉（超賣區）',
  description: 'KD在20-30以下超賣區，K線由下往上穿越D線',
  evaluate(candles, index): RuleSignal | null {
    if (index < 1) return null;
    const c = candles[index];
    const prev = candles[index - 1];
    if (c.kdK == null || c.kdD == null || prev.kdK == null || prev.kdD == null) return null;
    const isOversold  = c.kdK <= 30;
    const goldenCross = prev.kdK <= prev.kdD && c.kdK > c.kdD;
    if (!isOversold || !goldenCross) return null;
    return {
      type: 'BUY',
      label: 'KD低檔金叉買進',
      description: `KD在超賣區（K=${c.kdK}，D=${c.kdD}）出現黃金交叉`,
      reason: [
        '【書中KD規則】「KD黃金交叉向上（K線由下往上穿過D線）」是多頭確認的指標條件之一，也是書中多頭選股條件第6項。',
        '【超賣區的意義】「當KD下降到20左右的過低超賣區，表示股價太低、跌幅太大，容易有買盤進場，股價有機會反彈修正。」',
        '【最佳使用情境】KD低檔金叉＋MACD低檔背離（底底高）＋止跌長紅K棒，三指標共振才是最高勝率的進場組合。書中引述：「多頭回後買上漲，觀察MACD綠柱轉紅柱，代表多方趨勢再上漲；KD指標多排表示目前正處於上漲波，研判雙指標都屬於多方趨勢。」',
        '【注意空頭中的反彈】若整體趨勢空頭排列，KD低檔金叉只代表超賣反彈，不代表趨勢反轉，操作上以短線為主，不宜重倉。',
        '【低檔鈍化的情況】若KD長時間維持在20以下（低檔鈍化），代表空頭動能極強，不宜逆勢做多，等待確認止跌後再操作。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** KD高檔死亡交叉 */
export const kdOverboughtWarning: TradingRule = {
  id: 'kd-overbought',
  name: 'KD高檔死亡交叉（超買區）',
  description: 'KD在70-80以上超買區，K線由上往下穿越D線',
  evaluate(candles, index): RuleSignal | null {
    if (index < 1) return null;
    const c = candles[index];
    const prev = candles[index - 1];
    if (c.kdK == null || c.kdD == null || prev.kdK == null || prev.kdD == null) return null;
    const isOverbought = c.kdK >= 70;
    const deathCross   = prev.kdK >= prev.kdD && c.kdK < c.kdD;
    if (!isOverbought || !deathCross) return null;
    const isHighDeviation = c.ma20 != null && c.close > c.ma20 * 1.10;
    return {
      type: 'REDUCE',
      label: 'KD高檔死叉',
      description: `KD在超買區（K=${c.kdK}，D=${c.kdD}）出現死亡交叉${isHighDeviation ? '，且乖離月線已大' : ''}`,
      reason: [
        '【書中KD規則】「KD死亡交叉向下（K線由上往下穿過D線）」是空頭確認的指標條件，也是多頭停利的警訊。',
        '【超買區的意義】「當KD上升到80左右的過熱超買區，股價容易回檔修正。」——KD死叉是短線多頭力道轉弱的最直接訊號。',
        isHighDeviation
          ? '【乖離+死叉雙重警示】目前股價高於月線超過10%，加上KD死叉，雙重警示下應積極考慮停利出場或大幅減碼。'
          : '【減碼觀望】KD死叉後，先減碼1/3~1/2，以前高為停損，觀察是否能收復，若次日再創新高可以重新加碼。',
        '【高檔鈍化例外】若股價持續強勢，KD可能維持在80以上出現「高檔鈍化」。書中：「KD進入鈍化區時，要專注於股價走勢及價量配合，而非KD數值。」鈍化中不宜過早出場。',
        '【KD雙指標背離】若同時出現MACD高檔背離，代表兩大指標都在發出警訊，書中稱「雙指標二度背離」是最危險的停利訊號。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

// ═══════════════════════════════════════════════════════════════
//  ⑦ 停損/停利規則（朱老師SOP）
// ═══════════════════════════════════════════════════════════════

/** 停損出場：黑K收盤跌破MA5（朱老師SOP核心停損規則） */
export const stopLossBreakMA5: TradingRule = {
  id: 'stop-loss-break-ma5',
  name: '停損：黑K跌破MA5',
  description: '收黑K且收盤由MA5上方跌破至MA5下方，觸發朱老師停損SOP',
  evaluate(candles, index): RuleSignal | null {
    if (index < 1) return null;
    const c    = candles[index];
    const prev = candles[index - 1];
    if (c.ma5 == null || prev.ma5 == null) return null;
    const isBlack     = c.close < c.open;
    const breaksMA5   = prev.close >= prev.ma5 && c.close < c.ma5;
    if (!isBlack || !breaksMA5) return null;
    return {
      type: 'SELL',
      label: '停損出場（黑K破MA5）',
      description: `黑K收盤 ${c.close} 由MA5(${prev.ma5}) 上方跌破至 ${c.ma5} 下方，觸發停損訊號`,
      reason: [
        '【朱老師停損SOP】林穎《學會走圖SOP》明確說明：「黑K棒收盤跌破5日均線，就要停損出場，不管是獲利了結還是停損，這是鐵律。」',
        '【為什麼是MA5】5日均線代表最近1週的平均成本，跌破代表短期買方已全面失守，趨勢可能轉變。',
        '【執行紀律】書中強調：「停損要在第一時間執行，不要猶豫。早一天停損，可以少賠一段。」如果這根黑K是第一次跌破MA5，務必執行。',
        '【例外情況】若股票處於盤整區間（非明顯多頭），此訊號可調整為觀察而非立即停損。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};
