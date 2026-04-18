import fs from 'node:fs';
import path from 'node:path';
import { detectTrend, findPivots } from '../lib/analysis/trendAnalysis';
import { computeIndicators } from '../lib/indicators';
import type { Candle } from '../types';

/**
 * 黃金對照測試：pin 住用戶肉眼驗證過的歷史案例。
 *
 * 任何改到 findPivots / detectTrend 的改動，如果讓這些 case 的判斷跑掉，
 * 就會被這支測試擋下來。
 *
 * 新案例怎麼加：
 *   1. 用戶找到一支判錯的股票 + 日期
 *   2. 用戶寫下「正確答案」（多頭 / 空頭 / 盤整）和肉眼畫的波浪
 *   3. 把 symbol + date + expected 加進 CASES 陣列
 *   4. 跑 npm test -- trendAnalysis.golden 確認被擋
 *   5. 改演算法到測試通過為止
 */

interface GoldenCase {
  symbol: string;
  file: string;          // data/candles/TW|CN/xxx.json
  date: string;          // YYYY-MM-DD
  expectedTrend: '多頭' | '空頭' | '盤整';
  /** 用戶肉眼畫的波浪，純文件用。未來也可轉為額外斷言。 */
  pivots?: string;
  note?: string;
}

const CASES: GoldenCase[] = [
  {
    symbol: '2303.TW',
    file: 'TW/2303.TW.json',
    date: '2026-04-16',
    expectedTrend: '多頭',
    pivots: '底 4/02 @53.6 → 頭 4/10 @62.0 → 底 4/14 @59.7 → 現價 4/16 @68.3',
    note: '用戶 2026-04-18 指出：4/09 @60.0 那個微凹不該算底底低',
  },
  {
    symbol: '3105.TWO',
    file: 'TW/3105.TWO.json',
    date: '2026-04-16',
    expectedTrend: '多頭',
    note: '實際掃描已選入，作為正向 baseline',
  },
];

describe('findPivots golden cases', () => {
  it.each(CASES)(
    '$symbol $date 應判為 $expectedTrend',
    ({ file, date, expectedTrend, pivots, note }) => {
      const fullPath = path.join(process.cwd(), 'data/candles', file);
      if (!fs.existsSync(fullPath)) {
        // 本地 data 不存在時跳過（CI 可能沒有歷史 K 線資料）
        console.warn(`[golden] skip: ${fullPath} not found`);
        return;
      }
      const raw = JSON.parse(fs.readFileSync(fullPath, 'utf8')) as { candles: Candle[] };
      const candles = computeIndicators(raw.candles);
      const idx = candles.findIndex((k) => k.date === date);
      expect(idx).toBeGreaterThanOrEqual(0);

      const trend = detectTrend(candles, idx);
      const info = [pivots, note].filter(Boolean).join(' | ');
      expect(trend).toBe(expectedTrend);
      if (info) expect(info).toBeTruthy();
    },
  );
});

describe('findPivots 最小波幅 + 交替', () => {
  it('0.5% 微凹不應算 pivot low', () => {
    // 模擬 2303 4/08~4/10 的微凹：60.3 → 60.0 → 62.0
    // 前面需要墊夠長的 MA 資料讓指標穩定
    const base: Candle[] = Array.from({ length: 30 }, (_, i) => ({
      date: `2025-12-${String(i + 1).padStart(2, '0')}`,
      open: 60,
      high: 60.5,
      low: 59.5,
      close: 60,
      volume: 1000,
    }));
    const tail: Candle[] = [
      { date: '2026-01-01', open: 58, high: 58.5, low: 57.5, close: 58.3, volume: 1000 },
      { date: '2026-01-02', open: 60, high: 60.5, low: 59.8, close: 60.3, volume: 1000 },
      { date: '2026-01-03', open: 60, high: 60.2, low: 59.9, close: 60.0, volume: 1000 }, // 微凹
      { date: '2026-01-04', open: 62, high: 62.2, low: 61.8, close: 62.0, volume: 1000 },
      { date: '2026-01-05', open: 60, high: 60.5, low: 59.5, close: 60.1, volume: 1000 },
    ];
    const candles = computeIndicators([...base, ...tail]);
    const pivots = findPivots(candles, candles.length - 1, 10, 0.02);
    // 微凹 60.0 不該出現在 pivot 列表
    const hasMicroDip = pivots.some((p) => p.type === 'low' && Math.abs(p.price - 60.0) < 0.01);
    expect(hasMicroDip).toBe(false);
  });

  it('正價區持續時不產生新的頭（書本 p.22 行為）', () => {
    // 書本算法：只要沒跌破 MA5，就還在同一段，不會在段內切出新頭
    const base: Candle[] = Array.from({ length: 30 }, (_, i) => ({
      date: `2025-12-${String(i + 1).padStart(2, '0')}`,
      open: 60,
      high: 60.5,
      low: 59.5,
      close: 60,
      volume: 1000,
    }));
    const tail: Candle[] = [
      { date: '2026-01-01', open: 58, high: 58.5, low: 57.5, close: 58.0, volume: 1000 },
      { date: '2026-01-02', open: 60, high: 60.5, low: 59.8, close: 60.3, volume: 1000 },
      { date: '2026-01-03', open: 60, high: 60.2, low: 59.9, close: 60.1, volume: 1000 },
      { date: '2026-01-04', open: 62, high: 62.2, low: 61.8, close: 62.0, volume: 1000 },
      { date: '2026-01-05', open: 60, high: 60.5, low: 59.5, close: 60.5, volume: 1000 },
    ];
    const candles = computeIndicators([...base, ...tail]);
    const pivots = findPivots(candles, candles.length - 1, 10, 0.02);
    const highs = pivots.filter((p) => p.type === 'high');
    // 正價區持續中（close 一直站上 MA5），沒結束 → 不產生頭
    expect(highs.length).toBe(0);
  });
});
