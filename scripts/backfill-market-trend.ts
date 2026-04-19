/**
 * backfill-market-trend.ts — 為歷史 L4 scan session 補寫 marketTrend 欄位
 *
 * 背景：
 *   ScanSession schema 原本沒有 marketTrend 欄位，歷史掃描存檔時這個值被丟掉。
 *   載入歷史 session 後 digest 顯示「大盤趨勢：未知」。
 *   2026-04-19 加了 marketTrend 欄位（commit 見 project memory），這支腳本補齊歷史資料。
 *
 * 做法：
 *   1. 掃 data/ 目錄，找出所有 scan-{market}-{direction}-{mtfMode}-{date}.json
 *      （post_close 檔，intraday 不動）
 *   2. 對每個 session，若 marketTrend 已存在就跳過
 *      否則用 TaiwanScanner / ChinaScanner 的 getMarketTrend(date) 算當日大盤趨勢
 *   3. 寫回 session.marketTrend 並覆蓋存檔
 *
 * 用法：
 *   npx tsx scripts/backfill-market-trend.ts
 *   npx tsx scripts/backfill-market-trend.ts --market TW
 *   npx tsx scripts/backfill-market-trend.ts --dry-run
 *   npx tsx scripts/backfill-market-trend.ts --force  # 即使有值也覆蓋
 */

import { config } from 'dotenv';
import { existsSync } from 'fs';
import { promises as fs } from 'fs';
import path from 'path';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import type { ScanSession, MarketId, ScanDirection } from '../lib/scanner/types';
import { TaiwanScanner } from '../lib/scanner/TaiwanScanner';
import { ChinaScanner } from '../lib/scanner/ChinaScanner';

type MtfMode = 'daily' | 'mtf';

interface ScanFile {
  localName: string;
  market: MarketId;
  direction: ScanDirection;
  mtfMode: MtfMode;
  date: string;
  fullPath: string;
}

const DATA_DIR = path.join(process.cwd(), 'data');

// ── CLI ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');
const marketFilter = (() => {
  const idx = args.indexOf('--market');
  if (idx < 0) return null;
  const v = args[idx + 1];
  return v === 'TW' || v === 'CN' ? v : null;
})();

// ── 列出本地 post_close L4 session 檔 ───────────────────────────────
async function listPostCloseSessions(markets: MarketId[]): Promise<ScanFile[]> {
  const files: ScanFile[] = [];
  let entries: string[];
  try {
    entries = await fs.readdir(DATA_DIR);
  } catch {
    return [];
  }
  for (const name of entries) {
    const m = name.match(/^scan-(TW|CN)-(long|short)-(daily|mtf)-(\d{4}-\d{2}-\d{2})\.json$/);
    if (!m) continue;
    const market = m[1] as MarketId;
    if (!markets.includes(market)) continue;
    files.push({
      localName: name,
      market,
      direction: m[2] as ScanDirection,
      mtfMode: m[3] as MtfMode,
      date: m[4],
      fullPath: path.join(DATA_DIR, name),
    });
  }
  return files;
}

// ── 主流程 ─────────────────────────────────────────────────────────────
async function main() {
  const markets: MarketId[] = marketFilter ? [marketFilter] : ['TW', 'CN'];
  const files = await listPostCloseSessions(markets);
  console.log(`[backfill-market-trend] 找到 ${files.length} 個 post_close session 檔（markets=${markets.join(',')}）`);

  // 相同 market 用同一個 scanner instance，避免重複建立
  const scanners = {
    TW: new TaiwanScanner(),
    CN: new ChinaScanner(),
  } as const;

  // 按 (market, date) group：同一天只算一次 trend
  const trendCache = new Map<string, string>();

  let processed = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const f of files) {
    processed++;
    try {
      const raw = await fs.readFile(f.fullPath, 'utf8');
      const session = JSON.parse(raw) as ScanSession;

      if (!force && session.marketTrend && session.marketTrend.length > 0) {
        skipped++;
        continue;
      }

      const cacheKey = `${f.market}:${f.date}`;
      let trend = trendCache.get(cacheKey);
      if (!trend) {
        try {
          const t = await scanners[f.market].getMarketTrend(f.date);
          trend = String(t);
          trendCache.set(cacheKey, trend);
        } catch (err) {
          console.warn(`[backfill-market-trend] ${f.market} ${f.date} getMarketTrend 失敗:`, err);
          failed++;
          continue;
        }
      }

      session.marketTrend = trend;

      if (dryRun) {
        console.log(`[dry-run] ${f.localName} → marketTrend=${trend}`);
      } else {
        await fs.writeFile(f.fullPath, JSON.stringify(session, null, 2), 'utf8');
        console.log(`[updated] ${f.localName} → marketTrend=${trend}`);
      }
      updated++;
    } catch (err) {
      console.error(`[backfill-market-trend] 處理 ${f.localName} 失敗:`, err);
      failed++;
    }
  }

  console.log('\n── 完成 ──');
  console.log(`總處理: ${processed}`);
  console.log(`已更新: ${updated}${dryRun ? '（dry-run 未寫檔）' : ''}`);
  console.log(`已跳過（已有值）: ${skipped}`);
  console.log(`失敗: ${failed}`);
  console.log(`唯一日期數: ${trendCache.size}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
