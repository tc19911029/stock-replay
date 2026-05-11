/**
 * 巡查所有 RuleSignal emit 點的 label / ruleId 是否能被 signalClassifier 正確歸類。
 * 找出「歸類失敗 → 用 default」的訊號，這些是潛在誤分類的高風險源。
 *
 * 用法：npx tsx scripts/audit-signal-classifier.ts
 */

import { promises as fs } from 'fs';
import path from 'path';
import { classifySignal, RULE_ID_TO_SUBTYPE } from '@/lib/rules/signalClassifier';
import type { RuleSignal } from '@/types';

const RULES_DIR = path.join(process.cwd(), 'lib', 'rules');

interface Emit {
  file: string;
  ruleId: string;
  label: string;
  type: 'BUY' | 'SELL' | 'ADD' | 'REDUCE' | 'WATCH';
  description?: string;
}

// 從 rule 檔抓 type/label/ruleId 三元組
async function extractEmits(file: string): Promise<Emit[]> {
  const text = await fs.readFile(file, 'utf-8');
  const emits: Emit[] = [];

  // 找出所有 `id: 'xxx',` 與其後第一個 `type:` 與 `label:`
  const idRegex = /id:\s*['"]([^'"]+)['"]/g;
  const ids: { id: string; pos: number }[] = [];
  let m;
  while ((m = idRegex.exec(text)) !== null) {
    ids.push({ id: m[1], pos: m.index });
  }

  // 對每個 id，往後找 1500 字內的 type/label
  for (let i = 0; i < ids.length; i++) {
    const start = ids[i].pos;
    const end = i + 1 < ids.length ? ids[i + 1].pos : start + 3000;
    const block = text.substring(start, end);

    // 一個 rule 可能有多個 emit（gapTradingRules / threeBarReversalRules 有 if/else 多分支）
    const typeRegex = /type:\s*['"]?(BUY|SELL|ADD|REDUCE|WATCH)['"]?(?:\s+as\s+const)?/g;
    const labelRegex = /label:\s*['"`]([^'"`]+)['"`]/g;
    const types: { type: string; pos: number }[] = [];
    let tm;
    while ((tm = typeRegex.exec(block)) !== null) {
      types.push({ type: tm[1], pos: tm.index });
    }
    const labels: { label: string; pos: number }[] = [];
    while ((tm = labelRegex.exec(block)) !== null) {
      labels.push({ label: tm[1], pos: tm.index });
    }

    // 為每個 type 找最近的 label
    for (const t of types) {
      const nearest = labels
        .map(l => ({ ...l, dist: Math.abs(l.pos - t.pos) }))
        .sort((a, b) => a.dist - b.dist)[0];
      if (nearest) {
        emits.push({
          file: path.basename(file),
          ruleId: ids[i].id,
          label: nearest.label,
          type: t.type as Emit['type'],
        });
      }
    }
  }

  return emits;
}

async function main(): Promise<void> {
  const files = (await fs.readdir(RULES_DIR))
    .filter(f => f.endsWith('Rules.ts') || f === 'zhuRules.ts')
    .map(f => path.join(RULES_DIR, f));

  console.log(`Scanning ${files.length} rule files...`);
  const allEmits: Emit[] = [];
  for (const f of files) {
    const emits = await extractEmits(f);
    allEmits.push(...emits);
  }
  console.log(`Found ${allEmits.length} emit sites\n`);

  // 跑分類器
  type Row = Emit & { subtype: string; defaulted: boolean };
  const rows: Row[] = [];
  for (const e of allEmits) {
    const sig: RuleSignal = {
      type: e.type,
      label: e.label,
      description: '',
      reason: '',
      ruleId: e.ruleId,
      strength: 1,
      date: '',
    };
    const subtype = classifySignal(sig);

    // 「default 路徑」：BUY/ADD 沒匹配任何 pattern 就會回 entry_soft；SELL/REDUCE 回 exit_strong
    // 用 label/ruleId/description 組成的 haystack 是否含任何已知模式判斷
    const isDefault = isDefaultPath(sig, subtype);

    rows.push({ ...e, subtype, defaulted: isDefault });
  }

  // 分組顯示
  const groups: Record<string, Row[]> = {};
  for (const r of rows) {
    const key = `${r.type} → ${r.subtype}${r.defaulted ? ' (default)' : ''}`;
    (groups[key] ??= []).push(r);
  }

  for (const [key, rs] of Object.entries(groups).sort()) {
    console.log(`\n=== ${key}: ${rs.length} ===`);
    for (const r of rs.slice(0, 50)) {
      console.log(`  ${r.file.padEnd(28)} ${r.ruleId.padEnd(40)} ${r.label}`);
    }
    if (rs.length > 50) console.log(`  ...還有 ${rs.length - 50} 筆`);
  }

  // 重點列表：BUY default(entry_soft) + SELL default(exit_strong) 兩條
  const buyDefault = rows.filter(r => (r.type === 'BUY' || r.type === 'ADD') && r.defaulted);
  const sellDefault = rows.filter(r => (r.type === 'SELL' || r.type === 'REDUCE') && r.defaulted);

  console.log(`\n\n=== 高風險：BUY/ADD 走 default 變成 entry_soft（應該是書本硬進場？）: ${buyDefault.length} ===`);
  for (const r of buyDefault) console.log(`  ${r.file.padEnd(28)} ${r.ruleId.padEnd(40)} ${r.label}`);

  console.log(`\n=== 高風險：SELL/REDUCE 走 default 變成 exit_strong（軟出場被升級成硬出場？）: ${sellDefault.length} ===`);
  for (const r of sellDefault) console.log(`  ${r.file.padEnd(28)} ${r.ruleId.padEnd(40)} ${r.label}`);
}

// 是否走 default 路徑：ruleId 不在 lookup table 且沒匹配任何 legacy pattern
function isDefaultPath(sig: RuleSignal, subtype: string): boolean {
  // ruleId 已在主表（含 type:ruleId 複合鍵） → 不是 default
  if (RULE_ID_TO_SUBTYPE[`${sig.type}:${sig.ruleId}`]) return false;
  if (RULE_ID_TO_SUBTYPE[sig.ruleId]) return false;

  const haystack = `${sig.label} ${sig.description} ${sig.ruleId}`;
  if (sig.type === 'BUY' || sig.type === 'ADD') {
    if (subtype !== 'entry_soft') return false;
    const softExplicit = ['可能買點', '觀察買點', '葛蘭碧④反彈', 'granville-buy-4'];
    return !softExplicit.some(p => haystack.includes(p));
  }
  if (sig.type === 'SELL' || sig.type === 'REDUCE') {
    if (subtype !== 'exit_strong') return false;
    const strongExplicit = [
      '破MA5', '破月線', '跌破前低', '跌破頸線', '長黑吞噬', '長黑K',
      '跌破支撐', '布林壓縮跌破', 'ma5-exit', 'sell-break-', 'granville-sell-5',
      'granville-sell-6', 'granville-sell-7',
    ];
    return !strongExplicit.some(p => haystack.includes(p));
  }
  return false;
}

main().catch(e => { console.error(e); process.exit(1); });
