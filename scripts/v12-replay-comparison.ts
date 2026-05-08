/**
 * v12 vs v11 30 天歷史回放對比工具（Phase 1.13）
 *
 * 用法：
 *   npx tsx scripts/v12-replay-comparison.ts <market> <days>
 *
 * 範例：
 *   npx tsx scripts/v12-replay-comparison.ts TW 30
 *   npx tsx scripts/v12-replay-comparison.ts CN 7
 *
 * 流程：
 * 1. 讀取過去 N 天的 L4 scan record（v11 結果）
 * 2. 對相同股票池 + 相同日期跑 evaluateStockV12
 * 3. 比較 v11 vs v12 命中差異：
 *    - 共同命中（多頭軌訊號重疊度）
 *    - v11 有 v12 無（v12 過濾較嚴）
 *    - v11 無 v12 有（v12 新訊號 J/K/L/M/N/O/P/Q）
 * 4. 輸出 markdown 報告
 *
 * 注意：本工具**不寫任何 production 資料**，純 read + 比較 + 列印報告。
 *
 * 用此工具確認 v12 邏輯是否符合預期 → 通過後才接 cron route。
 */

import { promises as fs } from 'fs';
import path from 'path';

import type { CandleWithIndicators } from '../types';
import type { MarketId, StockScanResult } from '../lib/scanner/types';

// ── 設定 ────────────────────────────────────────────────────────────────

interface ReplayOptions {
  market: MarketId;
  days: number;
  /** 限定股票池（可選；不填則用 v11 scan record 中出現的全部）*/
  symbols?: string[];
  /** 是否輸出詳細 per-stock 比較（預設 false 只輸出 summary）*/
  verbose?: boolean;
}

interface DayComparisonResult {
  date: string;
  v11Count: number;
  v12Count: number;
  /** v11 有命中、v12 也有命中（共同）*/
  commonSymbols: string[];
  /** v11 有 v12 無 */
  v11Only: string[];
  /** v11 無 v12 有 */
  v12Only: string[];
  /** v12 觸發的字母分佈 */
  v12LetterDistribution: Record<string, number>;
}

interface ReplayReport {
  market: MarketId;
  days: number;
  startDate: string;
  endDate: string;
  totalV11: number;
  totalV12: number;
  totalCommon: number;
  totalV11Only: number;
  totalV12Only: number;
  letterDistribution: Record<string, number>;
  perDay: DayComparisonResult[];
}

// ── 主流程 ──────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const market = (args[0] ?? 'TW').toUpperCase() as MarketId;
  const days = parseInt(args[1] ?? '7', 10);
  const verbose = args.includes('--verbose');

  if (market !== 'TW' && market !== 'CN') {
    console.error('Usage: tsx v12-replay-comparison.ts <TW|CN> <days>');
    process.exit(1);
  }

  console.log(`# v12 vs v11 歷史回放對比`);
  console.log(`市場：${market}`);
  console.log(`回放天數：${days}`);
  console.log(``);

  const report = await runReplay({ market, days, verbose });
  await writeReport(report);
}

async function runReplay(opts: ReplayOptions): Promise<ReplayReport> {
  const { market, days, verbose } = opts;
  const dataDir = path.join(process.cwd(), 'data', 'scans', market);

  // 讀取最近 N 天的 scan record
  const dateFolders = await getRecentDates(dataDir, days);
  if (dateFolders.length === 0) {
    console.error(`找不到 ${market} 的歷史 scan record（${dataDir}）`);
    process.exit(1);
  }

  const perDay: DayComparisonResult[] = [];
  let totalV11 = 0;
  let totalV12 = 0;
  let totalCommon = 0;
  let totalV11Only = 0;
  let totalV12Only = 0;
  const totalLetterDist: Record<string, number> = {};

  for (const date of dateFolders) {
    const result = await compareOneDay(market, date, verbose);
    if (!result) continue;

    perDay.push(result);
    totalV11 += result.v11Count;
    totalV12 += result.v12Count;
    totalCommon += result.commonSymbols.length;
    totalV11Only += result.v11Only.length;
    totalV12Only += result.v12Only.length;

    for (const [letter, count] of Object.entries(result.v12LetterDistribution)) {
      totalLetterDist[letter] = (totalLetterDist[letter] ?? 0) + count;
    }

    console.log(
      `[${date}] v11=${result.v11Count} v12=${result.v12Count} 共同=${result.commonSymbols.length} ` +
      `v11only=${result.v11Only.length} v12only=${result.v12Only.length}`,
    );
  }

  return {
    market,
    days,
    startDate: dateFolders[0],
    endDate: dateFolders[dateFolders.length - 1],
    totalV11,
    totalV12,
    totalCommon,
    totalV11Only,
    totalV12Only,
    letterDistribution: totalLetterDist,
    perDay,
  };
}

async function compareOneDay(
  market: MarketId,
  date: string,
  verbose: boolean,
): Promise<DayComparisonResult | null> {
  // 讀 v11 結果（既有 scan record）
  const v11Symbols = await loadV11Symbols(market, date);
  if (v11Symbols.length === 0 && verbose) {
    console.warn(`[${date}] v11 無結果，跳過`);
  }

  // 讀 v12 結果（執行 evaluateStockV12 — 此處需要 candles 資料）
  // 注意：本腳本框架只跑 stub；實際整合需要載入個股 candles + 大盤 candles
  const v12Symbols = await loadV12Symbols(market, date);

  const v11Set = new Set(v11Symbols);
  const v12Set = new Set(v12Symbols);

  const commonSymbols = [...v11Set].filter(s => v12Set.has(s));
  const v11Only = [...v11Set].filter(s => !v12Set.has(s));
  const v12Only = [...v12Set].filter(s => !v11Set.has(s));

  return {
    date,
    v11Count: v11Symbols.length,
    v12Count: v12Symbols.length,
    commonSymbols,
    v11Only,
    v12Only,
    v12LetterDistribution: {},  // TODO: 從 v12 結果計算字母分佈
  };
}

// ── 資料載入 ────────────────────────────────────────────────────────────

async function getRecentDates(dataDir: string, days: number): Promise<string[]> {
  try {
    const entries = await fs.readdir(dataDir);
    return entries.filter(e => /^\d{4}-\d{2}-\d{2}$/.test(e)).sort().slice(-days);
  } catch {
    return [];
  }
}

async function loadV11Symbols(market: MarketId, date: string): Promise<string[]> {
  // 讀取 v11 scan record（A 六條件主結果）
  const file = path.join(process.cwd(), 'data', 'scans', market, date, 'long-daily.json');
  try {
    const content = await fs.readFile(file, 'utf-8');
    const session = JSON.parse(content);
    return (session.results as StockScanResult[])?.map(r => r.symbol) ?? [];
  } catch {
    return [];
  }
}

async function loadV12Symbols(market: MarketId, date: string): Promise<string[]> {
  // 框架版：暫時用 v11 同份結果（待 cron 整合 v12 後改讀 v12 scan record）
  // TODO: 串接 evaluateStockV12 跑歷史 candles
  return loadV11Symbols(market, date);
}

// ── 報告輸出 ────────────────────────────────────────────────────────────

async function writeReport(report: ReplayReport): Promise<void> {
  const lines: string[] = [];
  lines.push(`# v12 vs v11 ${report.market} ${report.days} 天回放報告`);
  lines.push(``);
  lines.push(`日期範圍：${report.startDate} ~ ${report.endDate}`);
  lines.push(``);
  lines.push(`## 摘要`);
  lines.push(``);
  lines.push(`| 項目 | 數量 |`);
  lines.push(`|---|---|`);
  lines.push(`| v11 命中總數 | ${report.totalV11} |`);
  lines.push(`| v12 命中總數 | ${report.totalV12} |`);
  lines.push(`| 共同命中（重疊度）| ${report.totalCommon} (${pct(report.totalCommon, report.totalV11)}%) |`);
  lines.push(`| v11 有 v12 無（v12 較嚴）| ${report.totalV11Only} |`);
  lines.push(`| v11 無 v12 有（v12 新訊號）| ${report.totalV12Only} |`);
  lines.push(``);

  if (Object.keys(report.letterDistribution).length > 0) {
    lines.push(`## v12 字母觸發分佈`);
    lines.push(``);
    const sortedLetters = Object.entries(report.letterDistribution).sort(([, a], [, b]) => b - a);
    for (const [letter, count] of sortedLetters) {
      lines.push(`- ${letter}: ${count}`);
    }
    lines.push(``);
  }

  lines.push(`## 每日結果`);
  lines.push(``);
  lines.push(`| 日期 | v11 | v12 | 共同 | v11only | v12only |`);
  lines.push(`|---|---|---|---|---|---|`);
  for (const day of report.perDay) {
    lines.push(
      `| ${day.date} | ${day.v11Count} | ${day.v12Count} | ${day.commonSymbols.length} | ` +
      `${day.v11Only.length} | ${day.v12Only.length} |`,
    );
  }

  const outFile = path.join(
    process.cwd(),
    `v12-replay-${report.market}-${report.days}d-${Date.now()}.md`,
  );
  await fs.writeFile(outFile, lines.join('\n'), 'utf-8');
  console.log(``);
  console.log(`📄 報告已寫入：${outFile}`);
}

function pct(part: number, total: number): string {
  if (total === 0) return '0';
  return ((part / total) * 100).toFixed(1);
}

// ── Entry ────────────────────────────────────────────────────────────────

main().catch(err => {
  console.error(err);
  process.exit(1);
});
