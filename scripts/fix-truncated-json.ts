/**
 * 修復併發寫入造成的 JSON 尾巴重複污染
 *
 * Pattern：合法 JSON 結尾後接著垃圾或重複內容（典型 zustand persist + race condition）
 * 修復策略：找到第一個合法的 JSON 結尾位置，截掉後面的所有東西。
 *
 * 用法：tsx scripts/fix-truncated-json.ts <file-path>
 */
import { promises as fs } from 'fs';

async function fixFile(filePath: string): Promise<{ ok: boolean; before: number; after?: number; reason?: string }> {
  const raw = await fs.readFile(filePath, 'utf-8');
  // 嘗試從整個 raw 找最後一個 '}'（最外層 close brace）
  // 用 stack-based 找 balanced JSON 結束位置
  let depth = 0;
  let inStr = false;
  let escape = false;
  let endIdx = -1;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) { endIdx = i; break; }
    }
  }
  if (endIdx < 0) return { ok: false, before: raw.length, reason: 'unbalanced JSON, no end found' };

  const truncated = raw.slice(0, endIdx + 1);
  // 驗證可解析
  try {
    JSON.parse(truncated);
  } catch (err) {
    return { ok: false, before: raw.length, reason: `truncated JSON still invalid: ${String(err).slice(0, 80)}` };
  }

  if (truncated.length === raw.length) {
    return { ok: true, before: raw.length, after: raw.length, reason: 'no change needed' };
  }

  await fs.writeFile(filePath, truncated);
  return { ok: true, before: raw.length, after: truncated.length };
}

async function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('Usage: tsx fix-truncated-json.ts <file-path> [<file-path>...]');
    process.exit(1);
  }
  for (const f of files) {
    const r = await fixFile(f);
    if (r.ok && r.after !== r.before) {
      console.log(`✓ ${f}: ${r.before} → ${r.after} bytes (truncated ${r.before - (r.after ?? r.before)} bytes)`);
    } else if (r.ok) {
      console.log(`- ${f}: ${r.reason ?? 'no change'}`);
    } else {
      console.log(`✗ ${f}: ${r.reason}`);
    }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
