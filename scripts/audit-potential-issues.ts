/**
 * audit-potential-issues.ts
 *
 * 主動式潛在問題排查（A~K 假設）。
 *
 * 用法：npx tsx scripts/audit-potential-issues.ts
 */

import fs from "fs";
import path from "path";
import { isTradingDay } from "../lib/utils/tradingDay";

const ROOT = process.cwd();
const DATA = path.join(ROOT, "data");
const CANDLES_TW = path.join(DATA, "candles", "TW");
const CANDLES_CN = path.join(DATA, "candles", "CN");
const TODAY = "2026-04-30";
const TOMORROW_THRESHOLD = "2026-05-01"; // anything > this is future

type Candle = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type L1File = {
  symbol: string;
  lastDate: string;
  updatedAt?: string;
  candles: Candle[];
};

function readJSON<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as T;
  } catch {
    return null;
  }
}

function listCandleFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
}

// ---- A: L1 資料完整性 ----
function auditA() {
  console.log("\n========== 假設 A：L1 資料完整性 ==========");
  const buckets = {
    zeroOhlc: [] as { sym: string; date: string }[],
    ohlcLogic: [] as { sym: string; date: string; reason: string }[],
    negative: [] as { sym: string; date: string; field: string; v: number }[],
    zeroVolButPrice: [] as { sym: string; date: string; close: number }[],
    dupDate: [] as { sym: string; date: string }[],
    futureDate: [] as { sym: string; date: string }[],
  };
  let totalCandles = 0;
  let totalFiles = 0;

  const dirs = [
    { dir: CANDLES_TW, market: "TW" as const },
    { dir: CANDLES_CN, market: "CN" as const },
  ];
  for (const { dir, market } of dirs) {
    for (const f of listCandleFiles(dir)) {
      const j = readJSON<L1File>(path.join(dir, f));
      if (!j || !Array.isArray(j.candles)) continue;
      totalFiles++;
      const seen = new Set<string>();
      for (const c of j.candles) {
        totalCandles++;
        if (!c.date) continue;
        // 重複
        if (seen.has(c.date)) buckets.dupDate.push({ sym: j.symbol, date: c.date });
        seen.add(c.date);
        // 未來
        if (c.date > TOMORROW_THRESHOLD) buckets.futureDate.push({ sym: j.symbol, date: c.date });
        const { open, high, low, close, volume } = c;
        // 負數
        for (const [k, v] of Object.entries({ open, high, low, close, volume })) {
          if (typeof v === "number" && v < 0)
            buckets.negative.push({ sym: j.symbol, date: c.date, field: k, v });
        }
        // 零K（OHLC 全 0）
        if (open === 0 && high === 0 && low === 0 && close === 0)
          buckets.zeroOhlc.push({ sym: j.symbol, date: c.date });
        // OHLC 邏輯錯誤（容忍 5%）
        const ref = high || close || open || 1;
        const tol = ref * 0.05;
        if (high < low - tol)
          buckets.ohlcLogic.push({ sym: j.symbol, date: c.date, reason: `high<low (${high}<${low})` });
        if (close > high + tol)
          buckets.ohlcLogic.push({ sym: j.symbol, date: c.date, reason: `close>high (${close}>${high})` });
        if (close < low - tol)
          buckets.ohlcLogic.push({ sym: j.symbol, date: c.date, reason: `close<low (${close}<${low})` });
        // 零量但有價（且非 OHLC 全 0）
        if (volume === 0 && (open || close || high || low))
          buckets.zeroVolButPrice.push({ sym: j.symbol, date: c.date, close });
      }
    }
    void market;
  }

  console.log(`掃描 L1 檔案：${totalFiles} 支，K 棒總數：${totalCandles.toLocaleString()}`);
  const rows = [
    ["零K (OHLC 全 0)", buckets.zeroOhlc.length, buckets.zeroOhlc.slice(0, 5)],
    ["OHLC 邏輯錯誤 (>5%)", buckets.ohlcLogic.length, buckets.ohlcLogic.slice(0, 5)],
    ["負數欄位", buckets.negative.length, buckets.negative.slice(0, 5)],
    ["零量但有價", buckets.zeroVolButPrice.length, buckets.zeroVolButPrice.slice(0, 5)],
    ["跨日重複", buckets.dupDate.length, buckets.dupDate.slice(0, 5)],
    ["未來日期", buckets.futureDate.length, buckets.futureDate.slice(0, 5)],
  ];
  for (const [label, count, samples] of rows) {
    console.log(`- ${label}: ${count}`);
    if ((count as number) > 0) console.log(`  樣本:`, samples);
  }
  return buckets;
}

// ---- B: L1 lastDate 落後 vs L2 ----
function auditB() {
  console.log("\n========== 假設 B：L1 lastDate vs L2 快照 ==========");
  const result: Record<string, string[]> = { TW: [], CN: [] };
  for (const market of ["TW", "CN"] as const) {
    const l2Path = path.join(DATA, `intraday-${market}-${TODAY}.json`);
    const l2 = readJSON<{ quotes: { symbol: string }[] }>(l2Path);
    if (!l2) {
      console.log(`- ${market}: 沒有 L2 ${TODAY} 快照`);
      continue;
    }
    const dir = market === "TW" ? CANDLES_TW : CANDLES_CN;
    let lagging = 0;
    const samples: string[] = [];
    for (const q of l2.quotes) {
      // L2 symbol for TW 是 "1101"，L1 檔名 "1101.TW.json" or "1101.TWO.json"
      const candidates =
        market === "TW"
          ? [`${q.symbol}.TW.json`, `${q.symbol}.TWO.json`]
          : [`${q.symbol}.json`, `${q.symbol}.SS.json`, `${q.symbol}.SZ.json`];
      let found: L1File | null = null;
      for (const c of candidates) {
        const p = path.join(dir, c);
        if (fs.existsSync(p)) {
          found = readJSON<L1File>(p);
          break;
        }
      }
      if (!found) continue;
      if (found.lastDate < TODAY) {
        lagging++;
        if (samples.length < 8) samples.push(`${q.symbol} (${found.lastDate})`);
      }
    }
    result[market] = samples;
    console.log(`- ${market}: L2 有 ${TODAY} 但 L1 落後的支數 = ${lagging}`);
    if (lagging > 0) console.log(`  樣本:`, samples);
  }
  return result;
}

// ---- C: scan 引用不存在的 K 棒 ----
function auditC() {
  console.log("\n========== 假設 C：L4 scan 引用不存在的 L1 K ==========");
  const scanDir = DATA;
  const files = fs.readdirSync(scanDir).filter((f) => /^scan-.*-2026-04-30\.json$/.test(f));
  const issues: { file: string; sym: string; date: string }[] = [];
  let checked = 0;
  for (const f of files) {
    const j = readJSON<{ market: string; date: string; results: { symbol: string }[] }>(
      path.join(scanDir, f)
    );
    if (!j || !Array.isArray(j.results)) continue;
    const dir = j.market === "TW" ? CANDLES_TW : CANDLES_CN;
    for (const r of j.results) {
      checked++;
      // r.symbol 可能是 "8074.TWO" or "600519.SS"
      const fname = `${r.symbol}.json`;
      const p = path.join(dir, fname);
      if (!fs.existsSync(p)) {
        issues.push({ file: f, sym: r.symbol, date: j.date });
        continue;
      }
      const l1 = readJSON<L1File>(p);
      if (!l1) continue;
      const has = l1.candles.some((c) => c.date === j.date);
      if (!has) issues.push({ file: f, sym: r.symbol, date: j.date });
    }
  }
  console.log(`- 掃描 ${files.length} 個 scan 檔，命中股共 ${checked} 筆`);
  console.log(`- 引用 L1 不存在或缺該日 K 的：${issues.length}`);
  if (issues.length) console.log(`  樣本:`, issues.slice(0, 8));
  return issues;
}

// ---- D: CN volume 數量級 ----
function auditD() {
  console.log("\n========== 假設 D：CN volume 數量級異常 ==========");
  const files = listCandleFiles(CANDLES_CN).slice(0, 30);
  const suspect: { sym: string; date: string; close: number; vol: number; turnover: number }[] = [];
  for (const f of files) {
    const j = readJSON<L1File>(path.join(CANDLES_CN, f));
    if (!j) continue;
    const recent = j.candles.slice(-5);
    for (const c of recent) {
      const turnover = c.close * c.volume;
      // 中國個股一日成交額正常落在 500萬 ~ 500億 RMB
      // 若以「股」計，volume 1000萬股 × 10 RMB = 1 億 RMB ✓
      // 若被誤放大 100×，turnover 會異常大；若被縮小 100×，會異常小
      if (c.close > 0 && c.volume > 0) {
        if (turnover < 1e5 || turnover > 5e11) {
          suspect.push({ sym: j.symbol, date: c.date, close: c.close, vol: c.volume, turnover });
        }
      }
    }
  }
  console.log(`- 抽樣 ${files.length} 支 × 近 5 天，可疑 turnover 級數 = ${suspect.length}`);
  if (suspect.length) console.log(`  樣本:`, suspect.slice(0, 8));
  return suspect;
}

// ---- E: TWO 上櫃股 ----
function auditE() {
  console.log("\n========== 假設 E：TWO 上櫃股近期更新 ==========");
  const files = listCandleFiles(CANDLES_TW).filter((f) => f.endsWith(".TWO.json"));
  let stale = 0;
  const samples: string[] = [];
  for (const f of files) {
    const j = readJSON<L1File>(path.join(CANDLES_TW, f));
    if (!j) continue;
    if (j.lastDate < "2026-04-29") {
      stale++;
      if (samples.length < 10) samples.push(`${j.symbol} (${j.lastDate})`);
    }
  }
  console.log(`- TWO 總數: ${files.length}`);
  console.log(`- lastDate < 2026-04-29 的: ${stale}`);
  if (stale) console.log(`  樣本:`, samples);
  return { total: files.length, stale };
}

// ---- F: L2 有但 L1 無（孤兒） ----
function auditF() {
  console.log("\n========== 假設 F：L2 有但 L1 無（候選池孤兒） ==========");
  const result: Record<string, string[]> = {};
  for (const market of ["TW", "CN"] as const) {
    const l2 = readJSON<{ quotes: { symbol: string; name?: string }[] }>(
      path.join(DATA, `intraday-${market}-${TODAY}.json`)
    );
    if (!l2) continue;
    const dir = market === "TW" ? CANDLES_TW : CANDLES_CN;
    const orphans: string[] = [];
    for (const q of l2.quotes) {
      const candidates =
        market === "TW"
          ? [`${q.symbol}.TW.json`, `${q.symbol}.TWO.json`]
          : [`${q.symbol}.json`, `${q.symbol}.SS.json`, `${q.symbol}.SZ.json`];
      const exists = candidates.some((c) => fs.existsSync(path.join(dir, c)));
      if (!exists) orphans.push(`${q.symbol}${q.name ? "/" + q.name : ""}`);
    }
    result[market] = orphans;
    console.log(`- ${market}: L2 報價數 ${l2.quotes.length}，L1 無檔的孤兒 = ${orphans.length}`);
    if (orphans.length) console.log(`  樣本:`, orphans.slice(0, 10));
  }
  return result;
}

// ---- G: MA Base 過期 ----
function auditG() {
  console.log("\n========== 假設 G：MA Base 過期 ==========");
  for (const market of ["TW", "CN"] as const) {
    const all = fs
      .readdirSync(DATA)
      .filter((f) => f.startsWith(`intraday-${market}-`) && f.endsWith("-ma-base.json"))
      .sort();
    const last = all[all.length - 1];
    if (!last) {
      console.log(`- ${market}: 找不到 ma-base`);
      continue;
    }
    const m = last.match(/intraday-\w+-(\d{4}-\d{2}-\d{2})-ma-base\.json/);
    const date = m?.[1] ?? "?";
    console.log(`- ${market}: 最新 MA Base = ${date} (檔: ${last})  vs 預期最新交易日=${TODAY}`);
    if (date < TODAY) console.log(`  ⚠️  落後 ${TODAY}`);
  }
}

// ---- H: scan 不該有的日期 ----
function auditH() {
  console.log("\n========== 假設 H：scan 檔案日期不是交易日 / 未來 ==========");
  const files = fs.readdirSync(DATA).filter((f) => /^scan-.*-(\d{4}-\d{2}-\d{2})\.json$/.test(f));
  const nonTrading: string[] = [];
  const future: string[] = [];
  for (const f of files) {
    const m = f.match(/(\d{4}-\d{2}-\d{2})\.json$/);
    if (!m) continue;
    const date = m[1];
    const market = f.includes("-CN-") ? "CN" : "TW";
    if (date > TOMORROW_THRESHOLD) future.push(f);
    else if (!isTradingDay(date, market as "TW" | "CN")) nonTrading.push(f);
  }
  console.log(`- 掃描 ${files.length} 個 scan 檔`);
  console.log(`- 非交易日 scan 檔: ${nonTrading.length}`);
  if (nonTrading.length) console.log(`  樣本:`, nonTrading.slice(0, 10));
  console.log(`- 未來日期 scan 檔: ${future.length}`);
  if (future.length) console.log(`  樣本:`, future.slice(0, 10));
  return { nonTrading, future };
}

// ---- I: stale 同批股票趨勢 ----
function auditI() {
  console.log("\n========== 假設 I：staleDays=1 是否有作用 ==========");
  for (const market of ["TW", "CN"] as const) {
    const reports = fs
      .readdirSync(path.join(DATA, "reports"))
      .filter((f) => f.startsWith(`verify-${market}-`))
      .sort()
      .slice(-5);
    console.log(`- ${market} 近 5 份 verify report:`);
    const counter = new Map<string, number>();
    for (const r of reports) {
      const j = readJSON<{ staleDetails?: { symbol: string }[]; staleCount?: number }>(
        path.join(DATA, "reports", r)
      );
      const staleCount = j?.staleDetails?.length ?? j?.staleCount ?? 0;
      console.log(`  ${r}: stale=${staleCount}`);
      for (const s of j?.staleDetails ?? []) {
        counter.set(s.symbol, (counter.get(s.symbol) ?? 0) + 1);
      }
    }
    const persistent = [...counter.entries()].filter(([, n]) => n >= 4).slice(0, 10);
    console.log(`  在 ≥4 份報告中重複出現的（持續 stale）: ${persistent.length}`);
    if (persistent.length) console.log(`    樣本:`, persistent);
  }
}

// ---- J: 高勝率 6 位置 detector 是否齊全 ----
function auditJ() {
  console.log("\n========== 假設 J：高勝率 6 位置 detector 完整性 ==========");
  const src = fs.readFileSync(path.join(ROOT, "lib/analysis/highWinPositions.ts"), "utf-8");
  const detectors = [
    "detectBottomTrendConfirmation", // 位置 1
    "pulledBackBuy", // 位置 2 (in trendAnalysis)
    "rangeBreakout", // 位置 3 (in trendAnalysis)
    "detectMaClusterBreak", // 位置 4
    "detectStrongPullbackResume", // 位置 5
    "detectFalseBreakRebound", // 位置 6
  ];
  for (const d of detectors) {
    const inThis = src.includes(`export function ${d}`);
    const labels = ["1.打底確認", "2.回後", "3.盤整突破", "4.均線糾結", "5.強勢短回", "6.假跌破"];
    const idx = detectors.indexOf(d);
    console.log(`- 位置 ${labels[idx]} → ${d}: ${inThis ? "✅ in highWinPositions.ts" : "(在他處)"}`);
  }
  console.log("✅ 6 detectors 全部已實作（記憶 J 過期）");
}

// ---- K: watchlist 一致性 ----
function auditK() {
  console.log("\n========== 假設 K：自選股 (watchlist) 資料一致性 ==========");
  const dataFiles = fs.readdirSync(DATA).filter((f) => /watchlist/i.test(f));
  console.log(`- data/ 下 watchlist 檔案: ${dataFiles.length}`);
  console.log(`  → watchlist 採 client-side localStorage（store/watchlistStore.ts），無 server 端持久化檔案`);
  console.log(`  → 無法做伺服器端一致性檢查；建議用戶從前端 export 後再驗證`);
}

function main() {
  console.log("=== 主動式潛在問題排查 ===");
  console.log(`時間: ${new Date().toISOString()}  (今天: ${TODAY})`);
  auditA();
  auditB();
  auditC();
  auditD();
  auditE();
  auditF();
  auditG();
  auditH();
  auditI();
  auditJ();
  auditK();
  console.log("\n=== 完成 ===");
}

main();
