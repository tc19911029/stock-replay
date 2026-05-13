import { readFileSync } from 'node:fs';
import path from 'node:path';

let cached: string | null = null;

const SOURCES: { file: string; label: string }[] = [
  { file: 'docs/TECHNICAL_ANALYSIS_5STEPS.md', label: '書本：五步法整理稿 v11（朱家泓 5 本 + 林穎 1 本精華 + 附錄 50+）' },
  { file: 'docs/RockStar_5Steps_Framework_v12.md', label: '書本：v12 框架（用戶版整理）' },
];

export function loadBookContext(): string {
  if (cached) return cached;
  // Turbopack build 對 process.cwd() 動態值會 trace 整個專案，產生 29 個
  // "Overly broad patterns" warnings（37428 files matched）。這些是 false-positive：
  // 1. 本檔走 nodejs runtime（chat/route.ts 設 export const runtime = 'nodejs'），
  //    不會 Edge bundle。
  // 2. scripts/check-instrumentation-edge-safe.ts 已驗 instrumentation 邊界乾淨。
  // 3. 試過 /*turbopackIgnore: true*/ 不收 (Next.js 16 + Turbopack)。
  // Build 仍 ✓ Compiled successfully，runtime 行為正常。
  const root = process.cwd();
  const parts: string[] = [];
  for (const { file, label } of SOURCES) {
    try {
      const body = readFileSync(path.join(root, file), 'utf-8');
      parts.push(`<${label}>\n${body}\n</${label}>`);
    } catch (err) {
      console.warn(`[bookContextLoader] missing ${file}:`, err instanceof Error ? err.message : err);
    }
  }
  cached = parts.join('\n\n');
  return cached;
}
