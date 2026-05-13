import { readFileSync } from 'node:fs';
import path from 'node:path';

let cached: string | null = null;

const SOURCES: { file: string; label: string }[] = [
  { file: 'docs/TECHNICAL_ANALYSIS_5STEPS.md', label: '書本：五步法整理稿 v11（朱家泓 5 本 + 林穎 1 本精華 + 附錄 50+）' },
  { file: 'docs/RockStar_5Steps_Framework_v12.md', label: '書本：v12 框架（用戶版整理）' },
];

export function loadBookContext(): string {
  if (cached) return cached;
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
