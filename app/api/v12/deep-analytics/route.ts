/**
 * GET /api/v12/deep-analytics?market=TW|CN
 *
 * 對 v12 14 字母歷史 scan 結果做四種深度分析：
 *
 * 1. **Ensemble**: 多字母同時命中時的勝率提升
 *    - 例：Q+N 同時觸發 80% winrate vs 單獨 Q 56%
 *    - 列出 top 10 最強組合（≥5 樣本）
 *
 * 2. **Regime**: 每字母在大盤多頭/盤整/空頭三狀態的表現
 *    - 看哪個字母「擇時敏感」哪個「全狀態適用」
 *
 * 3. **Drawdown**: 每字母 5 天持倉的 max drawdown
 *    - 平均 MDD / 最深 MDD
 *
 * 4. **Industry**: TW 字母在各產業的勝率
 *    - 例：Q 在半導體 vs 金融
 */
import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { listScanDates, loadScanSession } from '@/lib/storage/scanStorage';
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';
import type { MarketId, MtfMode } from '@/lib/scanner/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;

const LETTERS: MtfMode[] = ['B', 'C', 'D', 'E', 'F', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q'];

interface EnsembleStat {
  letters: string;          // e.g., "N+Q"
  hits: number;
  winRate: number;
  avgRet: number;
  vsBaseline: number;       // 比單獨字母平均勝率高多少 pp
}

interface RegimeStat {
  letter: string;
  bullish: { hits: number; winRate: number | null; avgRet: number | null };
  sideways: { hits: number; winRate: number | null; avgRet: number | null };
  bearish: { hits: number; winRate: number | null; avgRet: number | null };
}

interface DrawdownStat {
  letter: string;
  hits: number;
  avgMaxDD: number | null;  // 平均 5 天最大回撤
  worstDD: number | null;
}

interface IndustryStat {
  letter: string;
  industries: Array<{ industry: string; hits: number; winRate: number; avgRet: number }>;
}

// 對單個 (symbol, entry-date) 算 5 天 forward stats（return + MDD + market trend at that date）
async function fetchForwardStats(market: MarketId, symbol: string, entryDate: string): Promise<{
  ret5d: number | null;
  mdd5d: number | null;
}> {
  try {
    const file = await readCandleFile(symbol, market);
    if (!file?.candles) return { ret5d: null, mdd5d: null };
    const idx = file.candles.findIndex((c) => c.date === entryDate);
    if (idx < 0 || idx + 5 >= file.candles.length) return { ret5d: null, mdd5d: null };
    const entry = file.candles[idx].close;
    if (entry <= 0) return { ret5d: null, mdd5d: null };
    const exitClose = file.candles[idx + 5].close;
    const ret5d = (exitClose - entry) / entry;
    // Max drawdown over next 5 days
    let minClose = entry;
    for (let j = idx + 1; j <= idx + 5; j++) {
      if (file.candles[j].low < minClose) minClose = file.candles[j].low;
    }
    const mdd5d = (minClose - entry) / entry;  // negative = drawdown
    return { ret5d, mdd5d };
  } catch {
    return { ret5d: null, mdd5d: null };
  }
}

export async function GET(req: NextRequest) {
  const market = (req.nextUrl.searchParams.get('market') ?? 'TW') as MarketId;
  if (!['TW', 'CN'].includes(market)) return apiError('market must be TW or CN', 400);

  try {
    // ── 收集所有 (date, symbol, letter, marketTrend, industry) 觸發紀錄 ──
    interface Hit {
      date: string;
      symbol: string;
      letter: string;
      marketTrend: string;
      industry: string;
    }
    const allHits: Hit[] = [];
    const symbolDateLetters = new Map<string, Set<string>>();  // "symbol|date" → Set<letter>

    for (const letter of LETTERS) {
      const dates = await listScanDates(market, 'long', letter);
      for (const d of dates) {
        const sess = await loadScanSession(market, d.date, 'long', letter);
        if (!sess?.results) continue;
        const trend = String(sess.marketTrend ?? '盤整');
        for (const r of sess.results) {
          allHits.push({
            date: d.date, symbol: r.symbol, letter: letter as string,
            marketTrend: trend, industry: r.industry ?? '未分類',
          });
          const k = `${r.symbol}|${d.date}`;
          if (!symbolDateLetters.has(k)) symbolDateLetters.set(k, new Set());
          symbolDateLetters.get(k)!.add(letter as string);
        }
      }
    }

    // ── 預取 forward stats（避免重複算）──
    const forwardCache = new Map<string, { ret5d: number | null; mdd5d: number | null }>();
    const uniqKeys = Array.from(new Set(allHits.map((h) => `${h.symbol}|${h.date}`)));
    for (let i = 0; i < uniqKeys.length; i += 30) {
      const batch = uniqKeys.slice(i, i + 30);
      const results = await Promise.all(batch.map(async (k) => {
        const [symbol, date] = k.split('|');
        const stats = await fetchForwardStats(market, symbol, date);
        return { k, stats };
      }));
      for (const { k, stats } of results) forwardCache.set(k, stats);
    }

    // ── 1. Ensemble: top combinations by lift ──
    const baselineByLetter: Record<string, { hits: number; wins: number; ret: number }> = {};
    for (const letter of LETTERS) baselineByLetter[letter as string] = { hits: 0, wins: 0, ret: 0 };
    for (const h of allHits) {
      const f = forwardCache.get(`${h.symbol}|${h.date}`);
      if (!f || f.ret5d == null) continue;
      const b = baselineByLetter[h.letter];
      if (!b) continue;
      b.hits++;
      if (f.ret5d > 0) b.wins++;
      b.ret += f.ret5d;
    }
    const baselineWinRate: Record<string, number> = {};
    for (const [letter, b] of Object.entries(baselineByLetter)) {
      baselineWinRate[letter] = b.hits > 0 ? (b.wins / b.hits) * 100 : 0;
    }

    // 2-letter combos
    const comboStats: Record<string, { hits: number; wins: number; ret: number }> = {};
    for (const [, letterSet] of symbolDateLetters) {
      const letters = Array.from(letterSet).sort();
      if (letters.length < 2) continue;
      // 取 2-letter pairs
      for (let i = 0; i < letters.length; i++) {
        for (let j = i + 1; j < letters.length; j++) {
          const key = `${letters[i]}+${letters[j]}`;
          if (!comboStats[key]) comboStats[key] = { hits: 0, wins: 0, ret: 0 };
        }
      }
    }
    for (const [k, letterSet] of symbolDateLetters) {
      const letters = Array.from(letterSet).sort();
      if (letters.length < 2) continue;
      const f = forwardCache.get(k);
      if (!f || f.ret5d == null) continue;
      for (let i = 0; i < letters.length; i++) {
        for (let j = i + 1; j < letters.length; j++) {
          const key = `${letters[i]}+${letters[j]}`;
          const c = comboStats[key];
          c.hits++;
          if (f.ret5d > 0) c.wins++;
          c.ret += f.ret5d;
        }
      }
    }
    const ensemble: EnsembleStat[] = Object.entries(comboStats)
      .filter(([, s]) => s.hits >= 5)
      .map(([letters, s]) => {
        const winRate = (s.wins / s.hits) * 100;
        const avgRet = (s.ret / s.hits) * 100;
        const [a, b] = letters.split('+');
        const baseline = ((baselineWinRate[a] ?? 0) + (baselineWinRate[b] ?? 0)) / 2;
        return {
          letters,
          hits: s.hits,
          winRate: +winRate.toFixed(1),
          avgRet: +avgRet.toFixed(2),
          vsBaseline: +(winRate - baseline).toFixed(1),
        };
      })
      .sort((a, b) => b.vsBaseline - a.vsBaseline)
      .slice(0, 15);

    // ── 2. Regime breakdown ──
    const regime: RegimeStat[] = LETTERS.map((letter) => {
      const buckets = {
        bullish: { hits: 0, wins: 0, ret: 0 },
        sideways: { hits: 0, wins: 0, ret: 0 },
        bearish: { hits: 0, wins: 0, ret: 0 },
      };
      for (const h of allHits) {
        if (h.letter !== letter) continue;
        const f = forwardCache.get(`${h.symbol}|${h.date}`);
        if (!f || f.ret5d == null) continue;
        const bucket = h.marketTrend === '多頭' ? buckets.bullish
          : h.marketTrend === '空頭' ? buckets.bearish
          : buckets.sideways;
        bucket.hits++;
        if (f.ret5d > 0) bucket.wins++;
        bucket.ret += f.ret5d;
      }
      const calc = (b: { hits: number; wins: number; ret: number }) => ({
        hits: b.hits,
        winRate: b.hits > 0 ? +((b.wins / b.hits) * 100).toFixed(1) : null,
        avgRet: b.hits > 0 ? +((b.ret / b.hits) * 100).toFixed(2) : null,
      });
      return {
        letter: letter as string,
        bullish: calc(buckets.bullish),
        sideways: calc(buckets.sideways),
        bearish: calc(buckets.bearish),
      };
    });

    // ── 3. Drawdown ──
    const drawdown: DrawdownStat[] = LETTERS.map((letter) => {
      const dds: number[] = [];
      for (const h of allHits) {
        if (h.letter !== letter) continue;
        const f = forwardCache.get(`${h.symbol}|${h.date}`);
        if (!f || f.mdd5d == null) continue;
        dds.push(f.mdd5d);
      }
      return {
        letter: letter as string,
        hits: dds.length,
        avgMaxDD: dds.length > 0 ? +((dds.reduce((a, b) => a + b, 0) / dds.length) * 100).toFixed(2) : null,
        worstDD: dds.length > 0 ? +(Math.min(...dds) * 100).toFixed(2) : null,
      };
    });

    // ── 4. Industry breakdown (TW only — CN industry mostly null) ──
    const industry: IndustryStat[] = LETTERS.map((letter) => {
      const byInd: Record<string, { hits: number; wins: number; ret: number }> = {};
      for (const h of allHits) {
        if (h.letter !== letter) continue;
        const f = forwardCache.get(`${h.symbol}|${h.date}`);
        if (!f || f.ret5d == null) continue;
        if (!byInd[h.industry]) byInd[h.industry] = { hits: 0, wins: 0, ret: 0 };
        const b = byInd[h.industry];
        b.hits++;
        if (f.ret5d > 0) b.wins++;
        b.ret += f.ret5d;
      }
      return {
        letter: letter as string,
        industries: Object.entries(byInd)
          .filter(([, b]) => b.hits >= 3)
          .map(([industry, b]) => ({
            industry,
            hits: b.hits,
            winRate: +((b.wins / b.hits) * 100).toFixed(1),
            avgRet: +((b.ret / b.hits) * 100).toFixed(2),
          }))
          .sort((a, b) => b.winRate - a.winRate)
          .slice(0, 5),
      };
    });

    return apiOk({
      market,
      generatedAt: new Date().toISOString(),
      sampleSize: { totalHits: allHits.length, uniqueStockDays: uniqKeys.length },
      ensemble,
      regime,
      drawdown,
      industry,
    });
  } catch (err) {
    console.error('[v12/deep-analytics]', err);
    return apiError(`failed: ${String(err).slice(0, 200)}`);
  }
}
