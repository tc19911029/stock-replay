/**
 * v12 Phase 1.6 / 1.7 / 1.8 整合測試
 *
 * - LockWatch 機制（F/N 觀察名單）
 * - Provisional 3 天驗證（K/D）
 * - Step 3 停損（每訊號單一主方法）
 */

import {
  createLockWatchFromF,
  createLockWatchFromN,
  filterActiveRecords,
  markLockWatchPurchased,
  removeLockWatchManually,
} from '../lib/scanner/lockWatchManager';
import {
  createProvisional,
  isUnstableSignal,
  reTriggerProvisional,
} from '../lib/scanner/provisionalManager';
import {
  SIGNAL_TO_FIXED_STOP_PCT,
  SIGNAL_TO_PRIMARY_STOP,
  SIGNAL_TO_TRAILING_MA,
  calcKLineStopLoss,
  calculateInitialStopLoss,
  checkAbsoluteStopLoss,
} from '../lib/sell/v12StopLoss';
import type { V12Letter } from '../lib/analysis/v12Signals';

// ── Phase 1.6 LockWatch ──────────────────────────────────────────────────

describe('v12 Phase 1.6 — LockWatch 機制', () => {
  it('建立 F LockWatch（observation 階段）', () => {
    const record = createLockWatchFromF({
      symbol: '2330',
      market: 'TW',
      triggeredDate: '2026-05-08',
      triggerPrice: 100,
    });
    expect(record.triggerSignal).toBe('F');
    expect(record.currentStage).toBe('observation');
    expect(record.daysObserved).toBe(0);
    expect(record.history.length).toBe(1);
    expect(record.history[0].event).toBe('triggered');
  });

  it('建立 N LockWatch 含 patternType', () => {
    const record = createLockWatchFromN({
      symbol: '3035',
      market: 'TW',
      triggeredDate: '2026-05-08',
      patternType: 'triple-bottom',
      triggerPrice: 50,
      patternTargetPrice: 60,
      patternAchievementRate: 95,
    });
    expect(record.triggerSignal).toBe('N');
    expect(record.patternType).toBe('triple-bottom');
    expect(record.patternAchievementRate).toBe(95);
  });

  it('用戶手動移除 LockWatch（議題 17）', () => {
    const original = createLockWatchFromF({
      symbol: '2330', market: 'TW', triggeredDate: '2026-05-08', triggerPrice: 100,
    });
    const removed = removeLockWatchManually(original, '2026-05-15', '不想觀察了');
    expect(removed.currentStage).toBe('manually-removed');
    expect(removed.history.length).toBe(2);
    expect(removed.history[1].event).toBe('manual-remove');
  });

  it('用戶買進事件（議題 62）', () => {
    const original = createLockWatchFromN({
      symbol: '2330', market: 'TW', triggeredDate: '2026-05-08',
      patternType: 'head-shoulder', triggerPrice: 100,
    });
    const purchased = markLockWatchPurchased(original, '2026-05-13', 102.5);
    expect(purchased.currentStage).toBe('purchased');
    expect(purchased.history[1].event).toBe('purchased');
  });

  it('filterActiveRecords 只回傳 active 的（observation/entry-signal）', () => {
    const r1 = createLockWatchFromF({ symbol: 'A', market: 'TW', triggeredDate: '2026-05-08', triggerPrice: 100 });
    const r2 = removeLockWatchManually(
      createLockWatchFromF({ symbol: 'B', market: 'TW', triggeredDate: '2026-05-08', triggerPrice: 100 }),
      '2026-05-09',
    );
    const r3 = markLockWatchPurchased(
      createLockWatchFromF({ symbol: 'C', market: 'TW', triggeredDate: '2026-05-08', triggerPrice: 100 }),
      '2026-05-09', 105,
    );
    const active = filterActiveRecords([r1, r2, r3]);
    expect(active.length).toBe(1);
    expect(active[0].symbol).toBe('A');
  });
});

// ── Phase 1.7 Provisional ────────────────────────────────────────────────

describe('v12 Phase 1.7 — Provisional 3 天驗證', () => {
  it('createProvisional 初始狀態正確', () => {
    const p = createProvisional({ triggerPrice: 105, triggeredDate: '2026-05-08' });
    expect(p.status).toBe('provisional');
    expect(p.daysRemaining).toBe(3);
    expect(p.triggerPrice).toBe(105);
    expect(p.revocationCount).toBe(0);
    expect(p.history[0].event).toBe('triggered');
  });

  it('isUnstableSignal: 撤銷 < 2 次 → false', () => {
    const p = createProvisional({ triggerPrice: 105, triggeredDate: '2026-05-08' });
    expect(isUnstableSignal(p)).toBe(false);
  });

  it('isUnstableSignal: 30 天內撤銷 ≥ 2 次 → true（議題 7）', () => {
    const p = createProvisional({ triggerPrice: 105, triggeredDate: '2026-05-01' });
    p.revocationCount = 2;
    expect(isUnstableSignal(p)).toBe(true);
  });

  it('reTriggerProvisional 重觸發保留歷史', () => {
    const original = createProvisional({ triggerPrice: 100, triggeredDate: '2026-05-01' });
    original.history.push({ date: '2026-05-03', event: 'revoked-price' });
    const retrigger = reTriggerProvisional(original, 110, '2026-05-08');
    expect(retrigger.triggerPrice).toBe(110);
    expect(retrigger.daysRemaining).toBe(3);
    expect(retrigger.revocationCount).toBe(1);  // 30 天內 1 次撤銷
    expect(retrigger.history.length).toBeGreaterThan(original.history.length);
  });
});

// ── Phase 1.8 Step 3 停損 ────────────────────────────────────────────────

describe('v12 Phase 1.8 — 字母 → 主停損方法對應', () => {
  it('B/P/A 用 ① 紅 K low', () => {
    expect(SIGNAL_TO_PRIMARY_STOP.B).toBe('red-k-low');
    expect(SIGNAL_TO_PRIMARY_STOP.P).toBe('red-k-low');
    expect(SIGNAL_TO_PRIMARY_STOP.A).toBe('red-k-low');
  });

  it('C/E/K/D/N/O 用 ⑤ 結構支撐', () => {
    expect(SIGNAL_TO_PRIMARY_STOP.C).toBe('support-level');
    expect(SIGNAL_TO_PRIMARY_STOP.E).toBe('support-level');
    expect(SIGNAL_TO_PRIMARY_STOP.K).toBe('support-level');
    expect(SIGNAL_TO_PRIMARY_STOP.D).toBe('support-level');
    expect(SIGNAL_TO_PRIMARY_STOP.N).toBe('support-level');
    expect(SIGNAL_TO_PRIMARY_STOP.O).toBe('support-level');
  });

  it('J/M/F 用 ② pivot low', () => {
    expect(SIGNAL_TO_PRIMARY_STOP.J).toBe('pivot-low');
    expect(SIGNAL_TO_PRIMARY_STOP.M).toBe('pivot-low');
    expect(SIGNAL_TO_PRIMARY_STOP.F).toBe('pivot-low');
  });

  it('L 用 ① 黑 K low', () => {
    expect(SIGNAL_TO_PRIMARY_STOP.L).toBe('red-k-low');  // 但實際讀 triggerKLow
  });

  it('Q 用 MA10', () => {
    expect(SIGNAL_TO_PRIMARY_STOP.Q).toBe('ma10');
  });

  it('跟隨均線對應', () => {
    expect(SIGNAL_TO_TRAILING_MA.B).toBe('MA5');
    expect(SIGNAL_TO_TRAILING_MA.P).toBe('MA5');
    expect(SIGNAL_TO_TRAILING_MA.J).toBe('MA20');
    expect(SIGNAL_TO_TRAILING_MA.D).toBe('MA20');
    expect(SIGNAL_TO_TRAILING_MA.O).toBe('MA20');
    expect(SIGNAL_TO_TRAILING_MA.F).toBe('MA3');
    expect(SIGNAL_TO_TRAILING_MA.Q).toBe('MA10');
  });

  it('固定停損比例：多頭軌 5%、轉折軌 10%、F 7%', () => {
    expect(SIGNAL_TO_FIXED_STOP_PCT.B).toBe(0.05);
    expect(SIGNAL_TO_FIXED_STOP_PCT.D).toBe(0.10);
    expect(SIGNAL_TO_FIXED_STOP_PCT.N).toBe(0.10);
    expect(SIGNAL_TO_FIXED_STOP_PCT.F).toBe(0.07);
  });
});

describe('v12 Phase 1.8 — calcKLineStopLoss 三段式', () => {
  it('紅 K 漲幅 < 2.5% → 紅 K 最低 - 2 ticks', () => {
    const result = calcKLineStopLoss({ open: 100, close: 102, low: 99.5, high: 102.5 }, 0.05);
    // bodyPct = 2%, < 2.5% → low - 2 ticks = 99.5 - 0.10 = 99.4
    expect(result).toBeCloseTo(99.4, 2);
  });

  it('紅 K 漲幅 2.5% ~ 5% → 紅 K 最低', () => {
    const result = calcKLineStopLoss({ open: 100, close: 103, low: 99.5, high: 103.5 }, 0.05);
    expect(result).toBe(99.5);
  });

  it('紅 K 漲幅 ≥ 5% → 紅 K 1/2 位置', () => {
    const result = calcKLineStopLoss({ open: 100, close: 106, low: 99, high: 106.5 }, 0.05);
    // bodyPct = 6%, ≥ 5% → (open + close) / 2 = 103
    expect(result).toBe(103);
  });
});

describe('v12 Phase 1.8 — calculateInitialStopLoss', () => {
  it('B 訊號使用 ① 紅 K low + 5% 比例上拉保護', () => {
    const result = calculateInitialStopLoss({
      letter: 'B',
      entryPrice: 100,
      entryKbar: { open: 99, close: 101, low: 98.5, high: 101.5 },
      tickSize: 0.05,
    });
    // bodyPct = 2.02%, < 2.5% → low - 2 ticks = 98.5 - 0.1 = 98.4
    // 5% 比例 = 100 × 0.95 = 95，比 98.4 低 → 維持 98.4
    // 10% 絕對下限 = 90
    expect(result.stopLossPrice).toBeCloseTo(98.4, 1);
    expect(result.primaryMethod).toBe('red-k-low');
  });

  it('套 5% 比例上拉與 10% 絕對下限（議題 S3-7）', () => {
    const result = calculateInitialStopLoss({
      letter: 'B',
      entryPrice: 100,
      entryKbar: { open: 99, close: 101, low: 80, high: 101.5 },  // 紅 K low 異常低
      tickSize: 0.05,
    });
    // 紅 K low - 2 ticks = 79.9
    // B 訊號 5% 比例 = 100 × 0.95 = 95（高於 79.9 → 上拉到 95）
    // 10% 絕對下限 = 90（低於 95 → 維持 95）
    expect(result.stopLossPrice).toBe(95);
    expect(result.absoluteFloor).toBe(90);
  });

  it('F 訊號 7% 上限', () => {
    const result = calculateInitialStopLoss({
      letter: 'F',
      entryPrice: 100,
      entryKbar: { open: 99, close: 101, low: 88, high: 101.5 },
      tickSize: 0.05,
      pivotLow: 88,
    });
    // F 用 pivot low 88，但 7% 上限 = 93 → 上拉到 93
    expect(result.stopLossPrice).toBeGreaterThanOrEqual(93);
  });
});

describe('v12 Phase 1.8 — checkAbsoluteStopLoss', () => {
  it('⑥-4 跌幅 > 10% → 強制出場', () => {
    const result = checkAbsoluteStopLoss({
      entryPrice: 100,
      todayClose: 89,
      trendStateToday: '多頭',
      letter: 'B',
    });
    expect(result.triggered).toBe(true);
    expect(result.reason).toBe('loss-over-10pct');
  });

  it('⑥-2 多頭翻空頭 → 強制出場', () => {
    const result = checkAbsoluteStopLoss({
      entryPrice: 100,
      todayClose: 95,
      trendStateToday: '空頭',
      trendStateYesterday: '多頭',
      letter: 'B',
    });
    expect(result.triggered).toBe(true);
    expect(result.reason).toBe('trend-flipped-down');
  });

  it('⑥-1 C 訊號跌破盤整區 → 強制出場', () => {
    const result = checkAbsoluteStopLoss({
      entryPrice: 100,
      todayClose: 92,
      trendStateToday: '多頭',
      letter: 'C',
      consolidationLow: 95,
    });
    expect(result.triggered).toBe(true);
    expect(result.reason).toBe('broke-consolidation');
  });

  it('⑥-5 F 跌破 V 底 → 強制出場', () => {
    const result = checkAbsoluteStopLoss({
      entryPrice: 100,
      todayClose: 86,
      trendStateToday: '多頭',
      letter: 'F',
      vBottom: 88,
    });
    // close 86 跌破 V 底 88, 但跌幅 = 14% > 10% → ⑥-4 先觸發
    expect(result.triggered).toBe(true);
    expect(['loss-over-10pct', 'structure-broken']).toContain(result.reason);
  });

  it('一般情況 → 不強制出場', () => {
    const result = checkAbsoluteStopLoss({
      entryPrice: 100,
      todayClose: 95,
      trendStateToday: '多頭',
      letter: 'B',
    });
    expect(result.triggered).toBe(false);
  });
});
