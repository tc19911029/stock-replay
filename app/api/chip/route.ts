import { NextRequest, NextResponse } from 'next/server';

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
      const fb = parseNum(row[4]), tb = parseNum(row[7]), db = parseNum(row[10]);
      map.set(sym, { foreignBuy: fb, trustBuy: tb, dealerBuy: db, totalBuy: fb + tb + db, name: row[1]?.trim() || '' });
    }
  } catch (e) { console.warn('TWSE institutional:', e); }

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
      const fb = parseNum(row[4]), tb = parseNum(row[7]), db = parseNum(row[16]);
      map.set(sym, { foreignBuy: fb, trustBuy: tb, dealerBuy: db, totalBuy: fb + tb + db, name: row[1]?.trim() || '' });
    }
  } catch (e) { console.warn('TPEX institutional:', e); }

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
      const mBuy = parseNum(row[2]), mSell = parseNum(row[3]);
      const sBuy = parseNum(row[8]), sSell = parseNum(row[9]);
      const mBalance = parseNum(row[6]);  // 融資餘額
      const sBalance = parseNum(row[12]); // 融券餘額
      const mLimit = parseNum(row[7]);    // 融資限額
      map.set(sym, {
        marginBalance: mBalance,
        marginNet: mBuy - mSell,
        shortBalance: sBalance,
        shortNet: sSell - sBuy,
        marginUtilRate: mLimit > 0 ? +(mBalance / mLimit * 100).toFixed(1) : 0,
      });
    }
  } catch (e) { console.warn('fetchMargin:', e); }
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
  } catch (e) { console.warn('fetchDayTrade:', e); }
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
      const buy = parseNum(row[3]), sell = parseNum(row[4]), net = parseNum(row[5]);
      map.set(sym, { buy, sell, net });
    }
  } catch (e) { console.warn('fetchLargeTrader:', e); }
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

  // ── 法人面（權重最高）──
  if (inst) {
    if (inst.foreignBuy > 0) {
      const pts = Math.min(20, inst.foreignBuy / 50_000_000);
      score += pts;
      if (pts >= 5) details.push(`外資買超${(inst.foreignBuy / 1e6).toFixed(0)}M`);
    } else if (inst.foreignBuy < 0) {
      score += Math.max(-15, inst.foreignBuy / 50_000_000);
      if (inst.foreignBuy < -50_000_000) details.push(`外資賣超${(Math.abs(inst.foreignBuy) / 1e6).toFixed(0)}M`);
    }
    if (inst.trustBuy > 0) {
      score += Math.min(15, inst.trustBuy / 20_000_000);
      if (inst.trustBuy > 10_000_000) details.push(`投信買超${(inst.trustBuy / 1e6).toFixed(0)}M`);
    } else if (inst.trustBuy < 0) {
      score += Math.max(-10, inst.trustBuy / 20_000_000);
    }
    if (inst.foreignBuy > 0 && inst.trustBuy > 0 && inst.dealerBuy > 0) { score += 10; details.push('三法人同步買超'); }
    if (inst.foreignBuy < 0 && inst.trustBuy < 0 && inst.dealerBuy < 0) { score -= 10; details.push('三法人同步賣超'); }
  }

  // ── 融資融券面 ──
  if (margin) {
    if (margin.marginNet < -200) { score += Math.min(5, Math.abs(margin.marginNet) / 500); details.push(`融資減${Math.abs(margin.marginNet)}張`); }
    if (margin.marginNet > 500) { score -= Math.min(10, margin.marginNet / 500); details.push(`融資增${margin.marginNet}張`); }
    if (margin.shortNet > 0 && inst && inst.totalBuy > 0) { score += 3; details.push('軋空機會'); }
    if (margin.marginUtilRate > 60) { score -= 3; details.push(`融資使用率${margin.marginUtilRate}%偏高`); }
  }

  // ── 大額交易人 ──
  if (lt) {
    if (lt.net > 0) { score += Math.min(8, lt.net / 100_000_000); details.push(`大戶買超${(lt.net / 1e6).toFixed(0)}M`); }
    if (lt.net < -100_000_000) { score -= 5; details.push(`大戶賣超${(Math.abs(lt.net) / 1e6).toFixed(0)}M`); }
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

// ── 快取 ─────────────────────────────────────────────────────────────────────
let cache: { date: string; data: Map<string, ChipData>; ts: number } | null = null;
const CACHE_TTL = 10 * 60 * 1000;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const date = searchParams.get('date') || new Date().toISOString().slice(0, 10);
  const symbol = searchParams.get('symbol');

  if (cache && cache.date === date && Date.now() - cache.ts < CACHE_TTL) {
    if (symbol) {
      const d = cache.data.get(symbol.replace(/\.(TW|TWO)$/i, ''));
      return NextResponse.json(d || { error: 'not found' });
    }
    return NextResponse.json({ date, count: cache.data.size, data: Array.from(cache.data.values()) });
  }

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
