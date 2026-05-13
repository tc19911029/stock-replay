/**
 * 從 verify-cn-problem-stocks-report.json 自動 prune CN 退市股
 *
 * 流程：
 *   1. 讀 verify report 取 verdict='delisted' 清單
 *   2. 把 L1 檔案歸檔到 data/ARCHIVE-delisted/CN/
 *   3. 從 cn_stocklist.json 移除
 *   4. 寫歸檔說明 README.md
 *
 * 用法：
 *   npx tsx scripts/recheck-cn-tencent.ts          # 先驗證
 *   npx tsx scripts/prune-cn-delisted-from-report.ts   # 再清理
 */
import { promises as fs } from 'fs';
import path from 'path';

const REPORT_FILE = path.join('scripts', 'verify-cn-problem-stocks-report.json');
const ARCHIVE_DIR = path.join('data', 'ARCHIVE-delisted', 'CN');
const STOCKLIST = path.join('data', 'cn_stocklist.json');
const CANDLE_DIR = path.join('data', 'candles', 'CN');

interface CheckResult {
  symbol: string;
  yahoo: { status: string; lastDate?: string };
  em?: { status: string; name?: string };
  tencent?: { status: string; name?: string; price?: number; volume?: number };
  verdict: string;
  reason: string;
}

async function main() {
  console.log('==> 讀驗證報告 + 抓 delisted 清單');
  const reportRaw = await fs.readFile(REPORT_FILE, 'utf-8');
  const report = JSON.parse(reportRaw) as { results: CheckResult[]; counts: Record<string, number> };
  const delisted = report.results.filter(r => r.verdict === 'delisted');
  console.log(`找到 ${delisted.length} 支 delisted（總 ${report.results.length} 支問題股）`);

  if (delisted.length === 0) {
    console.log('沒有 delisted 股票，結束');
    return;
  }

  // ── Step 1：歸檔 L1 ─────────────────────────────────────────
  await fs.mkdir(ARCHIVE_DIR, { recursive: true });
  let archived = 0, skipped = 0;
  for (const r of delisted) {
    const src = path.join(CANDLE_DIR, `${r.symbol}.json`);
    const dst = path.join(ARCHIVE_DIR, `${r.symbol}.json`);
    try {
      await fs.rename(src, dst);
      archived++;
    } catch (e: unknown) {
      const code = (e as { code?: string }).code;
      if (code === 'ENOENT') {
        skipped++; // 沒檔可歸檔，跳過
      } else {
        console.warn(`  ⚠️ ${r.symbol} 歸檔失敗:`, e instanceof Error ? e.message : e);
      }
    }
  }
  console.log(`✅ 歸檔 ${archived}/${delisted.length} 個 L1 檔案（${skipped} 個沒檔可移）`);

  // ── Step 2：從 cn_stocklist.json 移除 ────────────────────────
  const slRaw = await fs.readFile(STOCKLIST, 'utf-8');
  const slData = JSON.parse(slRaw) as { updatedAt: string; stocks: { symbol: string; name?: string; industry?: string }[] };
  const before = slData.stocks.length;
  const delistedSet = new Set(delisted.map(d => d.symbol));
  slData.stocks = slData.stocks.filter(s => !delistedSet.has(s.symbol));
  slData.updatedAt = new Date().toISOString();
  const after = slData.stocks.length;
  await fs.writeFile(STOCKLIST, JSON.stringify(slData, null, 2));
  console.log(`✅ cn_stocklist.json: ${before} → ${after}（剔除 ${before - after}）`);

  // ── Step 3：寫歸檔說明 ────────────────────────────────────
  const noteFile = path.join(ARCHIVE_DIR, `README-${new Date().toISOString().slice(0, 10)}.md`);
  const tableRows = delisted
    .map(r => {
      const name = r.tencent?.name ?? r.em?.name ?? '-';
      const yLast = r.yahoo.lastDate ?? r.yahoo.status;
      const tcVol = r.tencent?.volume ?? '-';
      return `| ${r.symbol} | ${name} | ${yLast} | ${tcVol} | ${r.reason.slice(0, 50)} |`;
    })
    .join('\n');
  const note = `# CN 退市/合併歸檔（${new Date().toISOString().slice(0, 10)}）

來源：\`scripts/recheck-cn-tencent.ts\` 雙源驗證（Yahoo + Tencent）
總計：${delisted.length} 支

| 代號 | 名稱 | Yahoo 最後 | TC 量 | 判讀理由 |
|---|---|---|---|---|
${tableRows}

歸檔原因：兩源都標 inactive（Yahoo 404/NO_DATA + Tencent volume=0 或名稱含「退」）。

未來若有任一支復牌：把對應 .json 移回 \`data/candles/CN/\`，加回 \`cn_stocklist.json\`。
`;
  await fs.writeFile(noteFile, note);
  console.log(`📝 ${noteFile} 寫入`);

  console.log('\n==> 完成。下一步：');
  console.log('  1. 重啟 dev / 等下次 cron → 重新驗證 health');
  console.log('  2. curl /api/cron/daily-health-snapshot 看新覆蓋率');
}

main().catch(e => { console.error(e); process.exit(1); });
