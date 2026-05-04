/**
 * L1 Cache 管理：清除 / 驗證 cache 與 disk 一致性
 *
 * GET /api/admin/l1-cache?action=verify[&market=TW|CN]
 *   掃描指定市場（或全部）所有 cache entries，比對 disk file，回報 mismatch 清單
 *   只比對最後 5 根 K 棒（這是最容易被盤中污染的範圍）
 *
 * POST /api/admin/l1-cache?action=clear[&market=TW|CN]
 *   清除全部 cache（market 參數預留，目前忽略）
 */

import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import path from 'path';
import { clearCache, getCacheStats, invalidateEntry } from '@/lib/datasource/L1CandleCache';
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';
import { checkAdminAuth } from '@/lib/api/adminAuth';

export const runtime = 'nodejs';

interface MismatchEntry {
  symbol: string;
  market: 'TW' | 'CN';
  date: string;
  field: 'open' | 'high' | 'low' | 'close' | 'volume';
  disk: number;
  cache: number;
}

const TAIL_BARS = 5;

async function readDiskRaw(symbol: string, market: 'TW' | 'CN'): Promise<{ candles: Array<Record<string, number | string>> } | null> {
  const file = path.join(process.cwd(), 'data', 'candles', market, `${symbol}.json`);
  try {
    const raw = await readFile(file, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const authError = checkAdminAuth(req);
  if (authError) return authError;

  const action = req.nextUrl.searchParams.get('action') ?? 'verify';
  const marketFilter = req.nextUrl.searchParams.get('market') as 'TW' | 'CN' | null;

  if (action === 'stats') {
    return NextResponse.json(getCacheStats());
  }

  if (action !== 'verify') {
    return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  }

  // Verify：用 cache stats 拿 keys，逐一讀 disk 比對最後 5 根
  const stats = getCacheStats();
  const cachedKeys = stats.markets.map(m => m); // markets 不夠用，需要 entries — 改用直接走 dataDir
  void cachedKeys;

  const dataRoot = path.join(process.cwd(), 'data', 'candles');
  const { readdir } = await import('fs/promises');
  const markets: ('TW' | 'CN')[] = marketFilter ? [marketFilter] : ['TW', 'CN'];

  const mismatches: MismatchEntry[] = [];
  let scanned = 0;
  let cacheHits = 0;

  for (const market of markets) {
    let files: string[] = [];
    try { files = await readdir(path.join(dataRoot, market)); } catch { continue; }

    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const symbol = f.replace(/\.json$/, '');
      scanned++;

      const cached = await readCandleFile(symbol, market);
      if (!cached) continue;
      cacheHits++;

      const disk = await readDiskRaw(symbol, market);
      if (!disk?.candles?.length) continue;

      const tailCache = cached.candles.slice(-TAIL_BARS);
      const tailDisk = (disk.candles as Array<Record<string, number | string>>).slice(-TAIL_BARS);

      // 對齊日期再比
      const diskByDate = new Map(tailDisk.map(c => [String(c.date), c]));
      for (const cb of tailCache) {
        const db = diskByDate.get(cb.date);
        if (!db) continue;
        for (const field of ['open', 'high', 'low', 'close', 'volume'] as const) {
          const cv = (cb as unknown as Record<string, number>)[field];
          const dv = db[field] as number;
          if (typeof cv === 'number' && typeof dv === 'number' && cv !== dv) {
            mismatches.push({ symbol, market, date: cb.date, field, disk: dv, cache: cv });
          }
        }
      }
    }
  }

  // 依股票分組
  const bySymbol = new Map<string, MismatchEntry[]>();
  for (const m of mismatches) {
    const key = `${m.market}/${m.symbol}`;
    if (!bySymbol.has(key)) bySymbol.set(key, []);
    bySymbol.get(key)!.push(m);
  }

  const summary = [...bySymbol.entries()]
    .map(([key, entries]) => ({
      stock: key,
      diffs: entries.length,
      sampleDates: [...new Set(entries.map(e => e.date))].slice(0, 3),
    }))
    .sort((a, b) => b.diffs - a.diffs);

  return NextResponse.json({
    scanned,
    cacheHits,
    affectedStocks: bySymbol.size,
    totalMismatches: mismatches.length,
    summary: summary.slice(0, 100),
    samples: mismatches.slice(0, 10),
  });
}

export async function POST(req: NextRequest) {
  const authError = checkAdminAuth(req);
  if (authError) return authError;

  const action = req.nextUrl.searchParams.get('action') ?? 'clear';

  if (action === 'clear') {
    const before = getCacheStats();
    clearCache();
    return NextResponse.json({ cleared: true, before, after: getCacheStats() });
  }

  if (action === 'invalidate') {
    const symbol = req.nextUrl.searchParams.get('symbol');
    const market = req.nextUrl.searchParams.get('market') as 'TW' | 'CN' | null;
    if (!symbol || !market) {
      return NextResponse.json({ error: 'symbol & market required' }, { status: 400 });
    }
    invalidateEntry(symbol, market);
    return NextResponse.json({ invalidated: `${market}/${symbol}` });
  }

  return NextResponse.json({ error: 'unknown action' }, { status: 400 });
}
