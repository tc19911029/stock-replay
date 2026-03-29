/**
 * FinMind API Client
 * Free tier: 300 requests/hour, no API key required for basic datasets
 * Paid tier: higher rate limits with API token
 *
 * Docs: https://finmindtrade.com/analysis/#/data/api
 */

const FINMIND_BASE = 'https://api.finmindtrade.com/api/v4/data';
const FINMIND_TOKEN = process.env.FINMIND_API_TOKEN ?? '';  // optional paid token

const TTL = {
  INSTITUTIONAL:  24 * 60 * 60 * 1000,  // 24h
  FUNDAMENTALS:   24 * 60 * 60 * 1000,  // 24h
  MARGIN:         24 * 60 * 60 * 1000,  // 24h
} as const;

// ── In-memory cache ────────────────────────────────────────────────────────────

const cache = new Map<string, { data: unknown; expiresAt: number }>();

function cacheGet<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry || Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

function cacheSet<T>(key: string, data: T, ttl: number): void {
  cache.set(key, { data, expiresAt: Date.now() + ttl });
}

// ── FinMind API fetch ──────────────────────────────────────────────────────────

async function finmindFetch<T>(dataset: string, params: Record<string, string>): Promise<T[]> {
  const url = new URL(FINMIND_BASE);
  url.searchParams.set('dataset', dataset);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  if (FINMIND_TOKEN) {
    url.searchParams.set('token', FINMIND_TOKEN);
  }

  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(15000),
    headers: { 'Accept': 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`FinMind API error: ${res.status} ${res.statusText}`);
  }

  const json = await res.json() as { status: number; data: T[] };

  if (json.status !== 200) {
    throw new Error(`FinMind API status: ${json.status}`);
  }

  return json.data ?? [];
}

// ── Types ──────────────────────────────────────────────────────────────────────

export interface InstitutionalRow {
  date: string;
  stock_id: string;
  Foreign_Investor_buy: number;
  Foreign_Investor_sell: number;
  Foreign_Investor_buy_sell: number;  // net
  Investment_Trust_buy: number;
  Investment_Trust_sell: number;
  Investment_Trust_buy_sell: number;  // net
  Dealer_self_buy: number;
  Dealer_self_sell: number;
  Dealer_self_buy_sell: number;  // net
}

export interface MarginRow {
  date: string;
  stock_id: string;
  MarginPurchaseBuy: number;
  MarginPurchaseSell: number;
  MarginPurchaseCashRepayment: number;
  MarginPurchaseToday: number;
  ShortSaleBuy: number;
  ShortSaleSell: number;
  ShortSaleToday: number;
}

export interface RevenueRow {
  date: string;           // YYYY-MM
  stock_id: string;
  revenue: number;
  revenue_month: number;
  revenue_year: number;
}

export interface FinancialRow {
  date: string;
  stock_id: string;
  EPS: number | null;
  EPS_year: number | null;
  Gross_Profit_Margin: number | null;
  Net_Income_Margin: number | null;
}

export interface PERatioRow {
  date: string;
  stock_id: string;
  PER: number | null;
  PBR: number | null;
  dividend_yield: number | null;
}

// ── Normalized output types ────────────────────────────────────────────────────

export interface InstitutionalData {
  date: string;
  foreignNet: number;      // 外資買賣超（張）
  trustNet: number;        // 投信買賣超（張）
  dealerNet: number;       // 自營商買賣超（張）
  totalNet: number;        // 三大法人合計
  consecutiveForeignBuy: number;  // 外資連買天數
}

export interface MarginData {
  date: string;
  marginBalance: number;   // 融資餘額（張）
  shortBalance: number;    // 融券餘額（張）
  marginRatio: number;     // 融資/成交量比例
}

export interface FundamentalsData {
  eps: number | null;
  epsYoY: number | null;   // EPS YoY growth %
  grossMargin: number | null;
  netMargin: number | null;
  per: number | null;
  pbr: number | null;
  dividendYield: number | null;
  revenueLatest: number | null;
  revenueMoM: number | null;  // month-over-month %
  revenueYoY: number | null;  // year-over-year %
}

// ── Public API functions ───────────────────────────────────────────────────────

/**
 * 取得三大法人買賣超 — 最近 N 天
 */
export async function getInstitutional(
  stockId: string,
  days = 20,
): Promise<InstitutionalData[]> {
  const cacheKey = `institutional:${stockId}:${days}`;
  const cached = cacheGet<InstitutionalData[]>(cacheKey);
  if (cached) return cached;

  try {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days * 2);  // extra buffer for weekends
    const start = startDate.toISOString().split('T')[0];

    const rows = await finmindFetch<InstitutionalRow>('TaiwanStockInstitutionalInvestors', {
      data_id: stockId,
      start_date: start,
    });

    // Sort descending by date
    rows.sort((a, b) => b.date.localeCompare(a.date));
    const recent = rows.slice(0, days);

    // Calculate consecutive foreign buy days
    let consecutiveForeignBuy = 0;
    for (const r of recent) {
      if (r.Foreign_Investor_buy_sell > 0) consecutiveForeignBuy++;
      else break;
    }

    const result: InstitutionalData[] = recent.map(r => ({
      date: r.date,
      foreignNet: r.Foreign_Investor_buy_sell,
      trustNet: r.Investment_Trust_buy_sell,
      dealerNet: r.Dealer_self_buy_sell,
      totalNet: r.Foreign_Investor_buy_sell + r.Investment_Trust_buy_sell + r.Dealer_self_buy_sell,
      consecutiveForeignBuy,
    }));

    cacheSet(cacheKey, result, TTL.INSTITUTIONAL);
    return result;
  } catch (e) {
    console.warn(`[FinMind] 三大法人 failed for ${stockId}:`, (e as Error).message);
    return [];
  }
}

/**
 * 取得融資融券餘額 — 最近 N 天
 */
export async function getMarginBalance(
  stockId: string,
  days = 10,
): Promise<MarginData[]> {
  const cacheKey = `margin:${stockId}:${days}`;
  const cached = cacheGet<MarginData[]>(cacheKey);
  if (cached) return cached;

  try {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days * 2);
    const start = startDate.toISOString().split('T')[0];

    const rows = await finmindFetch<MarginRow>('TaiwanStockMarginPurchaseShortSale', {
      data_id: stockId,
      start_date: start,
    });

    rows.sort((a, b) => b.date.localeCompare(a.date));
    const recent = rows.slice(0, days);

    const result: MarginData[] = recent.map(r => ({
      date: r.date,
      marginBalance: r.MarginPurchaseToday,
      shortBalance: r.ShortSaleToday,
      marginRatio: 0,  // requires volume data to compute
    }));

    cacheSet(cacheKey, result, TTL.MARGIN);
    return result;
  } catch (e) {
    console.warn(`[FinMind] 融資融券 failed for ${stockId}:`, (e as Error).message);
    return [];
  }
}

/**
 * 取得月營收 — 最近 N 個月
 */
export async function getMonthlyRevenue(
  stockId: string,
  months = 12,
): Promise<RevenueRow[]> {
  const cacheKey = `revenue:${stockId}:${months}`;
  const cached = cacheGet<RevenueRow[]>(cacheKey);
  if (cached) return cached;

  try {
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - months - 1);
    const start = startDate.toISOString().split('T')[0];

    const rows = await finmindFetch<RevenueRow>('TaiwanStockMonthRevenue', {
      data_id: stockId,
      start_date: start,
    });

    rows.sort((a, b) => b.date.localeCompare(a.date));
    const recent = rows.slice(0, months);
    cacheSet(cacheKey, recent, TTL.FUNDAMENTALS);
    return recent;
  } catch (e) {
    console.warn(`[FinMind] 月營收 failed for ${stockId}:`, (e as Error).message);
    return [];
  }
}

/**
 * 取得財務指標（EPS、毛利率、淨利率）+ P/E、P/B — 合併成 FundamentalsData
 */
export async function getFundamentals(stockId: string): Promise<FundamentalsData> {
  const cacheKey = `fundamentals:${stockId}`;
  const cached = cacheGet<FundamentalsData>(cacheKey);
  if (cached) return cached;

  const startDate = new Date();
  startDate.setFullYear(startDate.getFullYear() - 2);
  const start = startDate.toISOString().split('T')[0];

  const [financials, peRows, revenues] = await Promise.allSettled([
    finmindFetch<FinancialRow>('TaiwanStockFinancialStatements', { data_id: stockId, start_date: start }),
    finmindFetch<PERatioRow>('TaiwanStockPER', { data_id: stockId, start_date: start }),
    getMonthlyRevenue(stockId, 13),
  ]);

  const finData = financials.status === 'fulfilled' ? financials.value : [];
  const peData  = peRows.status === 'fulfilled' ? peRows.value : [];
  const revData = revenues.status === 'fulfilled' ? revenues.value : [];

  // Latest financials
  finData.sort((a, b) => b.date.localeCompare(a.date));
  const latestFin = finData[0];
  const prevFin   = finData.find(r => r.date < (latestFin?.date ?? ''));

  // Latest P/E
  peData.sort((a, b) => b.date.localeCompare(a.date));
  const latestPE = peData[0];

  // Revenue MoM / YoY
  let revenueMoM: number | null = null;
  let revenueYoY: number | null = null;
  let revenueLatest: number | null = null;
  if (revData.length >= 1) {
    revenueLatest = revData[0].revenue;
    if (revData.length >= 2 && revData[1].revenue > 0) {
      revenueMoM = ((revData[0].revenue - revData[1].revenue) / revData[1].revenue) * 100;
    }
    if (revData.length >= 13 && revData[12].revenue > 0) {
      revenueYoY = ((revData[0].revenue - revData[12].revenue) / revData[12].revenue) * 100;
    }
  }

  // EPS YoY
  let epsYoY: number | null = null;
  if (latestFin?.EPS != null && prevFin?.EPS != null && prevFin.EPS !== 0) {
    epsYoY = ((latestFin.EPS - prevFin.EPS) / Math.abs(prevFin.EPS)) * 100;
  }

  const result: FundamentalsData = {
    eps: latestFin?.EPS ?? null,
    epsYoY,
    grossMargin: latestFin?.Gross_Profit_Margin ?? null,
    netMargin: latestFin?.Net_Income_Margin ?? null,
    per: latestPE?.PER ?? null,
    pbr: latestPE?.PBR ?? null,
    dividendYield: latestPE?.dividend_yield ?? null,
    revenueLatest,
    revenueMoM,
    revenueYoY,
  };

  cacheSet(cacheKey, result, TTL.FUNDAMENTALS);
  return result;
}

/**
 * 取得最近 N 天的三大法人合計摘要（for scan results table）
 */
export async function getInstitutionalSummary(stockId: string, days = 5): Promise<{
  foreignNet5d: number;
  trustNet5d: number;
  totalNet5d: number;
  consecutiveForeignBuy: number;
} | null> {
  try {
    const data = await getInstitutional(stockId, days);
    if (data.length === 0) return null;
    return {
      foreignNet5d: data.reduce((s, r) => s + r.foreignNet, 0),
      trustNet5d:   data.reduce((s, r) => s + r.trustNet, 0),
      totalNet5d:   data.reduce((s, r) => s + r.totalNet, 0),
      consecutiveForeignBuy: data[0].consecutiveForeignBuy,
    };
  } catch {
    return null;
  }
}
