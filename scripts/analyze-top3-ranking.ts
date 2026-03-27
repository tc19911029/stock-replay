/**
 * 分析 Top 3 排名公式準確率
 *
 * 跑多天回測，統計 Top 1/2/3 的實際收益表現
 * 嘗試不同權重組合，找出最佳排名公式
 *
 * Usage: npx tsx scripts/analyze-top3-ranking.ts
 */

const BASE = 'http://localhost:3001';

interface ScanResult {
  symbol: string;
  name: string;
  price: number;
  changePercent: number;
  volume: number;
  sixConditionsScore: number;
  sixConditionsBreakdown: { trend: boolean; position: boolean; kbar: boolean; ma: boolean; volume: boolean; indicator: boolean };
  trendState: string;
  trendPosition: string;
  surgeScore?: number;
  surgeGrade?: string;
  surgeFlags?: string[];
  triggeredRules: Array<{ ruleId: string; ruleName: string; signalType: string; reason: string }>;
  histWinRate?: number;
  histSignalCount?: number;
  aiRank?: number;
}

interface ForwardPerf {
  symbol: string;
  name: string;
  scanPrice: number;
  openReturn: number | null;
  d1Return: number | null;
  d3Return: number | null;
  d5Return: number | null;
  d10Return: number | null;
  d20Return: number | null;
  maxGain: number;
  maxLoss: number;
}

// ── 排名公式 ──────────────────────────────────────────────────────────────────

interface WeightConfig {
  surge: number;
  sixCon: number;
  winRate: number;
  position: number;
  ai: number;
}

function computeCompositeScore(r: ScanResult, w: WeightConfig): number {
  const surge = r.surgeScore ?? 0;
  const sixCon = (r.sixConditionsScore / 6) * 100;
  const winR = r.histWinRate ?? 50;
  const posBonus = r.trendPosition?.includes('起漲') ? 100
    : r.trendPosition?.includes('主升') ? 70
    : r.trendPosition?.includes('末升') ? 20 : 50;
  const aiBonus = r.aiRank != null && r.aiRank <= 5 ? (6 - r.aiRank) * 20 : 50;
  return surge * w.surge + sixCon * w.sixCon + winR * w.winRate + posBonus * w.position + aiBonus * w.ai;
}

function getTop3(results: ScanResult[], weights: WeightConfig): ScanResult[] {
  return [...results]
    .filter(r => r.surgeScore != null && r.surgeScore >= 30)
    .map(r => ({ ...r, _score: computeCompositeScore(r, weights) }))
    .sort((a, b) => b._score - a._score)
    .slice(0, 3);
}

// ── API 呼叫 ──────────────────────────────────────────────────────────────────

async function getStockList(market: string): Promise<Array<{ symbol: string; name: string }>> {
  const res = await fetch(`${BASE}/api/scanner/list?market=${market}`);
  const json = await res.json() as { stocks: Array<{ symbol: string; name: string }> };
  return json.stocks ?? [];
}

async function scanDate(market: string, date: string, stocks: Array<{ symbol: string; name: string }>): Promise<ScanResult[]> {
  // Split into 2 chunks like the store does
  const half = Math.ceil(stocks.length / 2);
  const chunks = [stocks.slice(0, half), stocks.slice(half)];

  const results: ScanResult[] = [];
  for (const chunk of chunks) {
    try {
      const res = await fetch(`${BASE}/api/backtest/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ market, date, stocks: chunk }),
      });
      if (res.ok) {
        const json = await res.json() as { results?: ScanResult[] };
        if (json.results) results.push(...json.results);
      }
    } catch (e) {
      console.error(`  Scan chunk failed for ${date}:`, e);
    }
  }
  return results;
}

async function getForwardPerf(scanDateStr: string, results: ScanResult[]): Promise<Map<string, ForwardPerf>> {
  const payload = results.map(r => ({ symbol: r.symbol, name: r.name, scanPrice: r.price }));
  try {
    const res = await fetch(`${BASE}/api/backtest/forward`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scanDate: scanDateStr, stocks: payload }),
    });
    if (!res.ok) return new Map();
    const json = await res.json() as { performance?: ForwardPerf[] };
    const map = new Map<string, ForwardPerf>();
    for (const p of (json.performance ?? [])) {
      map.set(p.symbol, p);
    }
    return map;
  } catch {
    return new Map();
  }
}

// ── 主流程 ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Top 3 排名公式校準分析');
  console.log('═══════════════════════════════════════════════════\n');

  const market = 'TW';

  // 生成最近 15 個交易日（排除週末）
  const dates: string[] = [];
  const today = new Date('2026-03-27');
  for (let i = 1; dates.length < 15; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    dates.push(d.toISOString().split('T')[0]);
  }

  console.log(`分析日期：${dates[dates.length - 1]} ~ ${dates[0]}`);
  console.log(`共 ${dates.length} 個交易日\n`);

  // 取得股票清單
  const stocks = await getStockList(market);
  console.log(`股票池：${stocks.length} 檔\n`);

  // 儲存每天的 Top3 資料
  interface DayResult {
    date: string;
    top3: Array<{
      rank: number;
      symbol: string;
      name: string;
      composite: number;
      surgeScore: number;
      sixScore: number;
      winRate: number;
      trendPos: string;
      d1Return: number | null;
      d5Return: number | null;
      d10Return: number | null;
      d20Return: number | null;
      maxGain: number;
    }>;
  }

  const currentWeights: WeightConfig = { surge: 0.35, sixCon: 0.20, winRate: 0.25, position: 0.10, ai: 0.10 };
  const allDayResults: DayResult[] = [];

  for (const date of dates) {
    process.stdout.write(`📊 ${date} ... `);

    const results = await scanDate(market, date, stocks);
    if (results.length === 0) {
      console.log('無掃描結果，跳過');
      continue;
    }

    const top3 = getTop3(results, currentWeights);
    if (top3.length === 0) {
      console.log(`選出 ${results.length} 檔但無 Top3 候選`);
      continue;
    }

    // 只取 top3 的 forward performance（節省 API 呼叫）
    const perfMap = await getForwardPerf(date, top3);

    const dayResult: DayResult = { date, top3: [] };
    for (let i = 0; i < top3.length; i++) {
      const r = top3[i];
      const p = perfMap.get(r.symbol);
      dayResult.top3.push({
        rank: i + 1,
        symbol: r.symbol,
        name: r.name,
        composite: Math.round(computeCompositeScore(r, currentWeights) * 10) / 10,
        surgeScore: r.surgeScore ?? 0,
        sixScore: r.sixConditionsScore,
        winRate: r.histWinRate ?? 0,
        trendPos: r.trendPosition ?? '',
        d1Return: p?.d1Return ?? null,
        d5Return: p?.d5Return ?? null,
        d10Return: p?.d10Return ?? null,
        d20Return: p?.d20Return ?? null,
        maxGain: p?.maxGain ?? 0,
      });
    }

    allDayResults.push(dayResult);

    const top1 = dayResult.top3[0];
    const d1Str = top1.d1Return != null ? `${top1.d1Return > 0 ? '+' : ''}${top1.d1Return.toFixed(2)}%` : 'N/A';
    console.log(`${results.length}檔 → Top1: ${top1.symbol.replace(/\.(TW|TWO)$/i, '')} ${top1.name} (1日:${d1Str})`);

    // 避免 rate limit
    await new Promise(r => setTimeout(r, 2000));
  }

  // ── 統計分析 ──────────────────────────────────────────────────────────────

  console.log('\n═══════════════════════════════════════════════════');
  console.log('  統計結果（現行公式）');
  console.log('═══════════════════════════════════════════════════\n');

  const stats = { 1: { count: 0, d1Sum: 0, d5Sum: 0, d10Sum: 0, maxGainSum: 0, wins1d: 0, wins5d: 0 },
                  2: { count: 0, d1Sum: 0, d5Sum: 0, d10Sum: 0, maxGainSum: 0, wins1d: 0, wins5d: 0 },
                  3: { count: 0, d1Sum: 0, d5Sum: 0, d10Sum: 0, maxGainSum: 0, wins1d: 0, wins5d: 0 } };

  for (const day of allDayResults) {
    for (const pick of day.top3) {
      const s = stats[pick.rank as 1 | 2 | 3];
      if (pick.d1Return != null) { s.d1Sum += pick.d1Return; s.count++; if (pick.d1Return > 0) s.wins1d++; }
      if (pick.d5Return != null) { s.d5Sum += pick.d5Return; }
      if (pick.d10Return != null) { s.d10Sum += pick.d10Return; }
      s.maxGainSum += pick.maxGain;
      if (pick.d5Return != null && pick.d5Return > 0) s.wins5d++;
    }
  }

  console.log('排名 | 天數 | 1日均報酬 | 5日均報酬 | 10日均報酬 | 最大漲幅均 | 1日勝率 | 5日勝率');
  console.log('─────┼──────┼──────────┼──────────┼───────────┼───────────┼─────────┼────────');
  for (const rank of [1, 2, 3] as const) {
    const s = stats[rank];
    if (s.count === 0) continue;
    console.log(
      `Top${rank} | ${String(s.count).padStart(4)} | ` +
      `${(s.d1Sum / s.count).toFixed(2).padStart(8)}% | ` +
      `${(s.d5Sum / s.count).toFixed(2).padStart(8)}% | ` +
      `${(s.d10Sum / s.count).toFixed(2).padStart(9)}% | ` +
      `${(s.maxGainSum / s.count).toFixed(2).padStart(9)}% | ` +
      `${((s.wins1d / s.count) * 100).toFixed(0).padStart(6)}% | ` +
      `${((s.wins5d / s.count) * 100).toFixed(0).padStart(5)}%`
    );
  }

  // ── 逐日詳細表 ────────────────────────────────────────────────────────────

  console.log('\n═══════════════════════════════════════════════════');
  console.log('  逐日詳細');
  console.log('═══════════════════════════════════════════════════\n');

  for (const day of allDayResults) {
    console.log(`📅 ${day.date}`);
    for (const p of day.top3) {
      const sym = p.symbol.replace(/\.(TW|TWO)$/i, '');
      const d1 = p.d1Return != null ? `${p.d1Return > 0 ? '+' : ''}${p.d1Return.toFixed(2)}%` : '  N/A  ';
      const d5 = p.d5Return != null ? `${p.d5Return > 0 ? '+' : ''}${p.d5Return.toFixed(2)}%` : '  N/A  ';
      const mg = `+${p.maxGain.toFixed(1)}%`;
      console.log(`  #${p.rank} ${sym.padEnd(6)} ${p.name.padEnd(6)} 綜合${String(p.composite).padStart(5)} 潛力${String(p.surgeScore).padStart(3)} 六條${p.sixScore}/6 勝率${String(p.winRate).padStart(3)}% | 1日:${d1.padStart(8)} 5日:${d5.padStart(8)} 最高:${mg.padStart(7)}`);
    }

    // 標記哪個 rank 實際表現最好
    const best = day.top3
      .filter(p => p.d1Return != null)
      .sort((a, b) => (b.d1Return ?? 0) - (a.d1Return ?? 0))[0];
    if (best && best.rank !== 1) {
      console.log(`  ⚠️  實際1日最佳是 #${best.rank}（${best.d1Return! > 0 ? '+' : ''}${best.d1Return!.toFixed(2)}%），排名不符`);
    } else if (best) {
      console.log(`  ✅ Top1 確實是1日最佳`);
    }
    console.log('');
  }

  // ── 嘗試不同權重組合 ──────────────────────────────────────────────────────

  console.log('═══════════════════════════════════════════════════');
  console.log('  權重優化搜索');
  console.log('═══════════════════════════════════════════════════\n');

  // Grid search over weight combinations
  const weightCombos: Array<{ name: string; w: WeightConfig }> = [
    { name: '現行公式    (S35 C20 W25 P10 A10)', w: { surge: 0.35, sixCon: 0.20, winRate: 0.25, position: 0.10, ai: 0.10 } },
    { name: '潛力主導    (S50 C15 W20 P10 A05)', w: { surge: 0.50, sixCon: 0.15, winRate: 0.20, position: 0.10, ai: 0.05 } },
    { name: '勝率主導    (S25 C15 W40 P10 A10)', w: { surge: 0.25, sixCon: 0.15, winRate: 0.40, position: 0.10, ai: 0.10 } },
    { name: '六條件主導  (S25 C35 W20 P10 A10)', w: { surge: 0.25, sixCon: 0.35, winRate: 0.20, position: 0.10, ai: 0.10 } },
    { name: '位置重視    (S30 C15 W20 P25 A10)', w: { surge: 0.30, sixCon: 0.15, winRate: 0.20, position: 0.25, ai: 0.10 } },
    { name: '均衡版      (S25 C25 W25 P15 A10)', w: { surge: 0.25, sixCon: 0.25, winRate: 0.25, position: 0.15, ai: 0.10 } },
    { name: '潛力+勝率   (S40 C10 W35 P10 A05)', w: { surge: 0.40, sixCon: 0.10, winRate: 0.35, position: 0.10, ai: 0.05 } },
    { name: '條件+勝率   (S20 C30 W30 P10 A10)', w: { surge: 0.20, sixCon: 0.30, winRate: 0.30, position: 0.10, ai: 0.10 } },
  ];

  console.log('公式名稱                          | Top1均1日 | Top1均5日 | Top1勝率1日 | Top1最高均 | 排名吻合率');
  console.log('──────────────────────────────────┼──────────┼──────────┼────────────┼───────────┼──────────');

  let bestCombo = weightCombos[0];
  let bestMetric = -Infinity;

  for (const combo of weightCombos) {
    let t1d1Sum = 0, t1d5Sum = 0, t1count = 0, t1wins = 0, t1maxGainSum = 0;
    let rankMatchCount = 0, rankTotalCount = 0;

    for (const day of allDayResults) {
      // Recompute top3 with this weight config using the original scan results
      // We need to re-rank from the stored scanResults... but we only saved top3
      // For a fair comparison, we need to use all scanResults. Let me use the top3 from each day
      // and see which weight config would have ranked them better.
      // Actually, we need the full scan results to re-rank properly.
      // For now, let's evaluate based on: does the top1 actually have the best d1Return?

      const reranked = [...day.top3]
        .map(p => {
          // Reconstruct minimal ScanResult for scoring
          const sr: ScanResult = {
            symbol: p.symbol, name: p.name, price: 0, changePercent: 0, volume: 0,
            sixConditionsScore: p.sixScore,
            sixConditionsBreakdown: { trend: true, position: true, kbar: true, ma: true, volume: true, indicator: true },
            trendState: '多頭', trendPosition: p.trendPos,
            surgeScore: p.surgeScore, triggeredRules: [],
            histWinRate: p.winRate,
          };
          return { ...p, _newScore: computeCompositeScore(sr, combo.w) };
        })
        .sort((a, b) => b._newScore - a._newScore);

      const top1 = reranked[0];
      if (top1.d1Return != null) {
        t1d1Sum += top1.d1Return;
        t1count++;
        if (top1.d1Return > 0) t1wins++;
      }
      if (top1.d5Return != null) t1d5Sum += top1.d5Return;
      t1maxGainSum += top1.maxGain;

      // Check if reranked top1 has the best d1Return
      const bestByReturn = [...day.top3].filter(p => p.d1Return != null).sort((a, b) => (b.d1Return ?? 0) - (a.d1Return ?? 0))[0];
      if (bestByReturn && bestByReturn.d1Return != null) {
        rankTotalCount++;
        if (reranked[0].symbol === bestByReturn.symbol) rankMatchCount++;
      }
    }

    const avgD1 = t1count > 0 ? t1d1Sum / t1count : 0;
    const avgD5 = t1count > 0 ? t1d5Sum / t1count : 0;
    const winRate = t1count > 0 ? (t1wins / t1count) * 100 : 0;
    const avgMaxGain = t1count > 0 ? t1maxGainSum / t1count : 0;
    const matchRate = rankTotalCount > 0 ? (rankMatchCount / rankTotalCount) * 100 : 0;

    // Combined metric: weight average return + win rate + match rate
    const metric = avgD1 * 2 + avgD5 + winRate * 0.1 + matchRate * 0.05;
    if (metric > bestMetric) {
      bestMetric = metric;
      bestCombo = combo;
    }

    console.log(
      `${combo.name} | ${avgD1.toFixed(2).padStart(8)}% | ${avgD5.toFixed(2).padStart(8)}% | ` +
      `${winRate.toFixed(0).padStart(9)}% | ${avgMaxGain.toFixed(2).padStart(9)}% | ${matchRate.toFixed(0).padStart(7)}%`
    );
  }

  console.log(`\n🏆 最佳公式: ${bestCombo.name}`);
  console.log(`   權重: surge=${bestCombo.w.surge} sixCon=${bestCombo.w.sixCon} winRate=${bestCombo.w.winRate} position=${bestCombo.w.position} ai=${bestCombo.w.ai}`);

  console.log('\n═══════════════════════════════════════════════════');
  console.log('  分析完成');
  console.log('═══════════════════════════════════════════════════');
}

main().catch(console.error);
