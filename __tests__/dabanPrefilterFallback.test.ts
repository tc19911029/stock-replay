/**
 * DabanScanner — scanDabanWithPrefilter 0 候選 fallback 決策測試
 *
 * 背景（2026-04-20 案例）：
 *   IntradayCache CN snapshot 在盤中某瞬被凍結，date 欄位對得上但
 *   所有 quote 的 changePercent 都 < 9.5%。預篩篩出 0 候選後，
 *   舊版直接 early return → cron route 看 <5 不存 → 那天 daban session
 *   永久遺失。強制全量 L1 重掃可拿到 73 支漲停。
 *
 * 修法：0 候選時看「date 是否=當天 + 盤中」，是 → 維持 early return
 *      （盤中真的可能 0 漲停）；否則 → fallback 全量 L1。
 */

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockReadSnapshot = jest.fn();
jest.mock('../lib/datasource/IntradayCache', () => ({
  readIntradaySnapshot: (...args: unknown[]) => mockReadSnapshot(...args),
}));

const mockLoadLocal = jest.fn();
jest.mock('../lib/datasource/LocalCandleStore', () => ({
  loadLocalCandlesWithTolerance: (...args: unknown[]) => mockLoadLocal(...args),
}));

const mockIsMarketOpen = jest.fn();
const mockGetCurrentTradingDay = jest.fn();
jest.mock('../lib/datasource/marketHours', () => ({
  isMarketOpen: (...args: unknown[]) => mockIsMarketOpen(...args),
  getCurrentTradingDay: (...args: unknown[]) => mockGetCurrentTradingDay(...args),
}));

const mockGetStockList = jest.fn();
jest.mock('../lib/scanner/ChinaScanner', () => ({
  ChinaScanner: jest.fn().mockImplementation(() => ({
    getStockList: mockGetStockList,
  })),
}));

import { scanDabanWithPrefilter } from '../lib/scanner/DabanScanner';

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** 「凍結中盤」snapshot：date 對、quotes 有量、但所有 changePercent < 9.5% */
const FROZEN_MID_SESSION_SNAPSHOT = {
  market: 'CN' as const,
  date: '2026-04-20',
  updatedAt: '2026-04-20T05:50:00Z',
  count: 2,
  quotes: [
    {
      symbol: '601318', name: '中國平安',
      open: 50, high: 51, low: 49, close: 50.5, volume: 1_000_000,
      prevClose: 50, changePercent: 1.0,
    },
    {
      symbol: '600519', name: '貴州茅台',
      open: 1600, high: 1620, low: 1590, close: 1610, volume: 100_000,
      prevClose: 1600, changePercent: 0.625,
    },
  ],
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe('scanDabanWithPrefilter — 0 候選 fallback 決策', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReadSnapshot.mockResolvedValue(FROZEN_MID_SESSION_SNAPSHOT);
    // fallback 路徑會用到 stockList + loadLocalCandlesWithTolerance；
    // 回 [] / null 讓 fallback 跑完不噴錯，但 mockLoadLocal 被呼叫即可證明走 fallback
    mockGetStockList.mockResolvedValue([{ symbol: '601318.SS', name: '中國平安' }]);
    mockLoadLocal.mockResolvedValue(null);
  });

  test('過去交易日 + 0 候選 → fallback 全量 L1（2026-04-20 案例）', async () => {
    mockGetCurrentTradingDay.mockReturnValue('2026-05-19');
    mockIsMarketOpen.mockReturnValue(false);

    const session = await scanDabanWithPrefilter('2026-04-20');

    // fallback 觸發：scanDabanFromLocalCandles 內部會對 stockList 每檔呼叫 loadLocal
    expect(mockLoadLocal).toHaveBeenCalled();
    expect(session.date).toBe('2026-04-20');
  });

  test('當天且盤中 + 0 候選 → 維持 early return（盤中可能真的 0 漲停）', async () => {
    mockGetCurrentTradingDay.mockReturnValue('2026-04-20');
    mockIsMarketOpen.mockReturnValue(true);

    const session = await scanDabanWithPrefilter('2026-04-20');

    // 早退：不打 L1，避免盤中 5000 檔全掃 30-60s
    expect(mockLoadLocal).not.toHaveBeenCalled();
    expect(session.resultCount).toBe(0);
    expect(session.sentiment?.isCold).toBe(true);
  });

  test('當天但已收盤 + 0 候選 → fallback（收盤後 snapshot 應完整，0 即可疑）', async () => {
    mockGetCurrentTradingDay.mockReturnValue('2026-04-20');
    mockIsMarketOpen.mockReturnValue(false);

    const session = await scanDabanWithPrefilter('2026-04-20');

    expect(mockLoadLocal).toHaveBeenCalled();
    expect(session.date).toBe('2026-04-20');
  });
});
