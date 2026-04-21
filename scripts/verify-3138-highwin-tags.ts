/**
 * 驗證耀登 3138 2026-04-21 是否真的同時命中：
 *   🎯 回後買上漲 + 🎯 盤整突破 + 🎯 假跌破反彈
 */

import { promises as fs } from 'fs';
import { computeIndicators } from '../lib/indicators';
import { evaluateSixConditions, findPivots } from '../lib/analysis/trendAnalysis';
import { detectFalseBreakRebound } from '../lib/analysis/highWinPositions';

async function main(): Promise<void> {
  const raw = await fs.readFile('data/candles/TW/3138.TW.json', 'utf-8');
  const data = JSON.parse(raw) as { candles: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }> };
  const rawBars = [...data.candles];

  // 把今天的 L2 snapshot 接上去
  const snap = JSON.parse(await fs.readFile('data/intraday-TW-2026-04-21.json', 'utf-8')) as { quotes: Array<{ symbol: string; open: number; high: number; low: number; close: number; volume: number }> };
  const todayQ = snap.quotes.find(q => q.symbol === '3138' || q.symbol === '3138.TW');
  if (todayQ && rawBars[rawBars.length - 1].date < '2026-04-21') {
    rawBars.push({ date: '2026-04-21', open: todayQ.open, high: todayQ.high, low: todayQ.low, close: todayQ.close, volume: todayQ.volume });
    console.log(`[補 4/21 from L2] O=${todayQ.open} H=${todayQ.high} L=${todayQ.low} C=${todayQ.close}`);
  }

  const bars = computeIndicators(rawBars);
  const idx = bars.findIndex(b => b.date === '2026-04-21');
  console.log(`總 ${bars.length} 根；2026-04-21 在 index ${idx}`);
  if (idx < 0) {
    console.log('找不到 2026-04-21');
    return;
  }

  const b = bars[idx];
  const prev = bars[idx - 1];
  console.log(`\n📊 2026-04-21 耀登`);
  console.log(`   O=${b.open} H=${b.high} L=${b.low} C=${b.close} Vol=${b.volume}`);
  console.log(`   前一日 O=${prev.open} H=${prev.high} L=${prev.low} C=${prev.close}`);
  console.log(`   MA5=${b.ma5?.toFixed(2)} MA10=${b.ma10?.toFixed(2)} MA20=${b.ma20?.toFixed(2)} MA60=${b.ma60?.toFixed(2)}`);

  const sc = evaluateSixConditions(bars, idx);
  console.log(`\n🎯 六條件結果`);
  console.log(`   totalScore=${sc.totalScore}/6 coreScore=${sc.coreScore}/5 isCoreReady=${sc.isCoreReady}`);
  console.log(`\n   ①趨勢    : pass=${sc.trend.pass} state=${sc.trend.state}`);
  console.log(`   ②均線    : pass=${sc.ma.pass}`);
  console.log(`   ③股價位置: pass=${sc.position.pass}`);
  console.log(`     ↳ detail: ${sc.position.detail}`);
  console.log(`   ④成交量  : pass=${sc.volume.pass} ratio=${sc.volume.ratio}`);
  console.log(`   ⑤進場K線: pass=${sc.kbar.pass} body=${sc.kbar.bodyPct}`);
  console.log(`   ⑥指標    : pass=${sc.indicator.pass}`);

  // ────── 拆解三個 🎯 加分 tag ──────
  const c = bars[idx];

  console.log(`\n🔍 逐項驗證 3 個加分 tag`);

  // ① 回後買上漲
  console.log(`\n[🎯 回後買上漲]`);
  const cond1a = c.close >= (c.ma5 ?? 0);
  const cond1b = c.close > prev.high;
  const pivots = findPivots(bars, idx, 8);
  const lastLow = pivots.find(p => p.type === 'low');
  const cond1c = lastLow ? c.close > lastLow.price : false;
  console.log(`   收盤站 MA5: ${c.close} ≥ ${c.ma5?.toFixed(2)} → ${cond1a}`);
  console.log(`   收盤過昨日最高: ${c.close} > ${prev.high} → ${cond1b}`);
  console.log(`   lastLow pivot: ${lastLow ? `${lastLow.date} price=${lastLow.price}` : 'none'}`);
  console.log(`   收盤 > lastLow: ${cond1c}`);
  console.log(`   → 結論: ${cond1a && cond1b && cond1c}`);

  // ② 盤整突破
  console.log(`\n[🎯 盤整突破]`);
  let rangeHigh = -Infinity, rangeLow = Infinity, windowLen = 0, brokeAt = -1;
  for (let i = idx - 1; i >= 0; i--) {
    const h = Math.max(rangeHigh, bars[i].high);
    const l = Math.min(rangeLow, bars[i].low);
    if (l <= 0) { brokeAt = i; break; }
    const amp = (h - l) / l;
    if (amp > 0.15) { brokeAt = i; break; }
    rangeHigh = h;
    rangeLow = l;
    windowLen++;
  }
  console.log(`   盤整窗口: ${windowLen} 天 (從 ${bars[idx - windowLen]?.date} 到 ${prev.date})`);
  console.log(`   箱頂 ${rangeHigh.toFixed(2)} / 箱底 ${rangeLow.toFixed(2)}, amp=${((rangeHigh - rangeLow) / rangeLow * 100).toFixed(1)}%`);
  console.log(`   窗口外被打破於: ${brokeAt >= 0 ? `${bars[brokeAt].date} H=${bars[brokeAt].high} L=${bars[brokeAt].low}` : 'n/a'}`);
  console.log(`   窗口 ≥ 6 天: ${windowLen >= 6}`);
  console.log(`   今日收盤突破箱頂: ${c.close} > ${rangeHigh.toFixed(2)} → ${c.close > rangeHigh}`);

  // ③ 假跌破反彈
  console.log(`\n[🎯 假跌破反彈]`);
  const cond3a = c.ma20 != null && prev.ma20 != null && c.ma20 > prev.ma20;
  let wasBroken = false, brokenAt: string | null = null;
  for (let j = Math.max(0, idx - 3); j < idx; j++) {
    const p = bars[j];
    if (p?.ma20 != null && p.close < p.ma20) { wasBroken = true; brokenAt = `${p.date} C=${p.close} < MA20=${p.ma20.toFixed(2)}`; break; }
  }
  const cond3b = c.close > (c.ma20 ?? 0);
  const cond3c = c.close > c.open;
  console.log(`   MA20 上揚: ${c.ma20?.toFixed(2)} > ${prev.ma20?.toFixed(2)} → ${cond3a}`);
  console.log(`   過去 3 日曾收盤 < MA20: ${wasBroken} ${brokenAt ? `(${brokenAt})` : ''}`);
  console.log(`   今日收盤 > MA20: ${c.close} > ${c.ma20?.toFixed(2)} → ${cond3b}`);
  console.log(`   今日紅K: C(${c.close}) > O(${c.open}) → ${cond3c}`);
  console.log(`   → 結論: ${detectFalseBreakRebound(bars, idx)}`);

  // ────── 回後買上漲 書本嚴格驗證（曾跌破 MA5） ──────
  console.log(`\n🔎 檢查 4/16~4/21 每日 low vs MA5（看是否真的「曾跌破 MA5」）`);
  for (let k = Math.max(0, idx - 5); k <= idx; k++) {
    const p = bars[k];
    if (p.ma5 == null) continue;
    const broke = p.low < p.ma5;
    console.log(`   ${p.date}: O=${p.open} H=${p.high} L=${p.low} C=${p.close} MA5=${p.ma5.toFixed(2)} ${broke ? '⬇️ low 跌破 MA5' : '✅ 全日在 MA5 上'}`);
  }

  console.log(`\n📖 書本嚴格版：4/21 是否為「回後買上漲」？`);
  // 書本：需要前幾日曾跌破 MA5（low 或 close < MA5），今日收盤站回 MA5 + 突破前一根高點
  let brokeMa5Before = false;
  for (let k = Math.max(0, idx - 10); k < idx; k++) {
    const p = bars[k];
    if (p.ma5 != null && p.close < p.ma5) { brokeMa5Before = true; break; }
  }
  console.log(`   過去 10 日曾「收盤 < MA5」: ${brokeMa5Before}`);
  console.log(`   今日收盤站回 MA5: ${c.close} > ${c.ma5?.toFixed(2)} → ${c.close > (c.ma5 ?? 0)}`);
  console.log(`   今日突破前一根高: ${c.close} > ${prev.high} → ${c.close > prev.high}`);
  console.log(`   → 書本嚴格結論: ${brokeMa5Before && c.close > (c.ma5 ?? 0) && c.close > prev.high}`);

  // 重跑 evaluateSixConditions 看新 detector 的結果
  console.log(`\n🔁 修改後 evaluateSixConditions 重跑（4/17 vs 4/20 vs 4/21）`);
  for (const d of ['2026-04-17', '2026-04-20', '2026-04-21']) {
    const i = bars.findIndex(b => b.date === d);
    if (i < 0) continue;
    const r = evaluateSixConditions(bars, i);
    console.log(`   ${d}: ${r.position.detail}`);
    console.log(`          highWinTags=[${r.highWinTags.join(', ')}]`);
  }

  // 針對 4/21 看 pivots 和 box
  console.log(`\n🔬 4/21 盤整突破細節`);
  const i21 = bars.findIndex(b => b.date === '2026-04-21');
  const pivots21 = findPivots(bars, i21, 10);
  console.log(`   findPivots 10 (newest first):`);
  for (const p of pivots21) {
    console.log(`     ${bars[p.index].date} idx=${p.index} type=${p.type} price=${p.price}`);
  }
  const highs = pivots21.filter(p => p.type === 'high').slice(0, 2);
  const lows = pivots21.filter(p => p.type === 'low').slice(0, 2);
  console.log(`   最近 2 高 pivots: ${highs.length} 支`);
  console.log(`   最近 2 低 pivots: ${lows.length} 支`);
  if (highs.length >= 2 && lows.length >= 2) {
    const oldestPivotIdx = Math.min(highs[1].index, lows[1].index);
    console.log(`   最舊 pivot index=${oldestPivotIdx} (${bars[oldestPivotIdx].date})`);
    console.log(`   到今日天數: ${i21 - oldestPivotIdx}`);
    let rH = -Infinity, rL = Infinity;
    for (let k = oldestPivotIdx; k <= i21 - 1; k++) {
      if (bars[k].high > rH) rH = bars[k].high;
      if (bars[k].low < rL) rL = bars[k].low;
    }
    console.log(`   箱頂 ${rH.toFixed(2)} / 箱底 ${rL.toFixed(2)} amp=${((rH - rL) / rL * 100).toFixed(1)}%`);
    console.log(`   今日收盤 ${bars[i21].close} > rangeHigh ${rH.toFixed(2)}: ${bars[i21].close > rH}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
