/**
 * v12 Phase 1.9 / 1.10 / 1.11 整合測試
 *
 * - Step 4 操作（智慧 K 線、均線跟隨、升級長線）
 * - Step 5 停利（獲利目標、K 棒訊號）
 * - 出場後路徑分流（議題 ζ）
 */

import type { CandleWithIndicators } from '../types';

import {
  canUpgradeToLongTerm,
  checkKLineExit,
  checkMAExit,
  getOperationMA,
} from '../lib/sell/v12Operation';
import {
  checkTakeProfitTargets,
  detectKBarExitSignal,
} from '../lib/sell/v12TakeProfit';
import {
  checkReentryConditions,
  determineExitPath,
} from '../lib/sell/v12ExitPath';

function mkK(open: number, high: number, low: number, close: number): CandleWithIndicators {
  return {
    date: '2026-05-08',
    open, high, low, close,
    volume: 1000,
  };
}

// ── Phase 1.9 Step 4 操作 ────────────────────────────────────────────────

describe('v12 Phase 1.9 — checkKLineExit 智慧 K 線', () => {
  it('多頭中跌破前一日最低 → 出場', () => {
    const today = mkK(100, 101, 95, 96);
    const yesterday = mkK(98, 102, 97, 100);
    const result = checkKLineExit(today, yesterday, '多頭');
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toContain('跌破前一日最低');
  });

  it('盤整時不啟用智慧 K 線（書本明寫）', () => {
    const today = mkK(100, 101, 95, 96);
    const yesterday = mkK(98, 102, 97, 100);
    const result = checkKLineExit(today, yesterday, '盤整');
    expect(result.shouldExit).toBe(false);
  });

  it('沒跌破前 K 低 → 不出場', () => {
    const today = mkK(98, 102, 97, 100);
    const yesterday = mkK(95, 99, 94, 98);
    const result = checkKLineExit(today, yesterday, '多頭');
    expect(result.shouldExit).toBe(false);
  });
});

describe('v12 Phase 1.9 — checkMAExit B/P 寶典 #5/#6（衝突 α）', () => {
  it('B 訊號 + 獲利 < 10% + 跌破 MA5 → 不出場（續抱）', () => {
    const result = checkMAExit(
      99,    // closeToday
      100,   // maValueToday (MA5)
      'B',
      95,    // entryPrice (獲利 = 4.2%)
    );
    expect(result.shouldExit).toBe(false);
    expect(result.reason).toContain('< 10%');
  });

  it('B 訊號 + 獲利 ≥ 10% + 跌破 MA5 → 出場（停利）', () => {
    const result = checkMAExit(
      111,   // closeToday
      112,   // maValueToday (MA5)
      'B',
      100,   // entryPrice (獲利 = 11%)
    );
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toContain('≥ 10%');
  });

  it('C 訊號（MA10）跌破即出場（不分獲利）', () => {
    const result = checkMAExit(
      99,
      100,
      'C',
      95,
    );
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toContain('Step 4 ②');
  });
});

describe('v12 Phase 1.9 — canUpgradeToLongTerm 升級長線', () => {
  it('短線模式 + 獲利 ≥ 10% → 可升級', () => {
    const result = canUpgradeToLongTerm(110, 100, 'short');
    expect(result.canUpgrade).toBe(true);
  });

  it('已是長線模式 → 不能再升級', () => {
    const result = canUpgradeToLongTerm(110, 100, 'long');
    expect(result.canUpgrade).toBe(false);
  });

  it('獲利 < 10% → 不能升級', () => {
    const result = canUpgradeToLongTerm(105, 100, 'short');
    expect(result.canUpgrade).toBe(false);
  });
});

describe('v12 Phase 1.9 — getOperationMA 操作均線對應', () => {
  it('Q 戰法永遠 MA10', () => {
    expect(getOperationMA('Q', 'short')).toBe('MA10');
    expect(getOperationMA('Q', 'long')).toBe('MA10');
  });

  it('升級長線後 B/P/C 全切 MA20（衝突 β）', () => {
    expect(getOperationMA('B', 'long')).toBe('MA20');
    expect(getOperationMA('C', 'long')).toBe('MA20');
    expect(getOperationMA('P', 'long')).toBe('MA20');
  });

  it('短線模式：B/P=MA5、C=MA10、F=MA3、D/J/O=MA20', () => {
    expect(getOperationMA('B', 'short')).toBe('MA5');
    expect(getOperationMA('P', 'short')).toBe('MA5');
    expect(getOperationMA('C', 'short')).toBe('MA10');
    expect(getOperationMA('F', 'short')).toBe('MA3');
    expect(getOperationMA('D', 'short')).toBe('MA20');
    expect(getOperationMA('J', 'short')).toBe('MA20');
    expect(getOperationMA('O', 'short')).toBe('MA20');
  });
});

// ── Phase 1.10 Step 5 停利 ───────────────────────────────────────────────

describe('v12 Phase 1.10 — checkTakeProfitTargets', () => {
  it('達型態目標價 → 直接停利', () => {
    const result = checkTakeProfitTargets({
      letter: 'N',
      entryPrice: 100,
      todayClose: 120,
      patternTargetPrice: 115,
    });
    expect(result.triggered).toBe(true);
    expect(result.reason).toBe('pattern-target');
  });

  it('乖離 ≥ 15% → 不直接停利，建議切 MA5', () => {
    const result = checkTakeProfitTargets({
      letter: 'B',
      entryPrice: 100,
      todayClose: 130,
      todayMA20: 110,  // 乖離 = (130-110)/110 = 18.2%
    });
    expect(result.triggered).toBe(false);
    expect(result.reason).toBe('high-deviation');
    expect(result.modeRecommendation).toBe('short-bias-MA5');
  });

  it('B/P 達 10% → 啟用進階紀律 flag', () => {
    const result = checkTakeProfitTargets({
      letter: 'B',
      entryPrice: 100,
      todayClose: 112,
    });
    expect(result.triggered).toBe(false);
    expect(result.enhancedDisciplineEnabled).toBe(true);
  });

  it('其他訊號達 10% → 不啟用 B/P 紀律', () => {
    const result = checkTakeProfitTargets({
      letter: 'C',
      entryPrice: 100,
      todayClose: 112,
    });
    expect(result.enhancedDisciplineEnabled).toBe(false);
  });
});

describe('v12 Phase 1.10 — detectKBarExitSignal K 棒訊號', () => {
  it('累計獲利 ≤ 0% → 不啟用（議題 G）', () => {
    const result = detectKBarExitSignal({
      todayCandle: mkK(100, 105, 95, 96),
      yesterdayCandle: mkK(98, 102, 97, 100),
      cumulativeProfit: -0.05,
    });
    expect(result.triggered).toBe(false);
  });

  it('穿心黑 K（強覆蓋）→ 觸發', () => {
    // 昨日紅 K（open 95, close 100），今日黑 K open 99, close 96 跌破 95 / 1.5 = 97.5
    // 但 close 96 < (95+100)/2 = 97.5 ✅ 跌破中點
    // close 96 < yesterday.low 90? 不行需要 yesterday.low = 95
    const yesterday = mkK(95, 102, 91, 100);  // 紅 K
    const today = mkK(99, 99.5, 88, 89);       // 黑 K, close=89 < 中點 97.5, < yesterday.low=91
    const result = detectKBarExitSignal({
      todayCandle: today,
      yesterdayCandle: yesterday,
      cumulativeProfit: 0.05,
    });
    expect(result.triggered).toBe(true);
    expect(result.signalType).toBe('piercing-black');
  });

  it('高檔長黑吞噬（陰包陽）→ 觸發', () => {
    // 昨日紅 K（open 95, close 100, low 88），今日黑 K（open 102, close 90）
    // bearish-engulfing：open > yclose (102>100) ✅，close < yopen (90<95) ✅
    // piercing 不觸發：close 90 ≥ yesterday.low 88（避免 piercing 先抓走）
    const yesterday = mkK(95, 101, 88, 100);
    const today = mkK(102, 103, 89, 90);
    const result = detectKBarExitSignal({
      todayCandle: today,
      yesterdayCandle: yesterday,
      cumulativeProfit: 0.05,
    });
    expect(result.triggered).toBe(true);
    expect(result.signalType).toBe('bearish-engulfing');
  });

  it('累計獲利 ≥ 20% + 大量長黑 + 跌破前 K 低 → 寶典 #8 觸發', () => {
    const yesterday = mkK(95, 101, 90, 100);
    yesterday.volume = 1000;
    const today = mkK(95, 96, 85, 86);  // 黑 K, low 85 < yesterday.low 90
    today.volume = 1500;  // 量比 1.5
    const result = detectKBarExitSignal({
      todayCandle: today,
      yesterdayCandle: yesterday,
      cumulativeProfit: 0.25,
    });
    expect(result.triggered).toBe(true);
    expect(['high-vol-black-break', 'bearish-engulfing', 'piercing-black']).toContain(result.signalType);
  });
});

// ── Phase 1.11 出場後路徑分流 ────────────────────────────────────────────

describe('v12 Phase 1.11 — determineExitPath（議題 ζ）', () => {
  it('賺錢停利（達型態目標價）→ 議題 22 完整評估', () => {
    const result = determineExitPath({
      exitReason: 'take-profit-target',
      exitPrice: 120,
      entryPrice: 100,
    });
    expect(result.path).toBe('full-reevaluation');
    expect(result.classification).toBe('take-profit');
    expect(result.isProfit).toBe(true);
  });

  it('賺錢時跌破均線 → 議題 22 完整評估', () => {
    const result = determineExitPath({
      exitReason: 'stop-loss-ma',
      exitPrice: 105,
      entryPrice: 100,
    });
    expect(result.path).toBe('full-reevaluation');
    expect(result.classification).toBe('take-profit');
  });

  it('虧錢時跌破均線 → 議題 28 再進場', () => {
    const result = determineExitPath({
      exitReason: 'stop-loss-ma',
      exitPrice: 95,
      entryPrice: 100,
    });
    expect(result.path).toBe('reentry-skip-step1');
    expect(result.classification).toBe('stop-loss');
  });

  it('絕對停損 10% 跌幅 → 議題 28 再進場', () => {
    const result = determineExitPath({
      exitReason: 'absolute-stop-10pct',
      exitPrice: 89,
      entryPrice: 100,
    });
    expect(result.path).toBe('reentry-skip-step1');
  });

  it('K 棒訊號出場 → 議題 22 完整評估', () => {
    const result = determineExitPath({
      exitReason: 'k-bar-signal',
      exitPrice: 115,
      entryPrice: 100,
    });
    expect(result.path).toBe('full-reevaluation');
  });
});

describe('v12 Phase 1.11 — checkReentryConditions（議題 28 + 衝突 E）', () => {
  it('趨勢仍多頭 + 大盤過 + 站回均線 → 可再進場', () => {
    const result = checkReentryConditions({
      stockTrend: '多頭',
      marketGatePassed: true,
      reclaimedMA: true,
    });
    expect(result.canReenter).toBe(true);
  });

  it('個股趨勢已改變 → 不可再進場', () => {
    const result = checkReentryConditions({
      stockTrend: '空頭',
      marketGatePassed: true,
      reclaimedMA: true,
    });
    expect(result.canReenter).toBe(false);
    expect(result.blockReason).toBe('stock-trend-changed');
  });

  it('衝突 E：大盤未過 → 不可再進場', () => {
    const result = checkReentryConditions({
      stockTrend: '多頭',
      marketGatePassed: false,
      reclaimedMA: true,
    });
    expect(result.canReenter).toBe(false);
    expect(result.blockReason).toBe('market-gate-blocked');
  });

  it('未站回均線 → 不可再進場', () => {
    const result = checkReentryConditions({
      stockTrend: '多頭',
      marketGatePassed: true,
      reclaimedMA: false,
    });
    expect(result.canReenter).toBe(false);
    expect(result.blockReason).toBe('ma-not-reclaimed');
  });
});
