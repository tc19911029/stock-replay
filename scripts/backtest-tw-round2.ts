/**
 * 台股策略回測 Round 2 — 尋找更好的策略
 *
 * 策略5: Larry Williams ATR波動性突破 — 當日波幅超過ATR×0.6就追進
 * 策略6: 追勢戰法 — 抓第一波飆漲後回檔再起的第二波
 * 策略7: RSI超賣反彈 — RSI<30 + 反轉K棒（vs V反轉用MA20偏離）
 * 策略8: Turtle 20日突破 — 經典海龜突破 + ATR追蹤止損
 * 策略9: KD低檔黃金交叉 — KD<25 在多頭趨勢中買低
 *
 * + 改良版V反轉 & 改良版雙均線（加額外過濾器）
 *
 * Usage: npx tsx scripts/backtest-tw-round2.ts
 */

import fs from 'fs';
import path from 'path';
import { computeIndicators } from '@/lib/indicators';
import type { CandleWithIndicators } from '@/types';

const BACKTEST_START = '2023-07-01';
const BACKTEST_END   = '2026-03-31';
const INITIAL_CAPITAL = 1000000;
const ROUND_TRIP_COST = 0.44;

const cacheFile = path.join(process.cwd(), 'data', 'backtest-candles.json');

interface Trade {
  strategy: string;
  entryDate: string; exitDate: string;
  symbol: string; name: string;
  entryPrice: number; exitPrice: number;
  grossReturn: number; netReturn: number;
  holdDays: number; exitReason: string;
}

// ══════════════════════════════════════════════════════════════
// 策略5: Larry Williams ATR 波動性突破
// 原理: 當日(close-open)幅度超過前日ATR×0.6 = 動能啟動
// 加趨勢過濾: close > MA20（順勢操作）
// ══════════════════════════════════════════════════════════════

function scanATRBreakout(candles: CandleWithIndicators[], idx: number): boolean {
  if (idx < 2) return false;
  const today = candles[idx];
  const yesterday = candles[idx - 1];

  if (yesterday.atr14 == null || today.ma20 == null || today.avgVol5 == null) return false;

  // 核心: 當日漲幅 > ATR × 0.6
  const dailyMove = today.close - today.open;
  if (dailyMove <= 0) return false; // 必須是紅K
  if (dailyMove < yesterday.atr14 * 0.6) return false;

  // 趨勢過濾: 在MA20上方
  if (today.close <= today.ma20) return false;

  // MA20 上升
  if (idx >= 5 && candles[idx - 5].ma20 != null) {
    if (today.ma20! <= candles[idx - 5].ma20!) return false;
  }

  // 量能確認
  if (today.volume < today.avgVol5 * 0.8) return false;

  // 收在K棒上半
  const range = today.high - today.low;
  if (range > 0 && (today.close - today.low) / range < 0.6) return false;

  return true;
}

function exitATRBreakout(
  candles: CandleWithIndicators[], entryIdx: number, entryPrice: number,
): { exitIdx: number; exitPrice: number; exitReason: string } | null {
  // ATR追蹤止損: 2×ATR
  const entryATR = candles[entryIdx].atr14 ?? entryPrice * 0.03;
  const atrStop = entryATR * 2;
  let trailHigh = entryPrice;

  for (let d = 1; d <= 10; d++) {
    const fi = entryIdx + d;
    if (fi >= candles.length) return null;
    const c = candles[fi];

    trailHigh = Math.max(trailHigh, c.high);

    // 停利 +10%
    if (c.high >= entryPrice * 1.10) {
      return { exitIdx: fi, exitPrice: +(entryPrice * 1.10).toFixed(2), exitReason: '停利+10%' };
    }

    // ATR追蹤止損
    if (c.low <= trailHigh - atrStop) {
      const exitP = Math.max(c.open, trailHigh - atrStop);
      return { exitIdx: fi, exitPrice: +exitP.toFixed(2), exitReason: 'ATR追蹤止損' };
    }

    // 固定停損 -5%
    if (c.low <= entryPrice * 0.95) {
      return { exitIdx: fi, exitPrice: +(entryPrice * 0.95).toFixed(2), exitReason: '停損-5%' };
    }

    if (d === 10) {
      return { exitIdx: fi, exitPrice: c.close, exitReason: '持有10天' };
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════════
// 策略6: 追勢戰法 — 第一波漲>15%後回檔，第二波起漲時進場
// ══════════════════════════════════════════════════════════════

function scanMomentumContinuation(candles: CandleWithIndicators[], idx: number): boolean {
  if (idx < 30) return false;
  const today = candles[idx];
  if (today.ma20 == null || today.ma10 == null || today.avgVol5 == null) return false;

  // 找過去30天內的第一波: 上漲≥15%的波段
  let waveStart = -1, waveEnd = -1, waveGain = 0;
  for (let i = idx - 5; i >= Math.max(1, idx - 30); i--) {
    // 找局部高點（確保 i-1 和 i+1 都有效）
    if (i <= 0 || i + 1 >= candles.length) continue;
    if (candles[i].high > candles[i - 1].high && candles[i].high > candles[i + 1].high) {
      // 往回找低點
      for (let j = i - 1; j >= Math.max(1, i - 20); j--) {
        if (candles[j].low < candles[j + 1].low) {
          const gain = (candles[i].high - candles[j].low) / candles[j].low * 100;
          if (gain >= 15) {
            waveStart = j; waveEnd = i; waveGain = gain;
            break;
          }
        }
        if (j > 1 && candles[j].low > candles[j - 1].low) continue;
        break;
      }
      if (waveEnd > 0) break;
    }
  }
  if (waveEnd < 0) return false;

  // 從高點回檔: 回檔幅度 30-70%（Fibonacci）
  const waveHigh = candles[waveEnd].high;
  const waveLow = candles[waveStart].low;
  const pullbackLow = Math.min(...candles.slice(waveEnd, idx).map(c => c.low));
  const retracement = (waveHigh - pullbackLow) / (waveHigh - waveLow);
  if (retracement < 0.25 || retracement > 0.75) return false;

  // 回檔沒有破前低
  if (pullbackLow < waveLow) return false;

  // 今日紅K突破回檔高點
  const pullbackHigh = Math.max(...candles.slice(waveEnd + 1, idx).map(c => c.high));
  if (today.close <= pullbackHigh) return false;

  // 紅K確認
  if (today.close <= today.open) return false;
  const bodyPct = (today.close - today.open) / today.open * 100;
  if (bodyPct < 2) return false;

  // 量能
  if (today.volume < today.avgVol5 * 1.2) return false;

  return true;
}

function exitMomentumContinuation(
  candles: CandleWithIndicators[], entryIdx: number, entryPrice: number, signalIdx: number,
): { exitIdx: number; exitPrice: number; exitReason: string } | null {
  for (let d = 1; d <= 15; d++) {
    const fi = entryIdx + d;
    if (fi >= candles.length) return null;
    const c = candles[fi];

    // 停利 +15%（追勢戰法目標大）
    if (c.high >= entryPrice * 1.15) {
      return { exitIdx: fi, exitPrice: +(entryPrice * 1.15).toFixed(2), exitReason: '停利+15%' };
    }

    // 停損 -7%（進場K棒低點）
    if (c.low <= entryPrice * 0.93) {
      return { exitIdx: fi, exitPrice: +(entryPrice * 0.93).toFixed(2), exitReason: '停損-7%' };
    }

    // 跌破 MA5（持有3天後）
    if (d >= 3 && c.ma5 != null && c.close < c.ma5) {
      return { exitIdx: fi, exitPrice: c.close, exitReason: '破MA5' };
    }

    if (d === 15) {
      return { exitIdx: fi, exitPrice: c.close, exitReason: '持有15天' };
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════════
// 策略7: RSI超賣反彈 — RSI<30 + 反轉K棒
// 和V反轉不同: 用RSI而非MA偏離，更敏感
// ══════════════════════════════════════════════════════════════

function scanRSIOversold(candles: CandleWithIndicators[], idx: number): boolean {
  if (idx < 2) return false;
  const today = candles[idx];
  const yesterday = candles[idx - 1];

  if (today.rsi14 == null || yesterday.rsi14 == null || today.avgVol5 == null) return false;

  // RSI < 30（超賣）
  if (yesterday.rsi14 >= 30) return false;

  // 今日RSI開始回升
  if (today.rsi14 <= yesterday.rsi14) return false;

  // 反轉K棒: 紅K 或 長下影線
  const range = today.high - today.low;
  if (range <= 0) return false;

  const isRedK = today.close > today.open;
  const longLowerShadow = (Math.min(today.open, today.close) - today.low) / range > 0.5;
  if (!isRedK && !longLowerShadow) return false;

  // 收在K棒中間以上
  if ((today.close - today.low) / range < 0.4) return false;

  // 量能不能太低
  if (today.volume < today.avgVol5 * 0.8) return false;

  // 安全: MA60存在且20天前上升（不是長期空頭）
  if (today.ma60 != null && idx >= 20) {
    const ma60_20ago = candles[idx - 20].ma60;
    if (ma60_20ago != null && today.ma60 < ma60_20ago * 0.95) return false;
  }

  return true;
}

function exitRSIOversold(
  candles: CandleWithIndicators[], entryIdx: number, entryPrice: number,
): { exitIdx: number; exitPrice: number; exitReason: string } | null {
  for (let d = 1; d <= 7; d++) {
    const fi = entryIdx + d;
    if (fi >= candles.length) return null;
    const c = candles[fi];

    // 停利 +8%
    if (c.high >= entryPrice * 1.08) {
      return { exitIdx: fi, exitPrice: +(entryPrice * 1.08).toFixed(2), exitReason: '停利+8%' };
    }

    // 停損 -5%
    if (c.low <= entryPrice * 0.95) {
      return { exitIdx: fi, exitPrice: +(entryPrice * 0.95).toFixed(2), exitReason: '停損-5%' };
    }

    // RSI回到50以上就出場（均值回歸完成）
    if (c.rsi14 != null && c.rsi14 >= 50) {
      return { exitIdx: fi, exitPrice: c.close, exitReason: 'RSI≥50' };
    }

    if (d === 7) {
      return { exitIdx: fi, exitPrice: c.close, exitReason: '持有7天' };
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════════
// 策略8: Turtle 20日突破
// 經典海龜: 突破20日高點 + ATR追蹤止損
// ══════════════════════════════════════════════════════════════

function scanTurtleBreakout(candles: CandleWithIndicators[], idx: number): boolean {
  if (idx < 21) return false;
  const today = candles[idx];

  if (today.atr14 == null || today.ma20 == null || today.avgVol5 == null) return false;

  // 突破20日最高收盤價
  let high20 = -Infinity;
  for (let i = idx - 20; i < idx; i++) {
    high20 = Math.max(high20, candles[i].close);
  }
  if (today.close <= high20) return false;

  // MA20上升
  if (idx >= 5 && candles[idx - 5].ma20 != null) {
    if (today.ma20! <= candles[idx - 5].ma20!) return false;
  }

  // 紅K
  if (today.close <= today.open) return false;

  // 量能
  if (today.volume < today.avgVol5 * 1.0) return false;

  // 不要在已經大漲後追: 20日漲幅<30%
  if (today.roc20 != null && today.roc20 > 30) return false;

  return true;
}

function exitTurtleBreakout(
  candles: CandleWithIndicators[], entryIdx: number, entryPrice: number,
): { exitIdx: number; exitPrice: number; exitReason: string } | null {
  const entryATR = candles[entryIdx].atr14 ?? entryPrice * 0.03;
  let trailStop = entryPrice - 2 * entryATR; // 初始止損 = 進場價 - 2ATR

  for (let d = 1; d <= 20; d++) {
    const fi = entryIdx + d;
    if (fi >= candles.length) return null;
    const c = candles[fi];

    // 更新追蹤止損（只能上移）
    const currentATR = c.atr14 ?? entryATR;
    const newStop = c.close - 2 * currentATR;
    trailStop = Math.max(trailStop, newStop);

    // 停利 +15%
    if (c.high >= entryPrice * 1.15) {
      return { exitIdx: fi, exitPrice: +(entryPrice * 1.15).toFixed(2), exitReason: '停利+15%' };
    }

    // ATR追蹤止損
    if (c.low <= trailStop) {
      const exitP = Math.max(c.open, trailStop);
      return { exitIdx: fi, exitPrice: +exitP.toFixed(2), exitReason: 'ATR追蹤止損' };
    }

    // 硬停損 -8%
    if (c.low <= entryPrice * 0.92) {
      return { exitIdx: fi, exitPrice: +(entryPrice * 0.92).toFixed(2), exitReason: '停損-8%' };
    }

    if (d === 20) {
      return { exitIdx: fi, exitPrice: c.close, exitReason: '持有20天' };
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════════
// 策略9: KD低檔黃金交叉（多頭趨勢中買低）
// ══════════════════════════════════════════════════════════════

function scanKDGoldenCross(candles: CandleWithIndicators[], idx: number): boolean {
  if (idx < 2) return false;
  const today = candles[idx];
  const yesterday = candles[idx - 1];

  if (today.kdK == null || today.kdD == null || yesterday.kdK == null || yesterday.kdD == null) return false;
  if (today.ma20 == null || today.ma10 == null) return false;

  // KD低檔: K<30 或 D<30（昨日）
  if (yesterday.kdK >= 30 && yesterday.kdD >= 30) return false;

  // 黃金交叉: 昨日 K <= D，今日 K > D
  if (yesterday.kdK > yesterday.kdD) return false;
  if (today.kdK <= today.kdD) return false;

  // 多頭趨勢: close > MA20 且 MA20 上升
  if (today.close <= today.ma20) return false;
  if (idx >= 5 && candles[idx - 5].ma20 != null) {
    if (today.ma20! <= candles[idx - 5].ma20!) return false;
  }

  // 紅K
  if (today.close <= today.open) return false;

  return true;
}

function exitKDGoldenCross(
  candles: CandleWithIndicators[], entryIdx: number, entryPrice: number,
): { exitIdx: number; exitPrice: number; exitReason: string } | null {
  for (let d = 1; d <= 10; d++) {
    const fi = entryIdx + d;
    if (fi >= candles.length) return null;
    const c = candles[fi];

    // 停利 +8%
    if (c.high >= entryPrice * 1.08) {
      return { exitIdx: fi, exitPrice: +(entryPrice * 1.08).toFixed(2), exitReason: '停利+8%' };
    }

    // 停損 -5%
    if (c.low <= entryPrice * 0.95) {
      return { exitIdx: fi, exitPrice: +(entryPrice * 0.95).toFixed(2), exitReason: '停損-5%' };
    }

    // KD死亡交叉（K < D 且 K > 80）
    if (c.kdK != null && c.kdD != null && c.kdK > 80 && c.kdK < c.kdD) {
      return { exitIdx: fi, exitPrice: c.close, exitReason: 'KD死叉' };
    }

    // 跌破MA10
    if (c.ma10 != null && c.close < c.ma10) {
      return { exitIdx: fi, exitPrice: c.close, exitReason: '破MA10' };
    }

    if (d === 10) {
      return { exitIdx: fi, exitPrice: c.close, exitReason: '持有10天' };
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════════
// 改良V反轉 — 加入 RSI 雙重確認 + 量能更嚴格
// ══════════════════════════════════════════════════════════════

function scanVReversalPlus(candles: CandleWithIndicators[], idx: number): boolean {
  if (idx < 5) return false;
  const today = candles[idx];
  if (today.ma20 == null || today.avgVol5 == null || today.rsi14 == null) return false;

  // 連跌3天+
  let consecutiveDown = 0;
  for (let i = idx - 1; i >= Math.max(0, idx - 10); i--) {
    if (candles[i].close < candles[i].open) consecutiveDown++;
    else break;
  }
  if (consecutiveDown < 3) return false;

  // 偏離MA20 ≥ 10%（放寬一點抓更多訊號）
  const deviation = (today.close - today.ma20) / today.ma20;
  if (deviation > -0.10) return false;

  // RSI超賣確認: RSI < 35
  if (today.rsi14 >= 35) return false;

  // 反轉K棒
  const range = today.high - today.low;
  if (range <= 0) return false;
  if ((today.close - today.low) / range < 0.4) return false;

  // 放量 ≥ 1.3x
  if (today.volume < today.avgVol5 * 1.3) return false;

  // 安全: 不是長期空頭
  if (idx >= 20) {
    const ma20_20ago = candles[idx - 20].ma20;
    const ma20_40ago = idx >= 40 ? candles[idx - 40].ma20 : null;
    if (ma20_20ago != null && ma20_40ago != null && ma20_20ago < ma20_40ago) return false;
  }

  return true;
}

function exitVReversalPlus(
  candles: CandleWithIndicators[], entryIdx: number, entryPrice: number, signalIdx: number,
): { exitIdx: number; exitPrice: number; exitReason: string } | null {
  // 找跌前高點
  let preDropHigh = entryPrice;
  for (let i = signalIdx; i >= Math.max(0, signalIdx - 15); i--) {
    preDropHigh = Math.max(preDropHigh, candles[i].close);
  }
  const targetReturn = Math.min((preDropHigh - entryPrice) / entryPrice, 0.15);

  for (let d = 1; d <= 7; d++) {
    const fi = entryIdx + d;
    if (fi >= candles.length) return null;
    const c = candles[fi];

    // 目標價
    if (targetReturn > 0.03 && c.high >= entryPrice * (1 + targetReturn)) {
      return { exitIdx: fi, exitPrice: +(entryPrice * (1 + targetReturn)).toFixed(2), exitReason: '達目標價' };
    }

    // 停損 -5%（更緊的止損）
    if (c.low <= entryPrice * 0.95) {
      return { exitIdx: fi, exitPrice: +(entryPrice * 0.95).toFixed(2), exitReason: '停損-5%' };
    }

    // RSI回到50就出
    if (c.rsi14 != null && c.rsi14 >= 55) {
      return { exitIdx: fi, exitPrice: c.close, exitReason: 'RSI≥55' };
    }

    if (d === 7) {
      return { exitIdx: fi, exitPrice: c.close, exitReason: '持有7天' };
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════════
// 改良雙均線 — 加量能+K棒品質過濾
// ══════════════════════════════════════════════════════════════

function scanTwoMAPlus(candles: CandleWithIndicators[], idx: number): boolean {
  if (idx < 5) return false;
  const today = candles[idx];
  const yesterday = candles[idx - 1];
  const fiveDaysAgo = candles[idx - 5];

  if (today.ma10 == null || today.ma24 == null || today.avgVol5 == null) return false;
  if (yesterday.ma10 == null || yesterday.ma24 == null) return false;
  if (fiveDaysAgo.ma24 == null) return false;

  // 基本條件（同原版）
  if (today.ma24 <= fiveDaysAgo.ma24) return false;
  if (today.close <= today.ma10) return false;
  if (today.ma10 <= today.ma24) return false;
  if (yesterday.close > yesterday.ma10) return false;
  if (today.close <= today.open) return false;

  // 新增: K棒實體 ≥ 2%
  const bodyPct = (today.close - today.open) / today.open * 100;
  if (bodyPct < 2) return false;

  // 新增: 量能 ≥ avgVol5 × 1.3
  if (today.volume < today.avgVol5 * 1.3) return false;

  // 新增: 不在過度偏離位置（偏離MA24 < 15%）
  const deviation = (today.close - today.ma24) / today.ma24;
  if (deviation > 0.15) return false;

  return true;
}

function exitTwoMAPlus(
  candles: CandleWithIndicators[], entryIdx: number, entryPrice: number,
): { exitIdx: number; exitPrice: number; exitReason: string } | null {
  for (let d = 1; d <= 20; d++) {
    const fi = entryIdx + d;
    if (fi >= candles.length) return null;
    const c = candles[fi];

    // 停損 -5%（更緊）
    if (c.low <= entryPrice * 0.95) {
      return { exitIdx: fi, exitPrice: +(entryPrice * 0.95).toFixed(2), exitReason: '停損-5%' };
    }

    // 破MA10
    if (c.ma10 != null && c.close < c.ma10) {
      return { exitIdx: fi, exitPrice: c.close, exitReason: '破MA10' };
    }

    // MA24轉下
    if (d >= 5 && c.ma24 != null) {
      const prev5 = candles[fi - 5];
      if (prev5.ma24 != null && c.ma24 < prev5.ma24) {
        return { exitIdx: fi, exitPrice: c.close, exitReason: 'MA24轉下' };
      }
    }

    if (d === 20) {
      return { exitIdx: fi, exitPrice: c.close, exitReason: '持有20天' };
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════════
// 回測引擎（同Round1）
// ══════════════════════════════════════════════════════════════

function runStrategyBacktest(
  strategyName: string,
  allStocks: Map<string, { name: string; candles: CandleWithIndicators[] }>,
  tradingDays: string[],
  scanFn: (candles: CandleWithIndicators[], idx: number) => boolean,
  exitFn: (candles: CandleWithIndicators[], entryIdx: number, entryPrice: number, signalIdx: number) => { exitIdx: number; exitPrice: number; exitReason: string } | null,
): Trade[] {
  const trades: Trade[] = [];
  let holdingUntilDay = -1;

  for (let dayIdx = 0; dayIdx < tradingDays.length; dayIdx++) {
    const date = tradingDays[dayIdx];
    if (dayIdx <= holdingUntilDay) continue;

    interface Candidate {
      symbol: string; name: string;
      candles: CandleWithIndicators[];
      signalIdx: number; score: number;
    }
    const candidates: Candidate[] = [];

    for (const [symbol, stockData] of allStocks) {
      const { candles } = stockData;
      const idx = candles.findIndex(c => c.date?.slice(0, 10) === date);
      if (idx < 30 || idx >= candles.length - 20) continue;

      if (!scanFn(candles, idx)) continue;

      const c = candles[idx];
      const bodyPct = Math.abs(c.close - c.open) / c.open * 100;
      const volRatio = c.avgVol5 && c.avgVol5 > 0 ? c.volume / c.avgVol5 : 1;
      candidates.push({ symbol, name: stockData.name, candles, signalIdx: idx, score: bodyPct * volRatio });
    }

    if (candidates.length === 0) continue;
    candidates.sort((a, b) => b.score - a.score);
    const pick = candidates[0];

    const entryIdx = pick.signalIdx + 1;
    if (entryIdx >= pick.candles.length) continue;
    const entryPrice = pick.candles[entryIdx].open;
    const entryDate = pick.candles[entryIdx].date?.slice(0, 10) ?? '';

    const exit = exitFn(pick.candles, entryIdx, entryPrice, pick.signalIdx);
    if (!exit) continue;

    const grossReturn = +((exit.exitPrice - entryPrice) / entryPrice * 100).toFixed(2);
    const netReturn = +(grossReturn - ROUND_TRIP_COST).toFixed(2);
    const holdDays = exit.exitIdx - entryIdx;
    const exitDate = pick.candles[exit.exitIdx]?.date?.slice(0, 10) ?? '';
    const exitDayIdx = tradingDays.indexOf(exitDate);
    holdingUntilDay = exitDayIdx >= 0 ? exitDayIdx : dayIdx + holdDays;

    trades.push({
      strategy: strategyName,
      entryDate, exitDate,
      symbol: pick.symbol, name: pick.name,
      entryPrice, exitPrice: exit.exitPrice,
      grossReturn, netReturn, holdDays,
      exitReason: exit.exitReason,
    });
  }
  return trades;
}

// ══════════════════════════════════════════════════════════════
// 統計 + 輸出
// ══════════════════════════════════════════════════════════════

interface StrategyStats {
  name: string; trades: Trade[];
  totalTrades: number; wins: number; losses: number;
  winRate: number; avgReturn: number; avgWin: number; avgLoss: number;
  profitFactor: number; maxDrawdown: number;
  finalCapital: number; totalReturn: number;
  avgHoldDays: number; maxConsecutiveLoss: number;
  sharpe: number;
}

function calcStats(name: string, trades: Trade[]): StrategyStats {
  const wins = trades.filter(t => t.netReturn > 0);
  const losses = trades.filter(t => t.netReturn <= 0);
  const totalProfit = wins.reduce((s, t) => s + t.netReturn, 0);
  const totalLoss = Math.abs(losses.reduce((s, t) => s + t.netReturn, 0));

  let capital = INITIAL_CAPITAL, peak = INITIAL_CAPITAL, maxDD = 0;
  const returns: number[] = [];
  for (const t of trades) {
    returns.push(t.netReturn);
    capital += Math.round(capital * t.netReturn / 100);
    peak = Math.max(peak, capital);
    maxDD = Math.min(maxDD, (capital - peak) / peak);
  }

  let maxConsLoss = 0, cur = 0;
  for (const t of trades) {
    if (t.netReturn <= 0) { cur++; maxConsLoss = Math.max(maxConsLoss, cur); }
    else cur = 0;
  }

  // Sharpe (per-trade)
  const avgRet = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const stdRet = returns.length > 1 ? Math.sqrt(returns.reduce((s, r) => s + (r - avgRet) ** 2, 0) / (returns.length - 1)) : 1;
  const sharpe = stdRet > 0 ? +(avgRet / stdRet).toFixed(3) : 0;

  return {
    name, trades,
    totalTrades: trades.length,
    wins: wins.length, losses: losses.length,
    winRate: trades.length > 0 ? +(wins.length / trades.length * 100).toFixed(1) : 0,
    avgReturn: +avgRet.toFixed(2),
    avgWin: wins.length > 0 ? +(totalProfit / wins.length).toFixed(2) : 0,
    avgLoss: losses.length > 0 ? +(-totalLoss / losses.length).toFixed(2) : 0,
    profitFactor: totalLoss > 0 ? +(totalProfit / totalLoss).toFixed(2) : totalProfit > 0 ? 999 : 0,
    maxDrawdown: +(maxDD * 100).toFixed(1),
    finalCapital: capital,
    totalReturn: +((capital / INITIAL_CAPITAL - 1) * 100).toFixed(1),
    avgHoldDays: trades.length > 0 ? +(trades.reduce((s, t) => s + t.holdDays, 0) / trades.length).toFixed(1) : 0,
    maxConsecutiveLoss: maxConsLoss,
    sharpe,
  };
}

function printResults(results: StrategyStats[]) {
  console.log('\n══════════════════════════════════════════════════════════════════════════════');
  console.log('  台股策略回測 Round 2 — 含5個新策略 + 2個改良版');
  console.log(`  期間: ${BACKTEST_START} ~ ${BACKTEST_END} | 初始: ${INITIAL_CAPITAL.toLocaleString()} | 一次一檔`);
  console.log('══════════════════════════════════════════════════════════════════════════════\n');

  const header = '指標'.padEnd(16) + results.map(r => r.name.padStart(10)).join('');
  console.log(header);
  console.log('─'.repeat(16 + results.length * 10));

  const rows: [string, (s: StrategyStats) => string][] = [
    ['總交易數',      s => s.totalTrades.toString()],
    ['勝/負',         s => `${s.wins}/${s.losses}`],
    ['勝率',          s => `${s.winRate}%`],
    ['平均報酬',      s => `${s.avgReturn >= 0 ? '+' : ''}${s.avgReturn}%`],
    ['平均獲利',      s => `+${s.avgWin}%`],
    ['平均虧損',      s => `${s.avgLoss}%`],
    ['盈虧比',        s => s.avgLoss !== 0 ? (s.avgWin / Math.abs(s.avgLoss)).toFixed(2) : 'N/A'],
    ['PF',            s => s.profitFactor.toString()],
    ['Sharpe',        s => s.sharpe.toString()],
    ['最大回撤',      s => `${s.maxDrawdown}%`],
    ['最大連虧',      s => `${s.maxConsecutiveLoss}次`],
    ['持有天數',      s => `${s.avgHoldDays}天`],
    ['最終資金',      s => (s.finalCapital / 10000).toFixed(0) + '萬'],
    ['總報酬',        s => `${s.totalReturn >= 0 ? '+' : ''}${s.totalReturn}%`],
  ];

  for (const [label, fn] of rows) {
    console.log(label.padEnd(16) + results.map(r => fn(r).padStart(10)).join(''));
  }
  console.log('─'.repeat(16 + results.length * 10));

  // 出場原因
  for (const r of results) {
    console.log(`\n  [${r.name}] 出場:`);
    const rc: Record<string, number> = {};
    for (const t of r.trades) rc[t.exitReason] = (rc[t.exitReason] || 0) + 1;
    for (const [reason, count] of Object.entries(rc).sort((a, b) => b[1] - a[1]))
      console.log(`    ${reason.padEnd(14)} ${count}筆 (${(count / r.trades.length * 100).toFixed(0)}%)`);
  }

  // 排名
  console.log('\n\n★ 策略排名 (依 Profit Factor):');
  const ranked = [...results].sort((a, b) => b.profitFactor - a.profitFactor);
  for (let i = 0; i < ranked.length; i++) {
    const r = ranked[i];
    const emoji = r.profitFactor >= 1.3 ? '🟢' : r.profitFactor >= 1.0 ? '🟡' : '🔴';
    console.log(`  ${i + 1}. ${emoji} ${r.name.padEnd(10)} PF=${r.profitFactor.toString().padEnd(5)} 勝率=${r.winRate}% 報酬=${r.totalReturn >= 0 ? '+' : ''}${r.totalReturn}% Sharpe=${r.sharpe}`);
  }
}

// ══════════════════════════════════════════════════════════════

async function main() {
  console.log('載入台股數據...');
  const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
  const allStocks = new Map<string, { name: string; candles: CandleWithIndicators[] }>();
  for (const [sym, data] of Object.entries(raw.stocks as Record<string, { name: string; candles: any[] }>)) {
    if (!data.candles || data.candles.length < 60) continue;
    try { allStocks.set(sym, { name: data.name, candles: computeIndicators(data.candles) }); } catch {}
  }
  console.log(`  ${allStocks.size} 支股票`);

  const benchSymbol = allStocks.has('2330.TW') ? '2330.TW' : allStocks.keys().next().value;
  const tradingDays = allStocks.get(benchSymbol!)!.candles
    .map(c => c.date?.slice(0, 10))
    .filter((d): d is string => !!d && d >= BACKTEST_START && d <= BACKTEST_END);
  console.log(`  ${tradingDays.length} 交易日\n`);

  const strategies: { name: string; scan: typeof scanATRBreakout; exit: typeof exitATRBreakout }[] = [
    { name: 'ATR突破', scan: scanATRBreakout, exit: exitATRBreakout },
    { name: '追勢戰法', scan: scanMomentumContinuation, exit: exitMomentumContinuation },
    { name: 'RSI超賣', scan: scanRSIOversold, exit: exitRSIOversold },
    { name: 'Turtle突破', scan: scanTurtleBreakout, exit: exitTurtleBreakout },
    { name: 'KD黃金叉', scan: scanKDGoldenCross, exit: exitKDGoldenCross },
    { name: 'V反轉+', scan: scanVReversalPlus, exit: (c, e, p, s) => exitVReversalPlus(c, e, p, s) },
    { name: '雙均線+', scan: scanTwoMAPlus, exit: (c, e, p) => exitTwoMAPlus(c, e, p) },
  ];

  const results: StrategyStats[] = [];
  for (let i = 0; i < strategies.length; i++) {
    const s = strategies[i];
    console.log(`  [${i + 1}/${strategies.length}] ${s.name}...`);
    const trades = runStrategyBacktest(s.name, allStocks, tradingDays, s.scan, s.exit);
    console.log(`    → ${trades.length} 筆`);
    results.push(calcStats(s.name, trades));
  }

  printResults(results);

  // 最佳交易
  console.log('\n\n各策略最佳3筆:');
  for (const r of results) {
    console.log(`  [${r.name}]`);
    for (const t of [...r.trades].sort((a, b) => b.netReturn - a.netReturn).slice(0, 3)) {
      console.log(`    ${t.entryDate} ${t.symbol.padEnd(10)} ${t.name.slice(0, 6).padEnd(8)} +${t.netReturn.toFixed(1)}% (${t.holdDays}天)`);
    }
  }
}

main().catch(console.error);
