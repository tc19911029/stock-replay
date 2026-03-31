import { CandleWithIndicators } from '@/types';

export type SellSignalType =
  | 'DEATH_CROSS'         // MA5 crosses below MA20
  | 'HIGH_VOL_UPPER_SHADOW' // High volume + long upper shadow in uptrend
  | 'KD_DEATH_CROSS'      // KD high-level death cross (K crosses below D when both > 70)
  | 'BREAK_MA5'           // Close breaks below MA5 after being above
  | 'BREAK_MA20'          // Close breaks below MA20 (serious)
  | 'TREND_BEARISH'       // Trend has turned bearish
  // 朱老師獲利方程式（《活用技術分析寶典》p.54）
  | 'LOWER_LOW'           // 收盤出現「頭頭低」
  | 'PROFIT_BREAK_MA5'    // 獲利>10% + 跌破MA5
  | 'PROFIT_CLIMAX_EXIT'  // 獲利>20% 或連續急漲+長黑覆蓋
  // 朱老師短線20條守則補充（p.711-712）
  | 'STRONG_COVER'        // 強覆蓋：黑K跌破前日紅K 1/2 + K值下彎（第11條）
  | 'HIGH_VOL_2DAY_3BLACK' // 高檔連2日爆量+回檔連3黑（第14條）
  | 'WEEKLY_RESIST_BREAK_MA5' // 週線遇壓+黑K跌破MA5（第19條）
  | 'SEASON_LINE_DOWN_BREAK'; // 季線向下回檔跌破5均（第20條）

export interface SellSignal {
  type: SellSignalType;
  label: string;
  detail: string;
  severity: 'high' | 'medium' | 'low';
}

/**
 * 偵測出場/賣出訊號（朱老師出場原則）
 * 嚴重程度：high = 立即出場考慮，medium = 警戒，low = 觀察
 */
export function detectSellSignals(
  candles: CandleWithIndicators[],
  index: number,
): SellSignal[] {
  if (index < 5) return [];
  const signals: SellSignal[] = [];

  const c     = candles[index];
  const prev  = candles[index - 1];
  const _prev2 = candles[index - 2];

  const ma5  = c.ma5;
  const ma20 = c.ma20;
  const kd_k = c.kdK;
  const kd_d = c.kdD;
  const prevMa5  = prev?.ma5;
  const prevMa20 = prev?.ma20;
  const prevKdK  = prev?.kdK;
  const prevKdD  = prev?.kdD;

  // 1. 死亡交叉：MA5 剛剛跌破 MA20
  if (ma5 != null && ma20 != null && prevMa5 != null && prevMa20 != null) {
    if (prevMa5 >= prevMa20 && ma5 < ma20) {
      signals.push({
        type: 'DEATH_CROSS',
        label: '死亡交叉',
        detail: `MA5(${ma5.toFixed(2)}) 跌破 MA20(${ma20.toFixed(2)})，趨勢轉弱訊號`,
        severity: 'high',
      });
    }
  }

  // 2. KD 高位死叉：K 從高位（>70）向下交叉 D
  if (kd_k != null && kd_d != null && prevKdK != null && prevKdD != null) {
    if (prevKdK > 70 && prevKdK >= prevKdD && kd_k < kd_d) {
      signals.push({
        type: 'KD_DEATH_CROSS',
        label: 'KD高位死叉',
        detail: `KD K(${kd_k.toFixed(1)}) 在高位死叉 D(${kd_d.toFixed(1)})，短線過熱回落`,
        severity: 'medium',
      });
    }
  }

  // 3. 跌破 MA20（嚴重警訊）
  if (ma20 != null && prev?.ma20 != null) {
    if (prev.close >= prev.ma20 * 0.99 && c.close < ma20 * 0.99) {
      signals.push({
        type: 'BREAK_MA20',
        label: '跌破月線',
        detail: `收盤(${c.close}) 跌破 MA20(${ma20.toFixed(2)})，多頭保護線失守`,
        severity: 'high',
      });
    }
  }

  // 4. 跌破 MA5（輕度警示）
  if (ma5 != null && prev?.ma5 != null) {
    if (prev.close >= prev.ma5 && c.close < ma5 && c.close >= (ma20 ?? 0)) {
      signals.push({
        type: 'BREAK_MA5',
        label: '跌破週線MA5',
        detail: `收盤(${c.close}) 跌破 MA5(${ma5.toFixed(2)})，短線動能轉弱`,
        severity: 'low',
      });
    }
  }

  // 5. 高檔爆量長上影線：量比 > 1.5x，上影線 > 實體的 2倍，且在多頭中
  const body = Math.abs(c.close - c.open);
  const upperShadow = c.high - Math.max(c.close, c.open);
  const volRatio5 = (() => {
    const vols = candles.slice(Math.max(0, index - 5), index).map(x => x.volume).filter(v => v > 0);
    if (vols.length === 0) return null;
    return c.volume / (vols.reduce((a, b) => a + b, 0) / vols.length);
  })();
  if (body > 0 && upperShadow > body * 2 && (volRatio5 ?? 0) > 1.5 && ma5 != null && ma20 != null && ma5 > ma20) {
    signals.push({
      type: 'HIGH_VOL_UPPER_SHADOW',
      label: '高檔爆量上影線',
      detail: `量比 ${(volRatio5 ?? 0).toFixed(1)}x，上影線為實體 ${(upperShadow / body).toFixed(1)} 倍，主力出貨警訊`,
      severity: 'high',
    });
  }

  // 6. 趨勢轉空
  // (imported separately via detectTrend, so we check MA cross as proxy)

  // ════════════════════════════════════════════════════════════════
  // 朱老師獲利方程式（《活用技術分析寶典》p.54）
  // ════════════════════════════════════════════════════════════════

  // 獲利方程式 第3條：收盤出現「頭頭低」→ 出場
  // 偵測：近期兩個波段高點，後面的高點比前面低
  if (index >= 10) {
    const recentHighs: { idx: number; price: number }[] = [];
    for (let i = index - 1; i >= Math.max(1, index - 20) && recentHighs.length < 3; i--) {
      const ci = candles[i];
      const pi = candles[i - 1];
      const ni = candles[i + 1];
      if (ci.high > pi.high && ci.high > ni.high) {
        recentHighs.push({ idx: i, price: ci.high });
      }
    }
    if (recentHighs.length >= 2) {
      const [newerHigh, olderHigh] = recentHighs;
      if (newerHigh.price < olderHigh.price && c.close < newerHigh.price) {
        signals.push({
          type: 'LOWER_LOW',
          label: '頭頭低出場',
          detail: `近期高點${olderHigh.price.toFixed(1)}→${newerHigh.price.toFixed(1)}頭頭低，多頭力竭`,
          severity: 'high',
        });
      }
    }
  }

  // 獲利方程式 第7條：連續急漲3天+大量長黑K覆蓋或吞噬 → 當天出場
  if (index >= 3) {
    const prev3Up = [candles[index-1], candles[index-2], candles[index-3]]
      .every(x => x.close > x.open);
    const isLongBlack = c.close < c.open && body > 0 && (c.open - c.close) / c.open >= 0.02;
    const bigVolume = (volRatio5 ?? 0) > 1.5;

    if (prev3Up && isLongBlack && bigVolume) {
      signals.push({
        type: 'PROFIT_CLIMAX_EXIT',
        label: '急漲後長黑出場',
        detail: `連續3日急漲後出現大量長黑K覆蓋，主力出貨訊號`,
        severity: 'high',
      });
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 朱老師短線20條守則補充（《活用技術分析寶典》p.711-712）
  // ════════════════════════════════════════════════════════════════

  // 第11條：強覆蓋 — 遇壓黑K下跌，跌破前一日紅K的二分之一，K值下彎 → 減碼警示
  if (prev && prev.close > prev.open && c.close < c.open) {
    const prevMidPrice = (prev.open + prev.close) / 2;
    const kdDownTurn = kd_k != null && prevKdK != null && kd_k < prevKdK;
    if (c.close < prevMidPrice && kdDownTurn) {
      signals.push({
        type: 'STRONG_COVER',
        label: '強覆蓋減碼',
        detail: `黑K跌破前日紅K 1/2(${prevMidPrice.toFixed(1)})，KD下彎，可減碼一半`,
        severity: 'medium',
      });
    }
  }

  // 第14條：高檔連2日爆量，回檔連3黑 → 不宜進場
  if (index >= 5) {
    // 找近5日是否有連2日爆量
    let has2DayBigVol = false;
    for (let i = index - 4; i < index - 1; i++) {
      const v1 = candles[i];
      const v2 = candles[i + 1];
      const avg = c.avgVol5;
      if (avg && v1.volume >= avg * 1.5 && v2.volume >= avg * 1.5) {
        has2DayBigVol = true;
        break;
      }
    }
    // 近3日連續收黑
    const last3Black = [candles[index], candles[index-1], candles[index-2]]
      .every(x => x.close < x.open);
    if (has2DayBigVol && last3Black) {
      signals.push({
        type: 'HIGH_VOL_2DAY_3BLACK',
        label: '爆量後連3黑',
        detail: `高檔連2日爆量後回檔連3黑，不宜進場做多`,
        severity: 'high',
      });
    }
  }

  // 第19條：週線接近壓力 + 日線出現黑K跌破MA5 → 多單要先出場
  // 用MA60作為週線壓力的近似（60日≈12週）
  if (c.ma60 != null && ma5 != null && c.close < c.open) {
    const nearMa60 = c.ma60 > c.close && (c.ma60 - c.close) / c.close < 0.05;
    const breakMa5 = prev && prev.ma5 != null && prev.close >= prev.ma5 && c.close < ma5;
    if (nearMa60 && breakMa5) {
      signals.push({
        type: 'WEEKLY_RESIST_BREAK_MA5',
        label: '遇壓破MA5',
        detail: `接近MA60(${c.ma60.toFixed(1)})壓力位，黑K跌破MA5(${ma5.toFixed(1)})，多單先出場`,
        severity: 'high',
      });
    }
  }

  // 第20條：季線(MA60)向下 + 回檔跌破5均 → 即使漲幅未達10%也要先出場
  if (c.ma60 != null && ma5 != null && index >= 5) {
    const prevMa60_5 = candles[index - 5]?.ma60;
    const ma60Declining = prevMa60_5 != null && c.ma60 < prevMa60_5;
    const breakMa5Now = prev && prev.ma5 != null && prev.close >= prev.ma5 && c.close < ma5;
    // 股價在MA60之上（已突破季線但季線仍向下）
    const aboveMa60 = c.close > c.ma60;
    if (ma60Declining && breakMa5Now && aboveMa60) {
      signals.push({
        type: 'SEASON_LINE_DOWN_BREAK',
        label: '季線下彎破5均',
        detail: `MA60(${c.ma60.toFixed(1)})仍下彎，回檔跌破MA5(${ma5.toFixed(1)})，多單先出場`,
        severity: 'medium',
      });
    }
  }

  return signals;
}
