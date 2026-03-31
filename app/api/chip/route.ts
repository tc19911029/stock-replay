import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

// ═══════════════════════════════════════════════════════════════════════════════
// 台股籌碼面完整 API
// 數據來源：TWSE + TPEX + TDCC（全部免費公開 API）
// ═══════════════════════════════════════════════════════════════════════════════

function parseNum(s: string): number {
  if (!s) return 0;
  return parseInt(s.replace(/,/g, ''), 10) || 0;
}

function parsePct(s: string): number {
  if (!s) return 0;
  return parseFloat(s.replace(/,/g, '').replace('%', '')) || 0;
}

// ── 完整籌碼數據 ─────────────────────────────────────────────────────────────
export interface ChipData {
  symbol: string;
  name?: string;
  // 三大法人
  foreignBuy: number;       // 外資買賣超（元）
  trustBuy: number;         // 投信買賣超（元）
  dealerBuy: number;        // 自營商買賣超（元）
  totalInstitutional: number;
  // 融資融券
  marginBalance: number;    // 融資餘額（張）
  marginNet: number;        // 融資增減（張）
  shortBalance: number;     // 融券餘額（張）
  shortNet: number;         // 融券增減（張）
  marginUtilRate: number;   // 融資使用率 %
  // 當沖
  dayTradeVolume: number;   // 當沖成交量
  dayTradeRatio: number;    // 當沖比例 %
  // 大額交易人
  largeTraderBuy: number;   // 大額交易人買超
  largeTraderSell: number;  // 大額交易人賣超
  largeTraderNet: number;   // 大額交易人淨買超
  // 借券
  lendingBalance: number;   // 借券餘額
  lendingNet: number;       // 借券增減
  // 集保大戶
  largeHolderPct: number;   // 千張以上大戶持股比例 %
  largeHolderChange: number;// 大戶持股變化 %（vs 上週）
  // 評分
  chipScore: number;
  chipGrade: string;
  chipSignal: string;
  chipDetail: string;       // 詳細說明
}

// ── 三大法人（TWSE 上市 + TPEX 上櫃）─────────────────────────────────────────
async function fetchInstitutional(date: string): Promise<Map<string, { foreignBuy: number; trustBuy: number; dealerBuy: number; totalBuy: number; name: string }>> {
  const map = new Map<string, { foreignBuy: number; trustBuy: number; dealerBuy: number; totalBuy: number; name: string }>();
  const dateStr = date.replace(/-/g, '');

  // TWSE 上市
  try {
    const res = await fetch(`https://www.twse.com.tw/rwd/zh/fund/T86?date=${dateStr}&selectType=ALL&response=json`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000),
    });
    const json = await res.json();
    for (const row of json?.data ?? []) {
      const sym = row[0]?.trim();
      if (!sym || sym.length > 6) continue;
      // TWSE 回傳的是「股數」，除以 1000 轉成「張」（跟三竹一致）
      // [4]=外陸資買賣超, [10]=投信買賣超, [11]=自營商買賣超合計
      const fb = Math.round(parseNum(row[4]) / 1000);
      const tb = Math.round(parseNum(row[10]) / 1000);
      const db = Math.round(parseNum(row[11]) / 1000);
      map.set(sym, { foreignBuy: fb, trustBuy: tb, dealerBuy: db, totalBuy: fb + tb + db, name: row[1]?.trim() || '' });
    }
  } catch { /* TWSE institutional fetch failed */ }

  // TPEX 上櫃
  try {
    const [y, m, d] = date.split('-');
    const roc = parseInt(y) - 1911;
    const res = await fetch(`https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php?l=zh-tw&o=json&se=EW&t=D&d=${roc}/${m}/${d}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.tpex.org.tw/' }, signal: AbortSignal.timeout(15000),
    });
    const json = await res.json();
    for (const row of json?.tables?.[0]?.data ?? []) {
      const sym = row[0]?.trim();
      if (!sym || sym.length > 6) continue;
      // TPEX 也是股數，除以 1000 轉張
      const fb = Math.round(parseNum(row[4]) / 1000);
      const tb = Math.round(parseNum(row[7]) / 1000);
      const db = Math.round(parseNum(row[16]) / 1000);
      map.set(sym, { foreignBuy: fb, trustBuy: tb, dealerBuy: db, totalBuy: fb + tb + db, name: row[1]?.trim() || '' });
    }
  } catch { /* TPEX institutional fetch failed */ }

  return map;
}

// ── 融資融券 ─────────────────────────────────────────────────────────────────
async function fetchMargin(date: string): Promise<Map<string, { marginBalance: number; marginNet: number; shortBalance: number; shortNet: number; marginUtilRate: number }>> {
  const map = new Map<string, { marginBalance: number; marginNet: number; shortBalance: number; shortNet: number; marginUtilRate: number }>();
  try {
    const dateStr = date.replace(/-/g, '');
    const res = await fetch(`https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${dateStr}&selectType=ALL&response=json`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000),
    });
    const json = await res.json();
    for (const row of json?.tables?.[1]?.data ?? []) {
      const sym = row[0]?.trim();
      if (!sym) continue;
      // row[5]=前日餘額, row[6]=今日餘額, row[7]=融資限額
      // row[11]=融券前日餘額, row[12]=融券今日餘額
      const mPrev    = parseNum(row[5]);
      const mBalance = parseNum(row[6]);
      const mLimit   = parseNum(row[7]);
      const sPrev    = parseNum(row[11]);
      const sBalance = parseNum(row[12]);
      map.set(sym, {
        marginBalance: mBalance,
        marginNet: mBalance - mPrev,          // 今日餘額 − 前日餘額 = 精確增減
        shortBalance: sBalance,
        shortNet: sBalance - sPrev,           // 同上
        marginUtilRate: mLimit > 0 ? +(mBalance / mLimit * 100).toFixed(1) : 0,
      });
    }
  } catch { /* fetchMargin failed */ }
  return map;
}

// ── 當沖統計 ─────────────────────────────────────────────────────────────────
async function fetchDayTrade(date: string): Promise<Map<string, { dayTradeVolume: number; dayTradeRatio: number }>> {
  const map = new Map<string, { dayTradeVolume: number; dayTradeRatio: number }>();
  try {
    const dateStr = date.replace(/-/g, '');
    const res = await fetch(`https://www.twse.com.tw/rwd/zh/marginTrading/TWT93U?date=${dateStr}&response=json`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000),
    });
    const json = await res.json();
    for (const row of json?.data ?? []) {
      const sym = row[0]?.trim();
      if (!sym) continue;
      const dtVol = parseNum(row[2]) + parseNum(row[5]); // 當沖買+賣
      const totalVol = parseNum(row[8]); // 總成交量
      map.set(sym, {
        dayTradeVolume: dtVol,
        dayTradeRatio: totalVol > 0 ? +(dtVol / totalVol * 100).toFixed(1) : 0,
      });
    }
  } catch { /* fetchDayTrade failed */ }
  return map;
}

// ── 大額交易人 ───────────────────────────────────────────────────────────────
async function fetchLargeTrader(date: string): Promise<Map<string, { buy: number; sell: number; net: number }>> {
  const map = new Map<string, { buy: number; sell: number; net: number }>();
  try {
    const dateStr = date.replace(/-/g, '');
    const res = await fetch(`https://www.twse.com.tw/rwd/zh/fund/TWT38U?date=${dateStr}&response=json`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000),
    });
    const json = await res.json();
    for (const row of json?.data ?? []) {
      const sym = row[1]?.trim();
      if (!sym || sym.length > 6) continue;
      // 股數 → 張
      const buy = Math.round(parseNum(row[3]) / 1000);
      const sell = Math.round(parseNum(row[4]) / 1000);
      const net = Math.round(parseNum(row[5]) / 1000);
      map.set(sym, { buy, sell, net });
    }
  } catch { /* fetchLargeTrader failed */ }
  return map;
}

// ── 計算籌碼面綜合評分 ───────────────────────────────────────────────────────
function calculateChipScore(
  inst: { foreignBuy: number; trustBuy: number; dealerBuy: number; totalBuy: number } | undefined,
  margin: { marginBalance: number; marginNet: number; shortBalance: number; shortNet: number; marginUtilRate: number } | undefined,
  dt: { dayTradeVolume: number; dayTradeRatio: number } | undefined,
  lt: { buy: number; sell: number; net: number } | undefined,
): { score: number; grade: string; signal: string; detail: string } {
  let score = 50;
  const details: string[] = [];

  // ── 法人面（單位：張）──
  if (inst) {
    // 外資：買超 > 500張 有意義，> 5000張 很大
    if (inst.foreignBuy > 0) {
      const pts = Math.min(20, inst.foreignBuy / 5000);
      score += pts;
      if (inst.foreignBuy >= 1000) details.push(`外資買超${inst.foreignBuy.toLocaleString()}張`);
    } else if (inst.foreignBuy < 0) {
      score += Math.max(-15, inst.foreignBuy / 5000);
      if (inst.foreignBuy <= -1000) details.push(`外資賣超${Math.abs(inst.foreignBuy).toLocaleString()}張`);
    }
    // 投信：買超 > 100張 就有意義（投信量較小但精準）
    if (inst.trustBuy > 0) {
      score += Math.min(15, inst.trustBuy / 500);
      if (inst.trustBuy >= 100) details.push(`投信買超${inst.trustBuy.toLocaleString()}張`);
    } else if (inst.trustBuy < 0) {
      score += Math.max(-10, inst.trustBuy / 500);
      if (inst.trustBuy <= -100) details.push(`投信賣超${Math.abs(inst.trustBuy).toLocaleString()}張`);
    }
    if (inst.foreignBuy > 0 && inst.trustBuy > 0 && inst.dealerBuy > 0) { score += 10; details.push('三法人同步買超'); }
    if (inst.foreignBuy < 0 && inst.trustBuy < 0 && inst.dealerBuy < 0) { score -= 10; details.push('三法人同步賣超'); }
  }

  // ── 融資融券面 ──
  if (margin) {
    if (margin.marginNet < -200) { score += Math.min(5, Math.abs(margin.marginNet) / 500); details.push(`融資減${Math.abs(margin.marginNet).toLocaleString()}張`); }
    if (margin.marginNet > 500) { score -= Math.min(10, margin.marginNet / 500); details.push(`融資增${margin.marginNet.toLocaleString()}張`); }
    if (margin.shortNet > 0 && inst && inst.totalBuy > 0) { score += 3; details.push('軋空機會'); }
    if (margin.marginUtilRate > 60) { score -= 3; details.push(`融資使用率${margin.marginUtilRate}%偏高`); }
  }

  // ── 大額交易人（單位：張）──
  if (lt) {
    if (lt.net > 0) { score += Math.min(8, lt.net / 5000); if (lt.net >= 500) details.push(`大戶買超${lt.net.toLocaleString()}張`); }
    if (lt.net < -500) { score -= 5; details.push(`大戶賣超${Math.abs(lt.net).toLocaleString()}張`); }
  }

  // ── 當沖面 ──
  if (dt) {
    if (dt.dayTradeRatio > 40) { score -= 5; details.push(`當沖比${dt.dayTradeRatio}%過高`); }
    else if (dt.dayTradeRatio > 25) { score -= 2; }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const grade = score >= 80 ? 'S' : score >= 65 ? 'A' : score >= 50 ? 'B' : score >= 35 ? 'C' : 'D';

  let signal = '中性';
  if (score >= 75 && inst && inst.foreignBuy > 0 && inst.trustBuy > 0) signal = '主力進場';
  else if (score >= 65 && inst && inst.totalBuy > 0) signal = '法人偏多';
  else if (score >= 55 && lt && lt.net > 0) signal = '大戶加碼';
  else if (score <= 25 && inst && inst.totalBuy < 0) signal = '主力出貨';
  else if (score <= 35 && margin && margin.marginNet > 500) signal = '散戶追高';
  else if (score <= 40 && inst && inst.foreignBuy < 0 && inst.trustBuy < 0) signal = '法人偏空';

  return { score, grade, signal, detail: details.join('；') || '中性' };
}

// ── 找最近有資料的交易日（最多往前找 5 天）────────────────────────────────
async function findLatestTradingDate(requestedDate: string): Promise<string> {
  let d = new Date(requestedDate + 'T12:00:00');
  for (let i = 0; i < 5; i++) {
    const dateStr = d.toISOString().slice(0, 10);
    const test = await fetchInstitutional(dateStr);
    if (test.size > 0) return dateStr;
    d = new Date(d.getTime() - 86400000); // go back one day
  }
  return requestedDate; // fallback
}

const chipQuerySchema = z.object({
  date:   z.string().optional(),
  symbol: z.string().optional(),
});

// ── 快取 ─────────────────────────────────────────────────────────────────────
let cache: { date: string; data: Map<string, ChipData>; ts: number } | null = null;
const CACHE_TTL = 10 * 60 * 1000;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const parsed = chipQuerySchema.safeParse(Object.fromEntries(searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  const rawDate = parsed.data.date ?? new Date().toISOString().slice(0, 10);
  const symbol = parsed.data.symbol ?? null;

  // Use cached data if available for any recent date
  if (cache && Date.now() - cache.ts < CACHE_TTL) {
    if (symbol) {
      const d = cache.data.get(symbol.replace(/\.(TW|TWO)$/i, ''));
      return NextResponse.json(d || { error: 'not found' });
    }
    return NextResponse.json({ date: cache.date, count: cache.data.size, data: Array.from(cache.data.values()) });
  }

  // Find the most recent trading day with available data
  const date = await findLatestTradingDate(rawDate);

  // 並行抓取所有數據源
  const [instMap, marginMap, dtMap, ltMap] = await Promise.all([
    fetchInstitutional(date),
    fetchMargin(date),
    fetchDayTrade(date),
    fetchLargeTrader(date),
  ]);

  const allSymbols = new Set([...instMap.keys(), ...marginMap.keys(), ...dtMap.keys(), ...ltMap.keys()]);
  const result = new Map<string, ChipData>();

  for (const sym of allSymbols) {
    const inst = instMap.get(sym);
    const margin = marginMap.get(sym);
    const dt = dtMap.get(sym);
    const lt = ltMap.get(sym);
    const { score, grade, signal, detail } = calculateChipScore(inst, margin, dt, lt);

    result.set(sym, {
      symbol: sym,
      name: inst?.name,
      foreignBuy: inst?.foreignBuy ?? 0,
      trustBuy: inst?.trustBuy ?? 0,
      dealerBuy: inst?.dealerBuy ?? 0,
      totalInstitutional: inst?.totalBuy ?? 0,
      marginBalance: margin?.marginBalance ?? 0,
      marginNet: margin?.marginNet ?? 0,
      shortBalance: margin?.shortBalance ?? 0,
      shortNet: margin?.shortNet ?? 0,
      marginUtilRate: margin?.marginUtilRate ?? 0,
      dayTradeVolume: dt?.dayTradeVolume ?? 0,
      dayTradeRatio: dt?.dayTradeRatio ?? 0,
      largeTraderBuy: lt?.buy ?? 0,
      largeTraderSell: lt?.sell ?? 0,
      largeTraderNet: lt?.net ?? 0,
      lendingBalance: 0,  // TODO: 借券 API
      lendingNet: 0,
      largeHolderPct: 0,  // TODO: TDCC 集保
      largeHolderChange: 0,
      chipScore: score,
      chipGrade: grade,
      chipSignal: signal,
      chipDetail: detail,
    });
  }

  cache = { date, data: result, ts: Date.now() };

  if (symbol) {
    const d = result.get(symbol.replace(/\.(TW|TWO)$/i, ''));
    return NextResponse.json(d || { error: 'not found' });
  }

  return NextResponse.json({ date, count: result.size, data: Array.from(result.values()) });
}
