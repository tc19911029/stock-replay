/**
 * 並列買法獨立掃描器（2026-04-20 架構 B 方案）
 *
 * 對 top 500 每支：合 L1 + L2 今日 K → 算 indicators → 跑 B/C/D/E detector
 * 成立者收進對應買法的 session 寫入 data/scan-{MARKET}-long-{B|C|E|F}-{date}-intraday-{hhmm}.json
 *
 * 用法：npx tsx scripts/scan-buy-methods-standalone.ts [--market TW|CN|BOTH]
 */

import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { readTurnoverRank } from '@/lib/scanner/TurnoverRank';
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';
import { readIntradaySnapshot } from '@/lib/datasource/IntradayCache';
import { computeIndicators } from '@/lib/indicators';
import { detectBreakoutEntry } from '@/lib/analysis/breakoutEntry';
import { detectVReversal } from '@/lib/analysis/vReversalDetector';
import { detectStrategyD } from '@/lib/analysis/gapEntry';
import { detectStrategyE } from '@/lib/analysis/highWinRateEntry';
import { saveScanSession } from '@/lib/storage/scanStorage';
import { getTWSENames } from '@/lib/datasource/TWSENames';
import type { StockScanResult, ScanSession, MarketId } from '@/lib/scanner/types';
import type { Candle } from '@/types';

type BuyMethod = 'B' | 'C' | 'D' | 'E';
const METHODS: BuyMethod[] = ['B', 'C', 'D', 'E'];

function todayDateFor(market: MarketId): string {
  const tz = market === 'TW' ? 'Asia/Taipei' : 'Asia/Shanghai';
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}

/** 合 L1 + L2 今日 K 棒（若 L2 有當日報價，覆蓋或 append 為最後一根） */
function mergeTodayL2(l1: Candle[], l2Quote: { open: number; high: number; low: number; close: number; volume: number } | undefined, date: string): Candle[] {
  if (!l2Quote || l2Quote.close <= 0) return l1;
  const merged = [...l1];
  const last = merged[merged.length - 1];
  const todayCandle: Candle = {
    date,
    open: l2Quote.open || l2Quote.close,
    high: l2Quote.high || l2Quote.close,
    low: l2Quote.low || l2Quote.close,
    close: l2Quote.close,
    volume: l2Quote.volume,
  };
  if (last?.date === date) {
    merged[merged.length - 1] = todayCandle;
  } else if (!last || last.date < date) {
    merged.push(todayCandle);
  }
  return merged;
}

async function scanMarket(market: MarketId): Promise<void> {
  const date = todayDateFor(market);
  const idx = await readTurnoverRank(market);
  if (!idx || !idx.symbols || idx.symbols.length === 0) {
    console.warn(`[${market}] top500 索引為空，放棄`);
    return;
  }
  const symbols = idx.symbols ?? [];
  console.log(`[${market}] 掃描 ${symbols.length} 支 top500，目標日期 ${date}`);

  const snapshot = await readIntradaySnapshot(market, date);
  const l2Map = new Map<string, { open: number; high: number; low: number; close: number; volume: number; name?: string }>();
  if (snapshot) {
    for (const q of snapshot.quotes) {
      l2Map.set(q.symbol, { open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume, name: q.name });
    }
  }

  // 名字查詢
  let nameMap: Map<string, string> = new Map();
  if (market === 'TW') {
    try {
      const names = await getTWSENames();
      nameMap = new Map(Object.entries(names));
    } catch { /* 用 L2 名字兜底 */ }
  }

  const buckets: Record<BuyMethod, StockScanResult[]> = { B: [], C: [], D: [], E: [] };

  let processed = 0;
  for (const sym of symbols) {
    processed++;
    try {
      const raw = await readCandleFile(sym, market);
      if (!raw || !raw.candles || raw.candles.length < 60) continue;
      const code = sym.replace(/\.(TW|TWO|SS|SZ)$/i, '');
      const l2 = l2Map.get(code);
      const merged = mergeTodayL2(raw.candles, l2, date);
      const candles = computeIndicators(merged);
      const lastIdx = candles.length - 1;
      const last = candles[lastIdx];
      if (!last || last.close <= 0) continue;

      const prev = candles[lastIdx - 1];
      const changePercent = prev && prev.close > 0
        ? +((last.close - prev.close) / prev.close * 100).toFixed(2)
        : 0;

      const name = nameMap.get(code) || l2?.name || code;

      const base: Partial<StockScanResult> & { symbol: string } = {
        symbol: sym,
        name,
        market,
        price: last.close,
        changePercent,
        volume: last.volume,
        triggeredRules: [],
        sixConditionsScore: 0,
        trendState: '盤整' as const,
        trendPosition: 'none' as const,
        scanTime: new Date().toISOString(),
      };

      if (detectBreakoutEntry(candles, lastIdx)) {
        buckets.B.push({ ...base, matchedMethods: ['B'] } as StockScanResult);
      }
      if (detectVReversal(candles, lastIdx)) {
        buckets.C.push({ ...base, matchedMethods: ['C'] } as StockScanResult);
      }
      if (detectStrategyD(candles, lastIdx)) {
        buckets.D.push({ ...base, matchedMethods: ['D'] } as StockScanResult);
      }
      if (detectStrategyE(candles, lastIdx)) {
        buckets.E.push({ ...base, matchedMethods: ['E'] } as StockScanResult);
      }
    } catch { /* skip */ }
  }

  console.log(`[${market}] 處理 ${processed} 支；B=${buckets.B.length} C=${buckets.C.length} D=${buckets.D.length} E=${buckets.E.length}`);

  // 寫每個買法的 session
  const scanTime = new Date().toISOString();
  for (const method of METHODS) {
    const results = buckets[method].sort((a, b) => (b.changePercent ?? 0) - (a.changePercent ?? 0));
    const session: ScanSession = {
      id: `${market}-long-${method}-${date}-intraday-${Date.now()}`,
      market,
      date,
      direction: 'long',
      multiTimeframeEnabled: false,
      buyMethod: method,
      sessionType: 'intraday',
      scanTime,
      resultCount: results.length,
      results,
    };
    await saveScanSession(session);
    console.log(`[${market}] ✅ 寫入買法 ${method}: ${results.length} 支`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const marketArg = args[args.indexOf('--market') + 1] ?? 'BOTH';
  if (marketArg === 'TW' || marketArg === 'BOTH') await scanMarket('TW');
  if (marketArg === 'CN' || marketArg === 'BOTH') await scanMarket('CN');
}

main().catch(err => { console.error(err); process.exit(1); });
