import { TradingRule, RuleSignal, CandleWithIndicators } from '@/types';
import {
  crossedAbove,
  crossedBelow,
  recentHigh,
  recentLow,
  isBullishMAAlignment,
  isBearishMAAlignment,
} from '@/lib/indicators';

/**
 * 朱家泓技術分析規則引擎
 * 來源：《做對5個實戰步驟》《抓住線圖 股民變股神》《學會走圖SOP》
 *
 * 技術分析四大金剛（優先順序）：
 *   1. 波浪型態（趨勢方向，最重要）
 *   2. K線（強弱判斷）
 *   3. 均線（方向與支撐）
 *   4. 成交量（輔助確認）
 *
 * 每條規則包含：
 *   description → 技術事實（發生了什麼）
 *   reason      → 操作建議理由（為什麼重要、書中怎麼說、應該怎麼做）
 */

// ═══════════════════════════════════════════════════════════════
//  工具函數
// ═══════════════════════════════════════════════════════════════

/** K棒實體大小（絕對值，百分比） */
function bodyPct(c: CandleWithIndicators): number {
  return Math.abs(c.close - c.open) / c.open;
}

/** 是否為實體長紅K（實體 > 開盤價2%，且收紅） */
function isLongRedCandle(c: CandleWithIndicators): boolean {
  return c.close > c.open && bodyPct(c) > 0.02;
}

/** 是否為實體長黑K（實體 > 開盤價2%，且收黑） */
function isLongBlackCandle(c: CandleWithIndicators): boolean {
  return c.close < c.open && bodyPct(c) > 0.02;
}

/** K棒1/2價（最高+最低）÷2 */
function halfPrice(c: CandleWithIndicators): number {
  return (c.high + c.low) / 2;
}

/** 計算收盤與MA的乖離率（正=高於MA，負=低於MA） */
function maDeviation(c: CandleWithIndicators, maKey: 'ma20' | 'ma60'): number | null {
  const ma = c[maKey];
  if (ma == null) return null;
  return (c.close - ma) / ma;
}

/** 判斷最近N根是否為波浪頭頭高（多頭趨勢） */
function isUptrendWave(candles: CandleWithIndicators[], index: number, lookback = 5): boolean {
  if (index < lookback) return false;
  const slice = candles.slice(index - lookback, index + 1);
  let higherHighs = 0;
  let higherLows  = 0;
  for (let i = 1; i < slice.length; i++) {
    if (slice[i].high > slice[i - 1].high) higherHighs++;
    if (slice[i].low  > slice[i - 1].low)  higherLows++;
  }
  return higherHighs >= 3 && higherLows >= 2;
}

/** 判斷最近N根是否為波浪頭頭低（空頭趨勢） */
function isDowntrendWave(candles: CandleWithIndicators[], index: number, lookback = 5): boolean {
  if (index < lookback) return false;
  const slice = candles.slice(index - lookback, index + 1);
  let lowerHighs = 0;
  let lowerLows  = 0;
  for (let i = 1; i < slice.length; i++) {
    if (slice[i].high < slice[i - 1].high) lowerHighs++;
    if (slice[i].low  < slice[i - 1].low)  lowerLows++;
  }
  return lowerHighs >= 3 && lowerLows >= 2;
}

// ═══════════════════════════════════════════════════════════════
//  ① 趨勢確認規則（波浪型態）
// ═══════════════════════════════════════════════════════════════

/** 多頭趨勢確認：帶量長紅K線突破前高 */
const bullishTrendConfirm: TradingRule = {
  id: 'bullish-trend-confirm',
  name: '多頭趨勢確認（帶量紅K過前高）',
  description: '帶量實體長紅K棒，收盤突破近5日最高點，多頭趨勢確認',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const c = candles[index];
    const prevHigh = recentHigh(candles, index, 5);
    const avgVol = c.avgVol5;
    if (!isLongRedCandle(c)) return null;
    if (c.close <= prevHigh) return null;
    const hasVol = avgVol == null || c.volume >= avgVol * 1.2;
    if (!hasVol) return null;
    const isMaBullish = isBullishMAAlignment(c);
    return {
      type: 'BUY',
      label: '多頭突破買點',
      description: `帶量（${c.volume >= (avgVol ?? 0) * 1.2 ? '量增' : ''}）長紅K棒收盤 ${c.close} 突破前5日高點 ${prevHigh.toFixed(2)}`,
      reason: [
        '【書中黃金買點②】「底部盤整完成，出現突破前面高點的帶量長紅K線時」——這是朱家泓書中4個黃金買點的第②個，是最基本的多頭進場訊號。',
        '【四大金剛確認】波浪型態（收盤過前高）＋K線（實體長紅）＋成交量（量增）三項同時確認，是最高品質的進場機會。',
        isMaBullish
          ? '【均線加分】目前MA5>MA10>MA20三線多頭排列，均線從阻力轉支撐，持股風險相對低。'
          : '【均線提示】均線尚未完成多頭排列，建議輕倉進場，等待均線排列整齊後再加碼。',
        '【進場SOP】進場後停損設在本根K線最低點（不超過7%）。若乖離MA20超過+15%，改為跌破MA5才出場。',
        '【操作口訣】「K線看轉折，均線看方向。進場做波段，操作做短線。」',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 空頭趨勢確認：帶量長黑K線跌破前低 */
const bearishTrendConfirm: TradingRule = {
  id: 'bearish-trend-confirm',
  name: '空頭趨勢確認（帶量黑K破前低）',
  description: '帶量實體長黑K棒，收盤跌破近5日最低點，空頭趨勢確認',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const c = candles[index];
    const prevLow = recentLow(candles, index, 5);
    const avgVol  = c.avgVol5;
    if (!isLongBlackCandle(c)) return null;
    if (c.close >= prevLow) return null;
    const hasVol = avgVol == null || c.volume >= avgVol * 1.2;
    if (!hasVol) return null;
    return {
      type: 'SELL',
      label: '空頭跌破賣點',
      description: `帶量長黑K棒收盤 ${c.close} 跌破前5日低點 ${prevLow.toFixed(2)}`,
      reason: [
        '【書中黃金賣點②】「頭部盤整完成，跌破前面低點的長黑K線時」——這是朱家泓4個黃金空點的第②個，是最基本的空頭進場訊號。',
        '【空頭趨勢特性】「空頭走勢：見撐不是撐，見壓多有壓」——空頭中所有支撐都容易被跌破，所有反彈都遇到壓力。',
        '【多單持有者】此刻若手中有多單，應執行停損出場。書中：「要在股市生存，能做到小賠的唯一方法只有停損。股市中再大的風險，只要執行停損都能避開。」',
        '【空單機會】若確認空頭排列，可在反彈至均線時做空，停損設在反彈最高點。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

// ═══════════════════════════════════════════════════════════════
//  ② 均線規則（進出依據）
// ═══════════════════════════════════════════════════════════════

/** 多頭三線排列確認 */
const bullishMAAlignment: TradingRule = {
  id: 'bullish-ma-alignment',
  name: '三線多頭排列剛成形',
  description: 'MA5 > MA10 > MA20，三線多頭排列剛完成',
  evaluate(candles, index): RuleSignal | null {
    if (index < 1) return null;
    const c = candles[index];
    const prev = candles[index - 1];
    if (!isBullishMAAlignment(c) || isBullishMAAlignment(prev)) return null;
    const aboveMA60 = c.ma60 == null || c.close > c.ma60;
    return {
      type: 'WATCH',
      label: '多頭排列確認',
      description: `MA5(${c.ma5}) > MA10(${c.ma10}) > MA20(${c.ma20}) 三線多頭排列剛成形`,
      reason: [
        '【書中進場條件】朱家泓《做對5個實戰步驟》的多頭選股條件第3項：「均線3線（MA5、MA10、MA20）多頭排列向上」——均線排列是進場的必要條件之一。',
        '【進場口訣】「就短線做多而言，日線多頭架構完成趨勢確認，加上均線3線多頭排列向上，這時順勢做多，成功賺錢的勝率大，賠錢停損的機率小。」',
        aboveMA60
          ? '【四線多頭】MA60季線也在股價下方，已形成四線多頭排列，代表短中長期全面偏多，可考慮較長波段持有。'
          : '【季線壓力】MA60季線仍在股價上方，為季線阻力。書中提醒：站上月線後先做短線，待站上季線後才轉為中長線操作。',
        '【操作建議】可等下一根回檔不破前低再上漲時進場（黃金買點③），勝率更高。',
        '【配合指標】搭配MACD OSC由綠轉紅（或KD黃金交叉）共振時進場，準確率更高。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 空頭三線排列確認 */
const bearishMAAlignment: TradingRule = {
  id: 'bearish-ma-alignment',
  name: '三線空頭排列剛成形',
  description: 'MA5 < MA10 < MA20，三線空頭排列剛完成',
  evaluate(candles, index): RuleSignal | null {
    if (index < 1) return null;
    const c = candles[index];
    const prev = candles[index - 1];
    if (!isBearishMAAlignment(c) || isBearishMAAlignment(prev)) return null;
    return {
      type: 'SELL',
      label: '空頭排列警示',
      description: `MA5(${c.ma5}) < MA10(${c.ma10}) < MA20(${c.ma20}) 三線空頭排列剛成形`,
      reason: [
        '【書中空頭排列邏輯】三線空頭排列代表短中期賣方力道全面主導，均線呈下壓態勢。「空頭走勢：見撐不是撐，見壓多有壓」——每次反彈到均線都是賣壓。',
        '【不宜做多】書中明確指出：「凡是均線同時往下，股價在均線下方時不做多。」均線空排期間，任何反彈都可能只是逢高出貨的機會。',
        '【操作建議】①持有多單者應考慮出場；②反彈到MA5或MA10附近、且均線方向向下時，是做空的機會；③等待趨勢轉為多頭排列再考慮做多。',
        '【空頭操作SOP】「空頭行進反彈壓力：反彈到壓力均線，不過前高再下跌」——這是做空的黃金進場位置。',
        '【停損設定】若做空，停損設在進場當日K線最高點，不超過7%。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 均線糾結突破 */
const maClusterBreakout: TradingRule = {
  id: 'ma-cluster-breakout',
  name: '均線糾結後突破',
  description: 'MA5、MA10、MA20 三線靠近糾結，今日帶量紅K突破',
  evaluate(candles, index): RuleSignal | null {
    if (index < 1) return null;
    const c = candles[index];
    if (c.ma5 == null || c.ma10 == null || c.ma20 == null) return null;
    const spread = Math.abs(c.ma5 - c.ma20) / c.ma20;
    if (spread > 0.025) return null; // 均線差距>2.5%代表未糾結
    const isBreakingUp = c.close > c.open && c.close > Math.max(c.ma5, c.ma10, c.ma20);
    const avgVol = c.avgVol5;
    const hasVol = avgVol == null || c.volume >= avgVol * 1.2;
    if (!isBreakingUp || !hasVol) return null;
    return {
      type: 'BUY',
      label: '均線糾結突破',
      description: `三均線差距僅 ${(spread * 100).toFixed(1)}%（糾結），帶量紅K突破所有均線`,
      reason: [
        '【書中口訣】「均線糾結的向上紅棒是起漲的開始。」——這是朱家泓書中最重要的均線操作口訣之一，糾結突破往往是波段起漲的訊號。',
        '【糾結的意義】三條均線靠攏代表多空力量長時間均衡，能量積累。一旦帶量突破，方向確立，後續走勢往往延續，不容易立刻反轉。',
        '【飆股特徵之一】朱家泓飆股8條件第5項：「發動前，短中長期均線糾結」——糾結突破也是飆股發動的前兆，需特別留意。',
        '【操作建議】可以此紅K棒低點或MA20為停損基準進場。若成交量是近期最大量，後續上漲空間更大。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 突破月線（MA20）買點 */
const breakAboveMA20: TradingRule = {
  id: 'break-above-ma20',
  name: '突破月線 MA20',
  description: '收盤由下往上穿越20日均線（月線）',
  evaluate(candles, index): RuleSignal | null {
    if (!crossedAbove(candles, index, 'ma20')) return null;
    const c = candles[index];
    const aboveMA60 = c.ma60 == null || c.close > c.ma60;
    return {
      type: 'BUY',
      label: '突破月線買點',
      description: `收盤 ${c.close} 突破月線 MA20 (${c.ma20})${aboveMA60 ? '，同時站上季線' : ''}`,
      reason: [
        '【書中月線規則】「股價在月線之上，而且月線呈現向上走勢，趨勢為多頭，只要股價沒有跌破月線之前，做多操作。」——月線是短線操作的多空分界線。',
        '【一條均線戰法進場】書中一條均線戰法：「底部打底完成，暴大量上漲紅K線，站上20日均線且均線走平或上揚，買進。」本訊號與此戰法相符。',
        aboveMA60
          ? '【雙線確認】同時站上季線（MA60），月線和季線雙重多頭確認。書中：「季線是中長期操作的多空分界均線」，雙線確認代表中短期同步偏多。'
          : '【季線壓力存在】目前季線仍在股價上方，按書中建議先以短線操作為主（參考三條均線戰法），待站上季線後再轉中線。',
        '【出場紀律】「一條均線戰法」出場條件：收盤跌破MA20出場，不要凹單。停損設在進場K線最低點。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 突破MA5短線買點 */
const breakAboveMA5: TradingRule = {
  id: 'break-above-ma5',
  name: '突破 MA5 短線買點',
  description: '收盤由下往上穿越5日均線，短線多方動能再起',
  evaluate(candles, index): RuleSignal | null {
    if (!crossedAbove(candles, index, 'ma5')) return null;
    const c = candles[index];
    if (c.close < (c.ma20 ?? 0) * 0.93) return null;
    return {
      type: 'BUY',
      label: '短線買點',
      description: `收盤 ${c.close} 突破 MA5 (${c.ma5})`,
      reason: [
        '【書中順勢波浪戰法】「低檔打底底底高，大量上漲紅K線站上5日均線；或突破盤整上頸線帶量紅K線」——站上MA5是短線多方動能確認的最低門檻。',
        '【MA5 功能】5日均線代表近一週的平均成本，站上後MA5從阻力轉為支撐，短線買方開始主導。',
        '【二條均線戰法出場規則】一旦進場，書中二條均線戰法說：「股價收盤跌破MA10一定要先出場。」以此為短線停利基準。',
        '【注意事項】若月線（MA20）仍向下，此突破可能只是空頭反彈，不宜重倉，輕倉試多即可。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 多頭回踩均線加碼 */
const bullishPullbackBuy: TradingRule = {
  id: 'bullish-pullback-buy',
  name: '多頭回踩支撐再上漲（黃金買點③）',
  description: '均線多頭排列中，前日低點觸及MA10，今日紅K棒反彈',
  evaluate(candles, index): RuleSignal | null {
    if (index < 3) return null;
    const c = candles[index];
    const prev = candles[index - 1];
    if (!isBullishMAAlignment(c)) return null;
    const ma10 = prev.ma10 ?? prev.ma20;
    if (ma10 == null) return null;
    const touchedSupport = prev.low <= ma10 * 1.02 && prev.low >= ma10 * 0.97;
    const isRed = c.close > c.open;
    const notBreakLow = c.low >= prev.low; // 今日不破前日低點
    if (!touchedSupport || !isRed || !notBreakLow) return null;
    return {
      type: 'ADD',
      label: '回踩加碼點',
      description: `多頭排列中，前日低點 ${prev.low} 觸及 MA10(${ma10?.toFixed(2)})，今日紅K反彈確認支撐有效`,
      reason: [
        '【書中黃金買點③】「回檔時沒有跌破前面低點，且出現再向上漲的紅K線時」——這是朱家泓4個黃金買點中第③個，也是最理想的進場機會，因為風險最低。',
        '【最佳進場位置】「多頭走勢的進場好時機，是買在回檔止跌再上漲的位置，而不是突破前面高點的位置。因為過高必拉回是多頭的特性。」',
        '【回後買上漲邏輯】「回後買上漲是指上升走勢中，在股價回檔修正後再次上漲時買進，而不是在回檔中自認為是低價就去買。」',
        '【停損設定】以前日低點（剛剛觸及均線的那根K線最低點）為停損基準，若再次跌破，代表支撐失效，應出場。',
        '【回檔幅度判斷】回至0.382止跌最強，回至0.5止跌正常，回至0.618止跌較弱。若回深至0.618後的反彈，後續是否能突破前高仍需觀察。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 跌破月線停損 */
const breakBelowMA20: TradingRule = {
  id: 'break-below-ma20',
  name: '跌破月線 MA20',
  description: '收盤跌破20日均線（月線）',
  evaluate(candles, index): RuleSignal | null {
    if (!crossedBelow(candles, index, 'ma20')) return null;
    const c = candles[index];
    const isLongBlack = isLongBlackCandle(c);
    return {
      type: 'SELL',
      label: '月線停損訊號',
      description: `收盤 ${c.close} 跌破月線 MA20 (${c.ma20})${isLongBlack ? '，且為實體長黑K' : ''}`,
      reason: [
        '【書中月線規則】「一旦股價跌破月線下方，而且月線下彎，就視為空頭趨勢，做空操作。」——跌破月線是趨勢轉空的重要訊號。',
        '【一條均線戰法出場】「收盤前確認股價跌破20日均線時，出場。」——此為明確的出場信號。',
        isLongBlack
          ? '【長黑加強警示】此根為實體長黑K，代表跌破力道強勁，非洗盤假跌破，建議立即執行停損。書中：「任何操作方法，一定要把停損放在最優先位置。」'
          : '【觀察是否假跌破】若為小實體K棒，可觀察3天內是否回到月線之上（假跌破），若3天內仍未收復，則確認停損。',
        '【停損的重要性】「要在股市生存，一定不能大賠。能夠做到小賠的唯一方法只有停損。停損是進入股市避開危險的煞車機制。」',
        '【多頭高檔 vs 初升段】若跌破時乖離月線已超過-10%，代表本次下跌已有一定幅度，停損後等待打底反彈訊號，不急著再進場。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 跌破季線 MA60 */
const breakBelowMA60: TradingRule = {
  id: 'break-below-ma60',
  name: '跌破季線 MA60',
  description: '收盤跌破60日均線（季線），進入中期空頭格局',
  evaluate(candles, index): RuleSignal | null {
    if (!crossedBelow(candles, index, 'ma60')) return null;
    const c = candles[index];
    return {
      type: 'SELL',
      label: '強力停損訊號',
      description: `收盤 ${c.close} 跌破季線 MA60 (${c.ma60})，中期空頭格局確認`,
      reason: [
        '【書中季線規則】「股價跌破季線下方，而且季線下彎，就視為空頭趨勢，做空操作。季線是中長期操作的多空分界均線。」',
        '【實際案例印證】書中舉例：「台積電自2022年2月底跌破季線後，進入中期空頭格局，此後股價從600元跌至555元，中期空頭的投資人可以持續做空操作。」',
        '【月線+季線雙死叉危機】若月線也同時位於季線下方（即月線死叉季線），代表中長期雙重空頭確認，後續下跌往往幅度更大、時間更長。',
        '【立即停損，不猶豫】書中強調：「一旦趨勢不再是多頭，持有的多單要在第一時間出場，才能避開後面的大跌走勢。」',
        '【等待轉機訊號】跌破季線後，等待以下訊號才再進場：①低檔底底高型態 ②帶量突破下降切線 ③月線重新站上季線（黃金交叉）。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 跌破 MA5 警告 */
const breakBelowMA5: TradingRule = {
  id: 'break-below-ma5',
  name: '跌破 MA5',
  description: '收盤跌破5日均線',
  evaluate(candles, index): RuleSignal | null {
    if (!crossedBelow(candles, index, 'ma5')) return null;
    const c = candles[index];
    const aboveMA20 = c.ma20 == null || c.close > c.ma20;
    return {
      type: aboveMA20 ? 'WATCH' : 'SELL',
      label: aboveMA20 ? '短線回檔警示' : '考慮停損',
      description: `收盤 ${c.close} 跌破 MA5 (${c.ma5})，${aboveMA20 ? '仍在月線上方' : '逼近月線支撐'}`,
      reason: [
        '【書中操作法③】「日線多頭MA5均線操作法：出場條件→黑K線收盤跌破MA5均線出場。」——若你使用MA5操作法，這是明確的出場訊號。',
        aboveMA20
          ? '【正常多頭回檔】股價仍在月線之上，按書中邏輯這可能只是多頭中的正常回檔。「多頭走勢總是上漲的多、回跌的少」，觀察是否在MA10或MA20獲得支撐後再上漲。'
          : '【趨勢轉弱警示】股價已跌近月線，若跌破月線則觸發更強的停損訊號。建議先減碼一半，其餘以月線為最後防線。',
        '【操作紀律】「會買股票是徒弟，會賣股票才是師傅。」跌破MA5若不出場，要有明確的理由（如確認為多頭洗盤），否則紀律停損優先。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

// ═══════════════════════════════════════════════════════════════
//  ③ 量價規則
// ═══════════════════════════════════════════════════════════════

/** 放量突破前高（最強買訊） */
const volumeBreakoutHigh: TradingRule = {
  id: 'volume-breakout-high',
  name: '放量突破前高',
  description: '成交量≥近5日均量2倍，且收盤突破近20日最高點',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const c = candles[index];
    const prevHigh = recentHigh(candles, index, 20);
    const avgVol = c.avgVol5;
    if (avgVol == null || prevHigh === -Infinity) return null;
    const ratio = c.volume / avgVol;
    if (ratio < 2 || c.close <= prevHigh) return null;
    return {
      type: 'BUY',
      label: '攻擊量突破',
      description: `量比 ${ratio.toFixed(1)}倍（${c.volume.toLocaleString()} / 均量 ${avgVol.toLocaleString()}），突破近20日高點 ${prevHigh.toFixed(2)}`,
      reason: [
        '【書中攻擊量定義】「攻擊量：成交量 > 前日 1.2 倍」。本K棒量達均量2倍，屬重度攻擊量，力道強勁。',
        '【書中大量突破邏輯】「盤整突破、多頭趨勢確認的大量實體長紅棒，可視為主力做多的攻擊訊號。成交量大代表攻擊力道強，後續股價就容易上漲。」',
        '【大量K棒的支撐功能】「大成交量的紅K棒，也是一根關鍵K棒，為多頭趨勢裡的重要支撐，因為這個大量代表主力進貨成本，自然不能被跌破，一旦跌破就容易引發停損賣壓。」',
        '【停損設定】進場後停損設在本K棒最低點，或1/2價（最高+最低÷2）。若跌破1/2價，代表多方氣勢轉弱，應出場。',
        '【注意追高風險】若股價已從低點漲幅超過50%才出現此訊號，需留意「高檔第一次有價有量：可能出貨（警示）」。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 高檔爆量長黑（出貨訊號）*/
const highVolumeLongBlack: TradingRule = {
  id: 'high-volume-long-black',
  name: '高檔爆量長黑（出貨訊號）',
  description: '高位（月線+10%以上）出現成交量≥均量3倍的實體長黑K棒',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const c = candles[index];
    const avgVol = c.avgVol5;
    if (avgVol == null) return null;
    const ratio = c.volume / avgVol;
    if (!isLongBlackCandle(c)) return null;
    const isHighLevel = c.ma20 != null && c.close > c.ma20 * 1.1;
    if (!isHighLevel || ratio < 3) return null;
    return {
      type: 'SELL',
      label: '高檔出貨長黑',
      description: `量比 ${ratio.toFixed(1)}倍（均量 ${avgVol.toLocaleString()}），高位實體長黑K，疑似主力出貨`,
      reason: [
        '【書中高檔大量規則】「高檔第一次有價有量：可能出貨（警示）。高檔第二次有價有量（反彈不過前高）：再次出貨量（下跌訊號）。」——現為第一次警示。',
        '【1/2價防守法】書中5種高檔暴大量因應策略策略①：「出現高檔暴大量紅K線，持股多的開始分批賣出1/3或1/2；以該長紅K線1/2價為防守價，跌破要全部出清。」',
        '【本根已是長黑】策略⑤：「出現高檔暴大量長黑K線：一律為賣出訊號，要趕快出場。」——本K棒已是長黑，屬於最強烈的出貨訊號。',
        '【書中出貨邏輯】「大量賣壓出籠（主力出貨）；買方雖然積極，但賣方更強（黑K收低）；後續上漲空間受限。」',
        '【停利vs停損】若已有獲利，應立即停利。若剛進場且已虧損，更要嚴格停損，「大賺小賠是股市致富的不變道理」。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 高檔暴大量長紅K（可能出貨紅K，慎追）*/
const highVolumeLongRed: TradingRule = {
  id: 'high-volume-long-red-top',
  name: '高檔暴大量長紅（慎追）',
  description: '高位出現暴大量長紅K棒，需警惕是否為主力誘多出貨',
  evaluate(candles, index): RuleSignal | null {
    if (index < 10) return null;
    const c = candles[index];
    const avgVol = c.avgVol5;
    if (avgVol == null) return null;
    const ratio = c.volume / avgVol;
    if (!isLongRedCandle(c)) return null;
    // 高位：高於月線15%以上
    const isHighLevel = c.ma20 != null && c.close > c.ma20 * 1.15;
    // 已漲幅大：高於近20日低點30%以上
    const prevLow = recentLow(candles, index, 20);
    const bigRise = c.close > prevLow * 1.30;
    if (!isHighLevel || ratio < 2.5 || !bigRise) return null;
    return {
      type: 'WATCH',
      label: '高檔大量紅K 慎追',
      description: `高位（月線+${((c.close / (c.ma20 ?? c.close) - 1) * 100).toFixed(1)}%），量比 ${ratio.toFixed(1)}倍長紅K，已從近低點漲${((c.close / prevLow - 1) * 100).toFixed(0)}%`,
      reason: [
        '【書中不適合買進的5種情況之①】「多頭高檔出現大量長紅K線（主力可能出貨）」——高位大量紅K是警示，不是追進訊號。',
        '【1/2價防守法】書中建議：以這根大量長紅K線的1/2價（最高+最低÷2）為防守線，若次日收盤跌破1/2價，代表多方氣勢轉弱，應考慮減碼。',
        '【停利時機】若手中有多單且獲利豐厚，書中建議在以下任一訊號出現時分批停利：①股價乖離MA20超過+15% ②MACD高檔背離 ③高檔爆量轉折。',
        '【追漲風險】「連續上漲出現第3根或第4根長紅K線（追到高點風險）」——高位追漲是書中特別提醒的散戶通病。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 高乖離停利提示 */
const highDeviationWarning: TradingRule = {
  id: 'high-deviation-warning',
  name: '乖離月線超過+15%（停利機制啟動）',
  description: '收盤高於MA20超過15%，書中規定改用MA5停利',
  evaluate(candles, index): RuleSignal | null {
    if (index < 1) return null;
    const c = candles[index];
    const prev = candles[index - 1];
    const dev = maDeviation(c, 'ma20');
    const prevDev = maDeviation(prev, 'ma20');
    if (dev == null || prevDev == null) return null;
    if (dev < 0.15 || prevDev >= 0.15) return null; // 剛超過15%
    return {
      type: 'WATCH',
      label: '乖離超15% 改MA5停利',
      description: `收盤乖離月線 ${(dev * 100).toFixed(1)}%（高於+15%門檻），停利機制切換`,
      reason: [
        '【書中長短線綜合操作法核心規則】「短線股價乖離MA20 > +15%，停利改為跌破MA5均線出場。」——這是朱家泓書中最重要的停利機制之一，讓利潤充分增長。',
        '【為何換到MA5停利】正常情況下用MA10停利，但乖離>15%代表漲勢強勁，改用更緊的MA5停利，一方面讓利潤跑，另一方面一旦轉弱能快速出場。',
        '【注意觀察】此後每根K棒，若收盤跌破MA5，即停利出場。不要等跌破MA20才出場，那樣已損失太多獲利。',
        '【書中停利觀念】「多頭股票強勢上漲，獲利達20%~25%時，要注意容易回檔做較長時間的整理。」',
        '【實戰引述】書中實際操作案例：「2013/12/26，黑K線收盤跌破MA5均線，收盤25.5元多單賣出，短線單次獲利6.55元，獲利率34.5%。」',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

// ═══════════════════════════════════════════════════════════════
//  ④ K線型態規則
// ═══════════════════════════════════════════════════════════════

/** 穿心紅K線（低檔反轉訊號）*/
const piercingRedCandle: TradingRule = {
  id: 'piercing-red-candle',
  name: '穿心紅K線（低檔）',
  description: '紅K棒突破前日黑K棒1/2價以上，低檔反轉訊號',
  evaluate(candles, index): RuleSignal | null {
    if (index < 3) return null;
    const c = candles[index];
    const prev = candles[index - 1];
    if (!isLongBlackCandle(prev)) return null;
    if (!isLongRedCandle(c)) return null;
    const half = halfPrice(prev);
    if (c.close <= half) return null;
    // 低檔確認（在月線附近或以下）
    const isLowLevel = c.ma20 == null || c.close <= c.ma20 * 1.05;
    if (!isLowLevel) return null;
    return {
      type: 'BUY',
      label: '穿心紅K（低檔反轉）',
      description: `今日紅K收盤 ${c.close} 突破昨日長黑K棒1/2價 ${half.toFixed(2)}，低檔穿心紅K反轉訊號`,
      reason: [
        '【書中K線型態】「穿心紅K線：長紅突破前一日長黑K線的1/2價」——這是書中低檔8個向上攻擊K線訊號第⑤個，代表多方力道強烈反撲。',
        '【1/2價的意義】「K線第5元素」概念：1/2價（最高+最低÷2）是多空均衡成本。今日紅K收盤超過昨日黑K的1/2價，代表昨日賣出的人已全部被多方反超，多方反攻成功。',
        '【操作建議】若同時滿足：①低檔位置 ②穿心紅K ③成交量放大 ④KD低檔或黃金交叉，可以進場試多。停損設在今日紅K最低點。',
        '【注意事項】若整體趨勢仍是空頭排列，此可能只是反彈，非趨勢反轉，適合短線交易，不宜重倉。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 高檔穿心黑K線（反轉訊號）*/
const piercingBlackCandle: TradingRule = {
  id: 'piercing-black-candle',
  name: '穿心黑K線（高檔反轉）',
  description: '黑K棒跌破前日紅K棒1/2價以下，高檔反轉訊號',
  evaluate(candles, index): RuleSignal | null {
    if (index < 3) return null;
    const c = candles[index];
    const prev = candles[index - 1];
    if (!isLongRedCandle(prev)) return null;
    if (!isLongBlackCandle(c)) return null;
    const half = halfPrice(prev);
    if (c.close >= half) return null;
    const isHighLevel = c.ma20 == null || c.close >= c.ma20 * 1.05;
    if (!isHighLevel) return null;
    return {
      type: 'SELL',
      label: '穿心黑K（高檔反轉）',
      description: `今日黑K收盤 ${c.close} 跌破昨日長紅K棒1/2價 ${half.toFixed(2)}，高檔穿心黑K反轉訊號`,
      reason: [
        '【書中K線型態】「穿心黑K線：長黑跌破前一日長紅K線1/2價」——這是書中高檔8個向下回檔K線訊號第⑤個，代表空方強力反撲。',
        '【1/2價跌破的意義】昨日紅K的買進者，今日有半數已套牢（收在1/2價以下），多方士氣大挫，賣方取得主導。',
        '【高位出現更危險】高位穿心黑K往往是主力出貨後的確認，後續下跌機率高。若同時伴隨MACD高檔背離或KD死亡交叉，更應果斷減碼。',
        '【書中急漲末端賣股方法】「K線出場訊號：大量長黑當日賣出」——高位長黑K是立即出場的訊號，不等次日確認。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 連三黑（空頭持續訊號）*/
const threeBlackCandles: TradingRule = {
  id: 'three-black-candles',
  name: '高位連三黑K（持續下跌訊號）',
  description: '高位連續3根實體黑K棒，下跌動能持續',
  evaluate(candles, index): RuleSignal | null {
    if (index < 3) return null;
    const c1 = candles[index];
    const c2 = candles[index - 1];
    const c3 = candles[index - 2];
    if (!isLongBlackCandle(c1) || !isLongBlackCandle(c2) || !isLongBlackCandle(c3)) return null;
    // 高位確認
    const isHighLevel = c1.ma20 != null && c3.close > c1.ma20 * 1.05;
    if (!isHighLevel) return null;
    return {
      type: 'SELL',
      label: '高位連三黑',
      description: `高位連續3根實體黑K，持續下跌動能強`,
      reason: [
        '【書中K線規則】「高檔8個向下回檔K線訊號」中提及：「連3根長黑K線（鎖股等反彈再放空）」——高位連三黑代表空方力量持續強勁。',
        '【操作建議】已持有多單者，應在本根黑K出現時立即停損出場，不要等反彈。書中：「操作做短線，看到轉折訊號要立刻行動。」',
        '【做空機會】若整體趨勢已轉空，連三黑結束後的反彈（不過前高）是做空的機會。書中：「空頭行進反彈壓力：反彈到壓力均線，不過前高再下跌」是黃金空點。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

// ═══════════════════════════════════════════════════════════════
//  ⑤ MACD 規則
// ═══════════════════════════════════════════════════════════════

/** MACD黃金交叉（OSC綠轉紅）*/
const macdGoldenCross: TradingRule = {
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
      type: 'WATCH',
      label: aboveZero ? 'MACD金叉（0軸上）' : 'MACD金叉（0軸下）',
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
const macdDeathCross: TradingRule = {
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
const macdBullishDivergence: TradingRule = {
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
const kdOversoldBounce: TradingRule = {
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
      type: 'WATCH',
      label: 'KD低檔金叉',
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
const kdOverboughtWarning: TradingRule = {
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
const stopLossBreakMA5: TradingRule = {
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

// ═══════════════════════════════════════════════════════════════
//  ALL RULES
// ═══════════════════════════════════════════════════════════════

export const DEFAULT_RULES: TradingRule[] = [
  // 趨勢確認
  bullishTrendConfirm,
  bearishTrendConfirm,
  // 均線
  bullishMAAlignment,
  bearishMAAlignment,
  maClusterBreakout,
  breakAboveMA20,
  breakAboveMA5,
  bullishPullbackBuy,
  breakBelowMA5,
  breakBelowMA20,
  breakBelowMA60,
  // 量價
  volumeBreakoutHigh,
  highVolumeLongBlack,
  highVolumeLongRed,
  highDeviationWarning,
  // K線型態
  piercingRedCandle,
  piercingBlackCandle,
  threeBlackCandles,
  // MACD
  macdGoldenCross,
  macdDeathCross,
  macdBullishDivergence,
  // KD
  kdOversoldBounce,
  kdOverboughtWarning,
  // 停損
  stopLossBreakMA5,
];
