import { CandleWithIndicators } from '@/types';
import { findPivots, detectTrend } from '@/lib/analysis/trendAnalysis';

export type SellSignalType =
  | 'DEATH_CROSS'         // MA5 crosses below MA20
  | 'HIGH_VOL_UPPER_SHADOW' // High volume + long upper shadow in uptrend
  | 'KD_DEATH_CROSS'      // KD high-level death cross (K crosses below D when both > 70)
  | 'BREAK_MA5'           // Close breaks below MA5 after being above
  | 'BREAK_MA10'          // Close breaks below MA10（朱家泓長短線綜合操作法核心出場線）
  | 'BREAK_MA20'          // Close breaks below MA20 (serious)
  | 'TREND_BEARISH'       // Trend has turned bearish
  // 朱老師獲利方程式（《活用技術分析寶典》p.54）
  | 'LOWER_LOW'           // 收盤出現「頭頭低」
  | 'PROFIT_BREAK_MA5'    // 獲利>10% + 跌破MA5（寶典 p.711 第 18 條）
  | 'PROFIT_CLIMAX_EXIT'  // 獲利>20% 或連續急漲+長黑覆蓋
  // 朱老師短線20條守則補充（p.711-712）
  | 'STRONG_COVER'        // 強覆蓋：黑K跌破前日紅K 1/2 + K值下彎（第11條）
  | 'HIGH_VOL_2DAY_3BLACK' // 高檔連2日爆量+回檔連3黑（第14條）
  | 'WEEKLY_RESIST_BREAK_MA5' // 週線遇壓+黑K跌破MA5（第19條）
  | 'SEASON_LINE_DOWN_BREAK' // 季線向下回檔跌破5均（第20條）
  // 寶典 Part 11-1 停損 5 法第 5 條「支阻停損」（p.703）
  | 'SUPPORT_BREAK_STOPLOSS' // 跌破關鍵支撐（前波低點 / 季線 MA60）→ 多單停損
  // 寶典 Part 11-1 停利 / 短線 K 線出場法
  | 'RED_K_LOW_BREAK'     // 收盤跌破最後一根紅 K 低點（寶典短線 K 線出場法）
  // 寶典「自高檔下殺 8 個 K 線訊號」（抓住線圖第 3 篇 p.150-154）
  | 'TRENDLINE_BREAK_BLACK' // 第 1 條：跌破上升切線長黑 K
  | 'HIGH_LEVEL_DOJI'     // 第 3 條：高檔十字 K（次日跌破前一日最低）
  | 'HIGH_LEVEL_HANGING_MAN' // 第 4 條：高檔吊人 K（長下影）
  | 'HIGH_LEVEL_BEARISH_ENGULF' // 第 6 條：高檔陰包陽吞噬
  | 'HIGH_LEVEL_OPEN_FLAT_BLACK'; // 第 7 條：高檔開平低（開=昨低）轉長黑

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
      // 事件型觸發：頭頭低成立 + 今日為「自 newerHigh 形成以來首次 close < newerHigh」。
      // 之後每天即使 close < newerHigh 也不重複報（避免持續狀態 noise）。
      let firstBreakIdx = -1;
      if (newerHigh.price < olderHigh.price) {
        for (let i = newerHigh.idx + 1; i <= index; i++) {
          if (candles[i].close < newerHigh.price) { firstBreakIdx = i; break; }
        }
      }
      if (firstBreakIdx === index) {
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

  // ════════════════════════════════════════════════════════════════
  // 寶典 p.711 第 18 條：上漲 > 10% + 跌破 MA5 → 停利
  // 推算「上漲 %」：用近 20 根 K 的最低收盤當基準（短線進場後的相對漲幅）
  // ════════════════════════════════════════════════════════════════
  if (index >= 20 && ma5 != null && prev?.ma5 != null) {
    const window = candles.slice(Math.max(0, index - 20), index);
    const minClose = Math.min(...window.map(k => k.close).filter(v => v > 0));
    if (minClose > 0) {
      const gainPct = (c.close - minClose) / minClose * 100;
      const breakMa5Now = prev.close >= prev.ma5 && c.close < ma5;
      if (gainPct > 10 && breakMa5Now) {
        signals.push({
          type: 'PROFIT_BREAK_MA5',
          label: '獲利>10%破MA5',
          detail: `近20日最低${minClose.toFixed(2)}→今日${c.close.toFixed(2)}（+${gainPct.toFixed(1)}%），跌破 MA5(${ma5.toFixed(2)}) 停利`,
          severity: 'high',
        });
      }
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 朱家泓「長短線綜合操作法」核心出場線：跌破 MA10
  //   寶典 Part 11-1 停損 5 法第 3 條 + 5 步驟步驟 4 第 6 章策略 3
  //   多頭跌破 MA10 → 停利出場（MA10 是中短線分界）
  // ════════════════════════════════════════════════════════════════
  if (c.ma10 != null && prev?.ma10 != null) {
    if (prev.close >= prev.ma10 && c.close < c.ma10) {
      signals.push({
        type: 'BREAK_MA10',
        label: '跌破MA10',
        detail: `收盤(${c.close}) 跌破 MA10(${c.ma10.toFixed(2)})，朱家泓綜合操作法停利線`,
        severity: 'high',
      });
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 寶典 Part 11-1 短線 K 線出場法：收盤跌破最後一根「中長紅 K」低點
  //   找近 5 根中最後一根中長紅 K（實體 ≥ 2%，視為有意義的進場/動能 K），
  //   收盤跌破該紅 K low → 短線出場（書本本意是進場那根紅K，無進場資訊
  //   時用近期中長紅K近似，避免被小紅K觸發太多 noise）
  // ════════════════════════════════════════════════════════════════
  if (index >= 5) {
    let lastRedK: typeof c | null = null;
    for (let i = index - 1; i >= Math.max(0, index - 5); i--) {
      const k = candles[i];
      const kBodyPct = k.open > 0 ? (k.close - k.open) / k.open : 0;
      if (k.close > k.open && kBodyPct >= 0.02) { lastRedK = k; break; }
    }
    if (lastRedK && c.close < lastRedK.low) {
      signals.push({
        type: 'RED_K_LOW_BREAK',
        label: '跌破紅K低點',
        detail: `收盤(${c.close}) 跌破近期中長紅 K(${lastRedK.date}) 低點 ${lastRedK.low.toFixed(2)}，短線 K 線出場法`,
        severity: 'high',
      });
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 寶典「自高檔下殺 8 個 K 線訊號」（抓住線圖第 3 篇 p.150-154）
  //   高檔判定：MA5 > MA20（多頭中），且非低檔
  // ════════════════════════════════════════════════════════════════
  const isHighLevel = ma5 != null && ma20 != null && ma5 > ma20;

  // 第 1 條：跌破上升切線長黑 K（用 MA20 上升 + 黑K跌破前 2 日最低當近似切線）
  if (isHighLevel && index >= 22) {
    const ma20Up = c.ma20 != null && candles[index - 5]?.ma20 != null && c.ma20 > candles[index - 5].ma20!;
    const isLongBlack = c.close < c.open && c.open > 0 && (c.open - c.close) / c.open >= 0.02;
    const prev2Low = Math.min(candles[index - 1]?.low ?? Infinity, candles[index - 2]?.low ?? Infinity);
    if (ma20Up && isLongBlack && c.close < prev2Low) {
      signals.push({
        type: 'TRENDLINE_BREAK_BLACK',
        label: '跌破切線長黑',
        detail: `上升趨勢中長黑K收 ${c.close.toFixed(2)} 跌破前 2 日最低 ${prev2Low.toFixed(2)}（寶典 8 下殺第 1 條）`,
        severity: 'high',
      });
    }
  }

  // 第 3 條：高檔十字 K → 次日跌破前一日最低 確認
  //   今日 K 是「昨日是十字」+ 今日跌破昨日最低
  if (isHighLevel && prev) {
    const prevBody = Math.abs(prev.close - prev.open);
    const prevRange = prev.high - prev.low;
    const isPrevDoji = prevRange > 0 && prevBody / prevRange < 0.1; // 實體 < range 10% 視為十字
    if (isPrevDoji && c.close < prev.low) {
      signals.push({
        type: 'HIGH_LEVEL_DOJI',
        label: '高檔十字後破低',
        detail: `昨日高檔十字 K，今日收盤 ${c.close.toFixed(2)} 跌破昨日最低 ${prev.low.toFixed(2)}（寶典 8 下殺第 3 條）`,
        severity: 'high',
      });
    }
  }

  // 第 4 條：高檔吊人 K（長下影 + 短實體 + 短上影） → 跌破前一日最低
  //   昨日是吊人，今日跌破昨日最低
  if (isHighLevel && prev) {
    const prevBody = Math.abs(prev.close - prev.open);
    const prevUpper = prev.high - Math.max(prev.close, prev.open);
    const prevLower = Math.min(prev.close, prev.open) - prev.low;
    const isHangingMan = prevBody > 0
      && prevLower >= prevBody * 2
      && prevUpper <= prevBody * 0.5;
    if (isHangingMan && c.close < prev.low) {
      signals.push({
        type: 'HIGH_LEVEL_HANGING_MAN',
        label: '高檔吊人破低',
        detail: `昨日高檔吊人 K（長下影），今日跌破昨日最低 ${prev.low.toFixed(2)}（寶典 8 下殺第 4 條）`,
        severity: 'high',
      });
    }
  }

  // 第 6 條：高檔陰包陽（吞噬）
  //   書本原文：「當日創新高、收盤跌破前最低」
  //   = 今日吞噬昨日紅 K + 創新高 + 收盤跌破昨日最低
  if (isHighLevel && prev) {
    const isPrevRed = prev.close > prev.open;
    const isCurBlack = c.close < c.open;
    const newHighToday = c.high > prev.high;
    const engulf = c.open >= prev.close && c.close <= prev.open; // 今日黑K包覆昨日紅K
    const breakPrevLow = c.close < prev.low; // 書本明列「收盤跌破前最低」
    if (isPrevRed && isCurBlack && newHighToday && engulf && breakPrevLow) {
      signals.push({
        type: 'HIGH_LEVEL_BEARISH_ENGULF',
        label: '高檔陰包陽',
        detail: `今日創新高 ${c.high.toFixed(2)} 後收長黑吞噬昨日紅K，收盤跌破昨日低 ${prev.low.toFixed(2)}（寶典 8 下殺第 6 條）`,
        severity: 'high',
      });
    }
  }

  // 第 7 條：高檔開平低轉長黑 — 開盤=昨日最低（開低）一路拉長黑
  if (isHighLevel && prev && c.open > 0) {
    const openEqualsPrevLow = Math.abs(c.open - prev.low) / prev.low < 0.005; // 開盤近昨低 0.5% 內
    const isLongBlack = c.close < c.open && (c.open - c.close) / c.open >= 0.02;
    if (openEqualsPrevLow && isLongBlack) {
      signals.push({
        type: 'HIGH_LEVEL_OPEN_FLAT_BLACK',
        label: '高檔開平低長黑',
        detail: `開盤 ${c.open.toFixed(2)} ≈ 昨日最低 ${prev.low.toFixed(2)}，一路拉長黑收 ${c.close.toFixed(2)}（寶典 8 下殺第 7 條）`,
        severity: 'high',
      });
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 5 步驟絕對停損 6 情況之第 1 條：走勢轉空頭確認 → TREND_BEARISH
  //   detectTrend 已可判斷，這裡作為 sell signal 透出
  // ════════════════════════════════════════════════════════════════
  if (index >= 21) {
    const trendNow = detectTrend(candles, index);
    const trendPrev = detectTrend(candles, index - 1);
    if (trendPrev !== '空頭' && trendNow === '空頭') {
      signals.push({
        type: 'TREND_BEARISH',
        label: '空頭趨勢確認',
        detail: `走勢由 ${trendPrev} 轉「空頭」確認（頭頭低底底低），絕對停損出場`,
        severity: 'high',
      });
    }
  }

  // 寶典 Part 11-1 停損 5 法第 5 條「支阻停損」（p.703）
  // 做多時關鍵支撐跌破停損。支撐來源（寶典 Part 6）：月線/季線、上升切線、前低、下方大量跳空缺口
  // 月線跌破已由 BREAK_MA20 涵蓋，這裡補：(1) 跌破前波低點 (2) 跌破季線 MA60
  if (index >= 21) {
    const reasons: string[] = [];

    // (1) 跌破前波低點（findPivots 最近的 low pivot）— 破壞多頭結構
    // 限制：之前股價有站上該低點之上（避免本來就在低點下方的個股誤觸）
    const pivots = findPivots(candles, index - 1, 8);
    const lastLow = pivots.find(p => p.type === 'low');
    if (lastLow && prev && prev.close >= lastLow.price && c.close < lastLow.price) {
      reasons.push(`跌破前波低點 ${lastLow.price.toFixed(2)}`);
    }

    // (2) 跌破季線 MA60（中長期支撐）
    if (c.ma60 != null && prev?.ma60 != null && prev.close >= prev.ma60 && c.close < c.ma60) {
      reasons.push(`跌破季線 MA60(${c.ma60.toFixed(2)})`);
    }

    if (reasons.length > 0) {
      signals.push({
        type: 'SUPPORT_BREAK_STOPLOSS',
        label: '關鍵支撐跌破',
        detail: `${reasons.join('、')}，依寶典停損 5 法第 5 條「支阻停損」多單應出場`,
        severity: 'high',
      });
    }
  }

  return signals;
}
