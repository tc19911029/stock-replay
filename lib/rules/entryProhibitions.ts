/**
 * 朱家泓進場10大戒律（做多 + 做空）
 * 來源：《活用技術分析寶典》p.54（做多）、p.82-85（做空）
 * 《做對5個實戰步驟》兩書一致確認
 *
 * 設計原則：
 * - 這些是硬性禁忌，任何一條觸發即不進場
 * - 與排序因子（surgeScore、compositeScore 等）完全獨立
 * - 由 MarketScanner 在六條件 SOP 通過後調用
 */

import type { CandleWithIndicators } from '@/types';
import { isNearWeeklyResistance } from '@/lib/analysis/multiTimeframeFilter';

export interface ProhibitionResult {
  prohibited: boolean;
  reasons: string[]; // 觸發的戒律說明
}

export interface ProhibitionContext {
  /** 最近 N 日三大法人淨買賣股數（由新到舊），caller pre-fetch 後傳入 */
  institutionalHistory?: Array<{ date: string; netShares: number }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 做多10大戒律
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 檢查做多進場10大戒律
 * 注意：以下戒律已由其他地方處理，此函數不重複檢查：
 *   - 戒律1（未突破月線勿做多）→ 六條件SOP條件#2/#3已要求 close > MA20
 *   - 戒律5（回檔跌破月線再上漲未過月線）→ 同上
 *   - 戒律8（空頭反彈）→ MarketScanner trend === '空頭' 已排除
 *   - 戒律10（黑K不進場）→ MarketScanner close > open 已排除
 */
export function checkLongProhibitions(
  candles: CandleWithIndicators[],
  index: number,
  ctx?: ProhibitionContext,
): ProhibitionResult {
  const reasons: string[] = [];

  if (index < 5) return { prohibited: false, reasons };

  const last = candles[index];

  // ── 戒律 8：三大法人連續賣超（書本 Part 10 p.661）──────────────────
  // 近 3 日三大法人皆明顯淨賣超（> 5 張/日）→ 主力出貨跡象，禁入
  // 書本沒明寫門檻，此處以 5 張（5000 股）為「有意義的賣超」，避免雜訊誤殺
  if (ctx?.institutionalHistory && ctx.institutionalHistory.length >= 3) {
    const MIN_MEANINGFUL_SHARES = -50_000;  // 每日淨賣 ≤ -50 張（50,000 股）才算，避免雜訊
    const recent3 = ctx.institutionalHistory.slice(0, 3);
    if (recent3.every(d => d.netShares < MIN_MEANINGFUL_SHARES)) {
      const avgSell = Math.round(recent3.reduce((a, d) => a + d.netShares, 0) / 3);
      reasons.push(`戒律8：三大法人近3日連續賣超（平均${avgSell.toLocaleString()}股/日）`);
    }
  }

  // ── 戒律2：上漲第3根以上位置，勿追高做多 ──────────────────────────────
  // 邏輯：連續3根以上收紅K（上漲）→ 已追高
  {
    let consecutiveUp = 0;
    for (let i = index; i >= Math.max(0, index - 4); i--) {
      if (candles[i].close > candles[i].open) {
        consecutiveUp++;
      } else {
        break;
      }
    }
    if (consecutiveUp >= 3) {
      reasons.push('戒律2：連續3根以上紅K，勿追高做多');
    }
  }

  // ── 戒律3：量價背離 + KD高檔 + 乖離過大，同時成立勿進場 ───────────────
  // 三個條件都成立才觸發（書上說「搭配」，即同時出現）
  {
    const kd = last.kdK;
    const ma20 = last.ma20;
    const deviation = ma20 && ma20 > 0
      ? (last.close - ma20) / ma20
      : 0;

    // 量價背離：近3日漲幅 > 5% 但今日成交量 < 昨日（上漲縮量）
    const prev = candles[index - 1];
    const bar3Ago = index >= 3 ? candles[index - 3] : null;
    const recentGain = bar3Ago && bar3Ago.close > 0
      ? (last.close - bar3Ago.close) / bar3Ago.close
      : 0;
    const volumeDivergence = recentGain > 0.05 && last.volume < prev.volume;

    // KD高檔：K值 > 80
    const kdHigh = kd != null && kd > 80;

    // 乖離過大：距MA20 > 12%
    const deviationLarge = deviation > 0.12;

    if (volumeDivergence && kdHigh && deviationLarge) {
      reasons.push('戒律3：量價背離+KD高檔+乖離過大同時成立，勿進場做多');
    }
  }

  // ── 戒律4：週線遇壓力前，勿進場做多 ─────────────────────────────────
  // 書本：聚合日K為週K → 找週K前波高點 → 今日收盤接近即為壓力區
  {
    const segment = candles.slice(0, index + 1);
    const { near, detail } = isNearWeeklyResistance(segment);
    if (near) {
      reasons.push(`戒律4：${detail ?? '接近週線前高壓力區'}，勿追多`);
    }
  }

  // ── 戒律6：回檔跌破前低，再上漲勿進場做多 ───────────────────────────
  // 邏輯：若近20根K棒中，最近的轉折低點（波谷）低於更早的轉折低點
  //       代表多頭結構可能轉弱，此波上漲不宜進場
  // 注意：用 close 判斷波谷（與 findPivots 一致，朱老師用收盤價判斷頭底）
  {
    const lookback = Math.min(20, index);
    const segment = candles.slice(index - lookback, index + 1);

    // 找近期兩個波谷（3點局部低點，用收盤價）
    const troughs: number[] = [];
    for (let i = 1; i < segment.length - 1; i++) {
      if (segment[i].close < segment[i - 1].close && segment[i].close < segment[i + 1].close) {
        troughs.push(segment[i].close);
      }
    }

    // 若有至少2個波谷，且最近的波谷低於較早的波谷 → 底底低，勿做多
    if (troughs.length >= 2) {
      const latestTrough = troughs[troughs.length - 1];
      const earlierTrough = troughs[troughs.length - 2];
      if (latestTrough < earlierTrough * 0.99) { // 允許1%誤差
        reasons.push('戒律6：回檔底底低（跌破前低），再上漲勿進場做多');
      }
    }
  }

  // ── 戒律7：盤整區內勿進場做多（書本 p.87 明寫 <15%）───────────────────
  // 邏輯：近10根K棒的高低點範圍 < 15%，且今日未突破此範圍
  {
    const lookback = Math.min(10, index - 1);
    const segment = candles.slice(index - lookback, index); // 不含今日
    if (segment.length >= 5) {
      const segHigh = Math.max(...segment.map(c => c.high));
      const segLow = Math.min(...segment.map(c => c.low));
      const rangeWidth = segLow > 0 ? (segHigh - segLow) / segLow : 1;

      // 盤整：區間幅度 < 15%（書本 p.87），且今日收盤未突破此盤整高點
      if (rangeWidth < 0.15 && last.close <= segHigh * 1.005) {
        reasons.push(`戒律7：股價在盤整區內（近10根K棒波動${(rangeWidth*100).toFixed(1)}%<15%），勿進場做多`);
      }
    }
  }

  // 註：MA20 乖離 >12% 書本 p.568 原文是「盡量避免追高」— 警示建議，不是硬 gate
  // 已移至 evaluateSixConditions positionDetail 作為 ⚠️ tag 顯示，不擋選股
  // 戒律 3（量背離+KD高檔+乖離 三合一）仍保留做為硬性禁入（書本 p.57 明寫）

  // 註：末升段暴大量黑K（書本 p.533 量價 13 條 #8(4)）是「持有中的出場警示」
  // 而非進場 gate（書本原文「容易急跌」是機率性表述）。
  // 該訊號已由「戒律 9：連續急漲大量長紅K 勿追高」+ 長黑吞噬出場 涵蓋，
  // 此處不獨立設 gate 避免 overreach（2026-04-19 用戶指出 MA20 乖離後發現同類錯誤）。

  // ── 戒律9：連續急漲的大量長紅K高檔，勿進場做多 ─────────────────────
  // 邏輯：近3根K棒都是大量（>前5日均量1.5倍）長紅K（實體>2%）
  {
    const lookback = 3;
    if (index >= lookback + 5) {
      let bigRedCount = 0;
      for (let i = index - lookback + 1; i <= index; i++) {
        const c = candles[i];
        const bodyPct = c.open > 0 ? (c.close - c.open) / c.open : 0;
        const avg5Vol = c.avgVol5 ?? 0;
        const isLargeRedCandle = bodyPct >= 0.02 && c.close > c.open;
        const isHighVolume = avg5Vol > 0 && c.volume > avg5Vol * 1.5;
        if (isLargeRedCandle && isHighVolume) bigRedCount++;
      }
      if (bigRedCount >= 3) {
        reasons.push('戒律9：連續急漲大量長紅K（3根以上），勿追高做多');
      }
    }
  }

  return {
    prohibited: reasons.length > 0,
    reasons,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 做空10大戒律
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 檢查做空進場10大戒律
 * 注意：以下戒律已由其他地方處理，此函數不重複檢查：
 *   - 戒律1（未跌破月線勿做空）→ 做空六條件SOP已要求 close < MA20
 *   - 戒律5（反彈突破月線再跌未破月線）→ 同上
 *   - 戒律8（多頭回檔）→ ShortScanner 只在空頭趨勢中操作
 *   - 戒律10（紅K不進場做空）→ 做空六條件SOP已要求 close < open
 */
export function checkShortProhibitions(
  candles: CandleWithIndicators[],
  index: number,
): ProhibitionResult {
  const reasons: string[] = [];

  if (index < 5) return { prohibited: false, reasons };

  const last = candles[index];

  // ── 戒律2：連續下跌第3根以上，勿殺低做空 ────────────────────────────
  {
    let consecutiveDown = 0;
    for (let i = index; i >= Math.max(0, index - 4); i--) {
      if (candles[i].close < candles[i].open) {
        consecutiveDown++;
      } else {
        break;
      }
    }
    if (consecutiveDown >= 3) {
      reasons.push('戒律2：連續3根以上黑K，勿殺低做空');
    }
  }

  // ── 戒律3：量價背離 + KD低檔 + 乖離過大，同時成立勿做空 ─────────────
  {
    const kd = last.kdK;
    const ma20 = last.ma20;
    const deviation = ma20 && ma20 > 0
      ? (last.close - ma20) / ma20
      : 0;

    // 量價背離（空頭）：近3日跌幅 > 5% 但今日成交量 < 昨日（下跌縮量=拋壓減輕）
    const prev = candles[index - 1];
    const bar3Ago = index >= 3 ? candles[index - 3] : null;
    const recentLoss = bar3Ago && bar3Ago.close > 0
      ? (bar3Ago.close - last.close) / bar3Ago.close
      : 0;
    const volumeDivergence = recentLoss > 0.05 && last.volume < prev.volume;

    // KD低檔：K值 < 20
    const kdLow = kd != null && kd < 20;

    // 乖離過大（做空）：距MA20 < -12%（跌太多）
    const deviationLarge = deviation < -0.12;

    if (volumeDivergence && kdLow && deviationLarge) {
      reasons.push('戒律3：量價背離+KD低檔+乖離過大同時成立，勿進場做空');
    }
  }

  // ── 戒律4：週線遇支撐前，勿進場做空 ─────────────────────────────────
  // 簡化：若收盤距近60根K棒低點在3%以內 → 即將遇支撐
  {
    const lookback = Math.min(60, index);
    const recentLows = candles.slice(index - lookback, index).map(c => c.low);
    const period60Low = Math.min(...recentLows);
    if (period60Low > 0 && last.close > 0) {
      const distanceToBottom = (last.close - period60Low) / last.close;
      if (distanceToBottom >= 0 && distanceToBottom < 0.03) {
        reasons.push('戒律4：接近近60根K棒低點（週線支撐區），距低點<3%，勿追空');
      }
    }
  }

  // ── 戒律6：反彈突破前高再下跌，勿進場做空 ───────────────────────────
  // 邏輯：若近20根K棒中最新波峰高於較早波峰 → 頭頭高，做空條件不成立
  {
    const lookback = Math.min(20, index);
    const segment = candles.slice(index - lookback, index + 1);

    const peaks: number[] = [];
    for (let i = 1; i < segment.length - 1; i++) {
      if (segment[i].high > segment[i - 1].high && segment[i].high > segment[i + 1].high) {
        peaks.push(segment[i].high);
      }
    }

    if (peaks.length >= 2) {
      const latestPeak = peaks[peaks.length - 1];
      const earlierPeak = peaks[peaks.length - 2];
      if (latestPeak > earlierPeak * 1.01) {
        reasons.push('戒律6：反彈突破前高（頭頭高），勿進場做空');
      }
    }
  }

  // ── 戒律7：盤整區內勿進場做空 ────────────────────────────────────────
  {
    const lookback = Math.min(10, index - 1);
    const segment = candles.slice(index - lookback, index);
    if (segment.length >= 5) {
      const segHigh = Math.max(...segment.map(c => c.high));
      const segLow = Math.min(...segment.map(c => c.low));
      const rangeWidth = segLow > 0 ? (segHigh - segLow) / segLow : 1;

      if (rangeWidth < 0.05 && last.close >= segLow * 0.995) {
        reasons.push('戒律7：股價在盤整區內（近10根K棒波動<5%），勿進場做空');
      }
    }
  }

  // ── 戒律9：連續急跌的大量長黑K低檔，勿進場做空 ─────────────────────
  {
    const lookback = 3;
    if (index >= lookback + 5) {
      let bigBlackCount = 0;
      for (let i = index - lookback + 1; i <= index; i++) {
        const c = candles[i];
        const bodyPct = c.open > 0 ? (c.open - c.close) / c.open : 0;
        const avg5Vol = c.avgVol5 ?? 0;
        const isLargeBlackCandle = bodyPct >= 0.02 && c.close < c.open;
        const isHighVolume = avg5Vol > 0 && c.volume > avg5Vol * 1.5;
        if (isLargeBlackCandle && isHighVolume) bigBlackCount++;
      }
      if (bigBlackCount >= 3) {
        reasons.push('戒律9：連續急跌大量長黑K（3根以上），勿殺低做空');
      }
    }
  }

  return {
    prohibited: reasons.length > 0,
    reasons,
  };
}
