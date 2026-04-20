/**
 * 並列買法歷史批次掃描（B/C/D/E 過去 N 日）
 *
 * 用法：
 *   npx tsx scripts/scan-buy-methods-history.ts                  # TW+CN 過去 20 日
 *   npx tsx scripts/scan-buy-methods-history.ts --market TW      # 只 TW
 *   npx tsx scripts/scan-buy-methods-history.ts --days 30
 */

import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { computeTurnoverRankAsOfDate } from '@/lib/scanner/TurnoverRank';
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';
import { computeIndicators } from '@/lib/indicators';
import { detectBreakoutEntry } from '@/lib/analysis/breakoutEntry';
import { detectVReversal } from '@/lib/analysis/vReversalDetector';
import { detectStrategyD } from '@/lib/analysis/gapEntry';
import { detectStrategyE } from '@/lib/analysis/highWinRateEntry';
import { saveScanSession } from '@/lib/storage/scanStorage';
import { getTWSENames } from '@/lib/datasource/TWSENames';
import { TaiwanScanner } from '@/lib/scanner/TaiwanScanner';
import { ChinaScanner } from '@/lib/scanner/ChinaScanner';
import { isTradingDay } from '@/lib/utils/tradingDay';
import type { StockScanResult, ScanSession, MarketId } from '@/lib/scanner/types';

type BuyMethod = 'B' | 'C' | 'D' | 'E';
const METHODS: BuyMethod[] = ['B', 'C', 'D', 'E'];

function listRecentTradingDays(market: MarketId, count: number): string[] {
  const tz = market === 'TW' ? 'Asia/Taipei' : 'Asia/Shanghai';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  const results: string[] = [];
  const cursor = new Date(today + 'T00:00:00Z');
  while (results.length < count) {
    const iso = cursor.toISOString().slice(0, 10);
    if (isTradingDay(iso, market)) results.push(iso);
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return results.reverse();
}

async function scanMarketDate(
  market: MarketId,
  date: string,
  allStocks: Array<{ symbol: string; name?: string }>,
  nameMap: Map<string, string>,
): Promise<void> {
  const rank = await computeTurnoverRankAsOfDate(market, allStocks, date, 500);
  if (rank.size === 0) {
    console.log(`   ⚠️  ${date} 歷史 top500 為空，跳過`);
    return;
  }
  const symbols = Array.from(rank.keys());

  const buckets: Record<BuyMethod, StockScanResult[]> = { B: [], C: [], D: [], E: [] };

  for (const sym of symbols) {
    try {
      const raw = await readCandleFile(sym, market);
      if (!raw || !raw.candles || raw.candles.length < 60) continue;
      // 找 date 對應 index（targetDate 在歷史 K 列中的位置）
      const idx = raw.candles.findIndex(c => c.date === date);
      if (idx < 60) continue;
      const candles = computeIndicators(raw.candles.slice(0, idx + 1));
      const lastIdx = candles.length - 1;
      const last = candles[lastIdx];
      if (!last || last.close <= 0) continue;

      const prev = candles[lastIdx - 1];
      const changePercent = prev && prev.close > 0
        ? +((last.close - prev.close) / prev.close * 100).toFixed(2)
        : 0;

      const code = sym.replace(/\.(TW|TWO|SS|SZ)$/i, '');
      const name = nameMap.get(code) || code;

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

  const scanTime = new Date().toISOString();
  for (const method of METHODS) {
    const results = buckets[method].sort((a, b) => (b.changePercent ?? 0) - (a.changePercent ?? 0));
    const session: ScanSession = {
      id: `${market}-long-${method}-${date}-post_close-${Date.now()}`,
      market,
      date,
      direction: 'long',
      multiTimeframeEnabled: false,
      buyMethod: method,
      sessionType: 'post_close',
      scanTime,
      resultCount: results.length,
      results,
    };
    await saveScanSession(session);
  }
  console.log(`   ✅ ${date} B=${buckets.B.length} C=${buckets.C.length} D=${buckets.D.length} E=${buckets.E.length}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let market: MarketId | 'BOTH' = 'BOTH';
  let days = 20;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--market' && args[i + 1]) {
      const m = args[i + 1].toUpperCase();
      if (m === 'TW' || m === 'CN' || m === 'BOTH') market = m as MarketId | 'BOTH';
      i++;
    } else if (args[i] === '--days' && args[i + 1]) {
      days = parseInt(args[i + 1], 10);
      i++;
    }
  }

  const markets: MarketId[] = market === 'BOTH' ? ['TW', 'CN'] : [market];

  for (const mkt of markets) {
    const scanner = mkt === 'TW' ? new TaiwanScanner() : new ChinaScanner();
    const allStocks = await scanner.getStockList();
    const dates = listRecentTradingDays(mkt, days);
    console.log(`\n📅 [${mkt}] B/C/D/E 歷史掃描 ${dates.length} 天: ${dates[0]} ~ ${dates[dates.length - 1]}`);

    // TW 名字 map
    let nameMap = new Map<string, string>();
    if (mkt === 'TW') {
      try {
        const names = await getTWSENames();
        nameMap = new Map(Object.entries(names));
      } catch { /* skip */ }
    } else {
      // CN 名字從 scanner 股票清單
      for (const s of allStocks) {
        if (s.name) {
          const code = s.symbol.replace(/\.(SS|SZ)$/i, '');
          nameMap.set(code, s.name);
        }
      }
    }

    for (const date of dates) {
      console.log(`🔍 [${mkt} ${date}] B/C/D/E 掃描...`);
      try {
        await scanMarketDate(mkt, date, allStocks, nameMap);
      } catch (err) {
        console.error(`   ❌ ${date} 失敗:`, err instanceof Error ? err.message : err);
      }
    }
  }

  console.log('\n🎉 B/C/D/E 歷史掃描完成');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
