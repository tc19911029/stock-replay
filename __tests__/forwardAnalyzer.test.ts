/**
 * ForwardAnalyzer 測試 — 驗證連假缺口場景
 *
 * 核心場景：本地 K 線停在連假前（如 04-02），連假後（04-07）數據缺失。
 * ForwardAnalyzer 應偵測到缺口並用 API 補足，而非使用不完整的本地數據。
 */

// ── Mocks ────────────────────────────────────────────────────────────────────

// Mock loadLocalCandles — 模擬本地 K 線只到 04-02（清明連假前）
const mockLocalCandles = jest.fn();
jest.mock('../lib/datasource/LocalCandleStore', () => ({
  loadLocalCandles: (...args: unknown[]) => mockLocalCandles(...args),
}));

// Mock fetchCandlesRange — 模擬 API 回傳連假後的數據
const mockFetchRange = jest.fn();
jest.mock('../lib/datasource/YahooFinanceDS', () => ({
  fetchCandlesRange: (...args: unknown[]) => mockFetchRange(...args),
}));

// Mock rateLimiter
jest.mock('../lib/datasource/UnifiedRateLimiter', () => ({
  rateLimiter: {
    acquire: jest.fn().mockResolvedValue(undefined),
    reportSuccess: jest.fn(),
  },
}));

import { analyzeForwardBatch } from '../lib/backtest/ForwardAnalyzer';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeCandle(date: string, close: number, open = close * 0.99) {
  return {
    date, open, high: close * 1.02, low: close * 0.98,
    close, volume: 1_000_000,
  };
}

/** 本地數據：2026-03-27 ~ 2026-04-02（清明前最後交易日） */
const LOCAL_CANDLES_UNTIL_0402 = [
  makeCandle('2026-03-25', 50),
  makeCandle('2026-03-26', 51),
  makeCandle('2026-03-27', 52),
  makeCandle('2026-03-30', 51),
  makeCandle('2026-03-31', 53),
  makeCandle('2026-04-01', 54),
  makeCandle('2026-04-02', 55), // ← 最後一根，04-03~04-06 放假
];

/** API 回傳：連假後的數據 */
const API_CANDLES_AFTER_HOLIDAY = [
  makeCandle('2026-04-07', 56),
  makeCandle('2026-04-08', 57),
];

// ── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();

  // 固定「今天」為 2026-04-08，避免測試結果受實際日期影響
  jest.useFakeTimers();
  // 設定為 2026-04-08 15:00 UTC+8 = 2026-04-08 07:00 UTC
  jest.setSystemTime(new Date('2026-04-08T07:00:00Z'));
});

afterEach(() => {
  jest.useRealTimers();
});

describe('ForwardAnalyzer — 連假缺口補足', () => {
  test('本地數據停在連假前，應用 API 補足缺口', async () => {
    // 本地有 K 線但只到 04-02
    mockLocalCandles.mockResolvedValue(LOCAL_CANDLES_UNTIL_0402);
    // API 回傳 04-07, 04-08（只補缺口部分）
    mockFetchRange.mockResolvedValue(API_CANDLES_AFTER_HOLIDAY);

    const { results } = await analyzeForwardBatch(
      [{ symbol: '2330.TW', name: '台積電', scanPrice: 54 }],
      '2026-04-01',
    );

    expect(results).toHaveLength(1);
    const perf = results[0];

    // d1 = 04-02 (本地保留), d2 = 04-07 (API 補足)
    expect(perf.d1Return).not.toBeNull();
    expect(perf.d2Return).not.toBeNull();
    // 應該有呼叫 API 補足，且 fetchStart 從 04-03 開始（nextDay of lastLocal 04-02）
    expect(mockFetchRange).toHaveBeenCalled();
    const fetchStart = mockFetchRange.mock.calls[0][1];
    expect(fetchStart).toBe('2026-04-03');
  });

  test('本地數據完全空白時，整段走 API', async () => {
    mockLocalCandles.mockResolvedValue(null);
    mockFetchRange.mockResolvedValue([
      makeCandle('2026-04-02', 55),
      ...API_CANDLES_AFTER_HOLIDAY,
    ]);

    const { results } = await analyzeForwardBatch(
      [{ symbol: '6419.TWO', name: '京晨科', scanPrice: 90 }],
      '2026-04-01',
    );

    expect(results).toHaveLength(1);
    expect(results[0].d1Return).not.toBeNull();
    expect(mockFetchRange).toHaveBeenCalled();
  });

  test('本地數據已涵蓋到今天，不打 API', async () => {
    const fullCandles = [
      ...LOCAL_CANDLES_UNTIL_0402,
      ...API_CANDLES_AFTER_HOLIDAY,
    ];
    mockLocalCandles.mockResolvedValue(fullCandles);

    const { results } = await analyzeForwardBatch(
      [{ symbol: '2330.TW', name: '台積電', scanPrice: 54 }],
      '2026-04-01',
    );

    expect(results).toHaveLength(1);
    expect(results[0].d1Return).not.toBeNull();
    // 本地數據完整 → 不需要打 API
    expect(mockFetchRange).not.toHaveBeenCalled();
  });

  test('掃描日距今 ≤3 天且無數據，回傳待定結構而非 null', async () => {
    // 設定今天為 04-08，掃描日 04-07 = 距今 1 天
    mockLocalCandles.mockResolvedValue([]);
    mockFetchRange.mockResolvedValue([]);

    // analyzeOne 的 retry 路徑有 setTimeout(2000)，需要推進 fake timer
    const promise = analyzeForwardBatch(
      [{ symbol: '2330.TW', name: '台積電', scanPrice: 54 }],
      '2026-04-07',
    );
    // 推進 timer 讓 retry setTimeout 完成
    await jest.advanceTimersByTimeAsync(3000);

    const { results, nullCount } = await promise;

    // 近期掃描不應算作 null（避免倖存者偏差）
    expect(results).toHaveLength(1);
    expect(nullCount).toBe(0);
    expect(results[0].d1Return).toBeNull(); // 數據尚未產生
  });
});
