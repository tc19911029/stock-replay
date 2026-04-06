/**
 * 陸股掃描回補腳本
 *
 * 用途：為歷史交易日重新跑 ChinaScanner，產生 4 種變體的新格式掃描檔案
 *   - long-daily, long-mtf, short-daily, short-mtf
 *
 * 特點：完全使用本地 candle 資料（/data/candles/CN/），不打外部 API
 *
 * 用法：
 *   npx tsx scripts/backfill-cn-scans.ts              # 回補所有缺失日期
 *   npx tsx scripts/backfill-cn-scans.ts --date 2026-04-01  # 只跑特定日期
 */

import { ChinaScanner } from '@/lib/scanner/ChinaScanner';
import { ScanSession } from '@/lib/scanner/types';
import { saveScanSession } from '@/lib/storage/scanStorage';
import { ZHU_V1 } from '@/lib/strategy/StrategyConfig';
import { isWeekday } from '@/lib/utils/tradingDay';
import { loadLocalCandlesForDate } from '@/lib/datasource/LocalCandleStore';
import { detectTrend } from '@/lib/analysis/trendAnalysis';
import { CandleWithIndicators } from '@/types';
import * as fs from 'fs';
import * as path from 'path';

// ── Local-only scanner（覆寫 fetchCandles 和 getMarketTrend） ─────────────

class LocalChinaScanner extends ChinaScanner {
  /**
   * 覆寫：從本地 /data/candles/CN/ 讀取，不打 API
   */
  async fetchCandles(symbol: string, asOfDate?: string): Promise<CandleWithIndicators[]> {
    if (!asOfDate) return [];
    const candles = await loadLocalCandlesForDate(symbol, 'CN', asOfDate);
    return candles ?? [];
  }

  /**
   * 覆寫：使用本地 000300.SS candle 計算大盤趨勢
   */
  async getMarketTrend(asOfDate?: string) {
    try {
      const candles = await loadLocalCandlesForDate('000300.SS', 'CN', asOfDate ?? '');
      if (!candles || candles.length < 20) return '盤整' as const;

      const lastIdx = candles.length - 1;
      const longTrend = detectTrend(candles, lastIdx);

      const last = candles[lastIdx];
      const shortTermBearish =
        last.ma5 != null && last.ma10 != null &&
        last.close < last.ma5 && last.ma5 < last.ma10;

      const marketOverheat =
        last.ma20 != null && last.ma20 > 0 &&
        last.close > last.ma20 * 1.08;

      if (longTrend === '多頭' && (shortTermBearish || marketOverheat)) {
        return '盤整' as const;
      }

      return longTrend;
    } catch {
      return '盤整' as const;
    }
  }
}

// ── Collect target dates ──────────────────────────────────────────────────

function collectDates(specificDate?: string): string[] {
  if (specificDate) return [specificDate];

  const dataDir = path.join(process.cwd(), 'data');
  const files = fs.readdirSync(dataDir);

  // Gather dates from legacy CN files
  const dates = new Set<string>();
  for (const f of files) {
    const m = f.match(/^scan-CN-(\d{4}-\d{2}-\d{2})\.json$/);
    if (m) dates.add(m[1]);
  }

  // Also add recent dates that might not have legacy files
  // Scan from 2026-02-10 to today
  const today = new Date().toISOString().split('T')[0];
  for (let d = new Date('2026-02-10'); d.toISOString().split('T')[0] <= today; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split('T')[0];
    if (isWeekday(dateStr, 'CN')) dates.add(dateStr);
  }

  return [...dates].sort();
}

function hasAllNewFormatFiles(date: string): boolean {
  const dataDir = path.join(process.cwd(), 'data');
  const variants = [
    `scan-CN-long-daily-${date}.json`,
    `scan-CN-long-mtf-${date}.json`,
    `scan-CN-short-daily-${date}.json`,
    `scan-CN-short-mtf-${date}.json`,
  ];
  return variants.every(f => fs.existsSync(path.join(dataDir, f)));
}

// ── Check local candle coverage ──────────────────────────────────────────

function checkCandleCoverage(date: string): boolean {
  // Check a few representative stocks to see if local candle data covers this date
  const candleDir = path.join(process.cwd(), 'data', 'candles', 'CN');
  const sampleStocks = ['000001.SZ', '600519.SS', '601398.SS'];
  for (const stock of sampleStocks) {
    try {
      const raw = fs.readFileSync(path.join(candleDir, `${stock}.json`), 'utf-8');
      const data = JSON.parse(raw);
      if (data.lastDate >= date) return true;
    } catch { /* skip */ }
  }
  return false;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dateIdx = args.indexOf('--date');
  const specificDate = dateIdx !== -1 ? args[dateIdx + 1] : undefined;

  const allDates = collectDates(specificDate);

  // Filter: skip dates with all 4 variants already present, and dates without candle coverage
  const dates = allDates.filter(d => {
    if (hasAllNewFormatFiles(d)) return false;
    if (!checkCandleCoverage(d)) return false;
    return true;
  });

  console.log(`\n📊 CN 掃描回補（本地 candle 模式）`);
  console.log(`   可用日期: ${allDates.length}, 需回補: ${dates.length}\n`);

  if (dates.length === 0) {
    console.log('✅ 所有日期已有完整的新格式檔案或無 candle 資料可用');
    return;
  }

  const scanner = new LocalChinaScanner();

  // 只掃描有本地 candle 資料的股票（跳過沒有下載的）
  const candleDir = path.join(process.cwd(), 'data', 'candles', 'CN');
  const localSymbols = new Set(
    fs.readdirSync(candleDir)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''))
  );

  const allStocks = await scanner.getStockList();
  const stocks = allStocks.filter(s => localSymbols.has(s.symbol));
  console.log(`   股票清單: ${stocks.length} 支（本地有 candle 資料，全部 ${allStocks.length} 支）\n`);

  const mtfThresholds = { ...ZHU_V1.thresholds, multiTimeframeFilter: true };
  let totalCreated = 0;

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const progress = `[${i + 1}/${dates.length}]`;

    try {
      // ── Long daily ──
      const { results: longDaily, marketTrend } = await scanner.scanSOP(stocks, date);
      const longDailySession: ScanSession = {
        id: `CN-long-daily-${date}-backfill`,
        market: 'CN', date, direction: 'long',
        multiTimeframeEnabled: false,
        scanTime: new Date().toISOString(),
        resultCount: longDaily.length, results: longDaily,
      };
      await saveScanSession(longDailySession);

      // ── Long MTF ──
      let longMtfCount = 0;
      try {
        const { results: longMtf } = await scanner.scanSOP(stocks, date, mtfThresholds);
        const longMtfSession: ScanSession = {
          id: `CN-long-mtf-${date}-backfill`,
          market: 'CN', date, direction: 'long',
          multiTimeframeEnabled: true,
          scanTime: new Date().toISOString(),
          resultCount: longMtf.length, results: longMtf,
        };
        await saveScanSession(longMtfSession);
        longMtfCount = longMtf.length;
      } catch { longMtfCount = -1; }

      // ── Short daily ──
      let shortDailyCount = 0;
      try {
        const { candidates: shortDaily } = await scanner.scanShortCandidates(stocks, date);
        const shortDailySession: ScanSession = {
          id: `CN-short-daily-${date}-backfill`,
          market: 'CN', date, direction: 'short',
          multiTimeframeEnabled: false,
          scanTime: new Date().toISOString(),
          resultCount: shortDaily.length, results: shortDaily,
        };
        await saveScanSession(shortDailySession);
        shortDailyCount = shortDaily.length;
      } catch { shortDailyCount = -1; }

      // ── Short MTF ──
      let shortMtfCount = 0;
      try {
        const { candidates: shortMtf } = await scanner.scanShortCandidates(stocks, date, mtfThresholds);
        const shortMtfSession: ScanSession = {
          id: `CN-short-mtf-${date}-backfill`,
          market: 'CN', date, direction: 'short',
          multiTimeframeEnabled: true,
          scanTime: new Date().toISOString(),
          resultCount: shortMtf.length, results: shortMtf,
        };
        await saveScanSession(shortMtfSession);
        shortMtfCount = shortMtf.length;
      } catch { shortMtfCount = -1; }

      totalCreated += 4;
      console.log(
        `${progress} ${date} ✅ trend=${marketTrend} ` +
        `long-d=${longDaily.length} long-m=${longMtfCount} ` +
        `short-d=${shortDailyCount} short-m=${shortMtfCount}`
      );
    } catch (err) {
      console.error(`${progress} ${date} ❌ ${err}`);
    }
  }

  // Summary
  const dataDir = path.join(process.cwd(), 'data');
  const newFiles = fs.readdirSync(dataDir).filter(f =>
    (f.startsWith('scan-CN-long-') || f.startsWith('scan-CN-short-'))
  );
  console.log(`\n✅ 完成！本次建立 ${totalCreated} 個檔案，CN 新格式檔案總計: ${newFiles.length}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
