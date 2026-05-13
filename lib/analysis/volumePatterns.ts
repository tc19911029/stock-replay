/**
 * 量價 detector — 書本 Part 7 p.487-535
 *
 * 實作：
 *   - 量 9 種分類（p.487-488）：基本/攻擊/爆大/止跌/進貨/換手/出貨/調節/搶反彈
 *   - 量價背離 3 種（p.500-506）：價漲量縮/價平量增/價漲量平
 *   - 高檔爆量 3 種（p.493-499）：調節/換手/出貨
 *   - 窒息量 + 凹洞量（p.525）
 *
 * 用法：各函式回傳 boolean，供上層判斷當前 K 棒是否符合該量價型態。
 */
import type { CandleWithIndicators } from '@/types';
import { BOOK_VOL_RATIO_MIN } from './bookThresholds';

/** 量分類（書本 p.487-488） */
export type VolumeType =
  | 'base'          // 基本量 = 5 日均量
  | 'attack'        // 攻擊量 = 前日 × 1.3
  | 'blowoff'       // 爆大量 = 5 日均量 × 2
  | 'stopDrop'      // 止跌量 = 5 日均量 × 0.5
  | 'accumulate'    // 進貨量 = 大量 + 股價上漲
  | 'turnover'      // 換手量 = 高檔大量K 3 日內被突破
  | 'distribution'  // 出貨量 = 大量 + 股價下跌/反轉
  | 'wash'          // 調節量 = 高檔大量K 下跌後又上漲突破
  | 'rebound';      // 搶反彈量 = 空頭低檔大量 + 後紅K反彈

export function classifyVolume(
  candles: CandleWithIndicators[],
  index: number,
): VolumeType[] {
  const c = candles[index];
  const prev = candles[index - 1];
  if (!c || !prev) return ['base'];

  const types: VolumeType[] = [];
  const avg5 = c.avgVol5 ?? 0;

  // 攻擊量（寶典 p.54 ④ ×1.3，0513 ABCDE D：改 import BOOK_VOL_RATIO_MIN 統一）
  if (prev.volume > 0 && c.volume >= prev.volume * BOOK_VOL_RATIO_MIN) types.push('attack');

  // 爆大量（5 日均量 × 2）— 抓住飆股 / 朱家泓 YouTube #17
  if (avg5 > 0 && c.volume >= avg5 * 2) types.push('blowoff');

  // ⚠️ 自創 padding（書本沒明寫量化）— 0513 ABCDE D 標自創
  // 止跌量（5 日均量 × 0.5，且當日不破低）— 0.5 為工程經驗值，未來搬 bookThresholds
  if (avg5 > 0 && c.volume <= avg5 * 0.5 && c.low >= prev.low) types.push('stopDrop');

  // 進貨量（大量 + 紅K），1.5 對齊 BASE_HIGH_VOL_RATIO；1.3 對齊 BOOK_VOL_RATIO_MIN
  const isBig = (avg5 > 0 && c.volume >= avg5 * 1.5) || (prev.volume > 0 && c.volume >= prev.volume * BOOK_VOL_RATIO_MIN);
  if (isBig && c.close > c.open) types.push('accumulate');

  // 出貨量（大量 + 黑K）
  if (isBig && c.close < c.open) types.push('distribution');

  // 換手量（當日為大量K，3 日內被後續紅K 突破高點）
  if (index >= 3 && avg5 > 0) {
    const past = candles[index - 3];
    if (past.volume >= avg5 * 1.5 && past.close > past.open) {
      const brokeOut = [candles[index - 2], candles[index - 1], c].some(k => k?.close > past.high);
      if (brokeOut) types.push('turnover');
    }
  }

  // 調節量（高檔大量K 下跌後又上漲突破）
  if (index >= 5 && avg5 > 0) {
    const past = candles[index - 5];
    if (past.volume >= avg5 * 1.5 && past.close < past.open) {  // 大量黑K
      if (c.close > past.high) types.push('wash');
    }
  }

  // 搶反彈量（空頭低檔大量 + 紅K反彈）
  if (c.ma20 && c.ma20 > 0 && c.close < c.ma20 && isBig && c.close > c.open) {
    types.push('rebound');
  }

  if (types.length === 0) types.push('base');
  return types;
}

/** 量價背離 3 種（書本 p.500-506） */
export interface VolumePriceDivergence {
  priceUpVolDown: boolean;   // 價漲量縮（背離）
  pricePlatVolUp: boolean;   // 價平量增（停滯）
  priceUpVolPlat: boolean;   // 價漲量平（止漲）
}

export function detectVolumePriceDivergence(
  candles: CandleWithIndicators[],
  index: number,
): VolumePriceDivergence {
  const c = candles[index];
  const prev = candles[index - 1];
  if (!c || !prev || prev.volume <= 0) {
    return { priceUpVolDown: false, pricePlatVolUp: false, priceUpVolPlat: false };
  }

  const priceChg = (c.close - prev.close) / prev.close;
  const volRatio = c.volume / prev.volume;

  return {
    priceUpVolDown:  priceChg > 0.01 && volRatio < 0.9,       // 價漲 >1% 量縮 >10%
    pricePlatVolUp:  Math.abs(priceChg) < 0.005 && volRatio > 1.3,  // 價幾乎不動量增 >30%
    priceUpVolPlat:  priceChg > 0.01 && volRatio >= 0.9 && volRatio <= 1.1,  // 價漲但量平
  };
}

/** 高檔爆量 3 種判定（書本 p.493-499） */
export interface HighVolumeHighPeak {
  washVolume:         boolean;  // 調節量
  turnoverVolume:     boolean;  // 換手量
  distributionVolume: boolean;  // 出貨量
}

export function detectHighPeakVolume(
  candles: CandleWithIndicators[],
  index: number,
): HighVolumeHighPeak {
  const c = candles[index];
  const avg5 = c?.avgVol5 ?? 0;
  if (index < 5 || avg5 <= 0) {
    return { washVolume: false, turnoverVolume: false, distributionVolume: false };
  }
  const prev = candles[index - 1];
  const isBlowoff = c.volume >= avg5 * 2;

  // 是否高檔（MA20 乖離 >5%）
  const inHighZone = c.ma20 && c.ma20 > 0 && (c.close - c.ma20) / c.ma20 > 0.05;

  let washVolume = false, turnoverVolume = false, distributionVolume = false;

  if (inHighZone && isBlowoff && prev) {
    // 調節量：當日大量黑 → 後續紅K 站回
    // （簡化版：當日大量黑 + 不破前低）
    if (c.close < c.open && c.low > prev.low * 0.98) washVolume = true;

    // 換手量：連續大量但股價未破 → 強勢
    if (c.close > prev.close) turnoverVolume = true;

    // 出貨量：高檔大量 + 黑K + 收盤跌破前日低
    if (c.close < c.open && c.close < prev.low) distributionVolume = true;
  }

  return { washVolume, turnoverVolume, distributionVolume };
}

/** 窒息量（書本 p.525）— 下跌中量縮到大量的 1/2 以下 */
export function detectChokingVolume(
  candles: CandleWithIndicators[],
  index: number,
): boolean {
  if (index < 5) return false;
  const c = candles[index];
  // 找前 5 天內的大量日
  for (let j = index - 5; j < index; j++) {
    const past = candles[j];
    if (!past?.avgVol5) continue;
    if (past.volume >= past.avgVol5 * 2) {
      return c.volume <= past.volume * 0.5 && c.close < c.open;
    }
  }
  return false;
}

/** 凹洞量（書本 p.525）— 窒息量次日出現放大量紅K 反彈 */
export function detectHollowVolume(
  candles: CandleWithIndicators[],
  index: number,
): boolean {
  if (index < 1) return false;
  const c = candles[index];
  if (c.close <= c.open) return false;
  return detectChokingVolume(candles, index - 1) && c.volume > candles[index - 1].volume * 1.5;
}
