/**
 * audit-deep-dive.ts
 *
 * audit-potential-issues.ts 跑出三個重點，這裡細看：
 *  - A: OHLC 邏輯錯誤分布（market/年份）
 *  - B: L1 落後是哪些股（含名稱）
 *  - F: TW 孤兒是 ETF 還是真股
 */

import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const DATA = path.join(ROOT, "data");
const CANDLES_TW = path.join(DATA, "candles", "TW");
const CANDLES_CN = path.join(DATA, "candles", "CN");
const TODAY = "2026-04-30";

type Candle = { date: string; open: number; high: number; low: number; close: number; volume: number };
type L1File = { symbol: string; lastDate: string; candles: Candle[] };

function readJSON<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as T;
  } catch {
    return null;
  }
}

// A 細看
function deepA() {
  console.log("\n=== A 細看：OHLC 邏輯錯誤分布 ===");
  const byMarket: Record<string, number> = { TW: 0, TWO: 0, CN: 0 };
  const byYear = new Map<string, number>();
  const sym2024_25: { sym: string; date: string; reason: string }[] = [];

  for (const { dir, mtag } of [
    { dir: CANDLES_TW, mtag: "TW" },
    { dir: CANDLES_CN, mtag: "CN" },
  ]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
      const j = readJSON<L1File>(path.join(dir, f));
      if (!j) continue;
      const isTwo = f.endsWith(".TWO.json");
      const m = isTwo ? "TWO" : mtag;
      for (const c of j.candles) {
        const ref = c.high || c.close || c.open || 1;
        const tol = ref * 0.05;
        let bad = "";
        if (c.high < c.low - tol) bad = `high<low`;
        else if (c.close > c.high + tol) bad = `close>high`;
        else if (c.close < c.low - tol) bad = `close<low`;
        if (bad) {
          byMarket[m] = (byMarket[m] ?? 0) + 1;
          const yr = c.date.slice(0, 4);
          byYear.set(yr, (byYear.get(yr) ?? 0) + 1);
          if (c.date >= "2024-01-01" && sym2024_25.length < 20) {
            sym2024_25.push({ sym: j.symbol, date: c.date, reason: bad });
          }
        }
      }
    }
  }
  console.log("by market:", byMarket);
  console.log("by year:", [...byYear.entries()].sort());
  console.log("近兩年樣本（≥ 2024-01-01）：");
  console.log(sym2024_25);
}

// B 細看
function deepB() {
  console.log("\n=== B 細看：L1 落後（含名稱） ===");
  for (const market of ["TW", "CN"] as const) {
    const l2 = readJSON<{ quotes: { symbol: string; name?: string }[] }>(
      path.join(DATA, `intraday-${market}-${TODAY}.json`)
    );
    if (!l2) continue;
    const dir = market === "TW" ? CANDLES_TW : CANDLES_CN;
    const lagging: { sym: string; name?: string; lastDate: string }[] = [];
    for (const q of l2.quotes) {
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
      if (found && found.lastDate < TODAY) {
        lagging.push({ sym: q.symbol, name: q.name, lastDate: found.lastDate });
      }
    }
    console.log(`${market} 落後 ${lagging.length} 支:`);
    for (const x of lagging) console.log(`  ${x.sym} ${x.name ?? ""} → lastDate=${x.lastDate}`);
  }
}

// F 細看
function deepF() {
  console.log("\n=== F 細看：TW 候選池孤兒分類 ===");
  const l2 = readJSON<{ quotes: { symbol: string; name?: string }[] }>(
    path.join(DATA, `intraday-TW-${TODAY}.json`)
  );
  if (!l2) return;
  const orphans: { sym: string; name?: string; type: string }[] = [];
  for (const q of l2.quotes) {
    const exists = [`${q.symbol}.TW.json`, `${q.symbol}.TWO.json`].some((c) =>
      fs.existsSync(path.join(CANDLES_TW, c))
    );
    if (!exists) {
      let type = "個股";
      if (/^00\d{3,4}/.test(q.symbol)) type = "ETF";
      else if (/^[BL]/.test(q.symbol)) type = "權證/牛熊";
      else if (q.symbol.length >= 5) type = "權證/特殊代碼";
      orphans.push({ sym: q.symbol, name: q.name, type });
    }
  }
  const byType = new Map<string, number>();
  for (const o of orphans) byType.set(o.type, (byType.get(o.type) ?? 0) + 1);
  console.log("by type:", [...byType.entries()]);
  console.log("非 ETF 的孤兒（最該關心的）：");
  for (const o of orphans.filter((x) => x.type !== "ETF").slice(0, 20))
    console.log(`  ${o.sym} ${o.name ?? ""} [${o.type}]`);
}

// E 細看 4804.TWO
function deepE() {
  console.log("\n=== E 細看：4804.TWO ===");
  const p = path.join(CANDLES_TW, "4804.TWO.json");
  if (!fs.existsSync(p)) {
    console.log("檔案不存在");
    return;
  }
  const j = readJSON<L1File>(p);
  if (!j) return;
  console.log(`4804.TWO lastDate=${j.lastDate}, 近 5 根:`);
  for (const c of j.candles.slice(-5)) console.log(`  ${c.date}: c=${c.close} v=${c.volume}`);
}

deepA();
deepB();
deepE();
deepF();
