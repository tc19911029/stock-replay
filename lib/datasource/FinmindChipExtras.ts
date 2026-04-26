/**
 * FinMind 籌碼面額外資料：融資融券、當沖、借券
 *
 * 用於補足 /api/chip 老介面顯示的欄位（除了三大法人 + TDCC 之外的部分）
 */

const FINMIND_API = 'https://api.finmindtrade.com/api/v4/data';

function getToken(): string {
  return process.env.FINMIND_API_TOKEN?.replace(/['"]/g, '').trim() ?? '';
}

async function fmGet<T>(dataset: string, code: string, startDate: string, endDate?: string): Promise<T[]> {
  const token = getToken();
  if (!token) return [];
  const end = endDate ?? startDate;
  const url = `${FINMIND_API}?dataset=${dataset}&data_id=${encodeURIComponent(code)}&start_date=${startDate}&end_date=${end}&token=${encodeURIComponent(token)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { 'Accept': 'application/json' } });
    if (!res.ok) return [];
    const json = await res.json() as { status?: number; data?: T[] };
    if (json.status !== 200) return [];
    return json.data ?? [];
  } catch {
    return [];
  }
}

// ── 融資融券 ────────────────────────────────────────────────────────────────

export interface MarginInfo {
  /** 融資餘額（張） */
  marginBalance: number;
  /** 融資增減（今日 - 昨日，張） */
  marginNet: number;
  /** 融券餘額（張） */
  shortBalance: number;
  /** 融券增減（今日 - 昨日，張） */
  shortNet: number;
  /** 融資使用率 % */
  marginUtilRate: number;
}

interface FmMarginRow {
  MarginPurchaseTodayBalance: number;
  MarginPurchaseYesterdayBalance: number;
  MarginPurchaseLimit: number;
  ShortSaleTodayBalance: number;
  ShortSaleYesterdayBalance: number;
}

export async function fetchMarginForStock(code: string, date: string): Promise<MarginInfo | null> {
  const rows = await fmGet<FmMarginRow>('TaiwanStockMarginPurchaseShortSale', code, date);
  const r = rows[0];
  if (!r) return null;
  const marginBalance = r.MarginPurchaseTodayBalance;
  const marginNet = r.MarginPurchaseTodayBalance - r.MarginPurchaseYesterdayBalance;
  const shortBalance = r.ShortSaleTodayBalance;
  const shortNet = r.ShortSaleTodayBalance - r.ShortSaleYesterdayBalance;
  const marginUtilRate = r.MarginPurchaseLimit > 0
    ? +((marginBalance / r.MarginPurchaseLimit) * 100).toFixed(2)
    : 0;
  return { marginBalance, marginNet, shortBalance, shortNet, marginUtilRate };
}

// ── 當沖 ───────────────────────────────────────────────────────────────────

export interface DayTradeInfo {
  /** 當沖成交張數 */
  dayTradeVolume: number;
  /** 當沖比例 % = 當沖量 / 總量（需要外部傳入 totalVolume，否則為 0） */
  dayTradeRatio: number;
}

interface FmDayTradeRow {
  Volume: number;
  BuyAmount: number;
  SellAmount: number;
}

export async function fetchDayTradeForStock(code: string, date: string, totalVolumeShares?: number): Promise<DayTradeInfo | null> {
  const rows = await fmGet<FmDayTradeRow>('TaiwanStockDayTrading', code, date);
  const r = rows[0];
  if (!r) return null;
  const volume = Math.round((r.Volume ?? 0) / 1000); // 股 → 張
  const ratio = totalVolumeShares && totalVolumeShares > 0
    ? +((r.Volume / totalVolumeShares) * 100).toFixed(2)
    : 0;
  return { dayTradeVolume: volume, dayTradeRatio: ratio };
}

// ── 借券賣出 SBL（含累積餘額 + 日流量） ──────────────────────────────────────
// 用 TaiwanDailyShortSaleBalances dataset（免費）：
//   SBLShortSalesCurrentDayBalance: 借券賣出當日餘額（累積部位）
//   SBLShortSalesShortSales:        當日新增借券賣出
//   SBLShortSalesReturns:           當日返還
//   ⇒ 券賣淨額 = ShortSales - Returns（正值表示空方加碼，負值表示空方回補）

export interface LendingInfo {
  /** 借券賣出餘額（累積部位，張） */
  lendingBalance: number;
  /** 券賣淨增減（今日新增 - 返還，張） */
  lendingNet: number;
}

interface FmShortSaleRow {
  date: string;
  stock_id: string;
  SBLShortSalesPreviousDayBalance: number;
  SBLShortSalesShortSales: number;
  SBLShortSalesReturns: number;
  SBLShortSalesCurrentDayBalance: number;
}

const toLots = (sharesValue: number): number => {
  if (sharesValue === 0) return 0;
  if (Math.abs(sharesValue) < 1000) return sharesValue >= 0 ? 1 : -1;
  return Math.round(sharesValue / 1000);
};

export async function fetchLendingForStock(code: string, date: string): Promise<LendingInfo | null> {
  const rows = await fmGet<FmShortSaleRow>('TaiwanDailyShortSaleBalances', code, date);
  const r = rows[0];
  if (!r) return null;
  const todayShortSales = r.SBLShortSalesShortSales ?? 0;
  const todayReturns = r.SBLShortSalesReturns ?? 0;
  const balance = r.SBLShortSalesCurrentDayBalance ?? 0;
  return {
    lendingBalance: toLots(balance),
    lendingNet: toLots(todayShortSales - todayReturns),
  };
}
