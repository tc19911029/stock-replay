/**
 * CN A 股 L1 全面稽核（04-29 / 04-30）
 *
 * 資料源：Tencent ifzq.gtimg.cn 日K（qfq 前復權）
 *   https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=<prefix><code>,day,YYYY-MM-DD,YYYY-MM-DD,1,qfq
 *   prefix: sh / sz
 *   每筆：[date, open, close, high, low, volume(手)]
 *
 * 注意：volume 單位是「手」(=100 股)；L1 似乎用 100×手 = 股
 *   先看 600519 04-30: Tencent=52753 手；L1=3314200。3314200 / 52753 ≈ 62.8（不對）
 *   貴州茅台 04-30 成交量大概 5000 萬股 ≈ 50 萬手；3314200 是「股」太少；52753 「手」 → 52753×100=5,275,300 股
 *   L1 3,314,200 對不上。可能是不同除權前後復權差異或不同日。先只比 OHLC。
 *
 * 用法：
 *   npx tsx scripts/audit-l1-cn-full.ts          # 純稽核
 *   npx tsx scripts/audit-l1-cn-full.ts --fix    # 偏差>0.5% 直接覆蓋 close/open/high/low（不動 volume）
 */

import { promises as fs } from 'fs';
import path from 'path';

const DATA_DIR = path.resolve('data/candles/CN');
const DATES = process.argv.includes('--history')
  ? ['2026-04-22', '2026-04-23', '2026-04-24', '2026-04-27', '2026-04-28']
  : ['2026-04-29', '2026-04-30'];
const FIX = process.argv.includes('--fix');
const DEV_PCT = 0.005;
const CONCURRENCY = 8;

interface Candle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface CandleFile {
  symbol: string;
  candles: Candle[];
  lastDate?: string;
  updatedAt?: string;
  sealedDate?: string;
}

interface Official {
  open: number;
  high: number;
  low: number;
  close: number;
  volumeShou: number;
}

async function fetchTencent(code: string, suffix: 'SS' | 'SZ'): Promise<Map<string, Official>> {
  const prefix = suffix === 'SS' ? 'sh' : 'sz';
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${prefix}${code},day,2026-04-20,2026-04-30,10,qfq`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  let json: { code: number; data?: Record<string, { qfqday?: string[][] }> };
  try { json = JSON.parse(text); } catch { throw new Error('JSON parse'); }
  if (json.code !== 0 || !json.data) throw new Error(`code=${json.code}`);
  const key = `${prefix}${code}`;
  const day = json.data[key]?.qfqday;
  const out = new Map<string, Official>();
  if (!day) return out;
  for (const r of day) {
    out.set(r[0], {
      open: parseFloat(r[1]),
      close: parseFloat(r[2]),
      high: parseFloat(r[3]),
      low: parseFloat(r[4]),
      volumeShou: parseFloat(r[5]),
    });
  }
  return out;
}

interface AuditRow {
  date: string;
  symbol: string;
  l1Close: number;
  officialClose: number;
  devPct: number;
}

async function listFiles(): Promise<{ file: string; symbol: string; code: string; suffix: 'SS' | 'SZ' }[]> {
  const all = await fs.readdir(DATA_DIR);
  const out: { file: string; symbol: string; code: string; suffix: 'SS' | 'SZ' }[] = [];
  for (const f of all) {
    const m = f.match(/^(\d{6})\.(SS|SZ)\.json$/);
    if (!m) continue;
    out.push({ file: f, symbol: f.replace('.json', ''), code: m[1], suffix: m[2] as 'SS' | 'SZ' });
  }
  return out;
}

async function main() {
  console.log(`[audit-cn] FIX=${FIX}`);
  const files = await listFiles();
  console.log(`[audit-cn] ${files.length} CN 檔案`);

  const stats: Record<string, { checked: number; dev05: AuditRow[]; dev1: number; dev5: number; fixed: number; fetchFail: number }> = {};
  for (const d of DATES) stats[d] = { checked: 0, dev05: [], dev1: 0, dev5: 0, fixed: 0, fetchFail: 0 };

  let processed = 0;
  let fetchFailures = 0;

  // 並發處理
  const queue = [...files];
  async function worker() {
    while (queue.length) {
      const item = queue.shift();
      if (!item) break;
      processed++;
      if (processed % 200 === 0) console.log(`[audit-cn] ${processed}/${files.length} (fetch fails: ${fetchFailures})`);

      let official: Map<string, Official>;
      try {
        official = await fetchTencent(item.code, item.suffix);
      } catch {
        fetchFailures++;
        for (const d of DATES) stats[d].fetchFail++;
        continue;
      }

      let raw: string;
      try { raw = await fs.readFile(path.join(DATA_DIR, item.file), 'utf-8'); } catch { continue; }
      let json: CandleFile;
      try { json = JSON.parse(raw); } catch { continue; }
      if (!Array.isArray(json.candles)) continue;

      let changed = false;
      for (const d of DATES) {
        const off = official.get(d);
        if (!off) continue;
        const idx = json.candles.findIndex(c => c.date === d);
        if (idx < 0) continue;
        const l1 = json.candles[idx];
        stats[d].checked++;
        const dev = Math.abs(l1.close - off.close) / off.close;
        if (dev > 0.05) stats[d].dev5++;
        if (dev > 0.01) stats[d].dev1++;
        if (dev > DEV_PCT) {
          stats[d].dev05.push({ date: d, symbol: item.symbol, l1Close: l1.close, officialClose: off.close, devPct: dev });
          if (FIX) {
            json.candles[idx] = {
              date: d,
              open: off.open,
              high: off.high,
              low: off.low,
              close: off.close,
              volume: l1.volume, // 保留原 volume（單位差異）
            };
            stats[d].fixed++;
            changed = true;
          }
        }
      }
      if (changed && FIX) {
        json.lastDate = json.candles[json.candles.length - 1]?.date ?? json.lastDate;
        json.updatedAt = new Date().toISOString();
        await fs.writeFile(path.join(DATA_DIR, item.file), JSON.stringify(json, null, 2));
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  console.log(`\n## 任務 2 全面稽核：CN A 股\n`);
  console.log('| 日期 | 對到 | 偏差>0.5% | 偏差>1% | 偏差>5% | fetch失敗 | 已修 |');
  console.log('|------|------|-----------|---------|---------|-----------|------|');
  for (const d of DATES) {
    const s = stats[d];
    console.log(`| ${d} | ${s.checked} | ${s.dev05.length} | ${s.dev1} | ${s.dev5} | ${s.fetchFail} | ${s.fixed} |`);
  }
  for (const d of DATES) {
    const s = stats[d];
    if (s.dev05.length === 0) continue;
    s.dev05.sort((a, b) => b.devPct - a.devPct);
    console.log(`\n### ${d} top 10 偏差（共 ${s.dev05.length}）`);
    for (const r of s.dev05.slice(0, 10)) {
      console.log(`  ${r.symbol}: L1=${r.l1Close} vs official=${r.officialClose} dev=${(r.devPct * 100).toFixed(2)}%`);
    }
  }
  console.log(`\n[audit-cn] 完成 (fetch失敗 ${fetchFailures})`);
}

main().catch(e => { console.error(e); process.exit(1); });
