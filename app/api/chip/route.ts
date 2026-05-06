import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';

// ═══════════════════════════════════════════════════════════════════════════════
// 台股籌碼面完整 API
// 數據來源：TWSE + TPEX + TDCC（全部免費公開 API）
// ═══════════════════════════════════════════════════════════════════════════════

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
import { isTradingDay } from '@/lib/utils/tradingDay';

/** 從 requestedDate 往前找最近的 TW 交易日（不打外部 API） */
async function findLatestTradingDate(requestedDate: string): Promise<string> {
  let d = new Date(requestedDate + 'T12:00:00');
  for (let i = 0; i < 7; i++) {
    const dateStr = d.toISOString().slice(0, 10);
    if (isTradingDay(dateStr, 'TW')) return dateStr;
    d = new Date(d.getTime() - 86400000);
  }
  return requestedDate;
}

const chipQuerySchema = z.object({
  date:   z.string().optional(),
  symbol: z.string().optional(),
});

// ─── 新版：用 FinMind + TDCC L1 直接抓單檔資料（不再 bulk pre-fetch 全市場） ──

import { fetchT86ForStock } from '@/lib/datasource/TwseT86Provider';
import { readTdccStock, readInstStock, writeInstStock } from '@/lib/chips/ChipStorage';
import { fetchMarginForStock, fetchDayTradeForStock, fetchLendingForStock } from '@/lib/datasource/FinmindChipExtras';

function dateMinusDays(d: string, n: number): string {
  const dt = new Date(d + 'T00:00:00Z');
  dt.setUTCDate(dt.getUTCDate() - n);
  return dt.toISOString().slice(0, 10);
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const parsed = chipQuerySchema.safeParse(Object.fromEntries(searchParams));
  if (!parsed.success) return apiValidationError(parsed.error);

  // 用 Asia/Taipei TZ；UTC 在 CST 凌晨會回傳前一天，籌碼資料對不上
  const rawDate = parsed.data.date ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
  const rawSymbol = parsed.data.symbol;
  if (!rawSymbol) return apiError('symbol required', 400);
  const code = rawSymbol.replace(/\.(TW|TWO)$/i, '');

  const date = await findLatestTradingDate(rawDate);

  try {
    // ── 1) 法人：先讀 L1，缺則 FinMind 補抓 ──
    let instFile = await readInstStock(code);
    let instOnDate = instFile?.data.find(r => r.date === date);
    if (!instOnDate) {
      const fetchStart = instFile?.lastDate ? dateMinusDays(instFile.lastDate, -1) : dateMinusDays(date, 30);
      try {
        const fetched = await fetchT86ForStock(code, fetchStart, date);
        if (fetched.size > 0) {
          const newRows = Array.from(fetched.entries()).map(([d, v]) => ({ date: d, ...v }));
          await writeInstStock(code, newRows);
          instFile = await readInstStock(code);
          instOnDate = instFile?.data.find(r => r.date === date);
        }
      } catch (err) {
        console.warn(`[/api/chip] FinMind ${code} 失敗:`, err instanceof Error ? err.message : err);
      }
    }

    // ── 2) 大戶持股 TDCC L1 + 3) 融資融券、當沖、借券（FinMind 並行）──
    // 用 allSettled：任何單一資料源失敗不應打掉整個籌碼面板（書本實務以外資+融資為主，借券缺值可接受）
    const settled = await Promise.allSettled([
      readTdccStock(code),
      fetchMarginForStock(code, date),
      fetchDayTradeForStock(code, date),
      fetchLendingForStock(code, date),
    ]);
    const pickFulfilled = <T,>(idx: number): T | null => {
      const r = settled[idx];
      return r.status === 'fulfilled' ? (r.value as T) : null;
    };
    const tdccFile = pickFulfilled<Awaited<ReturnType<typeof readTdccStock>>>(0);
    const marginInfo = pickFulfilled<Awaited<ReturnType<typeof fetchMarginForStock>>>(1);
    const dayTradeInfo = pickFulfilled<Awaited<ReturnType<typeof fetchDayTradeForStock>>>(2);
    const lendingInfo = pickFulfilled<Awaited<ReturnType<typeof fetchLendingForStock>>>(3);
    const latestTdcc = tdccFile?.data[tdccFile.data.length - 1];
    const prevTdcc = tdccFile?.data[tdccFile.data.length - 2];

    // 沒法人也沒大戶也沒融資資料 → 真正無資料
    if (!instOnDate && !latestTdcc && !marginInfo) {
      return apiError('not found', 404);
    }

    const foreignBuy = instOnDate?.foreign ?? 0;
    const trustBuy = instOnDate?.trust ?? 0;
    const dealerBuy = instOnDate?.dealer ?? 0;
    const totalBuy = instOnDate?.total ?? 0;

    const inst = instOnDate ? { foreignBuy, trustBuy, dealerBuy, totalBuy, name: '' } : undefined;
    const { score, grade, signal, detail } = calculateChipScore(inst, marginInfo ?? undefined, dayTradeInfo ?? undefined, undefined);

    const data: ChipData = {
      symbol: code,
      foreignBuy, trustBuy, dealerBuy,
      totalInstitutional: totalBuy,
      marginBalance: marginInfo?.marginBalance ?? 0,
      marginNet: marginInfo?.marginNet ?? 0,
      shortBalance: marginInfo?.shortBalance ?? 0,
      shortNet: marginInfo?.shortNet ?? 0,
      marginUtilRate: marginInfo?.marginUtilRate ?? 0,
      dayTradeVolume: dayTradeInfo?.dayTradeVolume ?? 0,
      dayTradeRatio: dayTradeInfo?.dayTradeRatio ?? 0,
      largeTraderBuy: 0, largeTraderSell: 0, largeTraderNet: 0,
      lendingBalance: lendingInfo?.lendingBalance ?? 0,
      lendingNet: lendingInfo?.lendingNet ?? 0,
      largeHolderPct: latestTdcc?.holder1000Pct ?? 0,
      largeHolderChange: latestTdcc && prevTdcc
        ? +(latestTdcc.holder1000Pct - prevTdcc.holder1000Pct).toFixed(2)
        : 0,
      chipScore: score,
      chipGrade: grade,
      chipSignal: signal,
      chipDetail: detail,
    };

    return apiOk(data);
  } catch (err) {
    console.error('[/api/chip] error:', err);
    return apiError('籌碼資料讀取失敗');
  }
}
