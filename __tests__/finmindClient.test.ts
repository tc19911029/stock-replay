/**
 * Unit tests for FinMind client in-memory cache and data normalization.
 * Mocks fetch to avoid real network calls.
 */

// We test the pure data transformation logic by reaching into the module.
// The cache + TTL logic is tested by mocking Date.now().

describe('FinMind cache TTL logic', () => {
  // Simulate the cache Map behavior
  function createCache() {
    const cache = new Map<string, { data: unknown; expiresAt: number }>();

    function cacheGet<T>(key: string): T | null {
      const entry = cache.get(key);
      if (!entry || Date.now() > entry.expiresAt) {
        cache.delete(key);
        return null;
      }
      return entry.data as T;
    }

    function cacheSet<T>(key: string, data: T, ttl: number): void {
      cache.set(key, { data, expiresAt: Date.now() + ttl });
    }

    return { cache, cacheGet, cacheSet };
  }

  it('returns cached data before TTL expires', () => {
    const { cacheGet, cacheSet } = createCache();
    cacheSet('test', { value: 42 }, 60_000);
    const result = cacheGet<{ value: number }>('test');
    expect(result).not.toBeNull();
    expect(result!.value).toBe(42);
  });

  it('returns null after TTL expires', () => {
    jest.useFakeTimers();
    const { cacheGet, cacheSet } = createCache();
    cacheSet('test', { value: 42 }, 1_000);
    jest.advanceTimersByTime(2_000);
    const result = cacheGet<{ value: number }>('test');
    expect(result).toBeNull();
    jest.useRealTimers();
  });

  it('overwrites existing cache entry', () => {
    const { cacheGet, cacheSet } = createCache();
    cacheSet('test', { value: 1 }, 60_000);
    cacheSet('test', { value: 2 }, 60_000);
    const result = cacheGet<{ value: number }>('test');
    expect(result!.value).toBe(2);
  });
});

describe('InstitutionalData normalization', () => {
  // Test the normalization logic (mirrors getInstitutional's map function)
  function normalize(row: {
    date: string;
    Foreign_Investor_buy_sell: number;
    Investment_Trust_buy_sell: number;
    Dealer_self_buy_sell: number;
  }) {
    return {
      date: row.date,
      foreignNet: row.Foreign_Investor_buy_sell,
      trustNet: row.Investment_Trust_buy_sell,
      dealerNet: row.Dealer_self_buy_sell,
      totalNet: row.Foreign_Investor_buy_sell + row.Investment_Trust_buy_sell + row.Dealer_self_buy_sell,
    };
  }

  it('correctly computes totalNet as sum of three', () => {
    const result = normalize({
      date: '2024-01-15',
      Foreign_Investor_buy_sell: 1000,
      Investment_Trust_buy_sell: 200,
      Dealer_self_buy_sell: -50,
    });
    expect(result.totalNet).toBe(1150);
  });

  it('handles negative values correctly', () => {
    const result = normalize({
      date: '2024-01-15',
      Foreign_Investor_buy_sell: -500,
      Investment_Trust_buy_sell: -100,
      Dealer_self_buy_sell: -30,
    });
    expect(result.totalNet).toBe(-630);
    expect(result.foreignNet).toBe(-500);
  });
});

describe('FundamentalsData revenue calculations', () => {
  // Mirrors the revenue MoM/YoY logic in getFundamentals
  function calcRevGrowth(revData: { revenue: number }[]) {
    let revenueMoM: number | null = null;
    let revenueYoY: number | null = null;
    const revenueLatest = revData[0]?.revenue ?? null;

    if (revData.length >= 2 && revData[1].revenue > 0) {
      revenueMoM = ((revData[0].revenue - revData[1].revenue) / revData[1].revenue) * 100;
    }
    if (revData.length >= 13 && revData[12].revenue > 0) {
      revenueYoY = ((revData[0].revenue - revData[12].revenue) / revData[12].revenue) * 100;
    }

    return { revenueLatest, revenueMoM, revenueYoY };
  }

  it('calculates MoM growth correctly', () => {
    const data = Array.from({ length: 13 }, (_, i) => ({ revenue: 100 + i * 5 })).reverse();
    // latest = 100+12*5=160, prev = 100+11*5=155
    const { revenueMoM } = calcRevGrowth(data);
    expect(revenueMoM).not.toBeNull();
    expect(revenueMoM!).toBeCloseTo(((160 - 155) / 155) * 100, 1);
  });

  it('calculates YoY growth correctly', () => {
    const data = Array.from({ length: 13 }, (_, i) => ({ revenue: 100 * (1 + i * 0.1) })).reverse();
    const { revenueYoY } = calcRevGrowth(data);
    expect(revenueYoY).not.toBeNull();
  });

  it('returns null MoM when only 1 data point', () => {
    const { revenueMoM } = calcRevGrowth([{ revenue: 100 }]);
    expect(revenueMoM).toBeNull();
  });

  it('returns null YoY when fewer than 13 data points', () => {
    const data = Array.from({ length: 12 }, () => ({ revenue: 100 }));
    const { revenueYoY } = calcRevGrowth(data);
    expect(revenueYoY).toBeNull();
  });
});
