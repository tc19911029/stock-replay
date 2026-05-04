#!/usr/bin/env npx tsx
/**
 * correct-candles.ts — Layer 1 歷史 K 線資料修正腳本
 *
 * 讀取 verify-candles.ts 產出的報告，從權威來源（TWSE/EastMoney）重新下載有問題的股票資料。
 *
 * 用法：
 *   npx tsx scripts/correct-candles.ts --market TW --report data/verify-report-TW-*.json
 *   npx tsx scripts/correct-candles.ts --market CN --report data/verify-report-CN-*.json --dry-run
 *   npx tsx scripts/correct-candles.ts --market TW --report data/verify-report-TW-*.json --severity high --limit 20
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';
import type { Candle } from '../types';
import type { VerificationReport, ComparisonResult } from '../lib/datasource/CandleVerifier';
import { validateCandles } from '../lib/datasource/validateCandles';

// ── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}
const hasFlag = (name: string) => args.includes(`--${name}`);

const MARKET = getArg('market', 'TW') as 'TW' | 'CN';
const REPORT_PATH = getArg('report', '');
const SEVERITY_MIN = getArg('severity', 'medium') as 'low' | 'medium' | 'high';
const LIMIT = parseInt(getArg('limit', '999'), 10);
const DRY_RUN = hasFlag('dry-run');
const DATE_START = getArg('from', '2024-04-13');
const DATE_END = getArg('to', '2026-04-13');

const DATA_DIR = path.join(process.cwd(), 'data', 'candles', MARKET);
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

if (!REPORT_PATH) {
  console.error('❌ 請用 --report 指定驗證報告路徑');
  process.exit(1);
}

// ── Severity filter ──────────────────────────────────────────────────────────

function severityValue(s: string): number {
  switch (s) { case 'high': return 3; case 'medium': return 2; case 'low': return 1; default: return 0; }
}

// ── TWSE fetch (TW stocks) ───────────────────────────────────────────────────

function extractCode(symbol: string): string | null {
  const m = symbol.match(/^(\d{4,5})\.(TW|TWO)$/i);
  return m ? m[1] : null;
}

function isOTC(symbol: string): boolean {
  return /\.TWO$/i.test(symbol) || /^\d{5}\.TW$/i.test(symbol);
}

async function fetchTWSEMonth(code: string, dateStr: string): Promise<Candle[]> {
  const url = `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${dateStr}&stockNo=${code}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`TWSE ${res.status}`);
  const json = await res.json() as { stat?: string; data?: string[][] };
  if (json.stat !== 'OK' || !json.data) return [];

  return json.data.map(row => {
    // ROC date: 114/04/01 → 2025/04/01
    const parts = row[0].trim().split('/');
    const year = parseInt(parts[0], 10) + 1911;
    const date = `${year}-${parts[1]}-${parts[2]}`;
    const num = (s: string) => parseFloat(s.replace(/,/g, ''));
    return {
      date,
      open: num(row[3]),
      high: num(row[4]),
      low: num(row[5]),
      close: num(row[6]),
      volume: Math.round(num(row[1]) / 1000), // shares → lots (張)
    };
  }).filter(c => c.open > 0 && c.close > 0 && !isNaN(c.open));
}

async function fetchTPExMonth(code: string, dateStr: string): Promise<Candle[]> {
  // dateStr = "20260401" → "2026/04/01"
  const y = dateStr.slice(0, 4);
  const m = dateStr.slice(4, 6);
  const url = `https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?date=${y}/${m}/01&code=${code}&response=json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`TPEx ${res.status}`);
  const json = await res.json() as { tables?: Array<{ data?: string[][] }> };
  const data = json.tables?.[0]?.data;
  if (!data) return [];

  return data.map(row => {
    const parts = row[0].trim().split('/');
    const year = parseInt(parts[0], 10) + 1911;
    const date = `${year}-${parts[1]}-${parts[2]}`;
    const num = (s: string) => parseFloat(s.replace(/,/g, ''));
    return {
      date,
      open: num(row[3]),
      high: num(row[4]),
      low: num(row[5]),
      close: num(row[6]),
      volume: Math.round(num(row[1]) / 1000), // shares → lots
    };
  }).filter(c => c.open > 0 && c.close > 0 && !isNaN(c.open));
}

/** 從 TWSE/TPEx 抓指定月份範圍的歷史 K 線 */
async function fetchTWSERange(symbol: string, startDate: string, endDate: string): Promise<Candle[]> {
  const code = extractCode(symbol);
  if (!code) throw new Error(`Invalid TW symbol: ${symbol}`);
  const otc = isOTC(symbol);

  // 計算月份列表
  const months: string[] = [];
  const start = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');
  const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  while (cursor <= end) {
    const y = cursor.getFullYear().toString();
    const m = (cursor.getMonth() + 1).toString().padStart(2, '0');
    months.push(`${y}${m}01`);
    cursor.setMonth(cursor.getMonth() + 1);
  }

  // 批次抓取（3 個月一批，間隔 2 秒）
  const BATCH = otc ? 4 : 3;
  const DELAY = otc ? 1000 : 2000;
  const allCandles: Candle[] = [];

  for (let i = 0; i < months.length; i += BATCH) {
    const batch = months.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(ds => otc ? fetchTPExMonth(code, ds) : fetchTWSEMonth(code, ds)),
    );
    for (const r of results) {
      if (r.status === 'fulfilled') allCandles.push(...r.value);
    }
    if (i + BATCH < months.length) await sleep(DELAY);
  }

  // 去重、排序
  const deduped = new Map<string, Candle>();
  for (const c of allCandles) deduped.set(c.date, c);
  return [...deduped.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// ── EastMoney fetch (CN stocks) ──────────────────────────────────────────────

function cnSecid(code: string, suffix?: 'SS' | 'SZ' | null): string {
  // suffix 是權威來源：000001.SS = 上證指數 (market=1)、000001.SZ = 平安銀行 (market=0)
  // 不可只看首字判斷，否則 000001.SS 會被誤路由到 0.000001（平安銀行）
  if (suffix === 'SS') return `1.${code}`;
  if (suffix === 'SZ') return `0.${code}`;
  return code.startsWith('6') || code.startsWith('9') ? `1.${code}` : `0.${code}`;
}

async function fetchEMKlines(symbol: string, startDate: string, endDate: string): Promise<Candle[]> {
  const m = symbol.match(/^(\d{6})\.(SS|SZ)$/i);
  if (!m) throw new Error(`Invalid CN symbol: ${symbol}`);
  const suffix = m[2].toUpperCase() as 'SS' | 'SZ';
  const secid = cnSecid(m[1], suffix);
  const beg = startDate.replace(/-/g, '');
  const end = endDate.replace(/-/g, '');

  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=0&beg=${beg}&end=${end}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`EastMoney ${res.status}`);

  const json = await res.json() as { data?: { klines?: string[] } };
  const klines = json.data?.klines;
  if (!klines || klines.length === 0) return [];

  return klines.map(line => {
    const p = line.split(',');
    // CSV: date, open, close, high, low, volume, ...
    return {
      date: p[0],
      open: +p[1],
      high: +p[3],
      low: +p[4],
      close: +p[2], // close is at index 2
      volume: Math.round(+p[5]), // shares
    };
  }).filter(c => c.open > 0 && c.close > 0);
}

// ── Main ─────────────────────────────────────────────────────────────────────

interface CorrectionEntry {
  symbol: string;
  source: string;
  datesAdded: number;
  datesRemoved: number;
  pricesChanged: number;
  candlesBefore: number;
  candlesAfter: number;
}

async function main(): Promise<void> {
  console.log(`\n🔧 Layer 1 修正：${MARKET} 市場`);
  if (DRY_RUN) console.log('   ⚡ DRY-RUN 模式（不寫入檔案）');

  // 1. 讀取驗證報告
  const reportRaw = await readFile(REPORT_PATH, 'utf-8');
  const report: VerificationReport = JSON.parse(reportRaw);
  console.log(`   報告: ${REPORT_PATH}`);
  console.log(`   報告日期: ${report.generatedAt}`);

  // 2. 篩選需修正的股票
  const minSev = severityValue(SEVERITY_MIN);
  const targets = report.issues
    .filter(i => severityValue(i.severity) >= minSev)
    .slice(0, LIMIT);

  console.log(`   severity ≥ ${SEVERITY_MIN}: ${targets.length} 支（limit=${LIMIT}）\n`);

  if (targets.length === 0) {
    console.log('✅ 無需修正');
    return;
  }

  const corrections: CorrectionEntry[] = [];
  const failures: Array<{ symbol: string; error: string }> = [];
  const startTime = Date.now();

  // 3. 逐股修正
  for (let i = 0; i < targets.length; i++) {
    const issue = targets[i];
    const { symbol } = issue;

    try {
      // 讀本地原始檔案
      const localPath = path.join(DATA_DIR, `${symbol}.json`);
      const localRaw = await readFile(localPath, 'utf-8');
      const localData = JSON.parse(localRaw) as {
        symbol: string;
        lastDate: string;
        updatedAt: string;
        sealedDate?: string;
        candles: Candle[];
      };
      const localCandles = localData.candles ?? [];

      // 從權威來源抓取
      let authCandles: Candle[];
      let source: string;

      if (MARKET === 'TW') {
        authCandles = await fetchTWSERange(symbol, DATE_START, DATE_END);
        source = isOTC(symbol) ? 'TPEx' : 'TWSE';
      } else {
        authCandles = await fetchEMKlines(symbol, DATE_START, DATE_END);
        source = 'EastMoney';
      }

      if (authCandles.length === 0) {
        failures.push({ symbol, error: `${source} returned 0 candles` });
        continue;
      }

      // 合併：驗證範圍內用權威資料覆蓋，範圍外保留本地
      const authMap = new Map<string, Candle>();
      for (const c of authCandles) authMap.set(c.date, c);

      const merged: Candle[] = [];
      const localDatesInRange = new Set<string>();

      // 保留本地在範圍外的資料
      for (const c of localCandles) {
        if (c.date < DATE_START || c.date > DATE_END) {
          merged.push(c);
        } else {
          localDatesInRange.add(c.date);
        }
      }

      // 加入權威資料（範圍內）
      for (const c of authCandles) {
        if (c.date >= DATE_START && c.date <= DATE_END) {
          merged.push(c);
        }
      }

      // 排序去重
      merged.sort((a, b) => a.date.localeCompare(b.date));
      const dedupMap = new Map<string, Candle>();
      for (const c of merged) dedupMap.set(c.date, c);
      const finalCandles = [...dedupMap.values()].sort((a, b) => a.date.localeCompare(b.date));

      // 驗證
      const validated = validateCandles(finalCandles as any);

      const entry: CorrectionEntry = {
        symbol,
        source,
        datesAdded: authCandles.filter(c => !localDatesInRange.has(c.date) && c.date >= DATE_START && c.date <= DATE_END).length,
        datesRemoved: validated.removed,
        pricesChanged: issue.priceMismatches.length,
        candlesBefore: localCandles.length,
        candlesAfter: validated.candles.length,
      };

      if (!DRY_RUN) {
        // 寫入本地檔案
        const newData = {
          symbol: localData.symbol,
          lastDate: validated.candles[validated.candles.length - 1]?.date ?? localData.lastDate,
          updatedAt: new Date().toISOString(),
          sealedDate: localData.sealedDate,
          candles: validated.candles.map(c => ({
            date: c.date,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
          })),
        };
        await writeFile(localPath, JSON.stringify(newData, null, 2), 'utf-8');
      }

      corrections.push(entry);

      // 進度
      const done = i + 1;
      if (done % 10 === 0 || done === targets.length) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        console.log(`  [${done}/${targets.length}] ${symbol} ← ${source} | +${entry.datesAdded} dates, ${entry.pricesChanged} prices | ${elapsed}s`);
      }

      // 限流
      if (MARKET === 'TW') await sleep(2500); // TWSE 需要更久
      else await sleep(500);

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push({ symbol, error: msg.slice(0, 200) });
    }
  }

  // 4. 產出修正報告
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const correctionReport = {
    market: MARKET,
    generatedAt: new Date().toISOString(),
    dryRun: DRY_RUN,
    summary: {
      attempted: targets.length,
      corrected: corrections.length,
      failed: failures.length,
      totalDatesAdded: corrections.reduce((s, c) => s + c.datesAdded, 0),
      totalPricesChanged: corrections.reduce((s, c) => s + c.pricesChanged, 0),
    },
    corrections,
    failures,
  };

  const reportOutPath = path.join(process.cwd(), 'data', `correction-report-${MARKET}-${ts}.json`);
  await mkdir(path.dirname(reportOutPath), { recursive: true });
  await writeFile(reportOutPath, JSON.stringify(correctionReport, null, 2), 'utf-8');

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // 5. 列印摘要
  console.log(`\n${'='.repeat(60)}`);
  console.log(`${DRY_RUN ? '🔍 DRY-RUN' : '✅'} ${MARKET} 修正完成（${elapsed}s）`);
  console.log(`   嘗試: ${correctionReport.summary.attempted}`);
  console.log(`   成功: ${correctionReport.summary.corrected}`);
  console.log(`   失敗: ${correctionReport.summary.failed}`);
  console.log(`   新增日期: ${correctionReport.summary.totalDatesAdded}`);
  console.log(`   價格修正: ${correctionReport.summary.totalPricesChanged}`);
  console.log(`\n📄 報告: ${reportOutPath}`);

  // 列出修正過的 symbol（供 sync-to-blob 使用）
  if (corrections.length > 0 && !DRY_RUN) {
    console.log(`\n📋 修正過的股票（${corrections.length} 支）：`);
    console.log(corrections.map(c => c.symbol).join(', '));
  }
}

main().catch(err => {
  console.error('❌ Fatal:', err);
  process.exit(1);
});
