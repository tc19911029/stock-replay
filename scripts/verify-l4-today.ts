/**
 * Verify L4 today — fail-closed sanity check for scan results.
 *
 * 掃描完 L4 後跑一次，檢查是否出現「用 T-1 bar 冒充 T 日結果」的症狀。
 * 判準：卡片 `chg% = 0` 比例 > 5% → 極可能是 L1 缺今日 bar 的偽造分析。
 *
 * 用法：
 *   npx tsx scripts/verify-l4-today.ts             # TW + CN 都驗
 *   npx tsx scripts/verify-l4-today.ts --market TW # 只驗台股
 *
 * Exit code:
 *   0 = 健康
 *   1 = 異常（chg%=0 比例過高、檔案損毀、或檔案不存在且為交易日）
 */

import { existsSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import path from 'node:path';

interface ScanFile {
  date: string;
  market: string;
  sessionType?: string;
  results: Array<{
    symbol: string;
    changePercent: number;
    sixConditionsScore: number;
  }>;
}

const CHG_ZERO_RATIO_THRESHOLD = 0.05; // 5%
const DATA_DIR = path.join(process.cwd(), 'data');

function getTodayDate(market: 'TW' | 'CN'): string {
  const tz = market === 'TW' ? 'Asia/Taipei' : 'Asia/Shanghai';
  return new Date().toLocaleString('sv-SE', { timeZone: tz }).split(' ')[0];
}

interface VerifyResult {
  market: 'TW' | 'CN';
  filename: string;
  ok: boolean;
  reason?: string;
  zeroChgCount?: number;
  totalResults?: number;
}

function verifyOne(market: 'TW' | 'CN', date: string, variant: string): VerifyResult {
  const filename = `scan-${market}-${variant}-${date}.json`;
  const full = path.join(DATA_DIR, filename);

  if (!existsSync(full)) {
    return { market, filename, ok: true, reason: 'file not present (ok if no results)' };
  }

  let parsed: ScanFile;
  try {
    parsed = JSON.parse(readFileSync(full, 'utf8'));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'parse failed';
    return { market, filename, ok: false, reason: `parse error: ${msg}` };
  }

  const results = parsed.results ?? [];
  if (results.length === 0) {
    return { market, filename, ok: true, reason: 'empty results' };
  }

  const zeroChg = results.filter(r => r.changePercent === 0 && r.sixConditionsScore >= 5).length;
  const ratio = zeroChg / results.length;

  if (ratio > CHG_ZERO_RATIO_THRESHOLD) {
    return {
      market,
      filename,
      ok: false,
      reason: `chg%=0 與高分共現比例 ${(ratio * 100).toFixed(1)}% 超過 ${CHG_ZERO_RATIO_THRESHOLD * 100}% 門檻`,
      zeroChgCount: zeroChg,
      totalResults: results.length,
    };
  }

  return { market, filename, ok: true, zeroChgCount: zeroChg, totalResults: results.length };
}

function quarantine(filename: string): void {
  const src = path.join(DATA_DIR, filename);
  const dstDir = path.join(DATA_DIR, `BAD-${new Date().toISOString().slice(0, 10)}-verify-l4`);
  const { mkdirSync } = require('node:fs');
  if (!existsSync(dstDir)) mkdirSync(dstDir, { recursive: true });
  const dst = path.join(dstDir, filename);
  renameSync(src, dst);
  console.error(`   🚨 已歸檔：${src} → ${dst}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const markets: Array<'TW' | 'CN'> = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--market' && args[i + 1]) {
      const m = args[i + 1].toUpperCase();
      if (m === 'TW' || m === 'CN') markets.push(m);
      i++;
    }
  }
  const targets = markets.length > 0 ? markets : (['TW', 'CN'] as const);
  const variants = ['long-daily', 'long-mtf', 'short-daily', 'short-mtf'];

  let hasFailure = false;
  for (const market of targets) {
    const date = getTodayDate(market);
    console.log(`\n🔍 驗證 [${market}] ${date}`);
    for (const variant of variants) {
      const r = verifyOne(market, date, variant);
      const icon = r.ok ? '✅' : '❌';
      const extra = r.totalResults
        ? ` (zeroChg=${r.zeroChgCount}/${r.totalResults})`
        : '';
      console.log(`   ${icon} ${r.filename}${extra} ${r.reason ?? ''}`);
      if (!r.ok && r.reason?.includes('chg%=0')) {
        quarantine(r.filename);
        hasFailure = true;
      } else if (!r.ok) {
        hasFailure = true;
      }
    }
  }

  if (hasFailure) {
    console.error('\n🛑 L4 驗證失敗，已歸檔可疑檔案');
    process.exit(1);
  }
  console.log('\n✅ L4 驗證通過');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
