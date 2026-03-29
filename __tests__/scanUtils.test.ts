/**
 * Unit tests for scan utility functions.
 * Tests: calcComposite, retColor, fmtRet, scoreColor, chipTooltip
 */
import { calcComposite, retColor, fmtRet, scoreColor, chipTooltip } from '../features/scan/utils';
import type { StockScanResult } from '../lib/scanner/types';

// ── Fixtures ────────────────────────────────────────────────────────────────────

function mockResult(overrides?: Partial<StockScanResult>): StockScanResult {
  return {
    symbol: '2330.TW', name: '台積電', market: 'TW',
    price: 800, changePercent: 1.5, volume: 20000000,
    triggeredRules: [],
    sixConditionsScore: 5,
    sixConditionsBreakdown: { trend: true, position: true, kbar: true, ma: true, volume: true, indicator: false },
    trendState: '多頭', trendPosition: '主升段',
    scanTime: '2024-01-15T13:30:00.000Z',
    surgeScore: 70,
    histWinRate: 65,
    ...overrides,
  };
}

// ── calcComposite ────────────────────────────────────────────────────────────────

describe('calcComposite', () => {
  it('returns a number between 0 and 100', () => {
    const score = calcComposite(mockResult());
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  it('gives higher score when all 6 conditions pass', () => {
    const all6 = calcComposite(mockResult({ sixConditionsScore: 6, sixConditionsBreakdown: { trend: true, position: true, kbar: true, ma: true, volume: true, indicator: true } }));
    const all0 = calcComposite(mockResult({ sixConditionsScore: 0, sixConditionsBreakdown: { trend: false, position: false, kbar: false, ma: false, volume: false, indicator: false } }));
    expect(all6).toBeGreaterThan(all0);
  });

  it('gives higher score with higher surgeScore', () => {
    const high = calcComposite(mockResult({ surgeScore: 100 }));
    const low  = calcComposite(mockResult({ surgeScore: 0 }));
    expect(high).toBeGreaterThan(low);
  });

  it('handles missing optional fields gracefully', () => {
    const base = mockResult();
    delete (base as Partial<StockScanResult>).surgeScore;
    delete (base as Partial<StockScanResult>).histWinRate;
    expect(() => calcComposite(base as StockScanResult)).not.toThrow();
  });
});

// ── retColor ─────────────────────────────────────────────────────────────────────

describe('retColor', () => {
  it('returns red class for positive returns (Asian convention: up = red)', () => {
    expect(retColor(5)).toMatch(/red/);
  });

  it('returns green class for negative returns', () => {
    expect(retColor(-3)).toMatch(/green/);
  });

  it('returns neutral class for zero or nullish', () => {
    const zeroColor = retColor(0);
    expect(typeof zeroColor).toBe('string');
  });

  it('handles null/undefined without throwing', () => {
    expect(() => retColor(null as unknown as number)).not.toThrow();
    expect(() => retColor(undefined as unknown as number)).not.toThrow();
  });
});

// ── fmtRet ───────────────────────────────────────────────────────────────────────

describe('fmtRet', () => {
  it('formats positive return with + sign and % suffix', () => {
    const result = fmtRet(5.678);
    expect(result).toContain('+');
    expect(result).toContain('%');
  });

  it('formats negative return with - sign', () => {
    const result = fmtRet(-3.2);
    expect(result).toContain('-');
  });

  it('returns a dash string for null/undefined', () => {
    const nullResult = fmtRet(null as unknown as number);
    const undefinedResult = fmtRet(undefined as unknown as number);
    // Accept either em-dash (—) or en-dash (–)
    expect(nullResult).toMatch(/[–—]/);
    expect(undefinedResult).toMatch(/[–—]/);
  });
});

// ── scoreColor ───────────────────────────────────────────────────────────────────

describe('scoreColor', () => {
  it('returns a string for any numeric score', () => {
    expect(typeof scoreColor(6)).toBe('string');
    expect(typeof scoreColor(0)).toBe('string');
    expect(typeof scoreColor(3)).toBe('string');
  });
});

// ── chipTooltip ──────────────────────────────────────────────────────────────────

describe('chipTooltip', () => {
  it('returns a string', () => {
    const result = chipTooltip({
      foreignBuy: 1000, trustBuy: 200, marginNet: -100,
    });
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('handles missing fields without throwing', () => {
    expect(() => chipTooltip({})).not.toThrow();
  });
});
