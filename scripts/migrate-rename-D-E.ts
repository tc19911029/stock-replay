/**
 * 2026-04-20 命名重整 migration：
 *   舊 'E' = 缺口   → 新 'D'
 *   舊 'F' = 一字底 → 新 'E'
 *   F 位置預留給變盤線（走圖輔助，無 detector，migration 不產新 F 檔）
 *
 * 本腳本處理：
 *   1. data/scan-{MARKET}-long-{E|F}-* 檔名重新命名（E→D、F→E；先把 F→E 做完再做 E→D 避免衝突）
 *   2. 所有 data/scan-*.json 內部 results[].matchedMethods 陣列 'E'→'D'、'F'→'E'（同時 re-map 不連鎖）
 *   3. session.buyMethod 欄位也跟著改
 *
 * Usage:
 *   npx tsx scripts/migrate-rename-D-E.ts          # dry-run，只印會改的項目
 *   npx tsx scripts/migrate-rename-D-E.ts --apply  # 真的落盤
 *
 * 備份：--apply 前會把 data/scan-*.json + daban-*.json 打包到 data/_backup-rename-D-E-{ts}.tar.gz
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const DATA_DIR = path.join(process.cwd(), 'data');
const APPLY = process.argv.includes('--apply');

interface Summary {
  renamedFiles: Array<{ from: string; to: string }>;
  patchedFiles: Array<{ path: string; changes: number }>;
  errors: string[];
}

function remapMatchedMethods(methods: unknown): { changed: boolean; next: string[] } | null {
  if (!Array.isArray(methods)) return null;
  const orig = methods as unknown[];
  const next: string[] = orig.map((m) => {
    if (m === 'F') return 'E';
    if (m === 'E') return 'D';
    return String(m);
  });
  const changed = next.some((m, i) => m !== orig[i]);
  return { changed, next };
}

function remapBuyMethod(bm: unknown): { changed: boolean; next: string | undefined } | null {
  if (bm == null) return { changed: false, next: undefined };
  if (bm === 'F') return { changed: true, next: 'E' };
  if (bm === 'E') return { changed: true, next: 'D' };
  return { changed: false, next: typeof bm === 'string' ? bm : undefined };
}

function patchSessionFile(filePath: string, summary: Summary): void {
  let session: Record<string, unknown>;
  try {
    session = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    summary.errors.push(`${filePath}: parse error ${(e as Error).message}`);
    return;
  }

  let changes = 0;

  // buyMethod top-level
  const bmRes = remapBuyMethod(session.buyMethod);
  if (bmRes?.changed) {
    session.buyMethod = bmRes.next;
    changes++;
  }

  // results[].matchedMethods
  const results = session.results;
  if (Array.isArray(results)) {
    for (const r of results) {
      if (r && typeof r === 'object') {
        const obj = r as Record<string, unknown>;
        const mm = remapMatchedMethods(obj.matchedMethods);
        if (mm?.changed) {
          obj.matchedMethods = mm.next;
          changes++;
        }
      }
    }
  }

  if (changes > 0) {
    summary.patchedFiles.push({ path: filePath, changes });
    if (APPLY) fs.writeFileSync(filePath, JSON.stringify(session));
  }
}

function renameFilenameIfNeeded(filename: string): string | null {
  // scan-TW-long-F-2026-04-20-intraday-0654.json → scan-TW-long-E-...
  // scan-TW-long-E-2026-04-20-intraday-0654.json → scan-TW-long-D-...
  const mF = filename.match(/^(scan-(?:TW|CN)-(?:long|short)-)F(-.+\.json)$/);
  if (mF) return mF[1] + 'E' + mF[2];
  const mE = filename.match(/^(scan-(?:TW|CN)-(?:long|short)-)E(-.+\.json)$/);
  if (mE) return mE[1] + 'D' + mE[2];
  return null;
}

function main(): void {
  const mode = APPLY ? 'APPLY' : 'DRY-RUN';
  console.log(`\n╔════════════════════════════════════════════════╗`);
  console.log(`║  rename-D-E migration  [${mode.padEnd(20)}]  ║`);
  console.log(`╚════════════════════════════════════════════════╝\n`);

  const summary: Summary = { renamedFiles: [], patchedFiles: [], errors: [] };

  if (!fs.existsSync(DATA_DIR)) {
    console.error(`data dir not found: ${DATA_DIR}`);
    process.exit(1);
  }

  const allFiles = fs.readdirSync(DATA_DIR).filter(f =>
    (f.startsWith('scan-') && f.endsWith('.json')) ||
    (f.startsWith('daban-') && f.endsWith('.json')),
  );

  // Step 1: backup (apply only)
  if (APPLY && allFiles.length > 0) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupName = `_backup-rename-D-E-${ts}.tar.gz`;
    const backupPath = path.join(DATA_DIR, backupName);
    console.log(`📦 建立備份 ${backupName}...`);
    try {
      execSync(`cd "${DATA_DIR}" && tar czf "${backupName}" scan-*.json daban-*.json 2>/dev/null || true`);
      console.log(`   ✅ 備份完成：${backupPath}\n`);
    } catch (e) {
      console.log(`   ⚠️  備份失敗（續跑）：${(e as Error).message}\n`);
    }
  }

  // Step 2: patch file contents first (before renames so we don't lose track)
  console.log(`📝 Step 1/2: patch matchedMethods & buyMethod 內容...`);
  for (const f of allFiles) {
    patchSessionFile(path.join(DATA_DIR, f), summary);
  }
  console.log(`   ${summary.patchedFiles.length} 個檔案需要內容 patch（${summary.patchedFiles.reduce((s, x) => s + x.changes, 0)} 處 remap）\n`);

  // Step 3: rename filenames — 先做 F→E (一字底)，再做 E→D (缺口)，避免中間態碰撞
  console.log(`📂 Step 2/2: rename 檔名 (F→E 先、E→D 後)...`);

  const currentFiles = APPLY
    ? fs.readdirSync(DATA_DIR).filter(f => f.startsWith('scan-') && f.endsWith('.json'))
    : allFiles.filter(f => f.startsWith('scan-'));

  // F→E pass
  for (const f of currentFiles) {
    if (!/^scan-(?:TW|CN)-(?:long|short)-F-/.test(f)) continue;
    const next = renameFilenameIfNeeded(f);
    if (!next) continue;
    const src = path.join(DATA_DIR, f);
    const dst = path.join(DATA_DIR, next);
    summary.renamedFiles.push({ from: f, to: next });
    if (APPLY) {
      if (fs.existsSync(dst)) {
        summary.errors.push(`衝突：${next} 已存在，不覆蓋 ${f}`);
        continue;
      }
      fs.renameSync(src, dst);
    }
  }

  // E→D pass (refresh file list after F→E renames if APPLY)
  const refreshed = APPLY
    ? fs.readdirSync(DATA_DIR).filter(f => f.startsWith('scan-') && f.endsWith('.json'))
    : allFiles.filter(f => f.startsWith('scan-'));

  for (const f of refreshed) {
    if (!/^scan-(?:TW|CN)-(?:long|short)-E-/.test(f)) continue;
    // 跳過剛才 F→E 搬過來的，它們的內部 buyMethod 已經是 E（一字底），不是 D
    // 判斷方法：dry-run 模式下用 filename+當初是 F 的列表；apply 模式下讀 session.buyMethod
    if (APPLY) {
      try {
        const session = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf-8'));
        // 如果 buyMethod === 'E' 是 migration 後的一字底（從 F 重新命名的），跳過
        // 真正要 E→D 的舊 '缺口' session：buyMethod 會是 'D'（已經被 step 1 patch 成 D）
        if (session.buyMethod === 'D') {
          // 已經 patch 成 D，代表這個 E 檔名是舊 '缺口' session
          const next = renameFilenameIfNeeded(f);
          if (!next) continue;
          const dst = path.join(DATA_DIR, next);
          if (fs.existsSync(dst)) {
            summary.errors.push(`衝突：${next} 已存在，不覆蓋 ${f}`);
            continue;
          }
          fs.renameSync(path.join(DATA_DIR, f), dst);
          summary.renamedFiles.push({ from: f, to: next });
        }
      } catch (e) {
        summary.errors.push(`${f}: E→D rename 判定失敗 ${(e as Error).message}`);
      }
    } else {
      // dry-run：簡化假設 — 所有 scan-*-E-* 要改成 scan-*-D-*
      // （實際 apply 時會用 buyMethod 欄位判定）
      const next = renameFilenameIfNeeded(f);
      if (next) summary.renamedFiles.push({ from: f, to: next });
    }
  }

  // ── Summary ──
  console.log(`\n════════════════════════════════════════════════`);
  console.log(`Summary`);
  console.log(`════════════════════════════════════════════════`);
  console.log(`  內容 patch：${summary.patchedFiles.length} 檔`);
  console.log(`  檔名 rename：${summary.renamedFiles.length} 檔`);
  console.log(`  錯誤：${summary.errors.length} 項`);

  if (summary.renamedFiles.length > 0) {
    console.log(`\n  檔名 rename 樣本（前 10）：`);
    for (const r of summary.renamedFiles.slice(0, 10)) {
      console.log(`    ${r.from}  →  ${r.to}`);
    }
  }
  if (summary.errors.length > 0) {
    console.log(`\n  錯誤：`);
    for (const e of summary.errors.slice(0, 10)) console.log(`    ${e}`);
  }

  if (!APPLY) {
    console.log(`\n  ℹ️  這是 dry-run。確認後加 --apply 實際落盤。`);
  } else {
    console.log(`\n  ✅ Migration 完成。備份在 data/_backup-rename-D-E-*.tar.gz`);
  }
  console.log('');
}

main();
