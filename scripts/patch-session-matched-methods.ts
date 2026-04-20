/**
 * 一次性 patch：對現有最新 intraday session，對每支 result 呼叫 B/C/D/E
 * 偵測器補 matchedMethods 欄位並寫回檔案。
 *
 * 盤後窗口已過、cron 不再跑，先 patch 讓用戶能切買法 tab 看到結果；
 * 下次開盤 cron 會自動跑新版 MarketScanner 帶 matchedMethods。
 *
 * 用法：npx tsx scripts/patch-session-matched-methods.ts
 */

import { config } from 'dotenv';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import path from 'path';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';
import { computeIndicators } from '@/lib/indicators';
import { detectBreakoutEntry } from '@/lib/analysis/breakoutEntry';
import { detectVReversal } from '@/lib/analysis/vReversalDetector';
import { detectStrategyD } from '@/lib/analysis/gapEntry';
import { detectStrategyE } from '@/lib/analysis/highWinRateEntry';

const DATA_DIR = path.join(process.cwd(), 'data');

async function patchLatestSession(market: 'TW' | 'CN'): Promise<void> {
  const files = readdirSync(DATA_DIR)
    .filter(f => f.startsWith(`scan-${market}-long-daily-2026-04-20-intraday-`) && f.endsWith('.json'));
  if (files.length === 0) {
    console.log(`${market}: no session found`);
    return;
  }
  files.sort((a, b) => {
    const ta = a.match(/intraday-(\d+)/)?.[1] ?? '0';
    const tb = b.match(/intraday-(\d+)/)?.[1] ?? '0';
    return Number(ta) - Number(tb);
  });
  const latest = files[files.length - 1];
  const filePath = path.join(DATA_DIR, latest);
  const session = JSON.parse(readFileSync(filePath, 'utf-8'));
  console.log(`${market}: 處理 ${latest}, resultCount=${session.resultCount}`);

  let patched = 0;
  for (const r of session.results) {
    const matched: string[] = ['A']; // 通過 scanSOP 的都過了 A
    try {
      const raw = await readCandleFile(r.symbol, market);
      if (!raw || raw.length < 30) continue;
      const candles = computeIndicators(raw);
      const lastIdx = candles.length - 1;
      if (detectBreakoutEntry(candles, lastIdx)) matched.push('B');
      if (detectVReversal(candles, lastIdx)) matched.push('C');
      if (detectStrategyD(candles, lastIdx)) matched.push('D');
      if (detectStrategyE(candles, lastIdx)) matched.push('E');
    } catch { /* 保底 A */ }
    r.matchedMethods = matched;
    patched++;
  }

  writeFileSync(filePath, JSON.stringify(session));
  const bySuffix = new Map<string, number>();
  for (const r of session.results) {
    for (const m of r.matchedMethods ?? []) bySuffix.set(m, (bySuffix.get(m) ?? 0) + 1);
  }
  console.log(`${market}: patched ${patched} 支; 分佈: ${[...bySuffix.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`);
}

async function main() {
  await patchLatestSession('TW');
  await patchLatestSession('CN');
}

main().catch(err => { console.error(err); process.exit(1); });
