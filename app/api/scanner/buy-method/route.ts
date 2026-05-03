/**
 * GET /api/scanner/buy-method?market=TW&date=2026-04-17&method=E
 *
 * 並列買法架構的獨立掃描端點（2026-04-21 rename 後）
 *
 * 字母對照：
 *   B — 回後買上漲（detectBreakoutEntry，pullback_buy subType）
 *   C — 盤整突破（detectConsolidationBreakout，consolidation_breakout subType）
 *   D — 一字底突破（detectStrategyE）
 *   E — 缺口進場（detectStrategyD）
 *   F — V 形反轉（detectVReversal）
 *
 * 資料來源：本地 L1 candles（data/candles/{market}/*.json）
 * 不動既有六條件掃描流程；各買法 detector 純 K 線邏輯 TW/CN 共用。
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import { loadLocalCandlesForDate, getLocalCandleDir } from '@/lib/datasource/LocalCandleStore';
import { detectStrategyE } from '@/lib/analysis/highWinRateEntry';
import { detectStrategyD } from '@/lib/analysis/gapEntry';
import { detectBreakoutEntry, detectConsolidationBreakout } from '@/lib/analysis/breakoutEntry';
import { detectVReversal } from '@/lib/analysis/vReversalDetector';
import { detectABCBreakout } from '@/lib/analysis/abcBreakoutEntry';
import { detectBlackKBreakout } from '@/lib/analysis/blackKBreakoutEntry';
import { evaluateSixConditions } from '@/lib/analysis/trendAnalysis';
import type { StockScanResult } from '@/lib/scanner/types';
import type { CandleWithIndicators } from '@/types';

export const runtime = 'nodejs';
export const maxDuration = 60;

const querySchema = z.object({
  market: z.enum(['TW', 'CN']).default('TW'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  method: z.enum(['B', 'C', 'D', 'E', 'F', 'G', 'H']),
});

type Method = z.infer<typeof querySchema>['method'];

/**
 * 跨策略命中：給定一支股票，回傳當天還命中哪些策略字母（A/B/C/D/E/F）
 * 主命中策略 method 一定在裡面；其他 5 個各跑一次 detector。
 */
function detectCrossMatches(
  candles: CandleWithIndicators[],
  idx: number,
  primary: Method,
): string[] {
  const matched: string[] = [primary];
  try {
    if (evaluateSixConditions(candles, idx).isCoreReady) matched.push('A');
  } catch { /* non-critical */ }
  if (primary !== 'B') {
    try { if (detectBreakoutEntry(candles, idx)?.isBreakout) matched.push('B'); } catch { /* */ }
  }
  if (primary !== 'C') {
    try { if (detectConsolidationBreakout(candles, idx)?.isBreakout) matched.push('C'); } catch { /* */ }
  }
  if (primary !== 'D') {
    try { if (detectStrategyE(candles, idx)?.isFlatBottom) matched.push('D'); } catch { /* */ }
  }
  if (primary !== 'E') {
    try { if (detectStrategyD(candles, idx)?.isGapEntry) matched.push('E'); } catch { /* */ }
  }
  if (primary !== 'F') {
    try { if (detectVReversal(candles, idx)?.isVReversal) matched.push('F'); } catch { /* */ }
  }
  if (primary !== 'G') {
    try { if (detectABCBreakout(candles, idx)?.isABCBreakout) matched.push('G'); } catch { /* */ }
  }
  if (primary !== 'H') {
    try { if (detectBlackKBreakout(candles, idx)?.isBlackKBreakout) matched.push('H'); } catch { /* */ }
  }
  // 排序：A 在最前，其他維持 B C D E F G H
  return ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].filter(m => matched.includes(m));
}

function runDetector(
  method: Method,
  candles: CandleWithIndicators[],
  idx: number,
): { matched: boolean; detail: string; subType?: string } {
  switch (method) {
    case 'B': {
      // B=回後買上漲
      const r = detectBreakoutEntry(candles, idx);
      return r?.isBreakout
        ? { matched: true, detail: r.detail, subType: r.subType }
        : { matched: false, detail: '' };
    }
    case 'C': {
      // C=盤整突破
      const r = detectConsolidationBreakout(candles, idx);
      return r?.isBreakout
        ? { matched: true, detail: r.detail, subType: r.subType }
        : { matched: false, detail: '' };
    }
    case 'D': {
      // D=一字底
      const r = detectStrategyE(candles, idx);
      return r?.isFlatBottom
        ? { matched: true, detail: r.detail }
        : { matched: false, detail: '' };
    }
    case 'E': {
      // E=缺口進場
      const r = detectStrategyD(candles, idx);
      return r?.isGapEntry
        ? { matched: true, detail: r.detail }
        : { matched: false, detail: '' };
    }
    case 'F': {
      // F=V形反轉
      const r = detectVReversal(candles, idx);
      return r?.isVReversal
        ? { matched: true, detail: r.detail }
        : { matched: false, detail: '' };
    }
    case 'G': {
      // G=ABC 突破（寶典 Part 11-1 位置 6）
      const r = detectABCBreakout(candles, idx);
      return r?.isABCBreakout
        ? { matched: true, detail: r.detail }
        : { matched: false, detail: '' };
    }
    case 'H': {
      // H=突破大量黑 K（寶典 Part 11-1 位置 8）
      const r = detectBlackKBreakout(candles, idx);
      return r?.isBlackKBreakout
        ? { matched: true, detail: r.detail }
        : { matched: false, detail: '' };
    }
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return apiValidationError(parsed.error);
  const { market, date, method } = parsed.data;

  try {
    const dir = getLocalCandleDir(market);
    if (!fs.existsSync(dir)) {
      return apiError(`本地 ${market} L1 目錄不存在`);
    }

    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    const results: StockScanResult[] = [];

    // 並行處理，batch 50 支
    const BATCH = 50;
    for (let i = 0; i < files.length; i += BATCH) {
      const batch = files.slice(i, i + BATCH);
      const settled = await Promise.allSettled(batch.map(async f => {
        const symbol = f.replace('.json', '');
        const candles = await loadLocalCandlesForDate(symbol, market, date);
        if (!candles || candles.length < 11) return null;

        const idx = candles.findIndex(c => c.date?.slice(0, 10) === date);
        if (idx < 0) return null;

        const det = runDetector(method, candles, idx);
        if (!det.matched) return null;

        const c = candles[idx];
        const prev = candles[idx - 1];
        const changePercent = prev && prev.close > 0 ? (c.close - prev.close) / prev.close * 100 : 0;

        // 讀檔名對應的 name（從原始 JSON）
        let name = symbol;
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
          if (raw?.name) name = raw.name;
        } catch { /* ignore */ }

        const r: StockScanResult = {
          symbol,
          name,
          market,
          price: c.close,
          changePercent,
          volume: c.volume,
          triggeredRules: [{
            ruleId: `buy-method-${method.toLowerCase()}`,
            ruleName: det.detail,
            signalType: 'BUY',
            reason: det.detail,
          }],
          sixConditionsScore: 0,
          sixConditionsBreakdown: {
            trend: false, position: false, kbar: false,
            ma: false, volume: false, indicator: false,
          },
          trendState: '多頭',
          trendPosition: '',
          scanTime: new Date().toISOString(),
          matchedMethods: detectCrossMatches(candles, idx, method),
          buyMethodSubType: det.subType,
        };
        return r;
      }));

      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value) results.push(r.value);
      }
    }

    // 按漲幅排序
    results.sort((a, b) => b.changePercent - a.changePercent);

    return apiOk({
      market, date, method,
      resultCount: results.length,
      results,
    });
  } catch (err: unknown) {
    console.error('[scanner/buy-method] error:', err);
    return apiError('買法掃描失敗');
  }
}
