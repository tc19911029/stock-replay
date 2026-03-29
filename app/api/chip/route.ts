import { NextRequest, NextResponse } from 'next/server';

// ═══════════════════════════════════════════════════════════════════════════════
// 台股籌碼面 API — 三大法人買賣超 + 融資融券
// ═══════════════════════════════════════════════════════════════════════════════

interface InstitutionalData {
  symbol: string;
  name: string;
  foreignBuy: number;    // 外資買賣超（元）
  trustBuy: number;      // 投信買賣超（元）
  dealerBuy: number;     // 自營商買賣超（元）
  totalBuy: number;      // 三大法人合計
}

interface MarginData {
  symbol: string;
  marginBuy: number;     // 融資買進
  marginSell: number;    // 融資賣出
  marginNet: number;     // 融資增減
  shortBuy: number;      // 融券買進
  shortSell: number;     // 融券賣出
  shortNet: number;      // 融券增減
}

export interface ChipData {
  symbol: string;
  name?: string;
  // 法人
  foreignBuy: number;
  trustBuy: number;
  dealerBuy: number;
  totalInstitutional: number;
  // 融資融券
  marginNet: number;
  shortNet: number;
  // 連續天數（正=連買，負=連賣）
  foreignConsecutive?: number;
  trustConsecutive?: number;
  // 評分
  chipScore: number;      // 0-100 籌碼面評分
  chipGrade: string;      // S/A/B/C/D
  chipSignal: string;     // 主力進場/主力出貨/散戶進場/中性
}

// 把 TWSE 的數字字串轉成數字
function parseNum(s: string): number {
  if (!s) return 0;
  return parseInt(s.replace(/,/g, ''), 10) || 0;
}

// 取得三大法人買賣超
async function fetchInstitutional(date: string): Promise<Map<string, InstitutionalData>> {
  const map = new Map<string, InstitutionalData>();
  try {
    const dateStr = date.replace(/-/g, '');
    const url = `https://www.twse.com.tw/rwd/zh/fund/T86?date=${dateStr}&selectType=ALL&response=json`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(15000),
    });
    const json = await res.json();
    if (json?.data) {
      for (const row of json.data) {
        const symbol = row[0]?.trim();
        if (!symbol || symbol.length > 6) continue;  // 跳過非股票
        map.set(symbol, {
          symbol,
          name: row[1]?.trim() || '',
          foreignBuy: parseNum(row[4]),    // 外資買賣超
          trustBuy: parseNum(row[7]),      // 投信買賣超
          dealerBuy: parseNum(row[10]),    // 自營商買賣超
          totalBuy: parseNum(row[4]) + parseNum(row[7]) + parseNum(row[10]),
        });
      }
    }
  } catch (e) {
    console.warn('fetchInstitutional error:', e);
  }
  return map;
}

// 取得融資融券
async function fetchMargin(date: string): Promise<Map<string, MarginData>> {
  const map = new Map<string, MarginData>();
  try {
    const dateStr = date.replace(/-/g, '');
    const url = `https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${dateStr}&selectType=ALL&response=json`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(15000),
    });
    const json = await res.json();
    const table = json?.tables?.[1];
    if (table?.data) {
      for (const row of table.data) {
        const symbol = row[0]?.trim();
        if (!symbol) continue;
        const marginBuy = parseNum(row[2]);
        const marginSell = parseNum(row[3]);
        const shortSell = parseNum(row[9]);
        const shortBuy = parseNum(row[8]);
        map.set(symbol, {
          symbol,
          marginBuy,
          marginSell,
          marginNet: marginBuy - marginSell,
          shortBuy,
          shortSell,
          shortNet: shortSell - shortBuy,
        });
      }
    }
  } catch (e) {
    console.warn('fetchMargin error:', e);
  }
  return map;
}

// 計算籌碼面評分
function calculateChipScore(inst: InstitutionalData | undefined, margin: MarginData | undefined): { score: number; grade: string; signal: string } {
  let score = 50; // 中性起點

  if (inst) {
    // 外資買超 → 加分（最多 +20）
    if (inst.foreignBuy > 0) score += Math.min(20, inst.foreignBuy / 50_000_000);
    else score += Math.max(-15, inst.foreignBuy / 50_000_000);

    // 投信買超 → 加分（最多 +15，投信通常量小但精準）
    if (inst.trustBuy > 0) score += Math.min(15, inst.trustBuy / 20_000_000);
    else score += Math.max(-10, inst.trustBuy / 20_000_000);

    // 三大法人同步買超 → 額外加分
    if (inst.foreignBuy > 0 && inst.trustBuy > 0 && inst.dealerBuy > 0) score += 10;
    // 三大法人同步賣超 → 扣分
    if (inst.foreignBuy < 0 && inst.trustBuy < 0 && inst.dealerBuy < 0) score -= 10;
  }

  if (margin) {
    // 融資減少 + 股價漲 = 主力吸籌（加分）
    if (margin.marginNet < 0) score += Math.min(5, Math.abs(margin.marginNet) / 500);
    // 融資大增 = 散戶追高（扣分）
    if (margin.marginNet > 500) score -= Math.min(10, margin.marginNet / 500);
    // 融券增加 = 有人放空（如果法人同時買超，可能是軋空行情）
    if (margin.shortNet > 0 && inst && inst.totalBuy > 0) score += 3;
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  const grade = score >= 80 ? 'S' : score >= 65 ? 'A' : score >= 50 ? 'B' : score >= 35 ? 'C' : 'D';

  let signal = '中性';
  if (score >= 70 && inst && inst.foreignBuy > 0 && inst.trustBuy > 0) signal = '主力進場';
  else if (score >= 60 && inst && inst.totalBuy > 0) signal = '法人偏多';
  else if (score <= 30 && inst && inst.totalBuy < 0) signal = '主力出貨';
  else if (score <= 40 && margin && margin.marginNet > 500) signal = '散戶追高';

  return { score, grade, signal };
}

// 快取
let cache: { date: string; data: Map<string, ChipData>; ts: number } | null = null;
const CACHE_TTL = 10 * 60 * 1000; // 10 分鐘

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const date = searchParams.get('date') || new Date().toISOString().slice(0, 10);
  const symbol = searchParams.get('symbol'); // 可選，查單支

  // 快取命中
  if (cache && cache.date === date && Date.now() - cache.ts < CACHE_TTL) {
    if (symbol) {
      const d = cache.data.get(symbol.replace(/\.(TW|TWO)$/i, ''));
      return NextResponse.json(d || { error: 'not found' });
    }
    const all = Array.from(cache.data.values());
    return NextResponse.json({ date, count: all.length, data: all });
  }

  // 並行抓取
  const [instMap, marginMap] = await Promise.all([
    fetchInstitutional(date),
    fetchMargin(date),
  ]);

  // 合併
  const allSymbols = new Set([...instMap.keys(), ...marginMap.keys()]);
  const result = new Map<string, ChipData>();

  for (const sym of allSymbols) {
    const inst = instMap.get(sym);
    const margin = marginMap.get(sym);
    const { score, grade, signal } = calculateChipScore(inst, margin);

    result.set(sym, {
      symbol: sym,
      name: inst?.name,
      foreignBuy: inst?.foreignBuy ?? 0,
      trustBuy: inst?.trustBuy ?? 0,
      dealerBuy: inst?.dealerBuy ?? 0,
      totalInstitutional: inst?.totalBuy ?? 0,
      marginNet: margin?.marginNet ?? 0,
      shortNet: margin?.shortNet ?? 0,
      chipScore: score,
      chipGrade: grade,
      chipSignal: signal,
    });
  }

  // 存快取
  cache = { date, data: result, ts: Date.now() };

  if (symbol) {
    const d = result.get(symbol.replace(/\.(TW|TWO)$/i, ''));
    return NextResponse.json(d || { error: 'not found' });
  }

  const all = Array.from(result.values());
  return NextResponse.json({ date, count: all.length, data: all });
}
