// 修復 OHLC 異常 K 棒：從 hist provider 重抓真實收盤覆寫
// 執行：npx tsx scripts/repair-ohlc-anomaly.ts TW

import fs from 'node:fs/promises';
import path from 'node:path';
import { saveLocalCandles } from '../lib/datasource/LocalCandleStore';
import { readCandleFile } from '../lib/datasource/CandleStorageAdapter';

const market = (process.argv[2] ?? 'TW') as 'TW' | 'CN';

function isAnomalousOHLC(c: { open: number; high: number; low: number; close: number }): boolean {
  return c.high < c.close || c.low > c.close || c.high < c.open || c.low > c.open;
}

async function main() {
  const dir = path.join(process.cwd(), 'data', 'candles', market);
  const files = (await fs.readdir(dir)).filter(f => f.endsWith('.json'));
  console.log(`[repair-ohlc] 掃 ${files.length} 支 L1 找 OHLC 異常`);

  // Phase 1: 收集所有異常 (sym, dates)
  const anomalies = new Map<string, string[]>();
  for (const f of files) {
    const sym = f.replace('.json', '');
    try {
      const d = JSON.parse(await fs.readFile(path.join(dir, f), 'utf-8'));
      const candles = (d.candles ?? d) as Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>;
      const bad = candles.filter(c => isAnomalousOHLC(c)).map(c => c.date);
      if (bad.length > 0) anomalies.set(sym, bad);
    } catch { /* skip */ }
  }
  console.log(`[repair-ohlc] 找到 ${anomalies.size} 支有異常`);
  if (anomalies.size === 0) return;

  // Phase 2: 用 fallback chain 重抓全段歷史並覆寫
  const scanner = market === 'TW'
    ? new (await import('../lib/scanner/TaiwanScanner')).TaiwanScanner()
    : new (await import('../lib/scanner/ChinaScanner')).ChinaScanner();

  let repaired = 0;
  let failed = 0;
  for (const [sym, dates] of anomalies) {
    try {
      console.log(`[repair-ohlc] ${sym} 異常日：${dates.join(', ')}`);
      const fresh = await scanner.fetchCandles(sym);
      if (!fresh || fresh.length < 30) {
        console.warn(`  ${sym} 重抓回 ${fresh?.length ?? 0} 根，跳過`);
        failed++;
        continue;
      }
      // 比對：fresh 裡這幾天的 close 跟原 L1 不同？
      const freshDateMap = new Map(fresh.map(c => [c.date, c]));
      let fixedAny = false;
      for (const d of dates) {
        const old = (await readCandleFile(sym, market))?.candles.find(c => c.date === d);
        const f = freshDateMap.get(d);
        if (old && f && (Math.abs(old.close - f.close) > 0.01 || isAnomalousOHLC(old))) {
          console.log(`  ${d}: old C=${old.close} → fresh C=${f.close}`);
          fixedAny = true;
        }
      }
      if (fixedAny) {
        await saveLocalCandles(sym, market, fresh);
        repaired++;
      } else {
        console.log(`  ${sym} 重抓後跟原始相同，可能 source 自己也有問題`);
      }
    } catch (e) {
      console.error(`  ${sym} 失敗:`, e instanceof Error ? e.message : e);
      failed++;
    }
  }
  console.log(`\n[repair-ohlc] ✅ 完成 repaired=${repaired} failed=${failed} total=${anomalies.size}`);
}

main().catch(e => { console.error(e); process.exit(1); });
