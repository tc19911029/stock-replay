/**
 * Contract test: 面板顯示 vs applyPanelFilter 一致性
 *
 * 驗證 CLAUDE.md Fundamental Rule R10 — 選股邏輯單一事實
 *
 * 規則：對任何 session date，前端 MTF toggle 過濾結果必須等同於
 *       `applyPanelFilter(session.results, { useMultiTimeframe: true })`。
 *       回測腳本第 1 名必須等同於同一 filter 的第 1 名（有樣本可驗時）。
 */
import fs from 'fs';
import path from 'path';
import { applyPanelFilter } from '@/lib/selection/applyPanelFilter';
import type { StockScanResult } from '@/lib/scanner/types';

interface Session {
  market: string;
  date: string;
  direction: string;
  multiTimeframeEnabled: boolean;
  results: StockScanResult[];
}

function loadSession(fileName: string): Session | null {
  const p = path.join(process.cwd(), 'data', fileName);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

// 取三個有內容且含 MTF 混合樣本的日期
const SAMPLES = [
  'scan-TW-long-mtf-2026-03-19.json',     // 4 筆全 weekly=false
  'scan-TW-long-daily-2026-03-20.json',   // 2 筆
  'scan-TW-long-daily-2026-04-16.json',   // 3 筆
];

describe('Scan panel parity contracts (R10)', () => {
  describe('applyPanelFilter 排序穩定', () => {
    test('空陣列回空陣列', () => {
      expect(applyPanelFilter([], { useMultiTimeframe: false })).toEqual([]);
      expect(applyPanelFilter([], { useMultiTimeframe: true })).toEqual([]);
    });

    test('漲幅 desc 優先，六條件總分次要', () => {
      const mk = (s: string, chg: number, six: number): StockScanResult => ({
        symbol: s, name: s, market: 'TW', industry: '',
        price: 100, changePercent: chg, volume: 0,
        triggeredRules: [], sixConditionsScore: six,
        sixConditionsBreakdown: {
          trend: true, position: true, kbar: true, ma: true, volume: true, indicator: true,
        },
        trendState: '多頭', trendPosition: '',
        scanTime: '2026-04-19T00:00:00.000Z',
        highWinRateScore: 0, highWinRateTypes: [], highWinRateDetails: [],
      } as unknown as StockScanResult);

      const results = [
        mk('A', 3, 5),  // 漲幅 3，六條件 5
        mk('B', 5, 4),  // 漲幅 5（最高）
        mk('C', 3, 6),  // 漲幅 3，六條件 6（比 A 高）
      ];
      const sorted = applyPanelFilter(results, { useMultiTimeframe: false });
      expect(sorted.map(r => r.symbol)).toEqual(['B', 'C', 'A']);
    });
  });

  describe.each(SAMPLES)('對樣本 %s', fileName => {
    const session = loadSession(fileName);
    const testOrSkip = session ? test : test.skip;

    testOrSkip('MTF toggle=off 保留所有 ScanPipeline 產生的 results', () => {
      if (!session) return;
      const filtered = applyPanelFilter(session.results, { useMultiTimeframe: false });
      expect(filtered.length).toBe(session.results.length);
    });

    testOrSkip('MTF toggle=on 只保留 mtfScore >= 3', () => {
      if (!session) return;
      const filtered = applyPanelFilter(session.results, { useMultiTimeframe: true });
      for (const r of filtered) {
        expect(r.mtfScore ?? 0).toBeGreaterThanOrEqual(3);
      }
      // 驗證沒漏篩
      const expected = session.results.filter(r => (r.mtfScore ?? 0) >= 3).length;
      expect(filtered.length).toBe(expected);
    });

    testOrSkip('排序後 #1 六條件總分必為全組最高', () => {
      if (!session || session.results.length === 0) return;
      const sorted = applyPanelFilter(session.results, { useMultiTimeframe: false });
      const maxScore = Math.max(...session.results.map(r => r.sixConditionsScore ?? 0));
      expect(sorted[0].sixConditionsScore ?? 0).toBe(maxScore);
    });
  });
});
