/**
 * 把 16 支已退市/合併的 CN 股從 cn_stocklist.json 移除，並把 L1 檔案歸檔。
 *
 * 已查證來源：scripts/verify-cn-stale.ts 比對 Yahoo + EastMoney
 *   - Yahoo 全 DELISTED
 *   - EastMoney 還有名稱但無報價（11 支名稱有「退」字、5 支合併/重組）
 */
import { promises as fs } from 'fs';
import path from 'path';

const DELISTED = [
  { sym: '000584.SZ', name: '工智退' },
  { sym: '000622.SZ', name: '恒立退' },
  { sym: '000861.SZ', name: '海印股份' },
  { sym: '000982.SZ', name: '中银绒业' },
  { sym: '000996.SZ', name: '中期退' },
  { sym: '002087.SZ', name: '新纺退' },
  { sym: '002336.SZ', name: '人乐退' },
  { sym: '002433.SZ', name: '太安退' },
  { sym: '002505.SZ', name: '鹏都农牧' },
  { sym: '002750.SZ', name: '龙津退' },
  { sym: '600297.SS', name: '广汇汽车' },
  { sym: '600321.SS', name: '正源股份' },
  { sym: '600705.SS', name: '中航产融' },
  { sym: '600837.SS', name: '海通证券（→ 国泰海通）' },
  { sym: '601028.SS', name: '玉龙股份' },
  { sym: '601989.SS', name: '中国重工（→ 中国船舶）' },
];

const ARCHIVE_DIR = path.join('data', 'ARCHIVE-delisted', 'CN');
const STOCKLIST = path.join('data', 'cn_stocklist.json');
const CANDLE_DIR = path.join('data', 'candles', 'CN');

async function main() {
  // ── Step 1：歸檔 L1 檔案 ────────────────────────────────────
  await fs.mkdir(ARCHIVE_DIR, { recursive: true });
  let archived = 0;
  for (const { sym } of DELISTED) {
    const src = path.join(CANDLE_DIR, `${sym}.json`);
    const dst = path.join(ARCHIVE_DIR, `${sym}.json`);
    try {
      await fs.rename(src, dst);
      archived++;
      console.log(`  📦 archived: ${sym}`);
    } catch (e) {
      console.warn(`  ⚠️ ${sym} 歸檔失敗:`, e instanceof Error ? e.message : e);
    }
  }
  console.log(`\n✅ 歸檔 ${archived}/${DELISTED.length} 個 L1 檔案到 ${ARCHIVE_DIR}\n`);

  // ── Step 2：從 cn_stocklist.json 移除 ─────────────────────
  const raw = await fs.readFile(STOCKLIST, 'utf-8');
  const data = JSON.parse(raw) as { updatedAt: string; stocks: { symbol: string; name?: string; industry?: string }[] };
  const before = data.stocks.length;
  const delistedSet = new Set(DELISTED.map(d => d.sym));
  data.stocks = data.stocks.filter(s => !delistedSet.has(s.symbol));
  data.updatedAt = new Date().toISOString();
  const after = data.stocks.length;
  await fs.writeFile(STOCKLIST, JSON.stringify(data, null, 2));
  console.log(`✅ cn_stocklist.json: ${before} → ${after}（剔除 ${before - after}）`);

  // ── Step 3：附加歸檔說明 ──────────────────────────────────
  const noteFile = path.join(ARCHIVE_DIR, 'README.md');
  const note = `# CN 退市/合併歸檔（${new Date().toISOString().slice(0, 10)}）

來源：scripts/verify-cn-stale.ts 雙源驗證（Yahoo + EastMoney）

| 代號 | 名稱 |
|---|---|
${DELISTED.map(d => `| ${d.sym} | ${d.name} |`).join('\n')}

歸檔原因：Yahoo API 已 DELISTED + EastMoney 已無報價。
未來若有任一支復牌交易，把對應 .json 移回 \`data/candles/CN/\` 並加回 \`cn_stocklist.json\`。
`;
  await fs.writeFile(noteFile, note);
  console.log(`📝 ${noteFile} 寫入歸檔說明\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
