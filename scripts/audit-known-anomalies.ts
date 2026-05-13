/**
 * Audit + 自動分類 — 對全市場跑各維度檢查，用 known-anomalies registry 過濾
 *
 * 流程：
 *   1. 掃 L1 全市場找各類 anomaly（sandwich vol=0、ohlc 違反等）
 *   2. 每筆查 registry → 已知合法 / 未知 bug
 *   3. 報告分布、unknown 列表
 *
 * 用法：
 *   npx tsx scripts/audit-known-anomalies.ts                    # 全部維度
 *   npx tsx scripts/audit-known-anomalies.ts --type sandwich-vol-zero
 *   npx tsx scripts/audit-known-anomalies.ts --json --write data/anomaly-audit-{date}.json
 *
 * 用戶價值：未來再質疑「為什麼這檔 vol=0」、「為什麼 close 比 high 高」
 *         可以直接 reference 紀錄證明「不是我們的問題」。
 */
import { config } from 'dotenv';
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';

if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { matchAnomaly, type AnomalyType } from '../lib/datasource/knownAnomalies';

type Market = 'TW' | 'CN';

interface Args { type?: AnomalyType; json: boolean; write?: string; }
function parseArgs(): Args {
  const a: Args = { json: false };
  for (let i = 2; i < process.argv.length; i++) {
    const x = process.argv[i];
    if (x === '--type') a.type = process.argv[++i] as AnomalyType;
    else if (x === '--json') a.json = true;
    else if (x === '--write') a.write = process.argv[++i];
  }
  return a;
}

interface AnomalyEntry {
  type: AnomalyType;
  market: Market;
  symbol: string;
  date: string;
  details: Record<string, unknown>;
  match: { ruleId: string; ruleName: string } | null;
}

function loadCandles(market: Market, fname: string): Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }> {
  try {
    const raw = JSON.parse(readFileSync(path.join(process.cwd(), 'data', 'candles', market, fname), 'utf8'));
    return Array.isArray(raw) ? raw : (raw.candles ?? []);
  } catch { return []; }
}

function findSandwichVolZero(): AnomalyEntry[] {
  const out: AnomalyEntry[] = [];
  for (const m of ['TW', 'CN'] as Market[]) {
    const dir = path.join(process.cwd(), 'data', 'candles', m);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const cs = loadCandles(m, f);
      const sym = f.replace('.json', '');
      for (let i = 1; i < cs.length - 1; i++) {
        const c = cs[i];
        if (c.volume !== 0 || c.close <= 0) continue;
        const prev = cs[i - 1], next = cs[i + 1];
        if (!(prev.volume > 0 && next.volume > 0)) continue;
        const match = matchAnomaly('sandwich-vol-zero', {
          symbol: sym, date: c.date,
          current: c, prev: { close: prev.close }, next: { open: next.open, close: next.close },
        });
        out.push({
          type: 'sandwich-vol-zero',
          market: m, symbol: sym, date: c.date,
          details: { prevClose: prev.close, nextOpen: next.open, ohlc: `O=${c.open} H=${c.high} L=${c.low} C=${c.close}`, vol: 0 },
          match: match ? { ruleId: match.ruleId, ruleName: match.ruleName } : null,
        });
      }
    }
  }
  return out;
}

function findOhlcInvariantViolations(): AnomalyEntry[] {
  // 修法已將全市場 invariant 違反清零（5773→0）；保留掃描 hook，未來新增 violation 會被偵測
  const out: AnomalyEntry[] = [];
  for (const m of ['TW', 'CN'] as Market[]) {
    const dir = path.join(process.cwd(), 'data', 'candles', m);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const cs = loadCandles(m, f);
      const sym = f.replace('.json', '');
      for (const c of cs) {
        if (c.close > c.high + 0.001 || c.close < c.low - 0.001) {
          const match = matchAnomaly('l1-ohlc-invariant-violation', {
            symbol: sym, date: c.date, current: c,
          });
          out.push({
            type: 'l1-ohlc-invariant-violation',
            market: m, symbol: sym, date: c.date,
            details: { ohlc: `O=${c.open} H=${c.high} L=${c.low} C=${c.close}` },
            match: match ? { ruleId: match.ruleId, ruleName: match.ruleName } : null,
          });
        }
      }
    }
  }
  return out;
}

async function main() {
  const args = parseArgs();

  console.log('=== Known-Anomalies Audit ===');

  const allFindings: AnomalyEntry[] = [];

  if (!args.type || args.type === 'sandwich-vol-zero') {
    console.log('\n[scan] sandwich vol=0 ...');
    const findings = findSandwichVolZero();
    allFindings.push(...findings);
    const known = findings.filter(f => f.match != null);
    const unknown = findings.filter(f => f.match == null);
    console.log(`  total ${findings.length}, known (合法) ${known.length}, unknown (待查) ${unknown.length}`);
    if (unknown.length > 0) {
      console.log('  Unknown samples 前 10：');
      unknown.slice(0, 10).forEach(u =>
        console.log(`    ${u.market}/${u.symbol}@${u.date}: ${JSON.stringify(u.details)}`));
    }
  }

  if (!args.type || args.type === 'l1-ohlc-invariant-violation') {
    console.log('\n[scan] L1 OHLC invariant ...');
    const findings = findOhlcInvariantViolations();
    allFindings.push(...findings);
    const known = findings.filter(f => f.match != null);
    const unknown = findings.filter(f => f.match == null);
    console.log(`  total ${findings.length}, known (合法) ${known.length}, unknown (待查) ${unknown.length}`);
    if (unknown.length > 0) {
      console.log('  Unknown samples 前 10：');
      unknown.slice(0, 10).forEach(u =>
        console.log(`    ${u.market}/${u.symbol}@${u.date}: ${JSON.stringify(u.details)}`));
    }
  }

  // ── Output ───────────────────────────────────────────────────────────────
  const summary = {
    generatedAt: new Date().toISOString(),
    total: allFindings.length,
    known: allFindings.filter(f => f.match != null).length,
    unknown: allFindings.filter(f => f.match == null).length,
    byType: Object.fromEntries(
      ['sandwich-vol-zero', 'l1-ohlc-invariant-violation'].map(t => {
        const subset = allFindings.filter(f => f.type === t);
        return [t, {
          total: subset.length,
          known: subset.filter(f => f.match != null).length,
          unknown: subset.filter(f => f.match == null).length,
        }];
      }),
    ),
  };

  console.log('\n=== 總結 ===');
  console.log(`Total anomalies: ${summary.total}`);
  console.log(`Known (有 registry 記錄、合法): ${summary.known}`);
  console.log(`Unknown (沒記錄、需要調查): ${summary.unknown}`);

  if (args.json) {
    console.log('\n' + JSON.stringify({ summary, findings: allFindings }, null, 2));
  }

  if (args.write) {
    const outPath = path.resolve(args.write);
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify({ summary, findings: allFindings }, null, 2));
    console.log(`Written ${outPath}`);
  }

  // Invariant：未知 > 0 → 真 bug、exit 1
  if (summary.unknown > 0) {
    console.error(`\n★ ${summary.unknown} 筆未知 anomaly — 請手動 register 或修法後 exit 1`);
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(2); });
