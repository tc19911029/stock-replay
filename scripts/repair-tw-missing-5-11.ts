/**
 * 補拉 TW missing target-date stocks（從 find-tw-missing-today-report.json 讀）
 *
 * 策略（優先序）：
 *   1. .TWO 上櫃 → 一次抓 TPEx openapi（含 5/11 OHLC），對 853 支批次 inject
 *   2. .TW 上市 → 單支 TaiwanScanner.fetchCandles fallback（TWSE STOCK_DAY_ALL 在 5/11
 *      cron 跑時還只有 5/8 資料，是這次 cron 失敗的根因之一）
 *
 * 用法：
 *   npx tsx scripts/repair-tw-missing-5-11.ts             (dry-run)
 *   npx tsx scripts/repair-tw-missing-5-11.ts --apply
 */

import { promises as fs } from 'fs';
import path from 'path';
import { TaiwanScanner } from '@/lib/scanner/TaiwanScanner';
import { saveLocalCandles } from '@/lib/datasource/LocalCandleStore';
import type { Candle } from '@/types';

interface BulkOHLCV { open: number; high: number; low: number; close: number; volume: number; }

interface MissingEntry {
  symbol: string;
  name?: string;
  lastDate: string;
  inStocklist: boolean;
}

interface Report {
  expectedDate: string;
  missing: MissingEntry[];
}

const REPORT_FILE = path.join(process.cwd(), 'scripts', 'find-tw-missing-today-report.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';

interface TPExRawRow {
  Date?: string; SecuritiesCompanyCode?: string;
  Open?: string; High?: string; Low?: string; Close?: string;
  TradingShares?: string;
}
function parseROCDate(raw?: string): string | null {
  if (!raw) return null;
  // TPEx 格式有兩種：1150511（連字串）或 115/05/11（斜線）
  const compact = raw.trim().match(/^(\d{3})(\d{2})(\d{2})$/);
  if (compact) {
    const yyyy = String(parseInt(compact[1], 10) + 1911);
    return `${yyyy}-${compact[2]}-${compact[3]}`;
  }
  const slashed = raw.trim().match(/^(\d{2,3})\/(\d{2})\/(\d{2})$/);
  if (slashed) {
    const yyyy = String(parseInt(slashed[1], 10) + 1911);
    return `${yyyy}-${slashed[2]}-${slashed[3]}`;
  }
  return null;
}
async function fetchTPExBulkClose(targetDate: string): Promise<Map<string, BulkOHLCV>> {
  const url = 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes';
  // Node fetch 被 Cloudflare 擋 (TLS fingerprint)，改用 curl shell
  const { execFileSync } = await import('child_process');
  const stdout = execFileSync('curl', ['-s', '--max-time', '30', '-A', UA, url], { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
  const rows = JSON.parse(stdout) as TPExRawRow[];
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('TPEx OpenAPI empty');

  const parseNum = (s?: string) => { if (!s) return 0; const n = parseFloat(s.replace(/,/g, '')); return isNaN(n) ? 0 : n; };
  const map = new Map<string, BulkOHLCV>();
  let dateMatched = 0;
  for (const row of rows) {
    const code = row.SecuritiesCompanyCode?.trim();
    if (!code || !/^\d{4,5}[A-Z]?$/.test(code)) continue;
    const rowDate = parseROCDate(row.Date);
    if (rowDate !== targetDate) continue;
    dateMatched++;
    const open = parseNum(row.Open);
    const high = parseNum(row.High);
    const low = parseNum(row.Low);
    const close = parseNum(row.Close);
    const volume = Math.round(parseNum(row.TradingShares) / 1000);
    if (close > 0 && open > 0) map.set(code, { open, high, low, close, volume });
  }
  if (dateMatched === 0) throw new Error(`TPEx OpenAPI 無 ${targetDate} 資料`);
  return map;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  console.log(`[mode] ${apply ? 'APPLY' : 'DRY-RUN'}`);

  const report: Report = JSON.parse(await fs.readFile(REPORT_FILE, 'utf-8'));
  const targetDate = report.expectedDate;
  const candidates = report.missing.filter(m => m.inStocklist);
  const tw = candidates.filter(c => c.symbol.endsWith('.TW'));
  const two = candidates.filter(c => c.symbol.endsWith('.TWO'));
  console.log(`[load] targetDate=${targetDate}  候選 ${candidates.length} (上市 .TW=${tw.length}, 上櫃 .TWO=${two.length})`);

  // ── 1) 批次：TPEx openapi → .TWO ─────────────────────────────────
  console.log(`\n[fetch] TPEx openapi ...`);
  let tpexMap = new Map<string, BulkOHLCV>();
  try {
    tpexMap = await fetchTPExBulkClose(targetDate);
    console.log(`        TPEx 載入 ${tpexMap.size} 支上櫃 (${targetDate} 之 OHLC)`);
  } catch (err) {
    console.error(`        TPEx 失敗：${err instanceof Error ? err.message : err}`);
  }

  let twoHit = 0;
  let twoMiss: string[] = [];
  const twoWrites: Array<{ symbol: string; ohlcv: BulkOHLCV }> = [];
  for (const c of two) {
    const code = c.symbol.replace(/\.TWO$/i, '');
    const ohlcv = tpexMap.get(code);
    if (ohlcv) {
      twoWrites.push({ symbol: c.symbol, ohlcv });
      twoHit++;
    } else {
      twoMiss.push(c.symbol);
    }
  }
  console.log(`[match] .TWO 命中 ${twoHit}/${two.length}，bulk miss ${twoMiss.length}`);
  if (twoMiss.length > 0 && twoMiss.length <= 20) {
    console.log(`        bulk miss list: ${twoMiss.join(', ')}`);
  }

  // ── 2) Per-symbol fallback：.TW + .TWO bulk miss → TaiwanScanner.fetchCandles ──
  const perSymbolList = [...tw.map(c => c.symbol), ...twoMiss];
  console.log(`\n[per-symbol] ${perSymbolList.length} 支走 fetchCandles fallback`);

  if (!apply) {
    console.log('\n[dry-run] 加 --apply 來實際寫入');
    console.log(`        將寫入 .TWO bulk: ${twoHit} 支`);
    console.log(`        將嘗試 per-symbol: ${perSymbolList.length} 支`);
    return;
  }

  // 3) 寫 .TWO bulk
  console.log(`\n[apply] 寫 .TWO bulk ${twoWrites.length} 支...`);
  let written = 0;
  let writeFailed = 0;
  for (const w of twoWrites) {
    try {
      await saveLocalCandles(w.symbol, 'TW', [{
        date: targetDate, open: w.ohlcv.open, high: w.ohlcv.high,
        low: w.ohlcv.low, close: w.ohlcv.close, volume: w.ohlcv.volume,
      }]);
      written++;
      if (written % 200 === 0) console.log(`        ${written}/${twoWrites.length}`);
    } catch (err) {
      writeFailed++;
      console.warn(`        ${w.symbol} 寫入失敗: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`        .TWO bulk done — 成功 ${written}, 失敗 ${writeFailed}`);

  // 4) Per-symbol fallback
  const scanner = new TaiwanScanner();
  const psResults: Array<{ symbol: string; status: string; close?: number }> = [];
  for (const sym of perSymbolList) {
    try {
      const candles = await scanner.fetchCandles(sym);
      const target = candles.find(c => c.date === targetDate);
      if (!target) {
        psResults.push({ symbol: sym, status: 'no-target-row' });
        continue;
      }
      const bar: Candle = {
        date: target.date, open: target.open, high: target.high,
        low: target.low, close: target.close, volume: target.volume,
      };
      await saveLocalCandles(sym, 'TW', [bar]);
      psResults.push({ symbol: sym, status: 'written', close: bar.close });
    } catch (err) {
      psResults.push({ symbol: sym, status: 'error: ' + (err instanceof Error ? err.message.slice(0,60) : 'unknown') });
    }
  }
  const psWritten = psResults.filter(r => r.status === 'written').length;
  console.log(`\n        per-symbol done — written ${psWritten}/${perSymbolList.length}`);
  for (const r of psResults) {
    if (r.status !== 'written') console.log(`          ${r.symbol}: ${r.status}`);
  }

  // 5) 報告
  await fs.writeFile(
    path.join(process.cwd(), 'scripts', 'repair-tw-missing-5-11-report.json'),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      targetDate,
      tpexBulkWritten: written,
      tpexBulkFailed: writeFailed,
      perSymbolResults: psResults,
    }, null, 2)
  );
  console.log(`\n報告：scripts/repair-tw-missing-5-11-report.json`);
}

main().catch(err => { console.error(err); process.exit(1); });
