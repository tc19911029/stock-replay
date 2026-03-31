import { TradingRule, RuleSignal } from '@/types';
import { recentHigh, recentLow } from '@/lib/indicators';
import { isLongRedCandle, isLongBlackCandle, halfPrice, maDeviation } from './ruleUtils';

// ═══════════════════════════════════════════════════════════════
//  ③ 量價規則
// ═══════════════════════════════════════════════════════════════

/** 放量突破前高（最強買訊） */
export const volumeBreakoutHigh: TradingRule = {
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
      label: '放量突破買進',
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
export const highVolumeLongBlack: TradingRule = {
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
export const highVolumeLongRed: TradingRule = {
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
export const highDeviationWarning: TradingRule = {
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
export const piercingRedCandle: TradingRule = {
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
      type: 'WATCH',
      label: '穿心紅K（觀察）',
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
export const piercingBlackCandle: TradingRule = {
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
export const threeBlackCandles: TradingRule = {
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
