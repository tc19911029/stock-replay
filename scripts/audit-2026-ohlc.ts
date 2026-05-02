import fs from "fs";
import path from "path";

const DATA = path.join(process.cwd(), "data");
const dirs = [path.join(DATA, "candles", "TW"), path.join(DATA, "candles", "CN")];
type Candle = { date: string; open: number; high: number; low: number; close: number; volume: number };
type L1 = { symbol: string; lastDate: string; candles: Candle[] };

for (const dir of dirs) {
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as L1;
    for (const c of j.candles) {
      if (c.date < "2026-01-01") continue;
      const ref = c.high || c.close || c.open || 1;
      const tol = ref * 0.05;
      if (c.high < c.low - tol || c.close > c.high + tol || c.close < c.low - tol) {
        console.log(j.symbol, c);
      }
    }
  }
}
