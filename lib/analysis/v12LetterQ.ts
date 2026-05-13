/**
 * v12 字母 Q：三條均線戰法（獨立第三軌「戰法軌」）
 *
 * 書本依據：抓住線圖 第 4 篇 第 8 章「穩健獲利密技：三條均線戰法」p.261-265 ⭐
 *   朱家泓本人「年獲利 1 倍」首選戰法
 *
 * 用 3 條均線：**MA3 + MA10 + MA24**（**注意：不是 MA5/10/20**，書本明寫）
 *
 * 多頭做多 SOP（書本 p.262）：
 *   - 趨勢判定：股價在 MA24 之上 + MA24 向上
 *   - 進場：MA3 + MA10 黃金交叉 + 股價站上 MA3
 *   - 續抱：MA3 + MA10 沒死叉前
 *   - 出場：收盤前確認 MA3+MA10 死叉 + 股價跌破 MA3
 *   - 停損：進場後守 MA10
 *
 * 議題 33/93：Q 觸發即進場（獨立軌不走 LockWatch）
 * 議題 96/124（衝突 γ）：Q 戰法仍過 Step 0 大盤過濾
 * 議題 96/125（衝突 δ）：Q 只用自己 SOP，Step 5 ②/③ 不強制
 *
 * 軌道：system（戰法軌，獨立 SOP，跳 Step 1 但仍過 Step 0）
 * 類別：system
 *
 * 用戶選用 Q 戰法時不混用 v12 字母系統（v11/v12 互斥）。
 */

import type { CandleWithIndicators } from '../../types';

import { isMAUp } from './maPivot';
import { isValidRedK } from './redKValidator';
import type { MarketId } from '../scanner/types';
import { Q_MIN_HISTORY } from './historyMinimums';

export interface LetterQResult {
  triggered: boolean;
  /** 進場後守 MA10（書本 p.262 明寫停損點）*/
  stopLossMA?: number;
  /** MA3 當日值 */
  ma3?: number;
  /** MA10 當日值 */
  ma10?: number;
  /** MA24 當日值（注意是 24 不是 20）*/
  ma24?: number;
  /** MA3 是否上穿 MA10（黃金交叉）*/
  goldenCrossToday?: boolean;
  /** close 是否站上 MA3 */
  aboveMA3?: boolean;
  /** MA24 是否上揚 */
  ma24Up?: boolean;
  bodyPct?: number;
  detail: string;
}

/**
 * Q 三條均線戰法偵測
 *
 * 注意：書本沒給 Q 戰法的紅 K 漲幅 / 量比要求，但我們對齊書本「中長紅 K」精神
 * 套用一般進場條件（紅 K 2% + 量 1.3×）。
 */
export function detectLetterQ(
  candles: CandleWithIndicators[],
  idx: number,
  market: MarketId = 'TW',
  symbol = '',
): LetterQResult {
  const empty: LetterQResult = { triggered: false, detail: 'Q 三條均線戰法未觸發' };

  if (idx < Q_MIN_HISTORY || candles.length === 0) return empty;

  const c = candles[idx];
  const prev = candles[idx - 1];
  const prevPrev = candles[idx - 2];
  if (!c || !prev || !prevPrev) return empty;

  // ── 0. MA3/MA10/MA24 全部要有 ─────────────────────────────────────────
  if (c.ma3 == null || c.ma10 == null || c.ma24 == null) return empty;
  if (prev.ma3 == null || prev.ma10 == null) return empty;

  // ── 1. 趨勢判定：股價在 MA24 之上 + MA24 上揚（書本 p.262）──
  if (c.close < c.ma24) return empty;

  const ma24Series = candles
    .slice(Math.max(0, idx - 30), idx + 1)
    .map(k => k.ma24)
    .filter((v): v is number => v != null);
  const ma24Up = isMAUp(ma24Series, 3);
  if (!ma24Up) return empty;

  // ── 2. MA3 黃金交叉 MA10（書本 p.262 進場條件）──
  // 黃金交叉 = 今日 MA3 > MA10 且昨日 MA3 ≤ MA10
  const goldenCrossToday = c.ma3 > c.ma10 && prev.ma3 <= prev.ma10;
  if (!goldenCrossToday) return empty;

  // ── 3. close 站上 MA3 ────────────────────────────────────────
  const aboveMA3 = c.close >= c.ma3;
  if (!aboveMA3) return empty;

  // ── 4. 紅 K + 實體 ≥ 2%（對齊書本「中長紅 K」精神）──
  if (!isValidRedK(c, prevPrev.close, market, symbol)) return empty;
  const bodyPct = ((c.close - c.open) / c.open) * 100;

  return {
    triggered: true,
    stopLossMA: c.ma10,
    ma3: c.ma3,
    ma10: c.ma10,
    ma24: c.ma24,
    goldenCrossToday,
    aboveMA3,
    ma24Up,
    bodyPct,
    detail: `Q 三條均線戰法（MA3=${c.ma3.toFixed(2)} 金叉 MA10=${c.ma10.toFixed(2)}+站上 MA3+MA24=${c.ma24.toFixed(2)} 上揚+紅K${bodyPct.toFixed(2)}%）`,
  };
}

/**
 * Q 戰法的「續抱/出場」判定（持倉中每日呼叫）
 *
 * 書本 p.262：MA3+MA10 死叉 + 股價跌破 MA3 → 出場
 *
 * @returns 是否該出場
 */
export function shouldExitLetterQ(
  candles: CandleWithIndicators[],
  idx: number,
): { shouldExit: boolean; reason: string } {
  if (idx < 1) return { shouldExit: false, reason: 'data-insufficient' };

  const c = candles[idx];
  const prev = candles[idx - 1];
  if (!c || !prev) return { shouldExit: false, reason: 'data-insufficient' };
  if (c.ma3 == null || c.ma10 == null || prev.ma3 == null || prev.ma10 == null) {
    return { shouldExit: false, reason: 'ma-missing' };
  }

  // MA3+MA10 死亡交叉（今日 MA3 < MA10 且昨日 MA3 ≥ MA10）
  const deathCross = c.ma3 < c.ma10 && prev.ma3 >= prev.ma10;
  // 股價跌破 MA3
  const belowMA3 = c.close < c.ma3;

  if (deathCross && belowMA3) {
    return { shouldExit: true, reason: 'Q 死叉跌破 MA3 出場' };
  }

  return { shouldExit: false, reason: 'holding' };
}
