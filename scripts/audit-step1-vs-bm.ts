/**
 * Step 1 池子 vs Step 2 字母 session 差集診斷
 *
 * 目的：驗證使用者反映的「Step 2 出現 Step 1 沒有的股票」是否屬實。
 *
 * 多頭軌字母 (B/C/E/J/K/L/M/P) 在 lib/scanner/MarketScanner.ts:1304-1326 應只
 * 從 Step 1 池子篩選。若任一字母 session 的 results 包含池子外股票 → pipeline bug。
 * 反轉軌 (D/F/N/O) 與戰法軌 (Q) 設計上不過 Step 1，差集非空為預期。
 *
 * Usage: npx tsx scripts/audit-step1-vs-bm.ts [TW|CN] [YYYY-MM-DD]
 */

import { loadStep1Pool } from '../lib/scanner/step1Pool';
import { loadScanSession } from '../lib/storage/scanStorage';
import type { MarketId } from '../lib/scanner/types';

const BULLISH = ['B', 'C', 'E', 'J', 'K', 'L', 'M', 'P'] as const;
const REVERSAL = ['D', 'F', 'N', 'O'] as const;
const SYSTEM = ['Q'] as const;
type Letter = (typeof BULLISH)[number] | (typeof REVERSAL)[number] | (typeof SYSTEM)[number];

async function main() {
  const market = (process.argv[2] || 'TW') as MarketId;
  const date = process.argv[3] || '2026-05-08';

  console.log(`\n=== Step1 vs Step2 audit · ${market} · ${date} ===\n`);

  const pool = await loadStep1Pool(market, date);
  if (!pool) {
    console.log(`Step 1 池子不存在 (${market}/${date}) — 多頭軌字母 sessions 應全為空（bug 若不空）`);
  } else {
    console.log(`Step 1 池子大小：${pool.symbols.length} 支（生成於 ${pool.generatedAt}）`);
  }
  const step1Set = new Set(pool?.symbols ?? []);

  const allLetters: Letter[] = [...BULLISH, ...REVERSAL, ...SYSTEM];
  const trackOf = (l: Letter) =>
    BULLISH.includes(l as never) ? '多頭軌'
      : REVERSAL.includes(l as never) ? '反轉軌'
        : '戰法軌';

  console.log('\nletter | track  | session | inStep1 | notInStep1 | sample notInStep1');
  console.log('-------|--------|---------|---------|------------|--------------------------------');

  let bullishLeak = 0;
  for (const letter of allLetters) {
    const session = await loadScanSession(market, date, 'long', letter);
    const symbols = session?.results.map(r => r.symbol) ?? [];
    const inPool = symbols.filter(s => step1Set.has(s));
    const notInPool = symbols.filter(s => !step1Set.has(s));
    const sample = notInPool.slice(0, 3).join(', ');
    const track = trackOf(letter);
    const flag = (BULLISH as readonly string[]).includes(letter) && notInPool.length > 0 ? ' ⚠ LEAK' : '';
    if (flag) bullishLeak += notInPool.length;
    console.log(
      `   ${letter}   | ${track} |   ${String(symbols.length).padStart(3)}   |  ${String(inPool.length).padStart(3)}    |    ${String(notInPool.length).padStart(3)}     | ${sample}${flag}`,
    );
  }

  console.log('\n=== 結論 ===');
  if (!pool) {
    console.log('Step 1 池子缺漏：上面任何多頭軌字母 session 數 > 0 都表示 fallback 邏輯存在（應 return []）');
  } else if (bullishLeak === 0) {
    console.log('✓ 多頭軌全部 session 都是 Step 1 子集；用戶看到的「多出來」應是反轉/戰法軌字母 → UI 標籤需更明顯區分。');
  } else {
    console.log(`✗ 多頭軌共 ${bullishLeak} 個股票不在 Step 1 池子裡 — pipeline 確實有 bug，需追 MarketScanner.scanBuyMethod 的 step1Symbols 讀取邏輯。`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
