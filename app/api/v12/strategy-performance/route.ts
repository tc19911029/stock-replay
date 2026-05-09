/**
 * GET /api/v12/strategy-performance?market=TW|CN
 *
 * 對 v12 14 字母策略過去 20 天的歷史 scan 結果做統計：
 * - hits: 該字母總命中次數
 * - days: 有命中的天數
 * - avgRet: 進場後 5 天平均報酬
 * - winRate: 進場後 5 天 close > entry 比例
 * - bestRet / worstRet
 * - sharpe-like: 平均報酬 / 標準差
 *
 * 回測「if 用 v12 字母 X 選股 持有 5 天」的 ex-post 績效。
 */
import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { listScanDates, loadScanSession } from '@/lib/storage/scanStorage';
import type { MarketId, MtfMode } from '@/lib/scanner/types';
import type { CandleFileData } from '@/lib/datasource/CandleStorageAdapter';
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const LETTERS: MtfMode[] = ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q'];

interface LetterStats {
  letter: string;
  hits: number;
  days: number;
  avgEntry: number;
  avgRet5d: number | null;
  winRate5d: number | null;
  bestRet: number | null;
  worstRet: number | null;
  sharpeLike: number | null;
  uniqueSymbols: number;
}

async function computeLetterStats(market: MarketId, letter: MtfMode): Promise<LetterStats> {
  const dates = await listScanDates(market, 'long', letter);
  const stats: LetterStats = {
    letter: letter as string,
    hits: 0, days: 0, avgEntry: 0, avgRet5d: null, winRate5d: null,
    bestRet: null, worstRet: null, sharpeLike: null, uniqueSymbols: 0,
  };
  if (dates.length === 0) return stats;

  const returns: number[] = [];
  let totalHits = 0;
  let totalEntry = 0;
  const symbolSet = new Set<string>();
  let daysWithHits = 0;

  // 先 load 所有 sessions
  for (const d of dates) {
    const sess = await loadScanSession(market, d.date, 'long', letter);
    if (!sess || !sess.results || sess.results.length === 0) continue;
    daysWithHits++;
    for (const r of sess.results) {
      totalHits++;
      totalEntry += r.price;
      symbolSet.add(r.symbol);
      // 5d forward return: 從 L1 candles 算
      try {
        const file: CandleFileData | null = await readCandleFile(r.symbol, market);
        if (!file || !file.candles) continue;
        const idx = file.candles.findIndex((c) => c.date === d.date);
        if (idx >= 0 && idx + 5 < file.candles.length) {
          const entry = file.candles[idx].close;
          const exit = file.candles[idx + 5].close;
          if (entry > 0) {
            const ret = (exit - entry) / entry;
            returns.push(ret);
          }
        }
      } catch { /* skip */ }
    }
  }

  stats.hits = totalHits;
  stats.days = daysWithHits;
  stats.uniqueSymbols = symbolSet.size;
  stats.avgEntry = totalHits > 0 ? +(totalEntry / totalHits).toFixed(2) : 0;

  if (returns.length > 0) {
    const sum = returns.reduce((a, b) => a + b, 0);
    const avg = sum / returns.length;
    const wins = returns.filter((r) => r > 0).length;
    const variance = returns.reduce((s, r) => s + Math.pow(r - avg, 2), 0) / returns.length;
    const stdev = Math.sqrt(variance);
    stats.avgRet5d = +(avg * 100).toFixed(2);
    stats.winRate5d = +((wins / returns.length) * 100).toFixed(1);
    stats.bestRet = +(Math.max(...returns) * 100).toFixed(2);
    stats.worstRet = +(Math.min(...returns) * 100).toFixed(2);
    stats.sharpeLike = stdev > 0 ? +(avg / stdev).toFixed(3) : null;
  }
  return stats;
}

export async function GET(req: NextRequest) {
  const market = (req.nextUrl.searchParams.get('market') ?? 'TW') as MarketId;
  if (!['TW', 'CN'].includes(market)) return apiError('market must be TW or CN', 400);

  try {
    const allStats = await Promise.all(LETTERS.map((l) => computeLetterStats(market, l)));
    return apiOk({
      market,
      generatedAt: new Date().toISOString(),
      stats: allStats,
    });
  } catch (err) {
    console.error('[v12/strategy-performance]', err);
    return apiError(`failed: ${String(err).slice(0, 200)}`);
  }
}
