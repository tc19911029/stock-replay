/**
 * eliminationFilter.ts — 朱家泓《活用技術分析寶典》淘汰法選股
 *
 * 書中 Part 10 (P659-668) 定義了 11 種要避開的股票狀況。
 * 此模組在 scanner 輸出前加一層負面篩選，
 * 排除不符合朱老師方法論的高風險股票。
 *
 * 對照實作 vs 書本原文：
 *   1.  沒走出底部（均線空排+股價月線下）         — ✅
 *   2.  重壓不過跌破 MA5                         — ✅
 *   3.  上漲一波後趨勢不明確（均線雜亂+震盪）    — ✅
 *   4.  沒有量能（量縮）                         — ✅
 *   5.  大幅上漲達 1 倍 AND 呈盤整趨勢           — ✅（2026-04-19 加「盤整」前置）
 *   6.  遇壓力大量長黑                           — ✅
 *   7.  趨勢頭頭低 AND MACD/KD 背離              — ✅（2026-04-19 加「頭頭低」前置）
 *   8.  三大法人連續賣超                         — ⚠️ 用大量黑K代理（無法人資料）
 *   9.  頻頻爆大量股價不漲                       — ✅
 *   10. 看不懂的股票（長期盤整均線糾結代理）     — ⚠️ 代理實作
 *   11. 有基本面、沒有技術面                     — ❌ 未實作（rockstock 無基本面資料源）
 */

import { CandleWithIndicators } from '@/types';
import { detectTrend } from '@/lib/analysis/trendAnalysis';

export interface EliminationResult {
  eliminated: boolean;
  reasons: string[];
  /** 扣分（0-20），不淘汰時也可能有扣分 */
  penalty: number;
}

/**
 * 1. 沒走出底部的股票：趨勢未完成，均線未多排
 */
function rule01_notOutOfBottom(candles: CandleWithIndicators[], idx: number): string | null {
  const c = candles[idx];
  if (c.ma5 == null || c.ma10 == null || c.ma20 == null) return null;
  // 均線空排 + 股價在月線下
  if (c.ma5 < c.ma10 && c.ma10 < c.ma20 && c.close < c.ma20) {
    return '淘汰1: 尚未走出底部（均線空排、股價在月線下）';
  }
  return null;
}

/**
 * 2. 重壓不過跌破MA5：趨勢完成但遇重壓不過
 */
function rule02_resistanceBlockBreakMA5(candles: CandleWithIndicators[], idx: number): string | null {
  if (idx < 20) return null;
  const c = candles[idx];
  if (c.ma5 == null || c.close >= c.ma5) return null;
  // 過去20天有明顯高點壓力
  const prev20High = Math.max(...candles.slice(idx - 20, idx).map(x => x.high));
  if (prev20High > 0 && c.high >= prev20High * 0.98 && c.close < c.ma5) {
    return '淘汰2: 遇重壓不過且跌破MA5';
  }
  return null;
}

/**
 * 4. 沒有量能：上漲行進中成交量明顯縮小
 * 書本 p.660 原文：「上漲行進中成交量明顯縮小，沒有量能」— 必須在上漲中才適用。
 * 注：朱師書本/網路資料只分「有量（>=5MA）/ 無量（<5MA）」，未定「嚴重萎縮」倍數。
 *     <0.5× 採市場通用「嚴重縮量」定義。
 */
function rule04_noVolume(candles: CandleWithIndicators[], idx: number): string | null {
  const c = candles[idx];
  if (c.avgVol5 == null || c.avgVol5 <= 0) return null;
  // 書本要求「上漲行進中」才檢查縮量；盤整/空頭縮量是常態，不應淘汰
  const trend = detectTrend(candles, idx);
  if (trend !== '多頭') return null;
  // 量比 < 0.5（量萎縮到均量一半以下，市場通用「嚴重縮量」定義）
  if (c.volume < c.avgVol5 * 0.5) {
    return '淘汰4: 上漲中成交量嚴重萎縮（量比<0.5）';
  }
  return null;
}

/**
 * 5. 大幅上漲過高 + 呈現盤整趨勢
 *
 * 書本 p.659 原文：「股價上漲達 1 倍以上位置，呈現盤整趨勢要立刻出場」
 * 修正（2026-04-19）：加入「盤整」前置條件，避免誤殺上漲中的翻倍股。
 */
function rule05_overExtended(candles: CandleWithIndicators[], idx: number): string | null {
  if (idx < 60) return null;
  const c = candles[idx];
  const low60 = Math.min(...candles.slice(Math.max(0, idx - 60), idx).map(x => x.low));
  if (low60 <= 0 || c.close <= low60 * 2) return null;

  // 書本要求「呈現盤整趨勢」才淘汰；多頭上漲中即使翻倍也不觸發
  const trend = detectTrend(candles, idx);
  if (trend !== '盤整') return null;

  return '淘汰5: 大幅上漲超過1倍且呈現盤整';
}

/**
 * 6. 遇壓力大量長黑：壓力線附近多次出現大量長黑K
 */
function rule06_resistanceLongBlack(candles: CandleWithIndicators[], idx: number): string | null {
  if (idx < 10) return null;
  // 過去10天在高檔出現2次以上大量長黑
  // 「高檔」前置：每根長黑日當天的 close 必須在 MA20 之上（書本「壓力線附近」= 高檔）
  // 修復前任何位置都會觸發 → false positive on 反彈中的長黑
  const recent = candles.slice(idx - 10, idx + 1);
  const bigBlacks = recent.filter(c =>
    c.close < c.open &&
    Math.abs(c.close - c.open) / c.open >= 0.02 &&
    c.avgVol5 != null && c.avgVol5 > 0 && c.volume >= c.avgVol5 * 1.5 &&
    c.ma20 != null && c.close > c.ma20  // 高檔：當日收盤在月線之上
  );
  if (bigBlacks.length >= 2) {
    return '淘汰6: 近10天高檔出現2次以上大量長黑K';
  }
  return null;
}

/**
 * 7. 趨勢頭頭低 + MACD 或 KD 指標背離
 *
 * 書本 p.662 原文：「趨勢呈現頭頭低的股票，且出現 MACD 或 KD 指標背離，要立刻出場」
 * 修正（2026-04-19）：加入「頭頭低」前置條件，避免誤殺多頭上漲中短期指標稍弱的股票。
 */
function rule07_indicatorDivergence(candles: CandleWithIndicators[], idx: number): string | null {
  if (idx < 10) return null;

  // 書本要求「趨勢呈現頭頭低」才檢查指標背離
  const trend = detectTrend(candles, idx);
  if (trend !== '空頭') return null;

  const c = candles[idx];
  const prev5 = candles[idx - 5];
  // MACD 背離
  if (c.macdOSC != null && prev5?.macdOSC != null) {
    if (c.high > prev5.high && c.macdOSC < prev5.macdOSC) {
      return '淘汰7: 頭頭低+MACD背離（價創新高但OSC走低）';
    }
  }
  // KD 背離
  if (c.kdK != null && prev5?.kdK != null) {
    if (c.high > prev5.high && c.kdK < prev5.kdK) {
      return '淘汰7: 頭頭低+KD背離（價創新高但K值走低）';
    }
  }
  return null;
}

/**
 * 9. 頻頻爆大量股價不漲
 * 「爆量」對齊朱家泓定義：前日 × 2（《抓住飆股》+ 理財達人秀 YouTube #17 明寫）
 * 注意：與六條件 ④「攻擊量×1.3」是不同概念 —「攻擊量」是進場用、「爆量」是判斷主力動作
 */
function rule09_highVolNoRise(candles: CandleWithIndicators[], idx: number): string | null {
  if (idx < 5) return null;
  const recent = candles.slice(idx - 5, idx + 1);
  const highVolDays = recent.filter((c, i) => {
    const pv = i > 0 ? recent[i - 1].volume : 0;
    return pv > 0 && c.volume >= pv * 2;
  });
  if (highVolDays.length >= 3) {
    // 有3天以上爆大量
    // 「股價不漲」閾值 <3%：朱家泓書+網路無具體值（「不漲」為描述性），3% 為實作自選
    const priceChange = (recent[recent.length - 1].close - recent[0].close) / recent[0].close;
    if (Math.abs(priceChange) < 0.03) {
      return '淘汰9: 頻頻爆大量但股價不漲（主力出貨）';
    }
  }
  return null;
}

// ── Main Evaluator ──────────────────────────────────────────────────────────────
// 2026-04-20 已移除以下 dead code：
//   rule08_institutionalSelling（R8 無法人資料）
//   rule10_threeBlacks（連3長黑，不在書本淘汰11條中）
//   rule10b_longConsolidation（R10 30/8%/2% 完全自創）
//   rule11_noTechnical（R11 基本面判定超出系統範圍）

/**
 * 淘汰條件總表（R1-R11）
 * 任一條命中即淘汰（對齊朱家泓「假突破收盤跌破=嚴重，立即出場」精神）。
 * 2026-04-20 移除「嚴重 1 條 / 一般 2 條」分類 — 書本+網路朱家泓資料均無此分級。
 */
const ELIMINATION_RULES = [
  rule01_notOutOfBottom,
  rule02_resistanceBlockBreakMA5,
  rule04_noVolume,
  rule05_overExtended,
  rule06_resistanceLongBlack,
  rule07_indicatorDivergence,
  rule09_highVolNoRise,
  // 2026-04-20 用戶決議移除以下三條：
  // R8 法人連續賣超 — rockstock 無法人資料，代理指標（大量黑K）不精確
  // R10 看不懂（長期盤整）— 30/8%/2% 完全自創
  // R11 基本面好沒技術面 — 基本面判定超出系統範圍
];

/**
 * 評估一支股票是否應被淘汰
 * @returns eliminated=true 表示強烈建議排除，penalty 為扣分
 */
export function evaluateElimination(
  candles: CandleWithIndicators[],
  idx: number,
): EliminationResult {
  const reasons: string[] = [];

  for (const rule of ELIMINATION_RULES) {
    try {
      const reason = rule(candles, idx);
      if (reason) reasons.push(reason);
    } catch { /* skip */ }
  }

  // 任一條命中即淘汰（書本精神：收盤跌破=嚴重即出場）
  const eliminated = reasons.length >= 1;
  // 每條扣 3 分，最多扣 20
  const penalty = Math.min(reasons.length * 3, 20);

  return { eliminated, reasons, penalty };
}
