/**
 * 做空選股 forward 績效審計
 *
 * 讀取所有 scan-{TW|CN}-short-daily-*.json，對每筆候選從 L1 取 d1/d3/d5/d10
 * 收盤漲幅，統計：
 *   - 做空角度：選後跌的比例（獲利）
 *   - 做多角度：選後漲的比例（空單被軋 = 紅旗）
 *
 * Usage:
 *   npx tsx scripts/audit-short-forward.ts
 */
import fs from 'fs';
import path from 'path';

interface ScanResult { symbol: string; name?: string }
interface Session {
  market: 'TW' | 'CN';
  date: string;
  results: ScanResult[];
}
interface Candle { date: string; close: number; open: number }

function loadCandles(market: 'TW' | 'CN', symbol: string): Candle[] | null {
  const p = path.join(process.cwd(), 'data', 'candles', market, `${symbol}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return Array.isArray(raw) ? raw : raw.candles ?? null;
  } catch { return null; }
}

function forwardReturn(candles: Candle[], scanDate: string, days: number): number | null {
  const idx = candles.findIndex(c => c.date?.slice(0, 10) === scanDate);
  if (idx < 0 || idx + days >= candles.length) return null;
  const base = candles[idx].close;
  const target = candles[idx + days].close;
  return base > 0 ? (target / base - 1) * 100 : null;
}

interface Row {
  market: string;
  scanDate: string;
  symbol: string;
  name: string;
  d1: number | null;
  d3: number | null;
  d5: number | null;
  d10: number | null;
}

function audit(market: 'TW' | 'CN'): void {
  const dir = path.join(process.cwd(), 'data');
  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith(`scan-${market}-short-daily-`) && f.endsWith('.json') && !f.includes('intraday'))
    .sort();

  const rows: Row[] = [];
  for (const f of files) {
    try {
      const s: Session = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      if (!s.results?.length) continue;
      for (const r of s.results) {
        const c = loadCandles(market, r.symbol);
        if (!c) continue;
        rows.push({
          market,
          scanDate: s.date,
          symbol: r.symbol,
          name: r.name ?? '',
          d1:  forwardReturn(c, s.date, 1),
          d3:  forwardReturn(c, s.date, 3),
          d5:  forwardReturn(c, s.date, 5),
          d10: forwardReturn(c, s.date, 10),
        });
      }
    } catch { /* skip */ }
  }

  if (rows.length === 0) {
    console.log(`\n[${market}] 無 short-daily 候選資料`);
    return;
  }

  const stat = (key: 'd1' | 'd3' | 'd5' | 'd10') => {
    const vals = rows.map(r => r[key]).filter((v): v is number => v !== null);
    if (vals.length === 0) return null;
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const med = [...vals].sort((a, b) => a - b)[Math.floor(vals.length / 2)];
    const up  = vals.filter(v => v > 0).length / vals.length * 100;
    const down = vals.filter(v => v < 0).length / vals.length * 100;
    return { n: vals.length, avg, med, up, down };
  };

  console.log(`\n${'═'.repeat(72)}`);
  console.log(`  [${market}] Short-daily 選股 forward 績效審計`);
  console.log('═'.repeat(72));
  console.log(`  樣本：${files.length} 個 session，${rows.length} 筆候選`);
  console.log('─'.repeat(72));
  console.log('  期間  筆數   平均漲幅    中位數    上漲%   下跌%    做空勝率');
  for (const k of ['d1', 'd3', 'd5', 'd10'] as const) {
    const s = stat(k);
    if (!s) continue;
    const shortWin = s.down; // 選後跌 = 空單獲利
    console.log(
      `  ${k.padEnd(5)} ${s.n.toString().padStart(4)}   ` +
      `${(s.avg >= 0 ? '+' : '') + s.avg.toFixed(2).padStart(6)}%   ` +
      `${(s.med >= 0 ? '+' : '') + s.med.toFixed(2).padStart(6)}%   ` +
      `${s.up.toFixed(1).padStart(5)}%   ${s.down.toFixed(1).padStart(5)}%   ` +
      `${shortWin.toFixed(1).padStart(5)}%`
    );
  }

  console.log('\n  判讀：');
  const d5 = stat('d5');
  if (d5) {
    if (d5.avg > 1) {
      console.log(`  ⚠ d5 平均 +${d5.avg.toFixed(2)}% → 做空反漲，空單逆風`);
    } else if (d5.avg < -1) {
      console.log(`  ✓ d5 平均 ${d5.avg.toFixed(2)}% → 做空方向正確`);
    } else {
      console.log(`  ~ d5 平均 ${d5.avg.toFixed(2)}% → 方向不明顯`);
    }
  }
  console.log('═'.repeat(72));
}

audit('TW');
audit('CN');
