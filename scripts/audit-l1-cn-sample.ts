/**
 * CN A 股 L1 抽樣稽核（04-29/04-30）
 *
 * 資料源：Sohu hisHq API
 *   https://q.stock.sohu.com/hisHq?code=cn_<6digit>&start=YYYYMMDD&end=YYYYMMDD
 *   回傳每筆：[date, open, close, change, change%, low, high, volume(手), amount, turnover%]
 *
 * 抽樣：30 支大型 A 股
 */

import { promises as fs } from 'fs';
import path from 'path';

const DATA_DIR = path.resolve('data/candles/CN');
const DATES = ['2026-04-29', '2026-04-30'];

// 30 支大型 A 股（混 SH + SZ）
const SAMPLES: Array<{ code: string; suffix: 'SS' | 'SZ' }> = [
  { code: '600519', suffix: 'SS' }, // 貴州茅台
  { code: '601318', suffix: 'SS' }, // 中國平安
  { code: '600036', suffix: 'SS' }, // 招商銀行
  { code: '601398', suffix: 'SS' }, // 工商銀行
  { code: '601857', suffix: 'SS' }, // 中國石油
  { code: '600028', suffix: 'SS' }, // 中國石化
  { code: '601988', suffix: 'SS' }, // 中國銀行
  { code: '600000', suffix: 'SS' }, // 浦發銀行
  { code: '600276', suffix: 'SS' }, // 恆瑞醫藥
  { code: '600887', suffix: 'SS' }, // 伊利股份
  { code: '601288', suffix: 'SS' }, // 農業銀行
  { code: '601628', suffix: 'SS' }, // 中國人壽
  { code: '601166', suffix: 'SS' }, // 興業銀行
  { code: '600030', suffix: 'SS' }, // 中信證券
  { code: '600585', suffix: 'SS' }, // 海螺水泥
  { code: '601012', suffix: 'SS' }, // 隆基綠能
  { code: '600048', suffix: 'SS' }, // 保利發展
  { code: '600104', suffix: 'SS' }, // 上汽集團
  { code: '601668', suffix: 'SS' }, // 中國建築
  { code: '600050', suffix: 'SS' }, // 中國聯通
  { code: '000001', suffix: 'SZ' }, // 平安銀行
  { code: '000002', suffix: 'SZ' }, // 萬科A
  { code: '000333', suffix: 'SZ' }, // 美的集團
  { code: '000651', suffix: 'SZ' }, // 格力電器
  { code: '000858', suffix: 'SZ' }, // 五糧液
  { code: '002415', suffix: 'SZ' }, // 海康威視
  { code: '002594', suffix: 'SZ' }, // 比亞迪
  { code: '300750', suffix: 'SZ' }, // 寧德時代
  { code: '300059', suffix: 'SZ' }, // 東方財富
  { code: '002475', suffix: 'SZ' }, // 立訊精密
];

interface SohuResp {
  status: number;
  hq?: string[][];
}

async function fetchSohu(code6: string): Promise<Map<string, { open: number; high: number; low: number; close: number; volumeShou: number }>> {
  const url = `https://q.stock.sohu.com/hisHq?code=cn_${code6}&start=20260427&end=20260430`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const arr = await res.json() as SohuResp[];
  const out = new Map<string, { open: number; high: number; low: number; close: number; volumeShou: number }>();
  if (!Array.isArray(arr) || arr.length === 0 || !arr[0].hq) return out;
  for (const row of arr[0].hq) {
    out.set(row[0], {
      open: Number(row[1]),
      close: Number(row[2]),
      low: Number(row[5]),
      high: Number(row[6]),
      volumeShou: Number(row[7]),
    });
  }
  return out;
}

async function main() {
  console.log('## 任務 2：CN 抽樣\n');
  console.log('| symbol | 日期 | L1 close | Sohu close | 偏差% |');
  console.log('|--------|------|----------|------------|-------|');
  let issues = 0;
  for (const s of SAMPLES) {
    const sym = `${s.code}.${s.suffix}`;
    const fp = path.join(DATA_DIR, `${sym}.json`);
    let raw: string;
    try { raw = await fs.readFile(fp, 'utf-8'); } catch { console.log(`| ${sym} | - | (no L1 file) | - | - |`); continue; }
    const json = JSON.parse(raw);
    const candles = json.candles ?? [];
    const byDate = new Map<string, { open: number; high: number; low: number; close: number; volume: number }>(
      candles.map((c: { date: string; open: number; high: number; low: number; close: number; volume: number }) => [c.date, c])
    );
    let sohu: Map<string, { open: number; high: number; low: number; close: number; volumeShou: number }>;
    try {
      sohu = await fetchSohu(s.code);
    } catch (e) {
      console.log(`| ${sym} | - | - | FETCH FAIL | ${(e as Error).message} |`);
      continue;
    }
    for (const d of DATES) {
      const l1 = byDate.get(d);
      const off = sohu.get(d);
      if (!l1 || !off) {
        console.log(`| ${sym} | ${d} | ${l1?.close ?? '—'} | ${off?.close ?? '—'} | (missing) |`);
        continue;
      }
      const dev = (l1.close - off.close) / off.close;
      const flag = Math.abs(dev) > 0.005 ? ' ⚠️' : '';
      if (Math.abs(dev) > 0.005) issues++;
      console.log(`| ${sym} | ${d} | ${l1.close} | ${off.close} | ${(dev * 100).toFixed(2)}%${flag} |`);
    }
    await new Promise(r => setTimeout(r, 300));
  }
  console.log(`\n[CN] 偏差>0.5% 共 ${issues} 筆 / ${SAMPLES.length * DATES.length} 抽樣`);
}

main().catch(e => { console.error(e); process.exit(1); });
