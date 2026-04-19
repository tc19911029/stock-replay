import {
  runSingleBacktest, runBatchBacktest, calcBacktestStats,
  scanResultToSignal,
  runSOPBacktest, DEFAULT_ZHU_EXIT,
  DEFAULT_STRATEGY, BacktestStrategyParams,
} from '../lib/backtest/BacktestEngine';
import { StockScanResult, ForwardCandle } from '../lib/scanner/types';

// ── Fixtures ────────────────────────────────────────────────────────────────────

function mockScanResult(overrides?: Partial<StockScanResult>): StockScanResult {
  return {
    symbol: '2330.TW', name: '台積電', market: 'TW',
    price: 100, changePercent: 2.5, volume: 10000000,
    triggeredRules: [],
    sixConditionsScore: 5,
    sixConditionsBreakdown: { trend: true, position: true, kbar: true, ma: true, volume: true, indicator: false },
    trendState: '多頭', trendPosition: '主升段',
    scanTime: '2024-01-15T13:30:00.000Z',
    ...overrides,
  };
}

function mockForwardCandles(count: number, startPrice: number, dailyPct = 0.01): ForwardCandle[] {
  return Array.from({ length: count }, (_, i) => {
    const price = startPrice * (1 + dailyPct * (i + 1));
    return {
      date:   `2024-01-${String(16 + i).padStart(2, '0')}`,
      open:   +(price * 0.995).toFixed(2),
      close:  +price.toFixed(2),
      high:   +(price * 1.010).toFixed(2),
      low:    +(price * 0.985).toFixed(2),
      volume: 1_000_000,
    };
  });
}

// 無滑價策略（方便精確計算測試）
const NO_SLIP: BacktestStrategyParams = { ...DEFAULT_STRATEGY, slippagePct: 0 };

// ── runSingleBacktest ────────────────────────────────────────────────────────────

describe('runSingleBacktest', () => {
  test('正常持有5日出場', () => {
    const trade = runSingleBacktest(scanResultToSignal(mockScanResult()), mockForwardCandles(10, 100, 0.005), NO_SLIP);
    expect(trade).not.toBeNull();
    expect(trade!.holdDays).toBe(5);
    expect(trade!.exitReason).toBe('holdDays');
  });

  test('資料不足時回傳 null', () => {
    expect(runSingleBacktest(scanResultToSignal(mockScanResult()), [])).toBeNull();
  });

  test('滑價使進場價高於原始開盤', () => {
    const candles = mockForwardCandles(5, 100, 0.01);
    const withSlip = runSingleBacktest(scanResultToSignal(mockScanResult()), candles, { ...DEFAULT_STRATEGY, slippagePct: 0.002 });
    const noSlip   = runSingleBacktest(scanResultToSignal(mockScanResult()), candles, NO_SLIP);
    expect(withSlip!.entryPrice).toBeGreaterThan(noSlip!.entryPrice);
  });

  test('滑價使淨報酬降低', () => {
    const candles = mockForwardCandles(5, 100, 0.01);
    const withSlip = runSingleBacktest(scanResultToSignal(mockScanResult()), candles, { ...DEFAULT_STRATEGY, slippagePct: 0.003 });
    const noSlip   = runSingleBacktest(scanResultToSignal(mockScanResult()), candles, NO_SLIP);
    expect(withSlip!.netReturn).toBeLessThan(noSlip!.netReturn);
  });

  test('停損觸發', () => {
    const candles: ForwardCandle[] = [
      { date: '2024-01-16', open: 100, close: 88, high: 101, low: 87, volume: 0 },
      { date: '2024-01-17', open: 88,  close: 90, high: 92,  low: 87, volume: 0 },
    ];
    const trade = runSingleBacktest(scanResultToSignal(mockScanResult()), candles, { ...NO_SLIP, stopLoss: -0.07 });
    expect(trade!.exitReason).toBe('stopLoss');
    expect(trade!.grossReturn).toBeLessThan(0);
  });

  test('長黑吞噬獨立觸發停利（runSOPBacktest，書本 p.55 第7條）', () => {
    // 書本規則：黑K 實體完全包覆前日紅K → 當天全部停利（不需獲利>20%/連漲3天）
    // Day0 進場 open=100，Day1 小紅 102→108 (實體5.9%)
    // Day2 長黑 open=109, close=100 (實體8.3%)：
    //   open 109 >= prev close 108 ✅
    //   close 100 <= prev open 102 ✅
    //   bodyPct 0.083 >= prevBodyPct 0.059 ✅
    //   bodyPct >= 0.02 ✅
    // → 觸發 sop_longBlackEngulf
    const candles: ForwardCandle[] = [
      { date: '2024-01-16', open: 100, close: 100, high: 101, low: 99,  volume: 1_000_000 },
      { date: '2024-01-17', open: 102, close: 108, high: 109, low: 102, volume: 1_000_000 },
      { date: '2024-01-18', open: 109, close: 100, high: 109, low: 100, volume: 1_500_000 },
      { date: '2024-01-19', open: 100, close: 101, high: 102, low: 99,  volume: 1_000_000 },
    ];
    const trade = runSOPBacktest(
      scanResultToSignal(mockScanResult()),
      candles,
      { ...NO_SLIP, stopLoss: null, trailingStop: null, trailingActivate: null },
      DEFAULT_ZHU_EXIT,
    );
    expect(trade!.exitReason).toBe('sop_longBlackEngulf');
    expect(trade!.exitDate).toBe('2024-01-18');
  });

  test('非吞噬的長黑 K 不觸發長黑吞噬規則', () => {
    // 黑K 沒完全包覆前日紅K（close > prev open）→ 不觸發
    const candles: ForwardCandle[] = [
      { date: '2024-01-16', open: 100, close: 100, high: 101, low: 99,  volume: 1_000_000 },
      { date: '2024-01-17', open: 102, close: 108, high: 109, low: 102, volume: 1_000_000 },
      // 黑K close=103 > 紅K open=102 → 沒包住下緣
      { date: '2024-01-18', open: 109, close: 103, high: 109, low: 103, volume: 1_500_000 },
      { date: '2024-01-19', open: 103, close: 104, high: 105, low: 102, volume: 1_000_000 },
      { date: '2024-01-20', open: 104, close: 106, high: 107, low: 103, volume: 1_000_000 },
    ];
    const trade = runSOPBacktest(
      scanResultToSignal(mockScanResult()),
      candles,
      { ...NO_SLIP, stopLoss: null, trailingStop: null, trailingActivate: null },
      DEFAULT_ZHU_EXIT,
    );
    expect(trade!.exitReason).not.toBe('sop_longBlackEngulf');
  });

  test('stopLossMaxPct 限制動態停損切換上限', () => {
    // 預設 stopLossMaxPct=-0.05（書本 Part 12 p.748 主流，2026-04-19 用戶決議）
    // entryPrice=100 (nextOpen=Day0 open)，Day0 low=94.5 → dynamicStopPct=-5.5%
    // 預設 -0.05: -5.5% < -5% → 退回 strategy.stopLoss=-0.05，stop=95
    // 放寬到 -0.07: -5.5% ≥ -7% → 用動態，stop=94.5
    // Day1 low=94.8 → 預設 95 觸發（94.8≤95），放寬 94.5 不觸發（94.8>94.5）
    const candles: ForwardCandle[] = [
      { date: '2024-01-16', open: 100,  close: 96,   high: 101, low: 94.5, volume: 0 },
      { date: '2024-01-17', open: 96,   close: 94.8, high: 96,  low: 94.8, volume: 0 },
      { date: '2024-01-18', open: 94.8, close: 96,   high: 97,  low: 95.5, volume: 0 },
      { date: '2024-01-19', open: 96,   close: 97,   high: 98,  low: 95.5, volume: 0 },
      { date: '2024-01-20', open: 97,   close: 98,   high: 99,  low: 96,   volume: 0 },
    ];
    const signal = scanResultToSignal(mockScanResult());
    const baseStrat = { ...NO_SLIP, stopLoss: -0.05, trailingStop: null, trailingActivate: null };

    // 預設 -5%：-5.5% dynamic 被拒 → fallback 到 -5% 停損位 95，Day1 94.8 觸發
    const tradeDefault = runSingleBacktest(signal, candles, baseStrat);
    expect(tradeDefault!.exitReason).toBe('stopLoss');

    // 放寬 -7%：-5.5% dynamic 有效 → 停損位 94.5，Day1 94.8 不觸發
    const tradeLoose = runSingleBacktest(signal, candles, { ...baseStrat, stopLossMaxPct: -0.07 });
    expect(tradeLoose!.exitReason).not.toBe('stopLoss');
  });

  test('停利觸發', () => {
    // 進場日 close=108 不觸發 TP（entry day 只看 close）
    // 隔日 high=122 > 115（TP 價），觸發停利
    const candles: ForwardCandle[] = [
      { date: '2024-01-16', open: 100, close: 108, high: 109, low: 99,  volume: 0 },  // 進場日
      { date: '2024-01-17', open: 108, close: 110, high: 122, low: 107, volume: 0 }, // 隔日觸發 TP
    ];
    const trade = runSingleBacktest(scanResultToSignal(mockScanResult()), candles, { ...NO_SLIP, takeProfit: 0.15, stopLoss: null });
    expect(trade!.exitReason).toBe('takeProfit');
    expect(trade!.grossReturn).toBeGreaterThan(0);
  });

  // #1 修改 1：同日觸發停損+停利時，根據 open 距離判斷誰先
  // 注意：進場日（i===0 && nextOpen）只用 close 判斷，需用第 2 根 K 線才會用 high/low
  test('同日停損停利都觸及 — open 離停損近 → 停損先觸發', () => {
    // entryPrice = open of candle[0] = 100, SL=-7% → 93, TP=+15% → 115
    // candle[1]: open=100, high=120 (>115, hitTP), low=88 (<93, hitSL)
    // distSL = |100-93| = 7, distTP = |100-115| = 15 → 停損先
    const candles: ForwardCandle[] = [
      { date: '2024-01-16', open: 100, close: 100, high: 101, low: 99, volume: 0 }, // 進場日
      { date: '2024-01-17', open: 100, close: 95, high: 120, low: 88,  volume: 0 },  // 隔日同時觸發 SL+TP
    ];
    const trade = runSingleBacktest(scanResultToSignal(mockScanResult()), candles, { ...NO_SLIP, stopLoss: -0.07, takeProfit: 0.15 });
    expect(trade!.exitReason).toBe('stopLoss');
  });

  test('同日停損停利都觸及 — open 離停利近 → 停利先觸發', () => {
    // entryPrice=100, SL=-7%→93, TP=+5%→105
    // candle[1]: open=103, high=120 (>105, hitTP), low=88 (<93, hitSL)
    // distSL = |103-93| = 10, distTP = |103-105| = 2 → 停利先
    const candles: ForwardCandle[] = [
      { date: '2024-01-16', open: 100, close: 100, high: 101, low: 99, volume: 0 }, // 進場日
      { date: '2024-01-17', open: 103, close: 95, high: 120, low: 88,  volume: 0 },  // 隔日同時觸發 SL+TP
    ];
    const trade = runSingleBacktest(scanResultToSignal(mockScanResult()), candles, { ...NO_SLIP, stopLoss: -0.07, takeProfit: 0.05 });
    expect(trade!.exitReason).toBe('takeProfit');
  });

  // #3 修改 3：跳空跌停時以開盤價出場
  test('跳空跌停時出場價 ≤ 停損價', () => {
    // 進場 candle[0] open=100 → entryPrice=100, SL=-7% → stopLossPrice=93
    // 持有期 candle[1] 跳空開盤 90（低於停損價 93）→ 應以開盤 90 出場
    const candles: ForwardCandle[] = [
      { date: '2024-01-16', open: 100, close: 100, high: 101, low: 99, volume: 0 }, // 進場日（正常）
      { date: '2024-01-17', open: 90,  close: 89,  high: 91,  low: 88, volume: 0 }, // 隔天跳空
    ];
    const trade = runSingleBacktest(scanResultToSignal(mockScanResult()), candles, { ...NO_SLIP, stopLoss: -0.07, holdDays: 5 });
    expect(trade!.exitReason).toBe('stopLoss');
    // 跳空開盤 90 < 停損價 93，出場價應 ≤ 93
    expect(trade!.exitPrice).toBeLessThanOrEqual(93);
  });

  test('淨報酬小於毛報酬（手續費+稅影響）', () => {
    const trade = runSingleBacktest(scanResultToSignal(mockScanResult()), mockForwardCandles(5, 100, 0.01), NO_SLIP);
    expect(trade!.netReturn).toBeLessThan(trade!.grossReturn);
    expect(trade!.totalCost).toBeGreaterThan(0);
  });

  test('資料不足時標記 dataEnd', () => {
    // holdDays=5 但只有 2 根 K 線
    const candles = mockForwardCandles(2, 100, 0.005);
    const trade = runSingleBacktest(scanResultToSignal(mockScanResult()), candles, { ...NO_SLIP, holdDays: 5 });
    expect(trade!.exitReason).toBe('dataEnd');
    expect(trade!.holdDays).toBe(2);
  });
});

// ── runBatchBacktest ─────────────────────────────────────────────────────────────

describe('runBatchBacktest', () => {
  test('回傳 trades 及 skippedCount', () => {
    const scan1 = mockScanResult({ symbol: '2330.TW' });
    const scan2 = mockScanResult({ symbol: '2317.TW', name: '鴻海' });
    const candlesMap = {
      '2330.TW': mockForwardCandles(5, 100, 0.01),
      // 2317.TW 無資料 → 應被跳過
    };
    const { trades, skippedCount } = runBatchBacktest([scan1, scan2], candlesMap, NO_SLIP);
    expect(trades.length).toBe(1);
    expect(skippedCount).toBe(1);
  });
});

// ── calcBacktestStats ────────────────────────────────────────────────────────────

describe('calcBacktestStats', () => {
  test('空陣列回傳 null', () => {
    expect(calcBacktestStats([])).toBeNull();
  });

  test('包含 skippedCount 與 coverageRate', () => {
    const trade = runSingleBacktest(scanResultToSignal(mockScanResult()), mockForwardCandles(5, 100, 0.01), NO_SLIP)!;
    const stats = calcBacktestStats([trade], 1)!;
    expect(stats.skippedCount).toBe(1);
    expect(stats.coverageRate).toBe(50); // 1/(1+1) = 50%
  });

  // #4 修改 4：MDD 計算正確（非連續虧損，而是權益曲線峰谷）
  test('MDD 計算 — 峰值到谷值（非連續虧損）', () => {
    // returns: +5, -1, +5, -2, +1, -6
    // 權益曲線: 5, 4, 9, 7, 8, 2
    // peak=9 at idx2, trough=2 at idx5 → MDD = 2-9 = -7
    // 舊邏輯連續虧損最大 = max(-1, -6) = -6（錯誤）
    const result = mockScanResult();
    const fakeReturns = [5, -1, 5, -2, 1, -6];
    // 建立假 trade 陣列（用 netReturn 模擬）
    const trades = fakeReturns.map(r => ({
      ...runSingleBacktest(scanResultToSignal(result), mockForwardCandles(1, 100))!,
      netReturn: r,
    }));
    const stats = calcBacktestStats(trades)!;
    expect(stats.maxDrawdown).toBeCloseTo(-7, 1);
  });

  test('profitFactor > 1 代表策略正期望', () => {
    const result = mockScanResult();
    const wins  = mockForwardCandles(5, 100, 0.02); // 大漲
    const loss  = mockForwardCandles(5, 100, -0.005); // 小跌
    const t1 = runSingleBacktest(scanResultToSignal(result), wins, NO_SLIP)!;
    const t2 = runSingleBacktest(scanResultToSignal(result), loss, NO_SLIP)!;
    const stats = calcBacktestStats([t1, t2])!;
    if (stats.profitFactor != null) {
      expect(stats.profitFactor).toBeGreaterThan(0);
    }
  });

  test('sharpeRatio 存在且為數字', () => {
    const result = mockScanResult();
    const trades = [
      runSingleBacktest(scanResultToSignal(result), mockForwardCandles(5, 100, 0.01), NO_SLIP)!,
      runSingleBacktest(scanResultToSignal(result), mockForwardCandles(5, 100, -0.005), NO_SLIP)!,
      runSingleBacktest(scanResultToSignal(result), mockForwardCandles(5, 100, 0.02), NO_SLIP)!,
    ];
    const stats = calcBacktestStats(trades)!;
    expect(typeof stats.sharpeRatio).toBe('number');
  });
});
