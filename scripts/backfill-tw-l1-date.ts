/**
 * 補填 TW L1 指定日期 OHLCV
 *
 * 用法：
 *   npx tsx scripts/backfill-tw-l1-date.ts --date 2026-05-12
 *   npx tsx scripts/backfill-tw-l1-date.ts --date 2026-05-12 --dry
 *
 * 為什麼：
 *   2026-05-12 daily-scan-tw cron 因 TPEx Cloudflare 阻擋拿不到上櫃 list → abort
 *   後 L1 download 也漏寫，造成 918 檔 L1 沒有 5/12 K。
 *   這個 script 直接從 TWSE MI_INDEX + TPEx openapi 拉 5/12 官方收盤 OHLCV，
 *   只填 L1 lastDate < 5/12 的檔案。
 *
 * 安全：
 *   只 append（lastDate < targetDate 才寫），不覆寫既有 5/12 K（避免衝掉好的資料）。
 *   --dry 預覽不寫入。
 */
import { config } from 'dotenv';
import { existsSync, readdirSync, readFileSync } from 'fs';
import path from 'path';

if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { saveLocalCandles } from '../lib/datasource/LocalCandleStore';
import { fetchJsonWithCurlFallback } from '../lib/datasource/curlFetch';

interface BulkOHLCV { open: number; high: number; low: number; close: number; volume: number; }

async function fetchTWSEBulkClose(dateStr: string): Promise<Map<string, BulkOHLCV>> {
  const d = dateStr.replace(/-/g, '');
  const url = `https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date=${d}&type=ALLBUT0999`;
  const { data } = await fetchJsonWithCurlFallback<{ stat: string; tables: Array<{ fields: string[]; data: string[][] }> }>(
    url, { timeoutMs: 30_000 },
  );
  if (data.stat !== 'OK') throw new Error(`TWSE MI_INDEX stat=${data.stat}`);
  const table = data.tables?.[8];
  if (!table?.data?.length) throw new Error('TWSE MI_INDEX table 8 missing');

  const parseNum = (s: string) => { const n = parseFloat(s.replace(/,/g, '')); return isNaN(n) ? 0 : n; };
  const map = new Map<string, BulkOHLCV>();
  for (const row of table.data) {
    const code = row[0]?.trim();
    if (!code || !/^\d{4,}[A-Z]?$/.test(code)) continue;
    const open = parseNum(row[5]);
    const high = parseNum(row[6]);
    const low = parseNum(row[7]);
    const close = parseNum(row[8]);
    const volume = Math.round(parseNum(row[2]) / 1000);
    if (close > 0 && open > 0) map.set(code, { open, high, low, close, volume });
  }
  return map;
}

interface TPExRawRow { Date?: string; SecuritiesCompanyCode?: string; Open?: string; High?: string; Low?: string; Close?: string; TradingShares?: string; }
function parseROCDateLocal(raw?: string): string | null {
  if (!raw) return null;
  const m = raw.trim().match(/^(\d{2,3})\/(\d{2})\/(\d{2})$/);
  if (!m) return null;
  return `${parseInt(m[1], 10) + 1911}-${m[2]}-${m[3]}`;
}
async function fetchTPExBulkClose(targetDate: string): Promise<Map<string, BulkOHLCV>> {
  const url = 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes';
  const { data: rows } = await fetchJsonWithCurlFallback<TPExRawRow[]>(url, { timeoutMs: 30_000 });
  const parseNum = (s?: string) => { if (!s) return 0; const n = parseFloat(s.replace(/,/g, '')); return isNaN(n) ? 0 : n; };
  const map = new Map<string, BulkOHLCV>();
  let dateMatched = 0;
  for (const row of rows) {
    const code = row.SecuritiesCompanyCode?.trim();
    if (!code || !/^\d{4,5}[A-Z]?$/.test(code)) continue;
    const rowDate = parseROCDateLocal(row.Date);
    if (rowDate !== targetDate) continue;
    dateMatched++;
    const open = parseNum(row.Open), high = parseNum(row.High), low = parseNum(row.Low), close = parseNum(row.Close);
    const volume = Math.round(parseNum(row.TradingShares) / 1000);
    if (close > 0 && open > 0) map.set(code, { open, high, low, close, volume });
  }
  if (dateMatched === 0) {
    console.warn(`[TPEx] 無 ${targetDate} 資料（OpenAPI 只回最新交易日，可能已換到下一個交易日）`);
  }
  return map;
}

interface Args { date: string; dry: boolean; }
function parseArgs(): Args {
  const args: Args = { date: '', dry: false };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--date') args.date = process.argv[++i];
    else if (a === '--dry') args.dry = true;
  }
  if (!args.date) {
    console.error('Usage: npx tsx scripts/backfill-tw-l1-date.ts --date YYYY-MM-DD [--dry]');
    process.exit(1);
  }
  return args;
}

async function main() {
  const { date, dry } = parseArgs();
  console.log(`目標日期: ${date} ${dry ? '(DRY RUN)' : ''}`);

  console.log('抓 TWSE MI_INDEX...');
  const twseMap = await fetchTWSEBulkClose(date).catch(err => {
    console.error('TWSE 抓取失敗:', err.message);
    return new Map<string, BulkOHLCV>();
  });
  console.log(`  TWSE 上市 ${twseMap.size} 檔`);

  console.log('抓 TPEx openapi...');
  const tpexMap = await fetchTPExBulkClose(date).catch(err => {
    console.error('TPEx 抓取失敗:', err.message);
    return new Map<string, BulkOHLCV>();
  });
  console.log(`  TPEx 上櫃 ${tpexMap.size} 檔`);

  // 掃 L1 找出 lastDate < date 的檔案
  const candleDir = path.join(process.cwd(), 'data', 'candles', 'TW');
  const files = readdirSync(candleDir).filter(f => f.endsWith('.json'));
  let written = 0;
  let skippedNoData = 0;
  let skippedHasDate = 0;

  for (const f of files) {
    const sym = f.replace('.json', '');
    const code = sym.replace(/\.(TW|TWO)$/i, '');
    const suffix = sym.endsWith('.TWO') ? 'TWO' : 'TW';
    let candles: Array<{ date: string }> = [];
    try {
      const raw = JSON.parse(readFileSync(path.join(candleDir, f), 'utf8'));
      candles = Array.isArray(raw) ? raw : (raw.candles || []);
    } catch { continue; }
    if (candles.length === 0) continue;
    const lastDate = candles[candles.length - 1].date;
    if (lastDate >= date) {
      skippedHasDate++;
      continue;
    }
    const ohlcv = (suffix === 'TW' ? twseMap : tpexMap).get(code) ?? twseMap.get(code) ?? tpexMap.get(code);
    if (!ohlcv) {
      skippedNoData++;
      continue;
    }
    if (!dry) {
      await saveLocalCandles(sym, 'TW', [{ date, ...ohlcv }]);
    }
    written++;
    if (written <= 5 || written % 100 === 0) {
      console.log(`  ${written}: ${sym} ${date} O=${ohlcv.open} H=${ohlcv.high} L=${ohlcv.low} C=${ohlcv.close} V=${ohlcv.volume}`);
    }
  }

  console.log('---');
  console.log(`寫入: ${written}, 已有 ${date}: ${skippedHasDate}, API 沒資料: ${skippedNoData}`);
}

main().catch(err => { console.error(err); process.exit(1); });
