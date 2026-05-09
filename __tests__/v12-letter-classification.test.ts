/**
 * v12 字母分類規則測試（三軌制 + 字母對應均線 + alias）
 *
 * 確保 UI / detector / API 對 14 字母的分類一致：
 * - 預選池：A
 * - 多頭軌：B/P/C/E/J/K/L/M
 * - 轉折軌：D/F/N/O
 * - 戰法軌：Q
 * - v11 alias（向後相容）：G→J, H→L, I→K
 */
import { getOperationMA } from '../lib/sell/v12Operation';
import { SIGNAL_TO_PRIMARY_STOP, SIGNAL_TO_FIXED_STOP_PCT } from '../lib/sell/v12StopLoss';

const TRACK = {
  pool: ['A'],
  bullish: ['B', 'P', 'C', 'E', 'J', 'K', 'L', 'M'],
  reversal: ['D', 'F', 'N', 'O'],
  system: ['Q'],
};

describe('v12 字母分類', () => {
  it('總計 14 個 v12 字母 + 1 預選池 = 14（去重）', () => {
    const all = [...TRACK.pool, ...TRACK.bullish, ...TRACK.reversal, ...TRACK.system];
    expect(all.length).toBe(14);
    expect(new Set(all).size).toBe(14);
  });

  it('多頭軌字母短線守 MA5 / MA10 / MA20', () => {
    expect(getOperationMA('B', 'short')).toBe('MA5');
    expect(getOperationMA('P', 'short')).toBe('MA5');
    expect(getOperationMA('C', 'short')).toBe('MA10');
    expect(getOperationMA('E', 'short')).toBe('MA10');
    expect(getOperationMA('J', 'short')).toBe('MA20');
    expect(getOperationMA('K', 'short')).toBe('MA10');
    expect(getOperationMA('L', 'short')).toBe('MA10');
    expect(getOperationMA('M', 'short')).toBe('MA10');
  });

  it('轉折軌字母短線對應均線', () => {
    expect(getOperationMA('D', 'short')).toBe('MA20');
    expect(getOperationMA('F', 'short')).toBe('MA3');
    expect(getOperationMA('N', 'short')).toBe('MA10');
    expect(getOperationMA('O', 'short')).toBe('MA20');
  });

  it('Q 戰法軌獨立 — 永遠 MA10', () => {
    expect(getOperationMA('Q', 'short')).toBe('MA10');
    expect(getOperationMA('Q', 'long')).toBe('MA10');
    expect(getOperationMA('Q', 'wave')).toBe('MA10');
  });

  it('升級長線後所有非 Q 字母統一 MA20（衝突 β）', () => {
    for (const letter of [...TRACK.bullish, ...TRACK.reversal] as const) {
      const ma = getOperationMA(letter, 'long');
      expect(ma).toBe('MA20');
    }
  });
});

describe('v12 SIGNAL_TO_PRIMARY_STOP 對照表完整', () => {
  it('全 14 字母都有對應主停損方法', () => {
    const required: Array<keyof typeof SIGNAL_TO_PRIMARY_STOP> = ['A', 'B', 'C', 'D', 'E', 'F', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q'];
    for (const letter of required) {
      expect(SIGNAL_TO_PRIMARY_STOP[letter]).toBeDefined();
    }
  });

  it('SIGNAL_TO_FIXED_STOP_PCT 對 Q 戰法應有獨立%', () => {
    expect(SIGNAL_TO_FIXED_STOP_PCT['Q']).toBeDefined();
  });
});

describe('v12 字母 ↔ 軌道分類', () => {
  it('多頭軌 vs 轉折軌互斥', () => {
    const bullSet = new Set(TRACK.bullish);
    for (const letter of TRACK.reversal) {
      expect(bullSet.has(letter)).toBe(false);
    }
  });

  it('Q 戰法不在多頭/轉折軌', () => {
    expect(TRACK.bullish.includes('Q')).toBe(false);
    expect(TRACK.reversal.includes('Q')).toBe(false);
    expect(TRACK.system.includes('Q')).toBe(true);
  });
});
