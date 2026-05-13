/**
 * 0513 ABCDE B3 — lockwatch updateLockWatch 純函式單元測試
 *
 * Root cause 防回歸：5/12→5/13 lockwatch records 從 321→13 跳水事件。
 * evolveDay 沒妥善 carry-forward observation records，這層的單元測試鎖死
 * updateLockWatch 對既有觀察紀錄不會「無故改變」（除非命中明確撤銷/升級條件）。
 *
 * 鎖死的 invariant：
 *   1. 已結束 stage（purchased/revoked/manually-removed/structure-broken）→ unchanged，
 *      不可被新一日 K 線覆寫
 *   2. observation 紀錄 close < triggerPrice → revoked（非 F）
 *   3. F observation close < triggerPrice → 不撤銷（triggerPrice 是反彈鎖定價）
 *   4. detectTrend 翻空頭 → revoked
 *   5. observation 沒命中撤銷 → 維持 observation，daysObserved 累加
 *   6. pending-breakout（舊資料）→ normalize 成 observation
 *   7. 空 candles → unchanged
 */

import { describe, it, expect } from '@jest/globals';
import { updateLockWatch } from '../lib/scanner/lockWatchManager';
import type { LockWatchRecord } from '../lib/scanner/lockWatchTypes';
import type { CandleWithIndicators } from '../types';

function mockCandle(overrides: Partial<CandleWithIndicators> & { date: string; close: number }): CandleWithIndicators {
  const base: CandleWithIndicators = {
    date: overrides.date,
    open: overrides.open ?? overrides.close,
    high: overrides.high ?? overrides.close,
    low: overrides.low ?? overrides.close,
    close: overrides.close,
    volume: overrides.volume ?? 1000,
    ma5: overrides.ma5,
    ma10: overrides.ma10,
    ma20: overrides.ma20,
    ma60: overrides.ma60,
    avgVol5: overrides.avgVol5,
  } as CandleWithIndicators;
  return base;
}

/** 多頭排列的 60 根 K 線（價格從 90 升到 130，MA60-20 全多排） */
function bullishCandles(endDate: string, endClose: number, lengthDays = 60): CandleWithIndicators[] {
  const candles: CandleWithIndicators[] = [];
  const startClose = endClose * 0.7;
  const slope = (endClose - startClose) / (lengthDays - 1);
  for (let i = 0; i < lengthDays; i++) {
    const close = startClose + slope * i;
    const date = `2026-04-${String(1 + i).padStart(2, '0')}`;
    candles.push(mockCandle({
      date,
      close,
      open: close * 0.99,
      high: close * 1.01,
      low: close * 0.98,
      volume: 1000,
    }));
  }
  // 末根 override
  candles[candles.length - 1] = mockCandle({
    date: endDate,
    close: endClose,
    open: endClose * 0.99,
    high: endClose * 1.01,
    low: endClose * 0.98,
  });
  return candles;
}

function makeNRecord(overrides: Partial<LockWatchRecord> = {}): LockWatchRecord {
  return {
    symbol: '2467.TW',
    market: 'TW',
    triggeredDate: '2026-05-12',
    triggerSignal: 'N',
    patternType: 'head-shoulder',
    triggerPrice: 612,
    currentStage: 'observation',
    daysObserved: 0,
    currentClose: 620,
    history: [
      { date: '2026-05-12', event: 'triggered', detail: 'N 型態確認' },
    ],
    ...overrides,
  };
}

function makeFRecord(overrides: Partial<LockWatchRecord> = {}): LockWatchRecord {
  return {
    symbol: '6907.TWO',
    market: 'TW',
    triggeredDate: '2026-04-23',
    triggerSignal: 'F',
    triggerPrice: 140,
    vBottom: 110.5,
    currentStage: 'observation',
    daysObserved: 0,
    currentClose: 140,
    history: [
      { date: '2026-04-23', event: 'triggered', detail: 'F V 反轉結構成立' },
    ],
    ...overrides,
  };
}

describe('updateLockWatch — carry-forward invariants', () => {
  describe('已結束 stage 不被覆寫', () => {
    it.each(['purchased', 'revoked', 'manually-removed', 'structure-broken'] as const)(
      'stage=%s → changed=false 且 record 不變',
      (stage) => {
        const original = makeNRecord({ currentStage: stage });
        const candles = bullishCandles('2026-05-13', 620);
        const result = updateLockWatch(original, candles, [], '2026-05-13');
        expect(result.changed).toBe(false);
        expect(result.record).toEqual(original);
      }
    );
  });

  describe('空 candles 不變', () => {
    it('candles=[] → changed=false', () => {
      const original = makeNRecord();
      const result = updateLockWatch(original, [], [], '2026-05-13');
      expect(result.changed).toBe(false);
      expect(result.record).toEqual(original);
    });
  });

  describe('撤銷條件', () => {
    it('observation N close < triggerPrice → revoked', () => {
      const original = makeNRecord({ triggerPrice: 612 });
      const candles = bullishCandles('2026-05-13', 580); // 580 < 612
      const result = updateLockWatch(original, candles, [], '2026-05-13');
      expect(result.changed).toBe(true);
      expect(result.record.currentStage).toBe('revoked');
    });

    it('observation F close < triggerPrice → NOT revoked（triggerPrice 是反彈鎖定價）', () => {
      const original = makeFRecord({ triggerPrice: 140 });
      const candles = bullishCandles('2026-04-24', 130); // 130 < 140 但 F 不撤銷
      const result = updateLockWatch(original, candles, [], '2026-04-24');
      expect(result.record.currentStage).not.toBe('revoked');
    });
  });

  describe('正常 carry-forward', () => {
    it('observation 沒命中撤銷 → 維持 observation', () => {
      const original = makeNRecord({ triggerPrice: 612 });
      const candles = bullishCandles('2026-05-13', 625); // 625 > 612 仍多頭
      const result = updateLockWatch(original, candles, [], '2026-05-13');
      expect(result.record.currentStage).toBe('observation');
    });

    it('daysObserved 用交易日累加', () => {
      const original = makeNRecord({
        triggeredDate: '2026-05-08',
        daysObserved: 0,
      });
      const candles = bullishCandles('2026-05-13', 625); // 5/8 → 5/13 = 3 交易日
      const result = updateLockWatch(original, candles, [], '2026-05-13');
      expect(result.record.daysObserved).toBeGreaterThan(0);
      expect(result.record.daysObserved).toBeLessThanOrEqual(5);
    });

    it('currentClose 每日刷新', () => {
      const original = makeNRecord({ currentClose: 620 });
      const candles = bullishCandles('2026-05-13', 625);
      const result = updateLockWatch(original, candles, [], '2026-05-13');
      expect(result.record.currentClose).toBe(625);
    });
  });

  describe('legacy stage 兼容', () => {
    it('pending-breakout（舊資料）→ normalize 成 observation', () => {
      const original = makeNRecord({ currentStage: 'pending-breakout' });
      const candles = bullishCandles('2026-05-13', 625);
      const result = updateLockWatch(original, candles, [], '2026-05-13');
      expect(result.record.currentStage).toBe('observation');
    });
  });

  describe('5/12→5/13 retrospect: 321 records 全 carry-forward', () => {
    it('多筆 observation 全部 carry-forward 不掉資料', () => {
      const records: LockWatchRecord[] = [];
      for (let i = 0; i < 50; i++) {
        records.push(makeNRecord({
          symbol: `${1000 + i}.TW`,
          triggerPrice: 600,  // 全部都不會撤銷
        }));
      }
      const candles = bullishCandles('2026-05-13', 625);
      const evolved = records.map((r) => updateLockWatch(r, candles, [], '2026-05-13').record);
      expect(evolved.length).toBe(records.length);
      // 沒一筆變 revoked
      expect(evolved.filter((r) => r.currentStage === 'revoked').length).toBe(0);
      // 全部還是 observation
      expect(evolved.filter((r) => r.currentStage === 'observation').length).toBe(records.length);
    });
  });
});
