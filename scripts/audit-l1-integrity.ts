// 資料完整性全市場稽核：找出缺日、middle gaps、異常 OHLC
// 執行：npx tsx scripts/audit-l1-integrity.ts TW 30  (檢查近 30 個交易日)

import fs from 'node:fs/promises';
import path from 'node:path';
import { isTradingDay } from '../lib/utils/tradingDay';
import { getLastTradingDay } from '../lib/datasource/marketHours';

const market = (process.argv[2] ?? 'TW') as 'TW' | 'CN';
const lookbackDays = parseInt(process.argv[3] ?? '30', 10);

function expectedTradingDays(refDay: string, n: number): string[] {
  // 從 refDay 倒退找 n 個交易日
  const days: string[] = [];
  const d = new Date(refDay + 'T12:00:00');
  while (days.length < n) {
    const ds = d.toISOString().slice(0, 10);
    if (isTradingDay(ds, market)) days.push(ds);
    d.setDate(d.getDate() - 1);
  }
  return days.sort();
}

async function main() {
  // 2026-05-08：用 lastTradingDay 而不是 today，避免今日還沒收盤就誤標全市場 stale
  const refDay = getLastTradingDay(market);
  const expected = expectedTradingDays(refDay, lookbackDays);
  console.log(`[audit] market=${market}, 預期最近 ${lookbackDays} 個交易日: ${expected[0]} ~ ${expected[expected.length-1]}`);

  const dir = path.join(process.cwd(), 'data', 'candles', market);
  const files = (await fs.readdir(dir)).filter(f => f.endsWith('.json'));
  console.log(`[audit] L1 共 ${files.length} 支`);

  // 每個交易日缺的股數
  const missingByDate = new Map<string, number>();
  expected.forEach(d => missingByDate.set(d, 0));

  // 異常 OHLC 清單
  const anomalousOHLC: string[] = [];
  // 中間 gap（不是末尾的缺）
  const middleGaps: { sym: string; missing: string[] }[] = [];
  // 末尾 stale
  const tailStale: { sym: string; lastDate: string; daysBehind: number }[] = [];

  for (const f of files) {
    const sym = f.replace('.json', '');
    try {
      const raw = await fs.readFile(path.join(dir, f), 'utf-8');
      const d = JSON.parse(raw);
      const candles = (d.candles ?? d) as Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>;
      if (!Array.isArray(candles) || candles.length === 0) continue;

      const dateSet = new Set(candles.map(c => c.date));
      const missing: string[] = [];
      for (const ed of expected) {
        if (!dateSet.has(ed)) {
          missing.push(ed);
          missingByDate.set(ed, (missingByDate.get(ed) ?? 0) + 1);
        }
      }

      // 區分 tail-stale vs middle-gap
      const lastDate = candles[candles.length - 1].date;
      const lastIdx = expected.indexOf(lastDate);
      if (lastIdx === -1 || lastIdx < expected.length - 1) {
        // last 比 expected 末尾舊 → tail stale
        const daysBehind = expected.length - 1 - (lastIdx === -1 ? 0 : lastIdx);
        if (daysBehind > 0) tailStale.push({ sym, lastDate, daysBehind });
      }
      const middleMissing = missing.filter(m => m < lastDate);
      if (middleMissing.length > 0) {
        middleGaps.push({ sym, missing: middleMissing });
      }

      // OHLC 異常檢查（最後 30 根）
      for (const c of candles.slice(-30)) {
        if (c.high < c.close || c.low > c.close || c.high < c.open || c.low > c.open) {
          if (anomalousOHLC.length < 20) {
            anomalousOHLC.push(`${sym} ${c.date} O=${c.open} H=${c.high} L=${c.low} C=${c.close}`);
          }
        }
      }
    } catch (e) { /* skip parse error */ }
  }

  // ── 結果輸出 ──
  console.log(`\n=== 每日缺漏分佈（caller-side: 哪一天最多股票缺）===`);
  for (const ed of expected) {
    const cnt = missingByDate.get(ed) ?? 0;
    if (cnt > 0) {
      const pct = (cnt / files.length * 100).toFixed(1);
      const flag = cnt > files.length * 0.1 ? ' ★★ 重大' : cnt > 50 ? ' ★ 注意' : '';
      console.log(`  ${ed}: ${cnt} 支缺 (${pct}%)${flag}`);
    }
  }

  console.log(`\n=== Middle Gaps（不是末尾的洞，最該補）===`);
  console.log(`共 ${middleGaps.length} 支有 middle gap`);
  // 按缺日數排序
  middleGaps.sort((a, b) => b.missing.length - a.missing.length);
  for (const g of middleGaps.slice(0, 15)) {
    console.log(`  ${g.sym}: 缺 ${g.missing.length} 天 [${g.missing.slice(0, 5).join(', ')}${g.missing.length > 5 ? '...' : ''}]`);
  }

  console.log(`\n=== Tail Stale（末尾落後的，可能停牌/退市/抓取失敗）===`);
  console.log(`共 ${tailStale.length} 支 tail stale`);
  tailStale.sort((a, b) => b.daysBehind - a.daysBehind);
  for (const s of tailStale.slice(0, 15)) {
    console.log(`  ${s.sym}: lastDate=${s.lastDate} 落後 ${s.daysBehind} 天`);
  }

  console.log(`\n=== OHLC 異常（前 20 例）===`);
  if (anomalousOHLC.length === 0) console.log('  ✅ 無');
  else for (const a of anomalousOHLC) console.log('  ' + a);

  console.log(`\n=== 總結 ===`);
  console.log(`  L1 共 ${files.length} 支`);
  console.log(`  Middle gaps: ${middleGaps.length} 支`);
  console.log(`  Tail stale: ${tailStale.length} 支`);
  console.log(`  OHLC 異常: ${anomalousOHLC.length} 例`);
}

main().catch(e => { console.error(e); process.exit(1); });
