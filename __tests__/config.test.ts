import {
  TW_TRADING, INTRADAY, SCANNER, BACKTEST,
  INDICATORS, CACHE, DISPLAY,
} from '../lib/config';

// ── TW_TRADING ──────────────────────────────────────────────────────────────────

describe('TW_TRADING', () => {
  test('FEE_RATE is a small positive fraction', () => {
    expect(TW_TRADING.FEE_RATE).toBeGreaterThan(0);
    expect(TW_TRADING.FEE_RATE).toBeLessThan(0.01);
  });

  test('FEE_DISCOUNT is between 0 and 1', () => {
    expect(TW_TRADING.FEE_DISCOUNT).toBeGreaterThan(0);
    expect(TW_TRADING.FEE_DISCOUNT).toBeLessThanOrEqual(1);
  });

  test('DAY_TRADE_TAX is less than NORMAL_TAX', () => {
    expect(TW_TRADING.DAY_TRADE_TAX).toBeLessThan(TW_TRADING.NORMAL_TAX);
  });

  test('MIN_FEE is a positive integer', () => {
    expect(TW_TRADING.MIN_FEE).toBeGreaterThan(0);
    expect(Number.isInteger(TW_TRADING.MIN_FEE)).toBe(true);
  });
});

// ── SCANNER ─────────────────────────────────────────────────────────────────────

describe('SCANNER', () => {
  test('MAX_HISTORY is positive', () => {
    expect(SCANNER.MAX_HISTORY).toBeGreaterThan(0);
  });

  test('AI_RANK_MAX_STOCKS is positive', () => {
    expect(SCANNER.AI_RANK_MAX_STOCKS).toBeGreaterThan(0);
  });

  test('MIN_HIST_WIN_RATE is between 0 and 100', () => {
    expect(SCANNER.MIN_HIST_WIN_RATE).toBeGreaterThanOrEqual(0);
    expect(SCANNER.MIN_HIST_WIN_RATE).toBeLessThanOrEqual(100);
  });
});

// ── INDICATORS ──────────────────────────────────────────────────────────────────

describe('INDICATORS', () => {
  test('all values are positive numbers', () => {
    for (const [, val] of Object.entries(INDICATORS)) {
      expect(typeof val).toBe('number');
      expect(val).toBeGreaterThan(0);
    }
  });

  test('RSI_OVERSOLD < RSI_OVERBOUGHT', () => {
    expect(INDICATORS.RSI_OVERSOLD).toBeLessThan(INDICATORS.RSI_OVERBOUGHT);
  });

  test('MA periods increase: SHORT < MID < LONG < QUARTER', () => {
    expect(INDICATORS.MA_SHORT).toBeLessThan(INDICATORS.MA_MID);
    expect(INDICATORS.MA_MID).toBeLessThan(INDICATORS.MA_LONG);
    expect(INDICATORS.MA_LONG).toBeLessThan(INDICATORS.MA_QUARTER);
  });
});

// ── CACHE ───────────────────────────────────────────────────────────────────────

describe('CACHE', () => {
  test('all TTL values are positive', () => {
    expect(CACHE.REALTIME_TTL).toBeGreaterThan(0);
    expect(CACHE.HISTORICAL_TTL).toBeGreaterThan(0);
    expect(CACHE.CHIP_TTL).toBeGreaterThan(0);
    expect(CACHE.THEME_TTL).toBeGreaterThan(0);
  });

  test('HISTORICAL_TTL > REALTIME_TTL (historical data cached longer)', () => {
    expect(CACHE.HISTORICAL_TTL).toBeGreaterThan(CACHE.REALTIME_TTL);
  });
});

// ── BACKTEST ────────────────────────────────────────────────────────────────────

describe('BACKTEST', () => {
  test('HOLD_DAYS values are positive integers', () => {
    for (const [, days] of Object.entries(BACKTEST.HOLD_DAYS)) {
      expect(days).toBeGreaterThan(0);
      expect(Number.isInteger(days)).toBe(true);
    }
  });

  test('stop losses are negative', () => {
    expect(BACKTEST.TIGHT_STOP_LOSS).toBeLessThan(0);
    expect(BACKTEST.MAX_STOP_LOSS).toBeLessThan(0);
  });

  test('TIGHT_STOP_LOSS is tighter (closer to 0) than MAX_STOP_LOSS', () => {
    expect(BACKTEST.TIGHT_STOP_LOSS).toBeGreaterThan(BACKTEST.MAX_STOP_LOSS);
  });
});

// ── INTRADAY ────────────────────────────────────────────────────────────────────

describe('INTRADAY', () => {
  test('DEFAULT_CAPITAL is positive', () => {
    expect(INTRADAY.DEFAULT_CAPITAL).toBeGreaterThan(0);
  });

  test('AUTO_TRADE_POSITION_RATIO is between 0 and 1', () => {
    expect(INTRADAY.AUTO_TRADE_POSITION_RATIO).toBeGreaterThan(0);
    expect(INTRADAY.AUTO_TRADE_POSITION_RATIO).toBeLessThanOrEqual(1);
  });
});

// ── DISPLAY ─────────────────────────────────────────────────────────────────────

describe('DISPLAY', () => {
  test('MAX_CANDLES is a positive number', () => {
    expect(DISPLAY.MAX_CANDLES).toBeGreaterThan(0);
  });
});
