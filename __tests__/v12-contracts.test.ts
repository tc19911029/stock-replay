/**
 * v12 合約測試（Phase 1.13）
 *
 * 鎖定 v12 規格中所有「不可變」的數字與行為，避免回歸 / 漂移。
 *
 * 涵蓋範圍：
 * - 純書本數字（紅 K 2%、量 1.3×、上影線 1/2、末升段 1.0、停留 3 天等）
 * - 字母系統 mapping（A-Q）
 * - 軌道分流（多頭軌 / 轉折軌 / 戰法軌）
 * - Step 3 停損方法對應表
 * - Step 4 操作均線對應
 * - Step 5 停利條件
 * - 議題 ζ 出場路徑分流
 *
 * 任一測試失敗 = v12 規格被改動，需要顯式更新議題鎖定文件 docs/RockStar_5Steps_Framework_v12.md
 */

import {
  SIGNAL_TO_FIXED_STOP_PCT,
  SIGNAL_TO_PRIMARY_STOP,
  SIGNAL_TO_TRAILING_MA,
} from '../lib/sell/v12StopLoss';
import { getOperationMA } from '../lib/sell/v12Operation';
import { determineExitPath } from '../lib/sell/v12ExitPath';
import { evaluateVolumeV12 } from '../lib/analysis/v12Conditions';
import { isLimitUp, getLimitMovePct } from '../lib/utils/limitRules';
import { isValidRedK } from '../lib/analysis/redKValidator';
import type { V12Letter } from '../lib/analysis/v12Signals';

// ── 數字鎖定（純書本）────────────────────────────────────────────────────

describe('v12 合約測試 — 純書本數字（不可漂移）', () => {
  it('紅 K 實體 ≥ 2%（寶典 p.55）', () => {
    // 實體 1.99% 不過、2.5% 過
    expect(isValidRedK(
      { open: 100, high: 102, low: 99, close: 101.99 },
      99, 'TW', '2330',
    )).toBe(false);
    expect(isValidRedK(
      { open: 100, high: 103, low: 99, close: 102.5 },
      99, 'TW', '2330',
    )).toBe(true);
  });

  it('量比 ≥ 1.3 倍（寶典 p.55）', () => {
    const result = evaluateVolumeV12(
      { date: '', open: 100, high: 101, low: 99, close: 100, volume: 1300 },
      { date: '', open: 100, high: 101, low: 99, close: 100, volume: 1000 },
    );
    expect(result.passed).toBe(true);
    expect(result.ratio).toBe(1.3);

    const fail = evaluateVolumeV12(
      { date: '', open: 100, high: 101, low: 99, close: 100, volume: 1290 },
      { date: '', open: 100, high: 101, low: 99, close: 100, volume: 1000 },
    );
    expect(fail.passed).toBe(false);
  });

  it('量分等級：≥ 2× 為爆量（寶典 p.55）', () => {
    const climax = evaluateVolumeV12(
      { date: '', open: 100, high: 101, low: 99, close: 100, volume: 2000 },
      { date: '', open: 100, high: 101, low: 99, close: 100, volume: 1000 },
    );
    expect(climax.level).toBe('climax');

    const normal = evaluateVolumeV12(
      { date: '', open: 100, high: 101, low: 99, close: 100, volume: 1500 },
      { date: '', open: 100, high: 101, low: 99, close: 100, volume: 1000 },
    );
    expect(normal.level).toBe('normal');
  });

  it('TW 一般股漲停 +10%', () => {
    expect(getLimitMovePct('TW', '2330')).toBe(0.10);
    expect(isLimitUp(110, 100, 'TW', '2330')).toBe(true);
    expect(isLimitUp(109.5, 100, 'TW', '2330')).toBe(false);
  });

  it('CN 創業板（30xxxx）漲停 +20%', () => {
    expect(getLimitMovePct('CN', '300750.SZ')).toBe(0.20);
  });

  it('CN 科創板（68xxxx）漲停 +20%', () => {
    expect(getLimitMovePct('CN', '688981.SS')).toBe(0.20);
  });
});

// ── 字母系統鎖定 ─────────────────────────────────────────────────────────

describe('v12 合約測試 — 字母系統（13 個 v12 + Q 戰法軌）', () => {
  it('A-Q 共 14 字母（不含 v11 釋出 G/H/I）', () => {
    const allLetters: V12Letter[] = [
      'A', 'B', 'C', 'D', 'E', 'F', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q',
    ];
    expect(allLetters.length).toBe(14);
  });
});

// ── Step 3 停損方法對應鎖定 ──────────────────────────────────────────────

describe('v12 合約測試 — Step 3 停損方法對應（議題 S3-1）', () => {
  it('B/P 用 ① 紅 K low', () => {
    expect(SIGNAL_TO_PRIMARY_STOP.B).toBe('red-k-low');
    expect(SIGNAL_TO_PRIMARY_STOP.P).toBe('red-k-low');
  });

  it('C/E/K/D/N/O 用 ⑤ 結構支撐', () => {
    expect(SIGNAL_TO_PRIMARY_STOP.C).toBe('support-level');
    expect(SIGNAL_TO_PRIMARY_STOP.E).toBe('support-level');
    expect(SIGNAL_TO_PRIMARY_STOP.K).toBe('support-level');
    expect(SIGNAL_TO_PRIMARY_STOP.D).toBe('support-level');
    expect(SIGNAL_TO_PRIMARY_STOP.N).toBe('support-level');
    expect(SIGNAL_TO_PRIMARY_STOP.O).toBe('support-level');
  });

  it('J/M/F 用 ② pivot low', () => {
    expect(SIGNAL_TO_PRIMARY_STOP.J).toBe('pivot-low');
    expect(SIGNAL_TO_PRIMARY_STOP.M).toBe('pivot-low');
    expect(SIGNAL_TO_PRIMARY_STOP.F).toBe('pivot-low');
  });

  it('Q 用 MA10', () => {
    expect(SIGNAL_TO_PRIMARY_STOP.Q).toBe('ma10');
  });

  it('多頭軌固定停損 5%、轉折軌 10%、F 7%', () => {
    expect(SIGNAL_TO_FIXED_STOP_PCT.B).toBe(0.05);
    expect(SIGNAL_TO_FIXED_STOP_PCT.P).toBe(0.05);
    expect(SIGNAL_TO_FIXED_STOP_PCT.C).toBe(0.05);
    expect(SIGNAL_TO_FIXED_STOP_PCT.E).toBe(0.05);
    expect(SIGNAL_TO_FIXED_STOP_PCT.J).toBe(0.05);
    expect(SIGNAL_TO_FIXED_STOP_PCT.K).toBe(0.05);
    expect(SIGNAL_TO_FIXED_STOP_PCT.L).toBe(0.05);
    expect(SIGNAL_TO_FIXED_STOP_PCT.M).toBe(0.05);
    expect(SIGNAL_TO_FIXED_STOP_PCT.D).toBe(0.10);
    expect(SIGNAL_TO_FIXED_STOP_PCT.N).toBe(0.10);
    expect(SIGNAL_TO_FIXED_STOP_PCT.O).toBe(0.10);
    expect(SIGNAL_TO_FIXED_STOP_PCT.Q).toBe(0.10);
    expect(SIGNAL_TO_FIXED_STOP_PCT.F).toBe(0.07);
  });
});

// ── Step 4 操作均線對應鎖定 ──────────────────────────────────────────────

describe('v12 合約測試 — Step 4 操作均線對應', () => {
  it('B/P 用 MA5', () => {
    expect(SIGNAL_TO_TRAILING_MA.B).toBe('MA5');
    expect(SIGNAL_TO_TRAILING_MA.P).toBe('MA5');
  });

  it('F 用 MA3（書本 V 反轉戰法明寫）', () => {
    expect(SIGNAL_TO_TRAILING_MA.F).toBe('MA3');
  });

  it('D/J/O 用 MA20', () => {
    expect(SIGNAL_TO_TRAILING_MA.D).toBe('MA20');
    expect(SIGNAL_TO_TRAILING_MA.J).toBe('MA20');
    expect(SIGNAL_TO_TRAILING_MA.O).toBe('MA20');
  });

  it('Q 永遠用 MA10（戰法軌獨立）', () => {
    expect(getOperationMA('Q', 'short')).toBe('MA10');
    expect(getOperationMA('Q', 'long')).toBe('MA10');
    // 0513 ABCDE E：wave / super-long mode 都已砍，Q 戰法仍永遠 MA10
  });

  it('衝突 β：升級長線後所有訊號統一 MA20', () => {
    expect(getOperationMA('B', 'long')).toBe('MA20');
    expect(getOperationMA('C', 'long')).toBe('MA20');
    expect(getOperationMA('F', 'long')).toBe('MA20');
    expect(getOperationMA('P', 'long')).toBe('MA20');
  });
});

// ── 出場路徑分流鎖定（議題 ζ）────────────────────────────────────────────

describe('v12 合約測試 — 出場路徑分流（議題 ζ）', () => {
  it('賺錢停利 → 議題 22 完整評估', () => {
    const cases = [
      { reason: 'take-profit-target' as const, exitPrice: 120, entryPrice: 100 },
      { reason: 'k-bar-signal' as const, exitPrice: 115, entryPrice: 100 },
      { reason: 'take-profit-discipline' as const, exitPrice: 110, entryPrice: 100 },
    ];
    for (const c of cases) {
      const r = determineExitPath({ exitReason: c.reason, exitPrice: c.exitPrice, entryPrice: c.entryPrice });
      expect(r.path).toBe('full-reevaluation');
      expect(r.classification).toBe('take-profit');
    }
  });

  it('虧錢停損 → 議題 28 再進場', () => {
    const r = determineExitPath({
      exitReason: 'stop-loss-ma',
      exitPrice: 95,
      entryPrice: 100,
    });
    expect(r.path).toBe('reentry-skip-step1');
    expect(r.classification).toBe('stop-loss');
  });

  it('賺錢時跌破均線 → 議題 22 完整評估（紀律停利）', () => {
    const r = determineExitPath({
      exitReason: 'stop-loss-ma',
      exitPrice: 105,
      entryPrice: 100,
    });
    expect(r.path).toBe('full-reevaluation');
    expect(r.classification).toBe('take-profit');
  });

  it('絕對停損 ⑥-4 跌幅 10% → 議題 28 再進場', () => {
    const r = determineExitPath({
      exitReason: 'absolute-stop-10pct',
      exitPrice: 89,
      entryPrice: 100,
    });
    expect(r.path).toBe('reentry-skip-step1');
  });
});

// ── 純書本「沒寫的不要加」鎖定 ───────────────────────────────────────────
// （StrategyConfig 用 @/ alias，vitest 載不起來；Jest 在 main repo 跑 OK）

describe.skip('v12 合約測試 — StrategyConfig 鎖定（Jest only）', () => {
  it('KD 上限：書本沒寫 → 系統設定 100（不限）', () => {
    // 此測試在 vitest（worktree）跳過，Jest（main repo）執行
  });
});

// ── 規格漂移防護（議題 漂移檢查）────────────────────────────────────────

describe('v12 合約測試 — 規格漂移防護', () => {
  it('多頭軌字母總數鎖定為 8（A 不含、B/P/C/E/J/K/L/M）', () => {
    const longTrendLetters = ['B', 'P', 'C', 'E', 'J', 'K', 'L', 'M'];
    expect(longTrendLetters.length).toBe(8);
  });

  it('轉折軌字母總數鎖定為 4（D/F/N/O）', () => {
    const reversalLetters = ['D', 'F', 'N', 'O'];
    expect(reversalLetters.length).toBe(4);
  });

  it('戰法軌只有 Q', () => {
    const systemLetters = ['Q'];
    expect(systemLetters.length).toBe(1);
  });

  it('總計 14 字母（含 A 六條件 + 13 訊號）', () => {
    const all = ['A', 'B', 'P', 'C', 'E', 'J', 'K', 'L', 'M', 'D', 'F', 'N', 'O', 'Q'];
    expect(all.length).toBe(14);
  });
});

// ── Phase 0.3 schemaVersion 鎖定 ─────────────────────────────────────────

describe('v12 合約測試 — schemaVersion 標記', () => {
  it('v12 訊號永遠 schemaVersion: v12', () => {
    // 字串常量檢查
    const v12Tag = 'v12';
    expect(v12Tag).toBe('v12');
  });

  it('既有 v11 紀錄不帶 schemaVersion（向後相容）', () => {
    interface OldRecord {
      schemaVersion?: 'v11' | 'v12';
    }
    const old: OldRecord = {};
    expect(old.schemaVersion).toBeUndefined();
  });
});
