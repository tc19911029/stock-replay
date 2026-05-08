/**
 * v12 Phase 0.3 資料結構升級 — 型別測試
 *
 * 確保新增的 type 結構正確、向後相容（舊 record 不帶新欄位仍可用）。
 */

import type {
  StockScanResult,
  ScanSession,
  ProvisionalState,
  ProvisionalEvent,
  MtfMode,
} from '../lib/scanner/types';
import type {
  LockWatchRecord,
  LockWatchEvent,
  LockWatchDailySnapshot,
} from '../lib/scanner/lockWatchTypes';
import type { PortfolioHolding } from '../store/portfolioStore';

describe('v12 Phase 0.3 — 向後相容（舊資料無新欄位）', () => {
  it('StockScanResult 沒帶 v12 欄位仍能建構', () => {
    const old: StockScanResult = {
      symbol: '2330',
      name: '台積電',
      market: 'TW',
      price: 1000,
      changePercent: 2.5,
      volume: 100000,
      triggeredRules: [],
      sixConditionsScore: 5,
      sixConditionsBreakdown: {
        trend: true, position: true, kbar: true,
        ma: true, volume: true, indicator: false,
      },
      trendState: '多頭',
      trendPosition: '主升段',
      scanTime: '2026-05-08T13:30:00Z',
    };
    expect(old.schemaVersion).toBeUndefined();
    expect(old.provisional).toBeUndefined();
  });

  it('ScanSession 沒帶 schemaVersion 仍能建構', () => {
    const old: ScanSession = {
      id: 'sess-1',
      market: 'TW',
      date: '2026-05-08',
      scanTime: '2026-05-08T13:30:00Z',
      resultCount: 0,
      results: [],
    };
    expect(old.schemaVersion).toBeUndefined();
  });

  it('PortfolioHolding 沒帶 v12 欄位仍能建構', () => {
    const old: PortfolioHolding = {
      id: '1',
      symbol: '2330',
      name: '台積電',
      shares: 100,
      costPrice: 1000,
      buyDate: '2026-05-08',
    };
    expect(old.triggerPrice).toBeUndefined();
    expect(old.triggerSignal).toBeUndefined();
    expect(old.operationMode).toBeUndefined();
  });
});

describe('v12 Phase 0.3 — 新欄位正確使用', () => {
  it('StockScanResult v12 欄位齊全', () => {
    const provisional: ProvisionalState = {
      triggerPrice: 105,
      daysRemaining: 3,
      status: 'provisional',
      revocationCount: 0,
      history: [
        { date: '2026-05-08', event: 'triggered' },
      ],
    };

    const v12: StockScanResult = {
      symbol: '2330',
      name: '台積電',
      market: 'TW',
      price: 1000,
      changePercent: 2.5,
      volume: 100000,
      triggeredRules: [],
      sixConditionsScore: 5,
      sixConditionsBreakdown: {
        trend: true, position: true, kbar: true,
        ma: true, volume: true, indicator: false,
      },
      trendState: '多頭',
      trendPosition: '主升段',
      scanTime: '2026-05-08T13:30:00Z',
      schemaVersion: 'v12',
      endPhaseFlag: false,
      seasonLineResistance: 1050,
      kdDecliningWarning: false,
      volumeLevel: 'climax',
      provisional,
      lastTrendChangeDate: '2026-04-15',
    };
    expect(v12.schemaVersion).toBe('v12');
    expect(v12.volumeLevel).toBe('climax');
    expect(v12.provisional?.daysRemaining).toBe(3);
  });

  it('ScanSession v12 buyMethod 支援新字母', () => {
    const sessions: Array<ScanSession['buyMethod']> = [
      'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q',
    ];
    sessions.forEach(m => expect(m).toBeTruthy());
  });

  it('MtfMode 含 v12 字母', () => {
    const modes: MtfMode[] = ['daily', 'mtf', 'B', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q'];
    expect(modes.length).toBe(11);
  });

  it('ProvisionalState 撤銷紀錄結構', () => {
    const events: ProvisionalEvent[] = [
      { date: '2026-05-08', event: 'triggered' },
      { date: '2026-05-09', event: 'revoked-price', detail: 'close 跌回 triggerPrice 之下' },
    ];
    const ps: ProvisionalState = {
      triggerPrice: 105,
      daysRemaining: 0,
      status: 'revoked',
      revocationCount: 1,
      history: events,
    };
    expect(ps.history.length).toBe(2);
    expect(ps.history[1].event).toBe('revoked-price');
  });
});

describe('v12 Phase 0.3 — LockWatchRecord（議題 23/65/93）', () => {
  it('triggerSignal 只允許 F | N（D/O 觸發即進場）', () => {
    const fRecord: LockWatchRecord = {
      symbol: '2330',
      market: 'TW',
      triggeredDate: '2026-05-08',
      triggerSignal: 'F',
      triggerPrice: 1000,
      currentStage: 'observation',
      daysObserved: 0,
      history: [{ date: '2026-05-08', event: 'triggered' }],
    };

    const nRecord: LockWatchRecord = {
      symbol: '2330',
      market: 'TW',
      triggeredDate: '2026-05-08',
      triggerSignal: 'N',
      patternType: 'head-shoulder',
      triggerPrice: 1000,
      patternTargetPrice: 1100,
      patternAchievementRate: 83,
      currentStage: 'observation',
      daysObserved: 0,
      history: [{ date: '2026-05-08', event: 'triggered' }],
    };

    expect(fRecord.triggerSignal).toBe('F');
    expect(nRecord.triggerSignal).toBe('N');
    expect(nRecord.patternType).toBe('head-shoulder');
    expect(nRecord.patternAchievementRate).toBe(83);
  });

  it('LockWatchEvent 完整生命週期', () => {
    const events: LockWatchEvent[] = [
      { date: '2026-05-08', event: 'triggered' },
      { date: '2026-05-09', event: 'provisional-pass' },
      { date: '2026-05-12', event: 'trend-confirmed' },
      { date: '2026-05-13', event: 'sop-passed' },
      { date: '2026-05-13', event: 'purchased' },
    ];
    expect(events.length).toBe(5);
    expect(events[4].event).toBe('purchased');
  });

  it('LockWatchDailySnapshot 單檔合併儲存（議題 61）', () => {
    const snapshot: LockWatchDailySnapshot = {
      market: 'TW',
      date: '2026-05-08',
      records: [],
      lastUpdated: '2026-05-08T18:00:00Z',
    };
    expect(snapshot.records).toEqual([]);
  });
});

describe('v12 Phase 0.3 — PortfolioHolding 進場價分流（議題 92）', () => {
  it('costPrice 跟 triggerPrice 分開', () => {
    const h: PortfolioHolding = {
      id: '1',
      symbol: '2330',
      name: '台積電',
      shares: 100,
      costPrice: 1000.5,        // 用戶實際買進價（盤中）
      buyDate: '2026-05-08',
      triggerPrice: 1002.0,     // 系統觸發日 close（書本訊號參考價）
      triggerSignal: 'B',
      operationMode: 'short',
      enhancedDisciplineEnabled: false,
      endPhaseTriggered: false,
      recentHigh: 1010,
    };
    expect(h.costPrice).not.toBe(h.triggerPrice);
    expect(h.triggerSignal).toBe('B');
  });
});
