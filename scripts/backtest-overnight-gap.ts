/**
 * Overnight Gap 策略回測
 *
 * 用戶構想：
 *   - 進場：每日 15:00 前掃描，選 TW long-daily 無 MTF 總分第一名
 *   - 買入：掃描當日收盤價買入
 *   - 出場：隔日開盤後，若高點觸及 +5% → 停利；若低點觸及 -2% → 停損
 *           若兩者都未觸及 → 隔日收盤價出場
 *
 * Usage:
 *   NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/backtest-overnight-gap.ts
 */
import fs from 'fs';
import path from 'path';
import { computeIndicators }     from '@/lib/indicators';
import { evaluateSixConditions } from '@/lib/analysis/trendAnalysis';
import { checkLongProhibitions } from '@/lib/rules/entryProhibitions';
import { evaluateElimination } from '@/lib/scanner/eliminationFilter';
import { evaluateHighWinRateEntry } from '@/lib/analysis/highWinRateEntry';
import { ZHU_OPTIMIZED } from '@/lib/strategy/StrategyConfig';
import type { CandleWithIndicators } from '@/types';

const CONFIG = {
  market: 'TW' as 'TW' | 'CN',
  period: { start: '2026-01-01', end: '2026-04-17' },
  capital: 1_000_000,
  topN: 500,
  mtfMin: 0,          // 用戶要求：不開 MTF
  tpPct: 5,           // 停利 +5%
  slPct: -3,          // 停損 -3%
  applyProhibitions: true,   // 10 大戒律（生產面板有）
  applyElimination: true,    // 淘汰法 R1-R11（生產面板有）
};

const SLIPPAGE_PCT = 0.003;
const TW_COST_PCT  = (0.001425 * 0.6 * 2 + 0.003) * 100;
const CN_COST_PCT  = 0.16;

interface StockData { name: string; candles: CandleWithIndicators[] }
interface Trade {
  no: number; entryDate: string; exitDate: string;
  symbol: string; name: string;
  entryPrice: number; exitPrice: number;
  netPct: number; pnl: number; capitalAfter: number;
  exitReason: string;
}

function buildNameMap(market: 'TW' | 'CN'): Map<string, string> {
  const names = new Map<string, string>();

  // TW：從最新「有中文名」的 L2 快照讀（某些 L2 檔 name 欄位被洗成空）
  if (market === 'TW') {
    const files = fs.readdirSync(path.join(process.cwd(), 'data'))
      .filter(f => f.startsWith('intraday-TW-') && f.endsWith('.json') && !f.includes('BAD') && !f.includes('ma-base'))
      .sort()
      .reverse();
    for (const f of files) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', f), 'utf-8'));
        const withName = (raw.quotes ?? []).filter((q: { name?: string }) => q.name && q.name.length > 0);
        if (withName.length < 100) continue; // 此檔 name 被洗空，跳過
        for (const q of raw.quotes) {
          if (q.symbol && q.name) {
            names.set(`${q.symbol}.TW`, q.name);
            names.set(`${q.symbol}.TWO`, q.name);
          }
        }
        break; // 找到一份有效的就停
      } catch { /* skip */ }
    }
  }

  // CN：從 cn_stocklist.json
  if (market === 'CN') {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'cn_stocklist.json'), 'utf-8'));
      for (const s of raw.stocks ?? []) {
        if (s.symbol && s.name) names.set(s.symbol, s.name);
      }
    } catch { /* skip */ }
  }

  return names;
}

function loadStocks(market: 'TW' | 'CN'): Map<string, StockData> {
  const stocks = new Map<string, StockData>();
  const dir = path.join(process.cwd(), 'data', 'candles', market);
  if (!fs.existsSync(dir)) return stocks;
  const nameMap = buildNameMap(market);
  process.stdout.write(`  讀取${market} K線...`);
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      const c: CandleWithIndicators[] = Array.isArray(raw) ? raw : raw.candles ?? raw;
      if (!c || c.length < 60) continue;
      const symbol = f.replace('.json', '');
      stocks.set(symbol, {
        name: nameMap.get(symbol) ?? (raw as { name?: string }).name ?? symbol,
        candles: computeIndicators(c),
      });
    } catch { /* skip */ }
  }
  console.log(` ${stocks.size} 支 (中文名 ${Array.from(stocks.values()).filter(s => s.name !== s.candles[0]?.date).length}/${stocks.size})`);
  return stocks;
}

function buildTopNSet(
  allStocks: Map<string, StockData>, date: string, topN: number,
): Set<string> {
  const list: { symbol: string; avg: number }[] = [];
  for (const [symbol, sd] of allStocks) {
    const idx = sd.candles.findIndex(c => c.date?.slice(0, 10) === date);
    if (idx < 1) continue;
    let total = 0, cnt = 0;
    for (let i = Math.max(0, idx - 20); i < idx; i++) {
      total += sd.candles[i].volume * sd.candles[i].close;
      cnt++;
    }
    list.push({ symbol, avg: cnt > 0 ? total / cnt : 0 });
  }
  list.sort((a, b) => b.avg - a.avg);
  return new Set(list.slice(0, topN).map(d => d.symbol));
}

function main(): void {
  console.log('\n  載入資料...');
  const allStocks = loadStocks(CONFIG.market);

  const tradingDaySet = new Set<string>();
  for (const [, sd] of allStocks) {
    for (const c of sd.candles) {
      const d = c.date?.slice(0, 10);
      if (d && d >= CONFIG.period.start && d <= CONFIG.period.end) tradingDaySet.add(d);
    }
  }
  const tradingDays = [...tradingDaySet].sort();
  console.log(`  交易日：${tradingDays[0]} ～ ${tradingDays.at(-1)} 共 ${tradingDays.length} 天`);

  const costPct = CONFIG.market === 'TW' ? TW_COST_PCT : CN_COST_PCT;
  const trades: Trade[] = [];
  let capital = CONFIG.capital;

  console.log('  跑回測...');
  for (const date of tradingDays) {
    const topNSet = buildTopNSet(allStocks, date, CONFIG.topN);

    interface Cand {
      symbol: string; name: string; idx: number;
      candles: CandleWithIndicators[];
      totalScore: number; changePercent: number;
      highWinRateScore: number;
    }
    const cands: Cand[] = [];

    for (const [symbol, sd] of allStocks) {
      if (!topNSet.has(symbol)) continue;
      const idx = sd.candles.findIndex(c => c.date?.slice(0, 10) === date);
      if (idx < 60 || idx + 1 >= sd.candles.length) continue;

      // 對齊生產：量比 1.5（ZHU_OPTIMIZED），不是書本 1.3
      const six = evaluateSixConditions(sd.candles, idx, ZHU_OPTIMIZED.thresholds);
      if (!six.isCoreReady || six.totalScore < 5) continue;

      // ── 對齊生產：10 大戒律 + 淘汰法 ───────────────────────────
      if (CONFIG.applyProhibitions) {
        const prohib = checkLongProhibitions(sd.candles, idx);
        if (prohib.prohibited) continue;
      }
      if (CONFIG.applyElimination) {
        const elim = evaluateElimination(sd.candles, idx);
        if (elim.eliminated) continue;
      }

      const c    = sd.candles[idx];
      const prev = sd.candles[idx - 1];
      const changePercent = prev.close > 0 ? (c.close - prev.close) / prev.close * 100 : 0;

      // 次要排序因子：高勝率（對齊 applyPanelFilter）
      let highWinRateScore = 0;
      try { highWinRateScore = evaluateHighWinRateEntry(sd.candles, idx).score; } catch { /* skip */ }

      cands.push({
        symbol, name: sd.name, idx, candles: sd.candles,
        totalScore: six.totalScore, changePercent,
        highWinRateScore,
      });
    }
    if (cands.length === 0) continue;

    // 對齊 lib/selection/applyPanelFilter.ts：六條件總分 desc，同分以高勝率次要
    cands.sort((a, b) => {
      const d = b.totalScore - a.totalScore;
      if (d !== 0) return d;
      return b.highWinRateScore - a.highWinRateScore;
    });
    const picked = cands[0];

    // 路徑 B：T 日收盤後選股（已用完整 K 棒算），T+1 開盤進場，T+1 盤中/收盤出場
    const scanC  = picked.candles[picked.idx];     // T 日（掃描日）
    const entryC = picked.candles[picked.idx + 1]; // T+1 日（進場日＝出場日）
    if (!entryC) continue;

    // T+1 開盤價買入 + 0.3% 滑價
    const entryPrice = +(entryC.open * (1 + SLIPPAGE_PCT)).toFixed(2);
    const prevClose  = scanC.close; // T 日收盤，用來判斷 T+1 是否跳空
    const tpPrice    = entryPrice * (1 + CONFIG.tpPct / 100);
    const slPrice    = entryPrice * (1 + CONFIG.slPct / 100);

    let exitPrice: number;
    let exitReason: string;

    const hitTP = entryC.high >= tpPrice;
    const hitSL = entryC.low  <= slPrice;

    if (hitTP && hitSL) {
      // 同日同時觸及：依 T+1 開盤相對 T 收盤跳空方向推論
      //   跳空開高 → 先上衝 → 先觸停利
      //   跳空開低或平盤 → 先下探 → 先觸停損（悲觀）
      if (entryC.open > prevClose) {
        exitPrice  = tpPrice;
        exitReason = `盤中+${CONFIG.tpPct}%停利（同日觸發，開高推論）`;
      } else {
        exitPrice  = slPrice;
        exitReason = `盤中${CONFIG.slPct}%停損（同日觸發，開低推論）`;
      }
    } else if (hitTP) {
      exitPrice  = tpPrice;
      exitReason = `盤中+${CONFIG.tpPct}%停利`;
    } else if (hitSL) {
      exitPrice  = slPrice;
      exitReason = `盤中${CONFIG.slPct}%停損`;
    } else {
      exitPrice  = entryC.close;
      exitReason = '收盤未觸及';
    }

    const grossPct = (exitPrice - entryPrice) / entryPrice * 100;
    const netPct   = grossPct - costPct;
    const pnl      = capital * netPct / 100;
    capital = Math.max(0, capital + pnl);

    const entryDate = entryC.date?.slice(0, 10) ?? '';
    trades.push({
      no: trades.length + 1,
      entryDate,
      exitDate: entryDate, // 當日沖，進出場同一天
      symbol: picked.symbol, name: picked.name,
      entryPrice, exitPrice: +exitPrice.toFixed(2),
      netPct: +netPct.toFixed(3),
      pnl: +pnl.toFixed(0),
      capitalAfter: +capital.toFixed(0),
      exitReason,
    });
  }

  // 報告
  console.log('\n' + '═'.repeat(72));
  console.log(`  Overnight Gap 回測：${CONFIG.market} long #1 no-MTF`);
  console.log('═'.repeat(72));
  console.log(`  週期        ${CONFIG.period.start} ～ ${CONFIG.period.end}`);
  console.log(`  選股        T 日 13:30 收盤後算六條件 (戒律=${CONFIG.applyProhibitions ? '開' : '關'}, 淘汰法=${CONFIG.applyElimination ? '開' : '關'})`);
  console.log(`  進場        T+1 開盤價 + ${(SLIPPAGE_PCT*100).toFixed(1)}% 滑價`);
  console.log(`  出場        T+1 盤中 +${CONFIG.tpPct}% 停利 / ${CONFIG.slPct}% 停損 / 收盤`);
  console.log(`  初始資金    ${CONFIG.capital.toLocaleString()} 元`);
  console.log('═'.repeat(72));

  if (trades.length === 0) {
    console.log('  ⚠ 無交易');
    return;
  }

  const final = trades.at(-1)!.capitalAfter;
  const totalRet = (final - CONFIG.capital) / CONFIG.capital * 100;
  const wins = trades.filter(t => t.netPct > 0);
  const losses = trades.filter(t => t.netPct <= 0);
  const winRate = wins.length / trades.length * 100;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.netPct, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.netPct, 0) / losses.length : 0;

  let peak = CONFIG.capital, maxDD = 0, cap = CONFIG.capital;
  for (const t of trades) {
    cap = t.capitalAfter;
    if (cap > peak) peak = cap;
    const dd = (peak - cap) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }

  console.log(`  總報酬      ${totalRet >= 0 ? '+' : ''}${totalRet.toFixed(1)}%`);
  console.log(`  最終資金    ${final.toLocaleString()} 元`);
  console.log(`  交易筆數    ${trades.length}`);
  console.log(`  勝率        ${winRate.toFixed(1)}% (${wins.length}勝/${losses.length}負)`);
  console.log(`  平均獲利    +${avgWin.toFixed(2)}%`);
  console.log(`  平均虧損    ${avgLoss.toFixed(2)}%`);
  console.log(`  最大回撤    ${maxDD.toFixed(1)}%`);

  const reasons = new Map<string, number>();
  for (const t of trades) reasons.set(t.exitReason, (reasons.get(t.exitReason) ?? 0) + 1);
  console.log('\n  出場原因');
  console.log('─'.repeat(72));
  for (const [r, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${r.padEnd(24)} ${n.toString().padStart(4)} 筆  ${(n / trades.length * 100).toFixed(0)}%`);
  }

  console.log('\n  逐筆交易');
  console.log('─'.repeat(100));
  console.log(
    '  #   進場日        出場日        代號     名稱         進場    出場    報酬%     損益         累計資金      原因'
  );
  for (const t of trades) {
    const ret = (t.netPct >= 0 ? '+' : '') + t.netPct.toFixed(2) + '%';
    const pnl = (t.pnl >= 0 ? '+' : '') + t.pnl.toLocaleString();
    console.log(
      `  ${t.no.toString().padStart(3)} ` +
      `${t.entryDate.padEnd(13)}${t.exitDate.padEnd(13)}` +
      `${t.symbol.padEnd(9)}${t.name.slice(0, 10).padEnd(13)}` +
      `${t.entryPrice.toFixed(2).padStart(6)}  ${t.exitPrice.toFixed(2).padStart(6)}  ` +
      `${ret.padStart(8)} ${pnl.padStart(12)}  ${t.capitalAfter.toLocaleString().padStart(12)}   ${t.exitReason}`
    );
  }
  console.log('═'.repeat(100));

  // 匯出 CSV
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const csvRows = [
    ['編號', '進場日', '出場日', '股票代號', '股票名稱', '進場價', '出場價', '淨報酬%', '損益(元)', '累計資金(元)', '出場原因'].join(','),
    ...trades.map(t => [
      t.no, t.entryDate, t.exitDate, t.symbol, `"${t.name}"`,
      t.entryPrice, t.exitPrice, t.netPct, t.pnl, t.capitalAfter, `"${t.exitReason}"`,
    ].join(',')),
  ];
  // 加 BOM 讓 Excel 正確顯示中文
  fs.writeFileSync(
    path.join(process.cwd(), `backtest-overnight-gap-${CONFIG.period.start}_${CONFIG.period.end}.csv`),
    '\uFEFF' + csvRows.join('\n'),
  );
  const csvPath = path.join(process.cwd(), `backtest-overnight-gap-${CONFIG.period.start}_${CONFIG.period.end}.csv`);
  console.log(`\n  CSV 已輸出：${csvPath}`);
}

main();
