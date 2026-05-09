/**
 * v12 portfolio signals API logic 測試
 *
 * 驗證 Step 3-5 訊號邏輯：
 * - calculateInitialStopLoss / updateStopLossDaily / checkAbsoluteStopLoss
 * - getOperationMA / canUpgradeToLongTerm
 * - checkTakeProfitTargets
 *
 * 純單元測試，不打 API。確保 v12-signals route.ts 用的核心函數結果正確。
 */
// 用 globals (vitest --globals)，不需要 import describe/it/expect
import { calcKLineStopLoss, checkAbsoluteStopLoss } from '../lib/sell/v12StopLoss';
import { checkMAExit, getOperationMA, canUpgradeToLongTerm } from '../lib/sell/v12Operation';
import { checkTakeProfitTargets } from '../lib/sell/v12TakeProfit';

describe('v12 Step 3 — calcKLineStopLoss', () => {
  it('弱紅 K（<2.5%）→ 守 low - 2 ticks', () => {
    // open 100, close 102 (body 2%) → 弱紅 K
    const result = calcKLineStopLoss({ open: 100, high: 103, low: 99, close: 102 }, 0.05);
    expect(result).toBe(99 - 0.1); // low - 2 ticks
  });

  it('中紅 K (2.5-5%) → 守紅 K low', () => {
    // open 100, close 103 (body 3%) → 中紅 K
    const result = calcKLineStopLoss({ open: 100, high: 104, low: 98, close: 103 }, 0.05);
    expect(result).toBe(98);
  });

  it('強紅 K (≥5%) → 守 1/2 位置', () => {
    // open 100, close 110 (body 10%) → 強紅 K
    const result = calcKLineStopLoss({ open: 100, high: 112, low: 99, close: 110 }, 0.05);
    expect(result).toBe(105); // (100+110)/2
  });
});

describe('v12 Step 3 ⑥ — checkAbsoluteStopLoss', () => {
  it('多頭翻空頭 → 強制出場', () => {
    const r = checkAbsoluteStopLoss({
      entryPrice: 100,
      todayClose: 95,
      trendStateToday: '空頭',
      trendStateYesterday: '多頭',
      letter: 'B',
    });
    expect(r.triggered).toBe(true);
    expect(r.reason).toBe('trend-flipped-down');
  });

  it('跌幅 >10% → 強制出場', () => {
    const r = checkAbsoluteStopLoss({
      entryPrice: 100,
      todayClose: 89,
      trendStateToday: '盤整',
      trendStateYesterday: '盤整',
      letter: 'B',
    });
    expect(r.triggered).toBe(true);
    expect(r.reason).toBe('loss-over-10pct');
  });

  it('C 訊號跌破盤整下緣 → 強制出場', () => {
    const r = checkAbsoluteStopLoss({
      entryPrice: 100,
      todayClose: 90,
      trendStateToday: '盤整',
      trendStateYesterday: '盤整',
      letter: 'C',
      consolidationLow: 92,
    });
    expect(r.triggered).toBe(true);
    expect(r.reason).toBe('broke-consolidation');
  });

  it('盤整未觸發任何條件 → 不出場', () => {
    const r = checkAbsoluteStopLoss({
      entryPrice: 100,
      todayClose: 96,
      trendStateToday: '盤整',
      trendStateYesterday: '盤整',
      letter: 'B',
    });
    expect(r.triggered).toBe(false);
  });
});

describe('v12 Step 4 — getOperationMA', () => {
  it('B 短線 → MA5', () => {
    expect(getOperationMA('B', 'short')).toBe('MA5');
  });
  it('P 短線 → MA5（議題 5）', () => {
    expect(getOperationMA('P', 'short')).toBe('MA5');
  });
  it('F 短線 → MA3（議題 S3-1）', () => {
    expect(getOperationMA('F', 'short')).toBe('MA3');
  });
  it('Q 戰法 → 永遠 MA10（戰法軌獨立）', () => {
    expect(getOperationMA('Q', 'short')).toBe('MA10');
    expect(getOperationMA('Q', 'long')).toBe('MA10');
    expect(getOperationMA('Q', 'wave')).toBe('MA10');
  });
  it('B 升級長線 → MA20（衝突 β）', () => {
    expect(getOperationMA('B', 'long')).toBe('MA20');
  });
  it('M 短線 → MA10', () => {
    expect(getOperationMA('M', 'short')).toBe('MA10');
  });
});

describe('v12 Step 4 — canUpgradeToLongTerm', () => {
  it('獲利 ≥10% + 短線 → 可升級', () => {
    const r = canUpgradeToLongTerm(110, 100, 'short');
    expect(r.canUpgrade).toBe(true);
    expect(r.profitPct).toBeCloseTo(0.1, 4);
  });
  it('獲利 <10% → 不可升級', () => {
    const r = canUpgradeToLongTerm(105, 100, 'short');
    expect(r.canUpgrade).toBe(false);
  });
  it('已是長線 → 不可升級', () => {
    const r = canUpgradeToLongTerm(120, 100, 'long');
    expect(r.canUpgrade).toBe(false);
  });
});

describe('v12 Step 4 — checkMAExit B/P 寶典 #5/#6', () => {
  it('B <10% 跌破 MA5 → 續抱（寶典 #5）', () => {
    const r = checkMAExit(98, 100, 'B', 95);  // close=98 < MA5=100, 獲利 (98-95)/95 = 3.16%
    expect(r.shouldExit).toBe(false);
    expect(r.reason).toContain('B/P');
  });
  it('B ≥10% 跌破 MA5 → 停利（寶典 #6）', () => {
    const r = checkMAExit(108, 110, 'B', 95);  // close=108 < MA5=110, 獲利 13.7%
    expect(r.shouldExit).toBe(true);
    expect(r.reason).toContain('B/P 寶典 #6');
  });
  it('其他訊號跌破 MA → 直接出場（不適用 #5/#6）', () => {
    const r = checkMAExit(95, 100, 'C', 90);
    expect(r.shouldExit).toBe(true);
    expect(r.reason).toContain('Step 4 ② 跌破均線');
  });
});

describe('v12 Step 5 — checkTakeProfitTargets', () => {
  it('達型態目標價 → 直接停利', () => {
    const r = checkTakeProfitTargets({
      letter: 'N',
      entryPrice: 100,
      todayClose: 130,
      patternTargetPrice: 130,
    });
    expect(r.triggered).toBe(true);
    expect(r.reason).toBe('pattern-target');
  });

  it('乖離 ≥15% → 切 MA5（不直接停利）', () => {
    const r = checkTakeProfitTargets({
      letter: 'B',
      entryPrice: 100,
      todayClose: 130,
      todayMA20: 110,  // 乖離 = 18.18%
    });
    expect(r.triggered).toBe(false);
    expect(r.reason).toBe('high-deviation');
    expect(r.modeRecommendation).toBe('short-bias-MA5');
  });

  it('B 達 10% → 啟用進階紀律', () => {
    const r = checkTakeProfitTargets({
      letter: 'B',
      entryPrice: 100,
      todayClose: 110,
      todayMA20: 105,  // 乖離 4.76% < 15%
    });
    expect(r.reason).toBe('profit-target-10');
    expect(r.enhancedDisciplineEnabled).toBe(true);
  });

  it('Q 達 10% → 不啟用進階紀律（戰法軌獨立）', () => {
    const r = checkTakeProfitTargets({
      letter: 'Q',
      entryPrice: 100,
      todayClose: 110,
    });
    expect(r.enhancedDisciplineEnabled).toBe(false);
  });
});

describe('v12 整合場景', () => {
  it('場景 1：B 訊號 +12% 跌破 MA5 → 寶典 #6 停利', () => {
    // 進場 100，今日 112，MA5 = 113
    const ma = getOperationMA('B', 'short');
    expect(ma).toBe('MA5');
    const r = checkMAExit(112, 113, 'B', 100);
    expect(r.shouldExit).toBe(true);
  });

  it('場景 2：升級長線後 B 用 MA20', () => {
    expect(getOperationMA('B', 'long')).toBe('MA20');
  });

  it('場景 3：Q 戰法 +20%，操作模式不影響均線', () => {
    expect(getOperationMA('Q', 'short')).toBe('MA10');
    expect(getOperationMA('Q', 'long')).toBe('MA10');
  });

  it('場景 4：跌幅 11% 翻空頭 → 兩條件都觸發但只回最先匹配的 ⑥-2', () => {
    const r = checkAbsoluteStopLoss({
      entryPrice: 100,
      todayClose: 89,
      trendStateToday: '空頭',
      trendStateYesterday: '多頭',
      letter: 'B',
    });
    expect(r.triggered).toBe(true);
    // ⑥-2 翻空頭優先（function 順序）
    expect(r.reason).toBe('trend-flipped-down');
  });
});
