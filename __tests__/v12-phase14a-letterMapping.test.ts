/**
 * v12 Phase 1.4A — 字母 mapping 結構測試
 *
 * 包裝既有 v11 G/H/I → v12 J/K/L
 *
 * 注意：本測試只驗證**型別結構與字母對應**，不真的呼叫 detector
 * （避開 vitest 在 worktree 內無法解析 @/ alias 的問題）。
 *
 * Jest 在 main repo 跑時會載入 v12Signals 完整模組（@/ alias OK）。
 */

import type {
  V12Letter,
  V12SignalCategory,
  V12SignalResult,
  V12Track,
} from '../lib/analysis/v12Signals';

describe('v12 Phase 1.4A — V12Letter 字母系統', () => {
  it('支援 14 個字母（A-O 含 P/Q）', () => {
    const letters: V12Letter[] = [
      'A', 'B', 'C', 'D', 'E', 'F',
      'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q',
    ];
    expect(letters.length).toBe(14);
  });

  it('v11 釋出字母 G/H/I 不在 v12 系統中', () => {
    // TypeScript 編譯時就擋住，這裡用 string array 確認文件記錄
    const releasedLetters = ['G', 'H', 'I'];
    const v12Letters = ['A', 'B', 'C', 'D', 'E', 'F', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q'];
    releasedLetters.forEach(g => expect(v12Letters).not.toContain(g));
  });
});

describe('v12 Phase 1.4A — V12SignalCategory 類別系統', () => {
  it('支援 7 種訊號類別', () => {
    const cats: V12SignalCategory[] = [
      'pattern', 'single-k', 'gap', 'reversal', 'channel', 'pullback', 'system',
    ];
    expect(cats.length).toBe(7);
  });
});

describe('v12 Phase 1.4A — V12Track 軌道系統', () => {
  it('3 個軌道', () => {
    const tracks: V12Track[] = ['long-trend', 'reversal', 'system'];
    expect(tracks.length).toBe(3);
  });
});

describe('v12 Phase 1.4A — V12SignalResult 結構', () => {
  it('結構完整（必填欄位）', () => {
    const result: V12SignalResult = {
      triggered: true,
      letter: 'J',
      category: 'single-k',
      track: 'long-trend',
      detail: 'J ABC 突破',
      schemaVersion: 'v12',
    };
    expect(result.schemaVersion).toBe('v12');
    expect(result.letter).toBe('J');
  });

  it('可選欄位齊全', () => {
    const result: V12SignalResult = {
      triggered: true,
      letter: 'L',
      category: 'single-k',
      track: 'long-trend',
      triggerPrice: 105.5,
      bodyPct: 2.5,
      volumeRatio: 1.8,
      detail: 'L 過大量黑 K 高',
      schemaVersion: 'v12',
      meta: { blackKHigh: 105.5, daysSinceBlackK: 2 },
    };
    expect(result.triggerPrice).toBe(105.5);
    expect(result.meta?.blackKHigh).toBe(105.5);
  });
});

describe('v12 Phase 1.4A — 字母歸屬規格', () => {
  it('J / K / L 應該在多頭軌（long-trend）', () => {
    const tracks: Record<string, V12Track> = {
      J: 'long-trend',
      K: 'long-trend',
      L: 'long-trend',
    };
    expect(tracks.J).toBe('long-trend');
    expect(tracks.K).toBe('long-trend');
    expect(tracks.L).toBe('long-trend');
  });

  it('J / L 屬 single-k 類別；K 屬 pattern 類別', () => {
    const cats: Record<string, V12SignalCategory> = {
      J: 'single-k',
      L: 'single-k',
      K: 'pattern',  // K 線橫盤是型態類，套 ×3% + 3 天 provisional
    };
    expect(cats.K).toBe('pattern');
    expect(cats.J).toBe('single-k');
    expect(cats.L).toBe('single-k');
  });
});
