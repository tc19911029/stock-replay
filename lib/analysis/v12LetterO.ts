/**
 * v12 字母 O：打底完成（書本第 1 位置）
 *
 * 書本依據：寶典 Part 11-1 第 1 位置「等打底完成」p.691 ⭐
 *   「空頭低檔大量盤整打底 + 反轉多頭確認 + 站上 MA20 + MA20 向上 +
 *    大量紅 K 突破；同時站上 MA60 可做長多」
 *
 * 條件：
 * 1. 過去趨勢為空頭，最近轉為盤整（detectTrend 軌跡：空頭 → 盤整）
 * 2. 打底期間出現過大成交量（書本「大量打底」）
 * 3. 今日 detectTrend 翻多（頭頭高底底高首次成立）
 * 4. close ≥ MA20 + MA20 上揚
 * 5. 紅 K ≥ 2% + 量 ≥ 1.3×
 * 6. close 突破打底盤整期最高 K 高
 *
 * 議題 33（第 10 輪修正後）：O 觸發即進場（要件已含「反轉多頭確認」）
 * 議題 47：O 不套 pivot gate（自帶結構，剛翻多沒 pivot 對）
 *
 * 軌道：reversal（轉折軌，不過 Step 1 六條件）
 * 類別：pattern（型態類，套 ×3% + 3 天 provisional）
 */

import type { CandleWithIndicators } from '../../types';

import { detectTrend } from './trendAnalysis';
import { isValidRedK } from './redKValidator';
import { isMAUp } from './maPivot';
import type { MarketId } from '../scanner/types';
import { BOOK_VOL_RATIO_MIN } from './bookThresholds';

export interface LetterOResult {
  triggered: boolean;
  /** 突破點 = 打底盤整期最高 K 高 */
  triggerPrice?: number;
  /** ×3% 真突破門檻 */
  breakoutThreshold?: number;
  bodyPct?: number;
  volumeRatio?: number;
  /** 打底盤整期間最高 K low */
  baseLow?: number;
  /** 打底盤整期間最低 K low */
  baseRangeLow?: number;
  /** 打底期間是否曾爆量（書本「大量盤整打底」）*/
  hadHighVolume?: boolean;
  /** 站上 MA60 = 可做長多（書本明寫加分項）*/
  aboveMA60?: boolean;
  detail: string;
}

const MIN_BASE_DAYS = 10;        // 打底期至少 10 天
const MAX_LOOKBACK_DAYS = 60;    // 最多回看 60 天找空頭→盤整轉換
const TRUE_BREAKOUT_PCT = 0.03;
const HIGH_VOLUME_RATIO = 1.5;   // 「大量」打底量 ≥ 過去 5 日均量 × 1.5

/**
 * O 打底完成偵測
 */
export function detectLetterO(
  candles: CandleWithIndicators[],
  idx: number,
  market: MarketId = 'TW',
  symbol = '',
): LetterOResult {
  const empty: LetterOResult = { triggered: false, detail: 'O 打底完成未觸發' };

  if (idx < 30 || candles.length === 0) return empty;

  const c = candles[idx];
  const prev = candles[idx - 1];
  const prevPrev = candles[idx - 2];
  if (!c || !prev || !prevPrev || prev.volume <= 0 || c.open <= 0) return empty;

  // 1. 今日 detectTrend = 多頭（剛翻多）
  if (detectTrend(candles, idx) !== '多頭') return empty;

  // 2. 昨日 detectTrend ≠ 多頭（今天才剛翻多）
  if (detectTrend(candles, idx - 1) === '多頭') return empty;

  // 3. 站上 MA20
  if (c.ma20 == null || c.close < c.ma20) return empty;

  // 4. MA20 上揚（用 MA pivot 判斷）
  const ma20Series = candles
    .slice(Math.max(0, idx - 30), idx + 1)
    .map(k => k.ma20)
    .filter((v): v is number => v != null);
  if (!isMAUp(ma20Series, 3)) return empty;

  // 5. 紅 K（含漲停/跳空例外）+ 實體 ≥ 2%
  if (!isValidRedK(c, prevPrev.close, market, symbol)) return empty;
  const bodyPct = ((c.close - c.open) / c.open) * 100;

  // 6. 量比 ≥ 1.3
  const volumeRatio = c.volume / prev.volume;
  if (volumeRatio < BOOK_VOL_RATIO_MIN) return empty;

  // 7. 找打底盤整期：往回找最近一次「空頭 → 盤整」轉換點
  let baseStartIdx = -1;
  let baseEndIdx = idx - 1;
  for (let i = idx - 1; i >= Math.max(0, idx - MAX_LOOKBACK_DAYS); i--) {
    const t = detectTrend(candles, i);
    if (t === '空頭') {
      // 從這裡往前找盤整起點
      for (let j = i + 1; j < idx; j++) {
        const tj = detectTrend(candles, j);
        if (tj === '盤整') {
          baseStartIdx = j;
          break;
        }
      }
      break;
    }
  }

  if (baseStartIdx < 0 || baseEndIdx - baseStartIdx < MIN_BASE_DAYS) return empty;

  // 8. 打底期間最高 K 高（突破點）+ 最低 K low + 是否曾爆量
  let baseHigh = -Infinity;
  let baseRangeLow = Infinity;
  let hadHighVolume = false;
  for (let i = baseStartIdx; i <= baseEndIdx; i++) {
    const k = candles[i];
    if (k.high > baseHigh) baseHigh = k.high;
    if (k.low < baseRangeLow) baseRangeLow = k.low;
    // 過去 5 日均量
    if (i >= 5) {
      let sum = 0;
      for (let j = i - 4; j <= i; j++) sum += candles[j].volume;
      const avg5 = sum / 5;
      if (avg5 > 0 && k.volume / avg5 >= HIGH_VOLUME_RATIO) hadHighVolume = true;
    }
  }

  // 書本明寫「大量盤整打底」前提
  if (!hadHighVolume) return empty;

  // 9. close 突破打底盤整期最高 K 高 + ×3% 真突破
  const breakoutThreshold = baseHigh * (1 + TRUE_BREAKOUT_PCT);
  if (c.close < breakoutThreshold) return empty;

  // 加分項：站上 MA60（書本「同時站上 MA60 可做長多」）
  const aboveMA60 = c.ma60 != null && c.close >= c.ma60;

  return {
    triggered: true,
    triggerPrice: baseHigh,
    breakoutThreshold,
    bodyPct,
    volumeRatio,
    baseLow: baseRangeLow,
    baseRangeLow,
    hadHighVolume,
    aboveMA60,
    detail: `O 打底完成（${baseEndIdx - baseStartIdx + 1}天打底+爆量+翻多+站MA20${aboveMA60 ? '+MA60可長多' : ''}+紅K${bodyPct.toFixed(2)}%+突破${baseHigh.toFixed(2)}）`,
  };
}
