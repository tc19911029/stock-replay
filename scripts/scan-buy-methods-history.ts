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
import { detectBreakoutEntry, detectConsolidationBreakout } from '@/lib/analysis/breakoutEntry';
import { detectVReversal } from '@/lib/analysis/vReversalDetector';
import { detectStrategyD } from '@/lib/analysis/gapEntry';
import { detectStrategyE } from '@/lib/analysis/highWinRateEntry';
import { saveScanSession } from '@/lib/storage/scanStorage';
import { getTWSENames } from '@/lib/datasource/TWSENames';
import { TaiwanScanner } from '@/lib/scanner/TaiwanScanner';
import { ChinaScanner } from '@/lib/scanner/ChinaScanner';
import { isTradingDay } from '@/lib/utils/tradingDay';
import type { StockScanResult, ScanSession, MarketId } from '@/lib/scanner/types';

type BuyMethod = 'B' | 'C' | 'D' | 'E' | 'F';
const METHODS: BuyMethod[] = ['B', 'C', 'D', 'E', 'F'];

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

  const buckets: Record<BuyMethod, StockScanResult[]> = { B: [], C: [], D: [], E: [], F: [] };

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

      const makeRule = (method: BuyMethod, detail: string) => ({
        ruleId: `buy-method-${method.toLowerCase()}`,
        ruleName: detail,
        signalType: 'BUY' as const,
        reason: detail,
      });

      const base = {
        symbol: sym,
        name,
        market,
        price: last.close,
        changePercent,
        volume: last.volume,
        sixConditionsScore: 0,
        trendState: '多頭' as const,
        trendPosition: '' as const,
        scanTime: new Date().toISOString(),
      };

      const rB = detectBreakoutEntry(candles, lastIdx);
      if (rB) {
        const detail = (rB as { detail?: string }).detail ?? '回後買上漲';
        buckets.B.push({ ...base, matchedMethods: ['B'], triggeredRules: [makeRule('B', detail)] } as StockScanResult);
      }
      const rC = detectConsolidationBreakout(candles, lastIdx);
      if (rC) {
        const detail = (rC as { detail?: string }).detail ?? '盤整突破';
        buckets.C.push({ ...base, matchedMethods: ['C'], triggeredRules: [makeRule('C', detail)] } as StockScanResult);
      }
      const rD = detectStrategyE(candles, lastIdx);
      if (rD) {
        const detail = (rD as { detail?: string }).detail ?? '一字底';
        buckets.D.push({ ...base, matchedMethods: ['D'], triggeredRules: [makeRule('D', detail)] } as StockScanResult);
      }
      const rE = detectStrategyD(candles, lastIdx);
      if (rE) {
        const detail = (rE as { detail?: string }).detail ?? '缺口進場';
        buckets.E.push({ ...base, matchedMethods: ['E'], triggeredRules: [makeRule('E', detail)] } as StockScanResult);
      }
      const rF = detectVReversal(candles, lastIdx);
      if (rF) {
        const detail = (rF as { detail?: string }).detail ?? 'V型反轉';
        buckets.F.push({ ...base, matchedMethods: ['F'], triggeredRules: [makeRule('F', detail)] } as StockScanResult);
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
    await saveScanSession(session, { allowOverwritePostClose: true });
  }
  console.log(`   ✅ ${date} B=${buckets.B.length} C=${buckets.C.length} D=${buckets.D.length} E=${buckets.E.length} F=${buckets.F.length}`);
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

    // 名字 map：優先用 scanner 股票清單（TW/TWO 都有），TW 再用 TWSE API 補漏
    let nameMap = new Map<string, string>();
    for (const s of allStocks) {
      if (s.name) {
        const suffix = mkt === 'TW' ? /\.(TW|TWO)$/i : /\.(SS|SZ)$/i;
        const code = s.symbol.replace(suffix, '');
        nameMap.set(code, s.name);
      }
    }
    if (mkt === 'TW') {
      try {
        const names = await getTWSENames();
        for (const [code, name] of Object.entries(names)) {
          if (!nameMap.has(code)) nameMap.set(code, name);
        }
      } catch { /* skip */ }
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
