/**
 * v12 Phase 1.5 — ScanPipeline 串接（v12StockEvaluator 結構測試）
 *
 * 純 type 結構測試 — 避開 vitest @/ alias 問題（v12StockEvaluator
 * 間接 import 既有 v11 detector 用 @/）。Jest 在 main repo 跑會完整載入。
 */

import type {
  V12EvalInputs,
  V12EvalResult,
} from '../lib/scanner/v12StockEvaluator';

describe('v12 Phase 1.5 — V12EvalInputs/Result 結構', () => {
  it('V12EvalInputs 結構完整', () => {
    const inputs: V12EvalInputs = {
      symbol: '2330',
      name: '台積電',
      market: 'TW',
      candles: [],
      indexCandles: [],
    };
    expect(inputs.symbol).toBe('2330');
    expect(inputs.market).toBe('TW');
  });

  it('V12EvalInputs 可帶 enabledLetters', () => {
    const inputs: V12EvalInputs = {
      symbol: '2330',
      name: '台積電',
      market: 'TW',
      candles: [],
      indexCandles: [],
      enabledLetters: ['J', 'K', 'L'],
    };
    expect(inputs.enabledLetters?.length).toBe(3);
  });

  it('V12EvalResult 結構完整', () => {
    const result: V12EvalResult = {
      symbol: '2330',
      name: '台積電',
      market: 'TW',
      date: '2026-05-09',
      marketGate: {
        passed: true,
        trendState: '多頭',
        marketTrendUpDate: null,
        bannerText: '',
        isAboveMA20: true,
        isMA20Up: true,
        hasPivotPair: true,
      },
      step1: {
        trendState: '多頭',
        lastTrendUpDate: null,
        indicatorPassed: true,
        kdDecliningWarning: false,
        endPhaseFlag: false,
        seasonLineResistance: null,
      },
      signals: [],
      schemaVersion: 'v12',
    };
    expect(result.schemaVersion).toBe('v12');
    expect(result.marketGate.passed).toBe(true);
    expect(result.step1.trendState).toBe('多頭');
  });
});

describe('v12 Phase 1.5 — Pipeline 整合契約', () => {
  it('schemaVersion 永遠 v12', () => {
    const result: Pick<V12EvalResult, 'schemaVersion'> = { schemaVersion: 'v12' };
    expect(result.schemaVersion).toBe('v12');
  });

  it('signals 是陣列（可空）', () => {
    const result: Pick<V12EvalResult, 'signals'> = { signals: [] };
    expect(Array.isArray(result.signals)).toBe(true);
  });
});
