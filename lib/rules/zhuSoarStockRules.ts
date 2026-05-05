/**
 * 朱家泓《抓住飆股輕鬆賺》— 獨家交易規則
 *
 * 本書三大核心貢獻（未見於其他朱家泓書籍）：
 * 1. 9種價量關係診斷 — 系統化分類當前價量狀態並給出操作建議
 * 2. 市場循環4階段偵測 — 打底期/上升期/做頭期/下跌期
 * 3. 位置風險評估 — 山頂/山腰/山谷（風險報酬比判斷）
 */

import { TradingRule, RuleSignal, CandleWithIndicators } from '@/types';
import { isUptrendWave, isDowntrendWave } from './ruleUtils';

// ─── 內部輔助 ────────────────────────────────────────────────────────────────

/** 價格相對前日的變化方向 */
function priceDir(c: CandleWithIndicators, prev: CandleWithIndicators): 'up' | 'down' | 'flat' {
  const pct = (c.close - prev.close) / prev.close;
  if (pct > 0.005) return 'up';
  if (pct < -0.005) return 'down';
  return 'flat';
}

/** 成交量相對5日均量的方向 */
function volDir(c: CandleWithIndicators): 'up' | 'down' | 'flat' {
  if (c.avgVol5 == null || c.avgVol5 === 0) return 'flat';
  const ratio = c.volume / c.avgVol5;
  if (ratio > 1.2) return 'up';
  if (ratio < 0.8) return 'down';
  return 'flat';
}

/** 近N日最高點 */
function nHigh(candles: CandleWithIndicators[], idx: number, n: number): number {
  return Math.max(...candles.slice(Math.max(0, idx - n), idx + 1).map((c) => c.high));
}

/** 近N日最低點 */
function nLow(candles: CandleWithIndicators[], idx: number, n: number): number {
  return Math.min(...candles.slice(Math.max(0, idx - n), idx + 1).map((c) => c.low));
}

/** 判斷是否處於盤整（近N日振幅 < threshold） */
function isRange(candles: CandleWithIndicators[], idx: number, n = 10, threshold = 0.06): boolean {
  if (idx < n) return false;
  const high = nHigh(candles, idx, n);
  const low = nLow(candles, idx, n);
  if (low === 0) return false;
  return (high - low) / low < threshold;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. 9種價量關係診斷
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 9種價量關係 — 每根K棒都輸出當前狀態分類與操作建議
 *
 * 書中核心口訣：
 * 多頭：量增則攻、量縮則回
 * 空頭：有量則跌、量縮則彈
 */
export const priceVolumeRelation: TradingRule = {
  id: 'zhu-price-volume-9',
  name: '9種價量關係診斷',
  description: '系統化分類當前價量狀態（9種組合），輸出操作建議',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const c = candles[index];
    const prev = candles[index - 1];
    const pd = priceDir(c, prev);
    const vd = volDir(c);
    const isUptrend = isUptrendWave(candles, index, 8);
    const isDowntrend = isDowntrendWave(candles, index, 8);

    type PVCase = {
      label: string;
      type: RuleSignal['type'];
      description: string;
      reason: string;
    };

    const cases: Record<string, PVCase> = {
      'up-up': {
        label: '價漲量增（最強多）',
        type: 'BUY',
        description: '股價上漲且成交量擴大，多方積極進攻',
        reason: [
          '【價量關係①】價漲量增：多方最積極的進攻狀態。',
          '成交量支持股價上漲，多頭走勢健康，可做多持續追蹤。',
          '操作：多頭趨勢中出現此訊號，可考慮進場或續抱。',
          '若在突破關鍵壓力區同時出現，為強烈進場訊號。',
        ].join('\n'),
      },
      'up-flat': {
        label: '價漲量平（動能有限）',
        type: 'WATCH',
        description: '股價上漲但成交量無明顯擴大',
        reason: [
          '【價量關係③】價漲量平：追價意願普通，動能有限。',
          '雖然股價上漲，但量未放大代表市場參與度不高。',
          '操作：觀察後續能否帶量突破，若無量則謹慎追高。',
        ].join('\n'),
      },
      'up-down': {
        label: '價漲量縮（注意反轉）',
        type: 'WATCH',
        description: '股價上漲但成交量萎縮，多頭動能不足',
        reason: [
          '【價量關係②】價漲量縮：追價意願低，注意即將反轉。',
          '股價不斷創新高但量越來越少，是動能衰竭的警訊。',
          '書中警示：「末升段的噴出行情」可能出現後，後續易出現量縮轉折。',
          '操作：若已獲利，可考慮減倉或設移動停損保護獲利。',
        ].join('\n'),
      },
      'down-up': {
        label: '價跌量增（恐慌賣壓）',
        type: isDowntrend ? 'SELL' : 'WATCH',
        description: '股價下跌且成交量放大，賣壓沉重',
        reason: [
          '【價量關係④】價跌量增：有量才下跌，恐慌性賣壓出現。',
          '空頭走勢中：有量才跌，代表持續跌勢，加速下跌風險。',
          '但底部若出現「打底巨量」（低檔爆量），可能是主力進場的訊號，需觀察後續。',
          isDowntrend
            ? '目前為下跌趨勢，此訊號偏向繼續下跌，不宜做多。'
            : '非明顯空頭趨勢，觀察是否在關鍵支撐區有撐。',
        ].join('\n'),
      },
      'down-flat': {
        label: '價跌量平（持續陰跌）',
        type: 'WATCH',
        description: '股價下跌成交量無明顯變化，持續陰跌',
        reason: [
          '【價量關係⑥】價跌量平：持續陰跌，賣壓雖不強但買方也無意接貨。',
          '操作：觀望，不宜進場，等待出現成交量變化或趨勢改變訊號。',
        ].join('\n'),
      },
      'down-down': {
        label: '價跌量縮（賣壓減輕）',
        type: 'WATCH',
        description: '股價下跌但成交量萎縮，賣壓逐漸減輕',
        reason: [
          '【價量關係⑤】價跌量縮：賣壓減輕，可能止跌。',
          '量縮說明殺手已少，籌碼沉澱，可能醞釀底部反彈。',
          '但空頭趨勢中：「空頭走勢量縮則彈」—— 只是技術性反彈，非趨勢扭轉。',
          '操作：不宜積極做多，觀察是否出現帶量長紅確認反轉。',
        ].join('\n'),
      },
      'flat-up': {
        label: '價平量增（有人佈局）',
        type: 'WATCH',
        description: '股價橫盤但成交量放大，可能有主力暗中進場',
        reason: [
          '【價量關係⑦】價平量增：有人進場佈局，注意突破方向。',
          '盤整中突然放量，代表主力可能在暗中吸籌碼。',
          '操作：等待股價確認突破方向，突破方向即為操作方向。',
          '若向上突破盤整區且帶量，為強烈多頭進場訊號。',
        ].join('\n'),
      },
      'flat-down': {
        label: '價平量縮（動能不足）',
        type: 'WATCH',
        description: '股價橫盤成交量萎縮，市場觀望',
        reason: [
          '【價量關係⑧】價平量縮：動能不足。',
          '書中口訣：「末升段量縮做頭，末跌段量縮做底」——需辨別位置。',
          '若在長期盤頂出現：做頭前兆，宜謹慎。',
          '若在長期盤底出現：蓄勢待發，等待放量突破。',
        ].join('\n'),
      },
      'flat-flat': {
        label: '價平量平（多空不明）',
        type: 'WATCH',
        description: '股價與成交量皆無明顯變化，市場觀望',
        reason: [
          '【價量關係⑨】價平量平：多空力量均衡，方向不明。',
          '操作：退出觀望，等待明確的多空訊號出現再進場。',
        ].join('\n'),
      },
    };

    const key = `${pd}-${vd}`;
    const match = cases[key];
    if (!match) return null;

    const trendLabel = isUptrend ? '（多頭趨勢）' : isDowntrend ? '（空頭趨勢）' : '（盤整中）';
    const volRatio = c.avgVol5 && c.avgVol5 > 0
      ? `量比${(c.volume / c.avgVol5).toFixed(1)}x`
      : '';

    return {
      type: match.type,
      label: match.label,
      description: `${match.description} ${trendLabel} ${volRatio}`,
      reason: match.reason,
      ruleId: this.id,
    };
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// 2. 市場循環4階段偵測
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 朱家泓4階段市場循環偵測
 *
 * 四個階段：
 * 1. 打底期（底部）：下跌結束，橫向盤整
 * 2. 上升期（多頭）：頭頭高、底底高
 * 3. 做頭期（頭部）：上漲結束，橫向盤整
 * 4. 下跌期（空頭）：頭頭低、底底低
 */
export const marketCycleStage: TradingRule = {
  id: 'zhu-market-cycle-4stage',
  name: '市場循環4階段偵測',
  description: '判斷當前處於：打底期/上升期/做頭期/下跌期，提示對應操作策略',
  evaluate(candles, index): RuleSignal | null {
    if (index < 20) return null;
    const c = candles[index];
    const isUptrend = isUptrendWave(candles, index, 10);
    const isDowntrend = isDowntrendWave(candles, index, 10);
    const ranging = isRange(candles, index, 10, 0.07);
    const aboveMA20 = c.ma20 != null && c.close > c.ma20;
    const aboveMA60 = c.ma60 != null && c.close > c.ma60;

    // 上升期：頭頭高+底底高+在均線之上
    if (isUptrend && !ranging && aboveMA20) {
      return {
        type: 'BUY',
        label: '上升期（多頭）',
        description: '頭頭高、底底高，均線多頭排列，股價在月線之上',
        reason: [
          '【循環階段②】上升期（多頭走勢）：',
          '特徵：頭頭高、底底高，漲多跌少，均線多頭排列。',
          '朱家泓口訣：「多頭就是不斷創新高，回檔不破前次低點。」',
          '操作策略（9條多頭操作法）：',
          '① 順著多頭趨勢做多。',
          '② 回檔修正後，再次上漲時是最佳買點。',
          '③ 盤整突破時進場。',
          '④ 收盤在MA5之上可續抱。',
          '⑤ 強勢股可獲利加碼往上操作。',
          '⑥ 多頭保護短線，套牢時較容易解套。',
          '停損參考：5日均線跌破為短線停損訊號。',
        ].join('\n'),
        ruleId: this.id,
      };
    }

    // 下跌期：頭頭低+底底低+在均線之下
    if (isDowntrend && !ranging && !aboveMA20) {
      return {
        type: 'SELL',
        label: '下跌期（空頭）',
        description: '頭頭低、底底低，均線空頭排列，股價在月線之下',
        reason: [
          '【循環階段④】下跌期（空頭走勢）：',
          '特徵：頭頭低、底底低，跌多漲少，均線空頭排列。',
          '朱家泓警示：「空頭走勢中做多，套牢時就難以解套。」',
          '操作策略：',
          '① 順著空頭趨勢放空，不要逆勢做多。',
          '② 反彈遇壓力再下跌時為放空賣點。',
          '③ 「反彈後下跌再空」為空頭最重要做空賣點。',
          '④ 若持有多單，應考慮減倉或停損。',
          '改變訊號：不再破新低就回升 = 空頭改變訊號，才可考慮轉多。',
        ].join('\n'),
        ruleId: this.id,
      };
    }

    // 打底期：空頭後橫盤 + 在低位 (ma60以下或接近)
    if (ranging && !aboveMA60) {
      const low20 = nLow(candles, index, 20);
      const fromLow = low20 > 0 ? (c.close - low20) / low20 : 0;
      if (fromLow < 0.15) {
        return {
          type: 'WATCH',
          label: '打底期（底部）',
          description: '空頭後進入橫向盤整，底部醞釀中',
          reason: [
            '【循環階段①】打底期（底部盤整）：',
            '特徵：股價止跌後開始橫向盤整，但均線仍空頭排列。',
            '操作：進入盤整可採「做或不做」兩種策略。',
            '若前波為空頭趨勢，盤整區以「高空低補」謹慎操作。',
            '等待反轉訊號：出現底底高 + 帶量長紅 + 突破前高 = 打底完成。',
            '打底型態參考：W底（最常見）、頭肩底、圓弧底、V形底。',
            '注意：未確認反轉前，勿貿然進場做多，打底可能變成跌破繼續下跌。',
          ].join('\n'),
          ruleId: this.id,
        };
      }
    }

    // 做頭期：多頭後橫盤 + 在高位
    if (ranging && aboveMA20) {
      const high20 = nHigh(candles, index, 20);
      const fromHigh = high20 > 0 ? (high20 - c.close) / high20 : 0;
      if (fromHigh < 0.1) {
        return {
          type: 'WATCH',
          label: '做頭期（頭部）',
          description: '多頭後進入橫向盤整，頭部形成中',
          reason: [
            '【循環階段③】做頭期（頭部盤整）：',
            '特徵：股價止漲後開始橫向盤整，但仍在均線之上。',
            '操作：進入盤整可採「做或不做」兩種策略。',
            '若前波為多頭趨勢，盤整區以「低接高出」操作。',
            '警示訊號（由多轉空觀察重點）：',
            '① 跌破上升切線。',
            '② 跌破前波低點，產生底底低。',
            '③ 反彈不過前頭高，產生頭頭低。',
            '頭部型態參考：M頭（最常見）、頭肩頂、圓弧頂。',
            '若出現盤整後跌破，趨勢轉為空頭，應立即減倉或停損。',
          ].join('\n'),
          ruleId: this.id,
        };
      }
    }

    return null;
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// 3. 位置風險評估（山頂/山腰/山谷）
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 看圖十字訣第6步：位置判斷
 *
 * 書中核心觀念：
 * 「選股要選位置在山谷（底部區）的，不要選位置在山頂（頭部區）的。
 *  底部區：風險最小、空間最大；頭部區：風險最大、空間最小。」
 */
export const positionRiskAssess: TradingRule = {
  id: 'zhu-position-risk',
  name: '進場位置風險評估',
  description: '判斷當前價格在近期波段的位置（山谷/山腰/山頂），評估風險報酬比',
  evaluate(candles, index): RuleSignal | null {
    if (index < 60) return null;
    const c = candles[index];
    // 用近60日範圍判斷相對位置
    const high60 = nHigh(candles, index, 60);
    const low60  = nLow(candles, index, 60);
    const range  = high60 - low60;
    if (range <= 0) return null;

    const position = (c.close - low60) / range; // 0=底部, 1=頂部

    if (position <= 0.3) {
      // 山谷 — 低風險，大空間
      return {
        type: 'WATCH',
        label: '山谷位置（低風險）',
        description: `股價位於近60日區間低部（位置${(position * 100).toFixed(0)}%），風險小、空間大`,
        reason: [
          '【看圖十字訣第6步】位置判斷：山谷（底部區）',
          `目前股價${c.close.toFixed(2)} 位於近60日高低區間低部 ${(position * 100).toFixed(0)}%。`,
          '特性：風險最小、獲利空間最大。',
          '書中建議：「位置在底部的股票，風險小，潛力大，是好的買進目標。」',
          `近60日最低點：${low60.toFixed(2)}，最高點：${high60.toFixed(2)}`,
          `若出現反轉訊號（帶量長紅、底底高），可積極考慮進場。`,
          '注意：低位不等於反轉，需配合波浪型態確認底部完成再進場。',
        ].join('\n'),
        ruleId: this.id,
      };
    }

    if (position >= 0.75) {
      // 山頂 — 高風險，小空間
      return {
        type: 'WATCH',
        label: '山頂位置（高風險）',
        description: `股價位於近60日區間高部（位置${(position * 100).toFixed(0)}%），風險大、空間小`,
        reason: [
          '【看圖十字訣第6步】位置判斷：山頂（頭部區）',
          `目前股價${c.close.toFixed(2)} 位於近60日高低區間高部 ${(position * 100).toFixed(0)}%。`,
          '特性：風險最大、獲利空間最小。',
          '書中警告：「位置在頭部的股票，追高就容易套牢。不要在山頂上買股票。」',
          `近60日最低點：${low60.toFixed(2)}，最高點：${high60.toFixed(2)}`,
          '操作建議：',
          '  ① 若持有多單，考慮設移動停損保護獲利。',
          '  ② 若計畫買進，需確認趨勢強勁（飆股噴出形態）才追，否則等回檔。',
          '  ③ 高位出現放量長黑或量縮不再創新高，為出場訊號。',
        ].join('\n'),
        ruleId: this.id,
      };
    }

    // 山腰 — 中等風險，需評估
    return {
      type: 'WATCH',
      label: '山腰位置（評估風險）',
      description: `股價位於近60日區間中段（位置${(position * 100).toFixed(0)}%），需評估趨勢方向`,
      reason: [
        '【看圖十字訣第6步】位置判斷：山腰（中段）',
        `目前股價${c.close.toFixed(2)} 位於近60日高低區間中段 ${(position * 100).toFixed(0)}%。`,
        '特性：風險報酬比居中，需配合趨勢方向操作。',
        `近60日最低點：${low60.toFixed(2)}，最高點：${high60.toFixed(2)}`,
        '操作建議：',
        '  ① 多頭趨勢中：可在回檔至支撐後進場，目標看高點。',
        '  ② 空頭趨勢中：可在反彈至壓力後放空，目標看低點。',
        '  ③ 盤整趨勢中：低接高出，或退出觀望等待方向確認。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// 4. 高檔巨量警示（書中核心口訣實作）
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 書中特別強調的「爆巨量後觀察法則」：
 * 爆巨量後2-3天若無更大量出現，要特別提高警覺
 */
export const postGiantVolumeWatch: TradingRule = {
  id: 'zhu-post-giant-vol',
  name: '巨量後縮量警戒',
  description: '爆巨量後2~3日內量能萎縮，可能是出貨或衰竭訊號',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const c = candles[index];
    if (c.avgVol5 == null || c.avgVol5 === 0) return null;

    // 近5日內是否有爆量（量比 >= 3x）
    let giantVolIdx = -1;
    for (let i = index - 3; i < index; i++) {
      if (i < 0) continue;
      const vr = candles[i].volume / (c.avgVol5 ?? 1);
      if (vr >= 3) { giantVolIdx = i; break; }
    }
    if (giantVolIdx < 0) return null;

    // 今日量比前巨量縮小（今日量 < 巨量日的 50%）
    const giantVol = candles[giantVolIdx].volume;
    if (c.volume > giantVol * 0.5) return null;

    // 今日量縮 (< 均量)
    if (c.volume >= c.avgVol5) return null;

    const daysAfter = index - giantVolIdx;
    const isHighPos = c.ma20 != null && c.close > c.ma20 * 1.1;
    const giantDay = candles[giantVolIdx];
    const giantWasRed = giantDay.close > giantDay.open;

    return {
      type: isHighPos ? 'SELL' : 'WATCH',
      label: `巨量後${daysAfter}日縮量（${isHighPos ? '高位警戒' : '觀察'})`,
      description: `${daysAfter}日前曾爆量${(giantVol / (c.avgVol5 ?? 1)).toFixed(1)}倍，今日量萎縮至均量${(c.volume / (c.avgVol5 ?? 1)).toFixed(1)}倍`,
      reason: [
        '【朱家泓《抓住飆股》爆巨量觀察法則】',
        `${daysAfter}日前出現爆巨量（${giantWasRed ? '紅K' : '黑K'}），今日成交量大幅萎縮。`,
        '書中法則：「爆巨量之後的2~3天，如果沒有出現更大的量，要特別提高警覺。」',
        giantWasRed
          ? '巨量日為紅K：可能是主力拉高出貨，後續需觀察能否續漲放量。'
          : '巨量日為黑K：可能是恐慌性賣壓，後續觀察是否止跌反彈。',
        isHighPos
          ? '目前位於高位（股價 > 月線+10%），巨量後縮量在高位是出貨的典型走法，宜提高警覺。'
          : '目前非高位，巨量後縮量可能是正常換手，持續觀察。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

// ── Phase 10：飆股 8 條件補齊 ──────────────────────────────────────────────

/**
 * 飆股條件3: 長期盤整（2月+）、左低右高、過頸線向上突破
 * 識別長期整理後的突破起漲
 */
export const surgeStockLongConsolidationBreak: TradingRule = {
  id: 'zhu-surge-long-consol-break',
  name: '飆股：長期盤整突破',
  description: '長期盤整(2月+)、左低右高、過頸線向上突破',
  evaluate(candles: CandleWithIndicators[], index: number) {
    if (index < 60) return null;
    const c = candles[index];

    // 紅K + 量能放大
    if (c.close <= c.open) return null;
    if (c.avgVol5 == null || c.volume < c.avgVol5 * 2.0) return null;

    // 前40根在窄幅盤整（高低振幅 < 15%）
    const lookback = candles.slice(Math.max(0, index - 40), index);
    const closes = lookback.map(x => x.close);
    const maxC = Math.max(...closes);
    const minC = Math.min(...closes);
    if (minC <= 0 || (maxC - minC) / minC > 0.15) return null;

    // 左低右高（後半最低 > 前半最低）
    const half = Math.floor(closes.length / 2);
    const leftLow = Math.min(...lookback.slice(0, half).map(x => x.low));
    const rightLow = Math.min(...lookback.slice(half).map(x => x.low));
    if (rightLow <= leftLow * 1.01) return null;

    // 突破盤整高點（頸線）
    if (c.close <= maxC) return null;

    return {
      type: 'BUY' as const,
      label: '飆股條件3',
      description: '長期盤整(40天)+左低右高+大量突破頸線',
      reason: '飆股條件3: 長期盤整(40天)+左低右高+大量突破頸線',
      ruleId: this.id,
    };
  },
};

/**
 * 飆股條件4: 雙重底大量突破 + 均線4線多排
 */
export const surgeStockDoubleBottomBreak: TradingRule = {
  id: 'zhu-surge-double-bottom',
  name: '飆股：雙底大量突破',
  description: '雙重底+大量突破+均線4線多排',
  evaluate(candles: CandleWithIndicators[], index: number) {
    if (index < 40) return null;
    const c = candles[index];

    // 紅K + 均線4線多排
    if (c.close <= c.open) return null;
    if (c.ma5 == null || c.ma10 == null || c.ma20 == null || c.ma60 == null) return null;
    if (!(c.ma5 > c.ma10 && c.ma10 > c.ma20 && c.ma20 > c.ma60)) return null;

    // 量能放大
    if (c.avgVol5 == null || c.volume < c.avgVol5 * 1.5) return null;

    // 找前30根的雙底
    const lookback = candles.slice(Math.max(0, index - 30), index);
    const lows = lookback.map(x => x.low);
    const globalLow = Math.min(...lows);
    if (globalLow <= 0) return null;

    const lowZones: number[] = [];
    for (let i = 0; i < lows.length; i++) {
      if (lows[i] <= globalLow * 1.03) {
        if (lowZones.length === 0 || i - lowZones[lowZones.length - 1] > 5) {
          lowZones.push(i);
        }
      }
    }
    if (lowZones.length < 2) return null;

    // 突破頸線
    const neckline = Math.max(
      ...lookback.slice(lowZones[0], lowZones[1]).map(x => x.high)
    );
    if (c.close <= neckline) return null;

    return {
      type: 'BUY' as const,
      label: '飆股條件4',
      description: '雙重底+均線4線多排+大量突破頸線',
      reason: '飆股條件4: 雙重底+均線4線多排+大量突破頸線',
      ruleId: this.id,
    };
  },
};

/**
 * 飆股條件5: 均線糾結 + 大量紅K上漲
 */
export const surgeStockMAClusterBreak: TradingRule = {
  id: 'zhu-surge-ma-cluster',
  name: '飆股：均線糾結突破',
  description: '均線糾結(MA5/10/20在2.5%內)後大量紅K突破',
  evaluate(candles: CandleWithIndicators[], index: number) {
    if (index < 20) return null;
    const c = candles[index];
    const prev = candles[index - 1];

    // 紅K + 大量
    if (c.close <= c.open) return null;
    if ((c.close - c.open) / c.open < 0.02) return null; // 實體 > 2%
    if (c.avgVol5 == null || c.volume < c.avgVol5 * 2.0) return null;

    // 前一根均線糾結（MA5/10/20 在 2.5% 範圍內）
    if (prev.ma5 == null || prev.ma10 == null || prev.ma20 == null) return null;
    const maxMA = Math.max(prev.ma5, prev.ma10, prev.ma20);
    const minMA = Math.min(prev.ma5, prev.ma10, prev.ma20);
    if (minMA <= 0 || (maxMA - minMA) / minMA > 0.025) return null;

    // 突破所有均線
    if (c.close <= maxMA) return null;

    return {
      type: 'BUY' as const,
      label: '飆股條件5',
      description: '均線糾結後大量紅K(>2%)突破',
      reason: '飆股條件5: 均線糾結後大量紅K(>2%)突破，起漲信號',
      ruleId: this.id,
    };
  },
};

/**
 * 飆股條件6: 大量紅K突破空頭長期下降切線，反彈站上月線
 */
export const surgeStockDowntrendBreak: TradingRule = {
  id: 'zhu-surge-downtrend-break',
  name: '飆股：突破下降切線站上月線',
  description: '大量紅K突破空頭長期下降切線，反彈站上月線',
  evaluate(candles: CandleWithIndicators[], index: number) {
    if (index < 30) return null;
    const c = candles[index];
    const prev = candles[index - 1];

    // 紅K + 大量
    if (c.close <= c.open) return null;
    if (c.avgVol5 == null || c.volume < c.avgVol5 * 1.5) return null;

    // 站上 MA20（前一根在下方）
    if (c.ma20 == null || prev.ma20 == null) return null;
    if (c.close <= c.ma20) return null;
    if (prev.close >= prev.ma20) return null; // 已經在上方不算

    // 前期有下降趨勢
    const prev20 = candles.slice(Math.max(0, index - 20), index);
    const firstHalfHigh = Math.max(...prev20.slice(0, 10).map(x => x.high));
    const secondHalfHigh = Math.max(...prev20.slice(10).map(x => x.high));
    if (firstHalfHigh <= secondHalfHigh) return null;

    return {
      type: 'BUY' as const,
      label: '飆股條件6',
      description: '大量紅K突破下降切線，站上月線',
      reason: '飆股條件6: 大量紅K突破下降切線，站上月線',
      ruleId: this.id,
    };
  },
};

// ── Phase 10：飆股 5 種量能判斷 ──────────────────────────────────────────

/**
 * 飆股技術操作規則1-3: 未破上升趨勢線/前2日低價/MA5 → 可續抱
 * 違反時 → 賣出警示
 */
export const surgeStockHoldOrSell: TradingRule = {
  id: 'zhu-surge-hold-or-sell',
  name: '飆股續抱/出場判斷',
  description: '未破前2日低/MA5/無黑K→續抱，2項以上違反→出場',
  evaluate(candles: CandleWithIndicators[], index: number) {
    if (index < 10) return null;
    const c = candles[index];

    // 先確認是在上漲趨勢中（至少 MA5 > MA20）
    if (c.ma5 == null || c.ma20 == null || c.ma5 <= c.ma20) return null;

    let violations = 0;
    const reasons: string[] = [];

    // 規則1: 破前2日低價
    const prev2Low = Math.min(candles[index - 1]?.low ?? Infinity, candles[index - 2]?.low ?? Infinity);
    if (c.close < prev2Low) { violations++; reasons.push('破前2日低'); }

    // 規則2: 破MA5（3日均線近似）
    if (c.ma5 != null && c.close < c.ma5) { violations++; reasons.push('破MA5'); }

    // 規則3: 出現黑K
    if (c.close < c.open) { violations++; reasons.push('出現黑K'); }

    // 2個以上條件違反 → 賣出
    if (violations >= 2) {
      return {
        type: 'SELL' as const,
        label: '飆股出場',
        description: `${reasons.join('+')}，${violations}項條件違反`,
        reason: `飆股出場: ${reasons.join('+')}，${violations}項條件違反`,
        ruleId: this.id,
      };
    }

    return null;
  },
};

/**
 * 飆股量能判斷5種：
 * 1. 攻擊量（> 2x 均量）+ 紅K = 續攻
 * 2. 巨量（> 3x 均量）= 可能出貨
 * 3. 量縮（< 0.7x 均量）+ 紅K = 籌碼惜售
 * 4. 量縮 + 黑K = 回檔休息
 * 5. 量增價平 = 主力換手
 */
export const surgeStockVolumeJudge: TradingRule = {
  id: 'zhu-surge-volume-5types',
  name: '飆股5種量能判斷',
  description: '攻擊量/巨量/縮量惜售/縮量回檔/量增換手 5種分類',
  evaluate(candles: CandleWithIndicators[], index: number) {
    if (index < 5) return null;
    const c = candles[index];
    const prev = candles[index - 1];
    if (c.avgVol5 == null || c.avgVol5 <= 0) return null;
    if (!prev || prev.close <= 0) return null;

    const volRatio = c.volume / c.avgVol5;
    const isRedK = c.close > c.open;
    // 用跨日漲跌幅（vs 前日收盤），不是日內 close-open；跳空場景才不會被當「價平」誤判
    const changePct = Math.abs(c.close - prev.close) / prev.close;

    // 1. 攻擊量 + 紅K
    if (volRatio >= 2.0 && volRatio < 3.0 && isRedK && changePct > 0.015) {
      return {
        type: 'WATCH' as const,
        label: '攻擊量',
        description: `攻擊量(${volRatio.toFixed(1)}x)+紅K → 續攻信號`,
        reason: `飆股量能: 攻擊量(${volRatio.toFixed(1)}x)+紅K → 續攻信號`,
        ruleId: this.id,
      };
    }

    // 2. 巨量（可能出貨）
    if (volRatio >= 3.0) {
      return {
        type: 'REDUCE' as const,
        label: '巨量警戒',
        description: `巨量(${volRatio.toFixed(1)}x) → 可能出貨`,
        reason: `飆股量能: 巨量(${volRatio.toFixed(1)}x) → 可能出貨，減碼觀察`,
        ruleId: this.id,
      };
    }

    // 3. 量縮 + 紅K = 惜售
    if (volRatio < 0.7 && isRedK) {
      return {
        type: 'WATCH' as const,
        label: '縮量惜售',
        description: `縮量(${volRatio.toFixed(1)}x)+紅K → 籌碼惜售`,
        reason: `飆股量能: 縮量(${volRatio.toFixed(1)}x)+紅K → 籌碼惜售，續抱`,
        ruleId: this.id,
      };
    }

    // 4. 量縮 + 黑K = 回檔
    if (volRatio < 0.7 && !isRedK) {
      return {
        type: 'WATCH' as const,
        label: '縮量回檔',
        description: `縮量(${volRatio.toFixed(1)}x)+黑K → 回檔休息`,
        reason: `飆股量能: 縮量(${volRatio.toFixed(1)}x)+黑K → 回檔休息，觀察`,
        ruleId: this.id,
      };
    }

    // 5. 量增價平 = 換手
    if (volRatio >= 1.5 && changePct < 0.005) {
      return {
        type: 'WATCH' as const,
        label: '量增換手',
        description: `量增(${volRatio.toFixed(1)}x)+價平 → 主力換手`,
        reason: `飆股量能: 量增(${volRatio.toFixed(1)}x)+價平 → 主力換手`,
        ruleId: this.id,
      };
    }

    return null;
  },
};

export const ZHU_SOAR_STOCK_RULES: TradingRule[] = [
  priceVolumeRelation,
  marketCycleStage,
  positionRiskAssess,
  postGiantVolumeWatch,
  // Phase 10 新增
  surgeStockLongConsolidationBreak,
  surgeStockDoubleBottomBreak,
  surgeStockMAClusterBreak,
  surgeStockDowntrendBreak,
  surgeStockHoldOrSell,
  surgeStockVolumeJudge,
];
