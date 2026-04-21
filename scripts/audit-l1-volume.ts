#!/usr/bin/env npx tsx
/**
 * audit-l1-volume.ts — L1 全市場 K 棒量異常全表掃描
 *
 * 掃描項目：
 *   1. 零量或負量（資料錯誤）
 *   2. 暴量：單日 volume > 前20日中位數 × spikeThreshold
 *   3. OHLC 完整性（high<low、零/負價格）
 *   4. 最後一根日期落後超過 N 個交易日（stale）
 *
 * 用法：
 *   npx tsx scripts/audit-l1-volume.ts --market TW
 *   npx tsx scripts/audit-l1-volume.ts --market CN
 *   npx tsx scripts/audit-l1-volume.ts --market ALL
 *   npx tsx scripts/audit-l1-volume.ts --market ALL --spike 30 --output data/reports/audit-volume.json
 */

import { readdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const marketArg = (args.find((_, i) => args[i - 1] === '--market') ?? 'ALL').toUpperCase();
const spikeThreshold = parseFloat(args.find((_, i) => args[i - 1] === '--spike') ?? '20');
const outputPath = args.find((_, i) => args[i - 1] === '--output') ?? '';
const STALE_DAYS = 5;

const DATA_ROOT = path.join(process.cwd(), 'data', 'candles');

interface Candle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface VolumeAnomaly {
  date: string;
  volume: number;
  median20: number;
  ratio: number;
}

interface OhlcAnomaly {
  date: string;
  issue: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface StockAudit {
  symbol: string;
  market: string;
  candleCount: number;
  lastDate: string;
  zeroVolumeDates: string[];
  negVolumeDates: string[];
  volumeSpikes: VolumeAnomaly[];
  ohlcAnomalies: OhlcAnomaly[];
  isStale: boolean;
  staleByDays?: number;
  status: 'clean' | 'warn' | 'error';
}

interface AuditReport {
  generatedAt: string;
  market: string;
  spikeThreshold: number;
  totalFiles: number;
  clean: number;
  warn: number;
  error: number;
  stocksWithZeroVolume: number;
  stocksWithSpikes: number;
  stocksWithOhlcIssues: number;
  stocksStale: number;
  topSpikes: Array<{ symbol: string; date: string; ratio: number; volume: number; median20: number }>;
  details: StockAudit[];
}

function median(vals: number[]): number {
  if (vals.length === 0) return 0;
  const sorted = [...vals].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function daysBehind(lastDate: string): number {
  const last = new Date(lastDate + 'T12:00:00');
  const now = new Date();
  return Math.round((now.getTime() - last.getTime()) / (1000 * 60 * 60 * 24));
}

function auditStock(filePath: string, market: string): StockAudit {
  const raw = JSON.parse(readFileSync(filePath, 'utf8'));
  const symbol: string = raw.symbol ?? path.basename(filePath, '.json');
  const candles: Candle[] = raw.candles ?? [];

  const zeroVolumeDates: string[] = [];
  const negVolumeDates: string[] = [];
  const volumeSpikes: VolumeAnomaly[] = [];
  const ohlcAnomalies: OhlcAnomaly[] = [];

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];

    // Zero / negative volume
    if (c.volume < 0) {
      negVolumeDates.push(c.date);
    } else if (c.volume === 0) {
      zeroVolumeDates.push(c.date);
    }

    // OHLC integrity
    if (c.open <= 0 || c.high <= 0 || c.low <= 0 || c.close <= 0) {
      ohlcAnomalies.push({ date: c.date, issue: '零或負價格', open: c.open, high: c.high, low: c.low, close: c.close });
    } else if (c.high < c.low) {
      ohlcAnomalies.push({ date: c.date, issue: 'high<low', open: c.open, high: c.high, low: c.low, close: c.close });
    } else if (c.open > c.high || c.open < c.low || c.close > c.high || c.close < c.low) {
      ohlcAnomalies.push({ date: c.date, issue: 'OHLC不一致', open: c.open, high: c.high, low: c.low, close: c.close });
    }

    // Volume spike: compare to prev 20-day median
    if (i >= 5 && c.volume > 0) {
      const window = candles.slice(Math.max(0, i - 20), i).map(x => x.volume).filter(v => v > 0);
      if (window.length >= 5) {
        const med = median(window);
        if (med > 0) {
          const ratio = c.volume / med;
          if (ratio >= spikeThreshold) {
            volumeSpikes.push({ date: c.date, volume: c.volume, median20: Math.round(med), ratio: +ratio.toFixed(1) });
          }
        }
      }
    }
  }

  const lastDate = candles[candles.length - 1]?.date ?? '';
  const behind = lastDate ? daysBehind(lastDate) : 999;
  const isStale = behind > STALE_DAYS * 1.5; // allow weekend buffer

  const hasError = negVolumeDates.length > 0 || ohlcAnomalies.length > 0;
  const hasWarn = zeroVolumeDates.length > 0 || volumeSpikes.length > 0 || isStale;

  return {
    symbol,
    market,
    candleCount: candles.length,
    lastDate,
    zeroVolumeDates,
    negVolumeDates,
    volumeSpikes,
    ohlcAnomalies,
    isStale,
    staleByDays: behind,
    status: hasError ? 'error' : hasWarn ? 'warn' : 'clean',
  };
}

function auditMarket(market: 'TW' | 'CN'): StockAudit[] {
  const dir = path.join(DATA_ROOT, market);
  const files = readdirSync(dir).filter(f => f.endsWith('.json'));
  const results: StockAudit[] = [];
  let done = 0;

  for (const f of files) {
    try {
      results.push(auditStock(path.join(dir, f), market));
    } catch (e) {
      results.push({
        symbol: f.replace('.json', ''),
        market,
        candleCount: 0,
        lastDate: '',
        zeroVolumeDates: [],
        negVolumeDates: [],
        volumeSpikes: [],
        ohlcAnomalies: [{ date: '', issue: `讀檔失敗: ${(e as Error).message}`, open: 0, high: 0, low: 0, close: 0 }],
        isStale: true,
        status: 'error',
      });
    }
    done++;
    if (done % 500 === 0) process.stdout.write(`  [${market}] ${done}/${files.length}\n`);
  }

  return results;
}

function buildReport(details: StockAudit[], market: string): AuditReport {
  const allSpikes = details.flatMap(d => d.volumeSpikes.map(s => ({ symbol: d.symbol, ...s })));
  allSpikes.sort((a, b) => b.ratio - a.ratio);

  return {
    generatedAt: new Date().toISOString(),
    market,
    spikeThreshold,
    totalFiles: details.length,
    clean: details.filter(d => d.status === 'clean').length,
    warn: details.filter(d => d.status === 'warn').length,
    error: details.filter(d => d.status === 'error').length,
    stocksWithZeroVolume: details.filter(d => d.zeroVolumeDates.length > 0).length,
    stocksWithSpikes: details.filter(d => d.volumeSpikes.length > 0).length,
    stocksWithOhlcIssues: details.filter(d => d.ohlcAnomalies.length > 0).length,
    stocksStale: details.filter(d => d.isStale).length,
    topSpikes: allSpikes.slice(0, 50),
    details,
  };
}

function printSummary(report: AuditReport) {
  const { totalFiles, clean, warn, error, stocksWithZeroVolume, stocksWithSpikes, stocksWithOhlcIssues, stocksStale, topSpikes } = report;
  console.log(`\n${'='.repeat(65)}`);
  console.log(`[${report.market}] L1 量異常稽核報告（門檻 ×${report.spikeThreshold}）`);
  console.log(`${'='.repeat(65)}`);
  console.log(`  總檔案數  : ${totalFiles}`);
  console.log(`  ✅ 乾淨   : ${clean} (${(clean / totalFiles * 100).toFixed(1)}%)`);
  console.log(`  ⚠️ 警告    : ${warn} (${(warn / totalFiles * 100).toFixed(1)}%)`);
  console.log(`  ❌ 錯誤   : ${error}`);
  console.log(`  零量股    : ${stocksWithZeroVolume}`);
  console.log(`  暴量股    : ${stocksWithSpikes}`);
  console.log(`  OHLC問題  : ${stocksWithOhlcIssues}`);
  console.log(`  日期落後  : ${stocksStale}`);

  if (topSpikes.length > 0) {
    console.log(`\n🔴 量暴衝 TOP 20（ratio = 當日量/前20日中位數）:`);
    for (const s of topSpikes.slice(0, 20)) {
      console.log(`  ${s.symbol} ${s.date}  ratio=${s.ratio}×  vol=${s.volume.toLocaleString()}  med=${s.median20.toLocaleString()}`);
    }
  }

  const errors = report.details.filter(d => d.status === 'error');
  if (errors.length > 0) {
    console.log(`\n❌ 錯誤清單 (前10):`);
    for (const d of errors.slice(0, 10)) {
      const issues = [...d.negVolumeDates.map(dt => `負量@${dt}`), ...d.ohlcAnomalies.map(a => `OHLC:${a.issue}@${a.date}`)];
      console.log(`  ${d.symbol}: ${issues.slice(0, 3).join(', ')}`);
    }
  }

  const stales = report.details.filter(d => d.isStale).sort((a, b) => (b.staleByDays ?? 0) - (a.staleByDays ?? 0));
  if (stales.length > 0) {
    console.log(`\n⏰ 落後清單 (前10):`);
    for (const d of stales.slice(0, 10)) {
      console.log(`  ${d.symbol}: 最後=${d.lastDate} 落後=${d.staleByDays}天`);
    }
  }
}

async function main() {
  const markets: Array<'TW' | 'CN'> = marketArg === 'ALL' ? ['TW', 'CN'] : [marketArg as 'TW' | 'CN'];
  const allDetails: StockAudit[] = [];

  for (const m of markets) {
    console.log(`\n[${m}] 掃描中...`);
    const details = auditMarket(m);
    allDetails.push(...details);
    const report = buildReport(details, m);
    printSummary(report);
  }

  if (markets.length > 1) {
    console.log(`\n${'='.repeat(65)}`);
    console.log(`[ALL] 合計`);
    const combined = buildReport(allDetails, 'ALL');
    console.log(`  總檔案 ${combined.totalFiles}，乾淨 ${combined.clean}，警告 ${combined.warn}，錯誤 ${combined.error}`);
    console.log(`  暴量股 ${combined.stocksWithSpikes}，OHLC問題 ${combined.stocksWithOhlcIssues}，落後 ${combined.stocksStale}`);
  }

  // Save JSON report
  const finalReport = buildReport(allDetails, marketArg);
  const outPath = outputPath || path.join(process.cwd(), 'data', 'reports', `audit-volume-${marketArg}-${new Date().toISOString().split('T')[0]}.json`);
  writeFileSync(outPath, JSON.stringify(finalReport, null, 2));
  console.log(`\n📄 完整報告已儲存：${outPath}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
