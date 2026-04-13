/**
 * 修復進度監控（每30秒自動刷新）
 * npx tsx scripts/watch-repair-progress.ts
 */
import { existsSync, readdirSync, readFileSync } from 'fs';

const TARGET_DATE = '2026-04-13';
const REFRESH_SECONDS = 20;

function bar(done: number, total: number, width = 30): string {
  const pct = total > 0 ? done / total : 0;
  const filled = Math.round(pct * width);
  return '[' + '█'.repeat(filled) + '░'.repeat(width - filled) + ']';
}

function getMarketStats(market: 'TW' | 'CN') {
  const dir = `data/candles/${market}`;
  if (!existsSync(dir)) return { total: 0, done: 0, lagging: 0, latest: '' };

  const files = readdirSync(dir).filter(f => f.endsWith('.json'));
  let done = 0;
  let lagging = 0;
  let latestProcessed = '';

  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8'));
      const lastDate: string = raw.lastDate || raw.candles?.at(-1)?.date || '';
      if (lastDate >= TARGET_DATE) {
        done++;
        if (lastDate > latestProcessed) latestProcessed = lastDate;
      } else {
        lagging++;
      }
    } catch { /* skip */ }
  }

  return { total: files.length, done, lagging, latest: latestProcessed };
}

function getRunningPIDs() {
  try {
    const { execSync } = require('child_process');
    const out = execSync('ps aux 2>/dev/null', { encoding: 'utf8' }) as string;
    const lines = out.split('\n');
    const procs: { name: string; pid: string }[] = [];
    for (const line of lines) {
      if (line.includes('repair-cn-tencent-mass') && !line.includes('grep')) {
        const pid = line.trim().split(/\s+/)[1];
        procs.push({ name: 'CN騰訊全量修復', pid });
      } else if (line.includes('repair-tw-lagging') && !line.includes('grep')) {
        const pid = line.trim().split(/\s+/)[1];
        procs.push({ name: 'TW落後修復', pid });
      } else if (line.includes('correct-candles') && !line.includes('grep')) {
        const pid = line.trim().split(/\s+/)[1];
        procs.push({ name: 'TW品質修正', pid });
      }
    }
    // dedup by name
    const seen = new Set<string>();
    return procs.filter(p => { if (seen.has(p.name)) return false; seen.add(p.name); return true; });
  } catch { return []; }
}

function render() {
  const tw = getMarketStats('TW');
  const cn = getMarketStats('CN');
  const procs = getRunningPIDs();
  const now = new Date().toLocaleTimeString('zh-TW', { hour12: false });

  // Clear screen
  process.stdout.write('\x1Bc');

  console.log('┌─────────────────────────────────────────────────────┐');
  console.log(`│  🔧 Layer 1 修復進度監控  [${now}]  目標: ${TARGET_DATE}  │`);
  console.log('├─────────────────────────────────────────────────────┤');
  console.log('│                                                     │');

  // TW
  const twPct = tw.total > 0 ? ((tw.done / tw.total) * 100).toFixed(1) : '0.0';
  const twBar = bar(tw.done, tw.total, 28);
  console.log(`│  🇹🇼 TW  ${twBar}  ${twPct.padStart(5)}%  │`);
  console.log(`│     已更新 ${String(tw.done).padStart(4)}/${tw.total} 支  待修復 ${tw.lagging} 支       │`);
  console.log('│                                                     │');

  // CN
  const cnPct = cn.total > 0 ? ((cn.done / cn.total) * 100).toFixed(1) : '0.0';
  const cnBar = bar(cn.done, cn.total, 28);
  console.log(`│  🇨🇳 CN  ${cnBar}  ${cnPct.padStart(5)}%  │`);
  console.log(`│     已更新 ${String(cn.done).padStart(4)}/${cn.total} 支  待修復 ${cn.lagging} 支      │`);
  console.log('│                                                     │');

  // 合計
  const totalDone = tw.done + cn.done;
  const totalAll = tw.total + cn.total;
  const totalPct = totalAll > 0 ? ((totalDone / totalAll) * 100).toFixed(1) : '0.0';
  const totalBar = bar(totalDone, totalAll, 28);
  console.log(`│  📊 總計  ${totalBar}  ${totalPct.padStart(5)}%  │`);
  console.log(`│     已更新 ${String(totalDone).padStart(5)}/${totalAll} 支                        │`);
  console.log('│                                                     │');

  // 執行中的腳本
  console.log('├─────────────────────────────────────────────────────┤');
  if (procs.length === 0) {
    console.log('│  ✅ 所有修復腳本已完成（或未執行）               │');
  } else {
    console.log('│  ⚙️  執行中的腳本:                                │');
    for (const p of procs) {
      const label = `│     • ${p.name} (PID ${p.pid})`;
      console.log(label.padEnd(53) + '│');
    }
  }

  // Vercel Blob 修復提示
  console.log('├─────────────────────────────────────────────────────┤');
  console.log('│  🌐 Vercel Blob 修復（local修完後執行）:           │');
  console.log('│  TW: /api/admin/repair-candles?market=TW&mode=repair │');
  console.log('│  CN: /api/admin/repair-candles?market=CN&mode=repair │');
  console.log('│                                                     │');
  console.log(`│  ⏱  ${REFRESH_SECONDS}秒後自動刷新  按 Ctrl+C 離開          │`);
  console.log('└─────────────────────────────────────────────────────┘');
}

async function main() {
  render();
  setInterval(render, REFRESH_SECONDS * 1000);
}

main();
