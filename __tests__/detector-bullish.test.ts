/**
 * 0513 ABCDE B2 scaffold — detector 範例 unit test（為 B3-B4 鋪路）
 *
 * **發現**：簡單合成階梯 K 線騙不了 detectTrend（用 findPivots 判頭頭高底底高，
 * 要 pivot pattern 對才會回「多頭」）。所以「明顯多頭階梯」test 會 fail。
 *
 * 結論：B3 階段要做的是真實 K 線 fixtures（從歷史已知多頭股票拷貝 60 天 JSON），
 * 不是用 candleFactory 合成。candleFactory 僅適合測「邊界 case」（資料不足、極端值）。
 *
 * 完整 14 字母 detector test 留 B3 跑。
 */

import { describe, it, expect } from '@jest/globals';
import { detectTrend } from '../lib/analysis/trendAnalysis';
import { makeBullishCandles } from './utils/candleFactory';

describe('detectTrend — B2 scaffold 範例（邊界 case 才合適合成）', () => {
  it('資料 < 20 根 → 預設 "盤整"（detectTrend boundary guard）', () => {
    const candles = makeBullishCandles(15);
    const trend = detectTrend(candles, candles.length - 1);
    expect(trend).toBe('盤整');
  });

  // TODO B3：「明顯多頭」「明確盤整」要用真實 JSON fixtures（從 data/candles/TW/ 拷貝），
  //   不是 candleFactory 合成 — pivot 邏輯比階梯複雜。
});
