/**
 * 歷史 scan 全面 replay 與修復
 *
 * 背景：
 *   過去某些交易日 cron download 出問題（如 04-21 TW 只下載 3% 資料）。
 *   雖然 L1 後來修復，但當天 cron 跑出的 scan-{market}-long-{method}-{date}.json
 *   仍是用殘缺資料生成。本腳本用「現在完整的 L1」重新 replay，
 *   覆寫舊結果。
 *
 * 流程：
 *   1) 掃描 data/scan-{TW,CN}-long-{B,C,D,E,F,daily,mtf}-{date}.json
 *   2) 對每個 (market, method) 算 resultCount 中位數，找出明顯偏低的日期
 *   3) 對可疑日期跑 runScanPipeline（含 buyMethods）覆寫
 *   4) 對比 + 輸出報告
 *
 * 用法：
 *   npx tsx scripts/replay-historical-scans.ts             # 分析 + 列可疑（dry run）
 *   npx tsx scripts/replay-historical-scans.ts --apply     # 真的 replay 並覆寫
 *   npx tsx scripts/replay-historical-scans.ts --apply --dates 2026-04-21,2026-04-22
 *   npx tsx scripts/replay-historical-scans.ts --apply --market TW
 */

import { config } from 'dotenv';
import { existsSync, readdirSync, readFileSync } from 'fs';
import path from 'path';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { runScanPipeline } from '@/lib/scanner/ScanPipeline';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { getActiveStrategyServer } from '@/lib/strategy/activeStrategyServer';
import { computeTurnoverRankAsOfDate } from '@/lib/scanner/TurnoverRank';
import { TaiwanScanner } from '@/lib/scanner/TaiwanScanner';
import { ChinaScanner } from '@/lib/scanner/ChinaScanner';

type Market = 'TW' | 'CN';
type Method = 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'daily' | 'mtf';

const METHODS: Method[] = ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'daily', 'mtf'];
const BUY_METHODS: ('B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I')[] = ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];

interface ExistingScan {
  market: Market;
  method: Method;
  date: string;
  resultCount: number;
  scanTime: string;
  file: string;
}

interface SuspicionEntry {
  market: Market;
  method: Method;
  date: string;
  oldCount: number;
  median: number;
  ratio: number; // oldCount / median
  reason: string;
}

interface ReplayDiff {
  market: Market;
  date: string;
  perMethod: Record<string, { old: number; new: number; diff: number }>;
  rewroteAny: boolean;
}

const DATA_DIR = path.join(process.cwd(), 'data');

// ─── Step 1: 列舉現有 post-close scan 結果 ───────────────────────────
function loadExistingScans(): ExistingScan[] {
  const files = readdirSync(DATA_DIR).filter(f =>
    /^scan-(TW|CN)-long-(B|C|D|E|F|G|H|I|daily|mtf)-\d{4}-\d{2}-\d{2}\.json$/.test(f)
  );
  const out: ExistingScan[] = [];
  for (const file of files) {
    const m = file.match(/^scan-(TW|CN)-long-(B|C|D|E|F|G|H|I|daily|mtf)-(\d{4}-\d{2}-\d{2})\.json$/);
    if (!m) continue;
    const [, market, method, date] = m;
    try {
      const json = JSON.parse(readFileSync(path.join(DATA_DIR, file), 'utf-8'));
      // 只看 post_close（intraday session 不在這裡）
      if (json.sessionType && json.sessionType !== 'post_close') continue;
      out.push({
        market: market as Market,
        method: method as Method,
        date,
        resultCount: typeof json.resultCount === 'number' ? json.resultCount : (json.results?.length ?? 0),
        scanTime: String(json.scanTime ?? ''),
        file,
      });
    } catch (err) {
      console.warn(`[load] 無法讀 ${file}:`, err instanceof Error ? err.message : err);
    }
  }
  return out;
}

// ─── Step 2: 偵測可疑 ─────────────────────────────────────────────
// 規則：
//  - daily/mtf：oldCount < median * 0.3 且 median >= 5（避免市場本就空的日期）
//  - B/C/E/F：oldCount = 0 而同 method 其他天 median >= 3 → 可疑
//  - D：永遠 0，跳過
//  - 額外硬編碼可疑：04-21 TW（已知 L1 缺漏）, 04-22 TW（修復日）, 04-29/04-30 TW+CN（剛修收盤偏差）
function detectSuspicious(scans: ExistingScan[]): SuspicionEntry[] {
  const suspicions: SuspicionEntry[] = [];
  const groupKey = (s: ExistingScan) => `${s.market}|${s.method}`;
  const groups = new Map<string, ExistingScan[]>();
  for (const s of scans) {
    if (!groups.has(groupKey(s))) groups.set(groupKey(s), []);
    groups.get(groupKey(s))!.push(s);
  }

  for (const [key, list] of groups) {
    const [market, method] = key.split('|') as [Market, Method];
    if (method === 'D') continue; // 一字底通常 0
    const sorted = [...list].sort((a, b) => a.resultCount - b.resultCount);
    const median = sorted[Math.floor(sorted.length / 2)]?.resultCount ?? 0;
    if (median < 3 && method !== 'daily' && method !== 'mtf') continue;
    if (median < 5 && (method === 'daily' || method === 'mtf')) {
      // 市場本就空，幾乎所有天命中數低，跳過 ratio 判定
      continue;
    }

    for (const s of list) {
      const ratio = median > 0 ? s.resultCount / median : 1;
      const isLow = s.resultCount === 0
        ? true
        : ratio < 0.3;
      if (isLow) {
        suspicions.push({
          market, method, date: s.date,
          oldCount: s.resultCount, median, ratio,
          reason: s.resultCount === 0 ? `0 hit (median=${median})` : `${s.resultCount}/${median.toFixed(0)} = ${(ratio * 100).toFixed(0)}%`,
        });
      }
    }
  }

  // 額外硬編碼補上「已知殘缺日期」
  const KNOWN_BAD: Array<[Market, string]> = [
    ['TW', '2026-04-21'], ['TW', '2026-04-22'],
    ['TW', '2026-04-29'], ['TW', '2026-04-30'],
    ['CN', '2026-04-29'], ['CN', '2026-04-30'],
  ];
  for (const [market, date] of KNOWN_BAD) {
    for (const method of METHODS) {
      const exists = scans.find(s => s.market === market && s.method === method && s.date === date);
      if (!exists) continue;
      if (suspicions.some(s => s.market === market && s.method === method && s.date === date)) continue;
      suspicions.push({
        market, method, date,
        oldCount: exists.resultCount, median: 0, ratio: 1,
        reason: `known L1 gap day`,
      });
    }
  }

  return suspicions.sort((a, b) =>
    `${a.market}${a.date}${a.method}`.localeCompare(`${b.market}${b.date}${b.method}`)
  );
}

// ─── Step 3: replay 一個 (market, date) 跑全 7 個 method ────────────
async function replayMarketDate(
  market: Market,
  date: string,
  allStocks: Array<{ symbol: string; name?: string }>,
  beforeMap: Map<string, ExistingScan>,
): Promise<ReplayDiff> {
  const diff: ReplayDiff = { market, date, perMethod: {}, rewroteAny: false };

  if (!isTradingDay(date, market)) {
    console.log(`   ⏭️  ${date} 非交易日，跳過`);
    return diff;
  }

  const historicalRank = await computeTurnoverRankAsOfDate(market, allStocks, date, 500);
  if (historicalRank.size === 0) {
    console.warn(`   ⚠️  ${date} 歷史 top500 為空（L1 可能沒到這天），跳過`);
    return diff;
  }

  const activeStrategy = await getActiveStrategyServer();

  const result = await runScanPipeline({
    market,
    date,
    sessionType: 'post_close',
    directions: ['long'],
    mtfModes: ['daily', 'mtf'],
    buyMethods: BUY_METHODS,
    force: true,
    deadlineMs: 600_000,
    strategy: activeStrategy,
    turnoverRankOverride: historicalRank,
  });

  for (const method of METHODS) {
    const key = method === 'daily' || method === 'mtf'
      ? `long-${method}`
      : `long-${method}`;
    const newCount = result.counts[key] ?? 0;
    const beforeKey = `${market}|${method}|${date}`;
    const oldCount = beforeMap.get(beforeKey)?.resultCount ?? 0;
    diff.perMethod[method] = { old: oldCount, new: newCount, diff: newCount - oldCount };
    if (newCount !== oldCount) diff.rewroteAny = true;
  }

  return diff;
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const onlyMarket: Market | null = (() => {
    const i = args.indexOf('--market');
    if (i < 0) return null;
    const v = args[i + 1]?.toUpperCase();
    return v === 'TW' || v === 'CN' ? (v as Market) : null;
  })();
  const onlyDates: string[] | null = (() => {
    const i = args.indexOf('--dates');
    if (i < 0) return null;
    return args[i + 1]?.split(',').map(s => s.trim()).filter(Boolean) ?? null;
  })();

  console.log(`\n🔍 歷史 scan replay — ${new Date().toISOString()}`);
  console.log(`   模式: ${apply ? '✏️  APPLY (覆寫)' : '🔬 DRY RUN'}`);
  if (onlyMarket) console.log(`   市場限定: ${onlyMarket}`);
  if (onlyDates) console.log(`   日期限定: ${onlyDates.join(', ')}`);

  // ── Step 1: 載入現有 scan ──
  const existing = loadExistingScans();
  console.log(`   載入 ${existing.length} 個 post-close scan 檔`);

  const beforeMap = new Map<string, ExistingScan>();
  for (const s of existing) beforeMap.set(`${s.market}|${s.method}|${s.date}`, s);

  // ── Step 2: 偵測可疑 ──
  let suspicions = detectSuspicious(existing);
  if (onlyMarket) suspicions = suspicions.filter(s => s.market === onlyMarket);
  if (onlyDates) suspicions = suspicions.filter(s => onlyDates.includes(s.date));

  console.log(`\n📋 可疑紀錄 ${suspicions.length} 筆：`);
  console.log('Market Method Date       Old Median Ratio Reason');
  for (const s of suspicions) {
    console.log(
      `${s.market.padEnd(6)} ${s.method.padEnd(6)} ${s.date} ${String(s.oldCount).padStart(4)} ${String(s.median).padStart(6)} ${(s.ratio * 100).toFixed(0).padStart(5)}% ${s.reason}`
    );
  }

  // 收斂為 (market, date) 唯一日期清單
  const targets = new Map<string, { market: Market; date: string }>();
  for (const s of suspicions) {
    targets.set(`${s.market}|${s.date}`, { market: s.market, date: s.date });
  }
  console.log(`\n🎯 將 replay ${targets.size} 個 (market, date) 組合`);

  if (!apply) {
    console.log(`\n💡 加 --apply 真的執行 replay`);
    return;
  }

  // ── Step 3: replay ──
  const diffs: ReplayDiff[] = [];
  const scannerCache = new Map<Market, { stocks: Array<{ symbol: string; name?: string }> }>();

  // 按 market 分組以共用 stockList
  const targetsByMarket = new Map<Market, string[]>();
  for (const t of targets.values()) {
    if (!targetsByMarket.has(t.market)) targetsByMarket.set(t.market, []);
    targetsByMarket.get(t.market)!.push(t.date);
  }

  for (const [market, dates] of targetsByMarket) {
    if (!scannerCache.has(market)) {
      const scanner = market === 'TW' ? new TaiwanScanner() : new ChinaScanner();
      const stocks = await scanner.getStockList();
      scannerCache.set(market, { stocks });
      console.log(`\n📦 [${market}] 載入 ${stocks.length} 支股票清單`);
    }
    const { stocks } = scannerCache.get(market)!;
    const sortedDates = [...dates].sort();
    for (const date of sortedDates) {
      console.log(`\n🔄 [${market} ${date}] replay...`);
      try {
        const diff = await replayMarketDate(market, date, stocks, beforeMap);
        diffs.push(diff);
        const summary = Object.entries(diff.perMethod)
          .map(([m, v]) => `${m}:${v.old}→${v.new}(${v.diff >= 0 ? '+' : ''}${v.diff})`)
          .join(' ');
        console.log(`   ✅ ${summary}`);
      } catch (err) {
        console.error(`   ❌ 失敗:`, err instanceof Error ? err.message : err);
      }
    }
  }

  // ── Step 4: 報告 ──
  console.log(`\n\n## Replay 結果報告\n`);
  for (const market of ['TW', 'CN'] as Market[]) {
    const rows = diffs.filter(d => d.market === market);
    if (rows.length === 0) continue;
    console.log(`### ${market}\n`);
    console.log('| 日期 | daily | mtf | B | C | D | E | F | G | H | I | 動作 |');
    console.log('|------|-------|-----|---|---|---|---|---|---|---|---|------|');
    for (const d of rows) {
      const cell = (m: string) => {
        const v = d.perMethod[m];
        if (!v) return '—';
        if (v.diff === 0) return `${v.new}`;
        return `${v.old}→${v.new}`;
      };
      console.log(
        `| ${d.date} | ${cell('daily')} | ${cell('mtf')} | ${cell('B')} | ${cell('C')} | ${cell('D')} | ${cell('E')} | ${cell('F')} | ${cell('G')} | ${cell('H')} | ${cell('I')} | ${d.rewroteAny ? '已覆寫' : '無變化'} |`
      );
    }
    console.log('');
  }

  console.log(`\n🎉 完成 — 共 ${diffs.length} 個 (market, date) 已 replay`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
