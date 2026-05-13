/**
 * 用當前 cn_stocklist.json 重生 verify report（不需 download）。
 * 用於 prune-cn-delisted 後立刻看新 coverageRate。
 */
import { promises as fs } from 'fs';
import path from 'path';
import { verifyDownload } from '../lib/datasource/DownloadVerifier';
import { getLastTradingDay } from '../lib/datasource/marketHours';

async function main() {
  const market = 'CN' as const;
  const lastTrading = getLastTradingDay(market);
  const stocklistPath = path.join('data', 'cn_stocklist.json');
  const data = JSON.parse(await fs.readFile(stocklistPath, 'utf-8')) as {
    stocks: { symbol: string }[];
  };
  const symbols = data.stocks.map(s => s.symbol);
  console.log(`==> 重生 ${market} ${lastTrading} verify report`);
  console.log(`    cn_stocklist.json: ${symbols.length} 支`);

  // 不傳實際 download 統計（succeeded/failed/skipped 全 0），verify 仍會掃 L1 算 coverage / gap / stale
  const report = await verifyDownload(market, lastTrading, symbols, {
    succeeded: 0,
    failed: 0,
    skipped: symbols.length,
  });

  console.log('\n=== 新 verify 報告 ===');
  console.log(JSON.stringify(report.summary, null, 2));
  console.log(`\nhealth: ${report.health}`);
  console.log(`coverageRate: ${(report.summary.coverageRate * 100).toFixed(2)}%`);
  console.log(`failedSymbols: ${report.failedSymbols.length}`);
  console.log(`permanentStale: ${report.summary.stocksPermanentStale}`);
}

main().catch(e => { console.error(e); process.exit(1); });
