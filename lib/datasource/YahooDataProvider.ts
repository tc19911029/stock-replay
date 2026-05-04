// lib/datasource/YahooDataProvider.ts
import { Candle, CandleWithIndicators } from '@/types';
import { computeIndicators } from '@/lib/indicators';
import { DataProvider } from './DataProvider';
import { globalCache } from './MemoryCache';
import { getTWSEQuote, type TWSEQuote } from './TWSERealtime';
import { getEastMoneyQuote, getUSStockQuote } from './EastMoneyRealtime';

/** 從 symbol 提取台股純數字代碼，非台股回傳 null */
function extractTWCode(symbol: string): string | null {
  const m = symbol.match(/^(\d{4,5})\.(TW|TWO)$/i);
  return m ? m[1] : null;
}

/** 從 symbol 提取 A 股純數字代碼，非 A 股回傳 null */
function extractCNCode(symbol: string): string | null {
  const m = symbol.match(/^(\d{6})\.(SS|SZ)$/i);
  return m ? m[1] : null;
}

/** 從 symbol 提取 A 股後綴（SS/SZ），用於區分指數 vs 同代碼個股 */
function extractCNSuffix(symbol: string): 'SS' | 'SZ' | undefined {
  const m = symbol.match(/\.(SS|SZ)$/i);
  return m ? (m[1].toUpperCase() as 'SS' | 'SZ') : undefined;
}

/** 從 symbol 提取美股 ticker，非美股回傳 null */
function extractUSTicker(symbol: string): string | null {
  // 美股 ticker: 純字母（1-5字母），不帶交易所後綴
  // 排除台股（數字.TW）和 A 股（數字.SS/.SZ）
  if (/^\d/.test(symbol)) return null;
  if (/\.(TW|TWO|SS|SZ)$/i.test(symbol)) return null;
  // 像 AAPL, TSLA, BRK-B 等
  if (/^[A-Z]{1,5}(-[A-Z])?$/i.test(symbol)) return symbol.toUpperCase();
  return null;
}

/** 取得美股紐約時間的「今日」日期字串（自動處理夏令/冬令時） */
function getUSDateStr(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/** 取得台股/A股 UTC+8 的「今日」日期字串 */
function getAsiaDateStr(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
}

const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept': 'application/json',
};

// 歷史資料 TTL：24 小時（歷史資料不會變）
const HISTORICAL_TTL = 24 * 60 * 60 * 1000;
// 近期資料 TTL：5 分鐘（當天資料可能更新）
const RECENT_TTL = 1 * 60 * 1000;  // 盤中 1 分鐘快取（Yahoo 本身有 15-20 分鐘延遲）

/** 原始 OHLC，不套用除權息調整（用於跨日期區間比較，避免調整基準不同） */
function parseYahooCandlesRaw(json: unknown, symbol?: string): Candle[] {
  const result = (json as { chart?: { result?: unknown[] } })?.chart?.result?.[0] as {
    timestamp?: number[];
    indicators?: {
      quote?: { open: number[]; high: number[]; low: number[]; close: number[]; volume: number[] }[];
    };
  } | undefined;
  if (!result) return [];

  const timestamps: number[] = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0];
  if (!q) return [];

  // TW 股票 Yahoo volume 單位是「股」，系統統一用「張」（1 張 = 1000 股）
  const isTW = !!symbol && /\.(TW|TWO)$/i.test(symbol);
  const volDivisor = isTW ? 1000 : 1;

  return timestamps
    .map((ts, i) => {
      const o = q.open[i]; const h = q.high[i];
      const l = q.low[i];  const c = q.close[i];
      const v = q.volume[i];
      if (o == null || h == null || l == null || c == null || isNaN(o)) return null;
      return {
        date:   new Date(ts * 1000).toISOString().split('T')[0],
        open:   +o.toFixed(2),
        high:   +h.toFixed(2),
        low:    +l.toFixed(2),
        close:  +c.toFixed(2),
        volume: v != null ? Math.round(v / volDivisor) : 0,
      };
    })
    .filter((c): c is Candle => c != null);
}

function parseYahooCandles(json: unknown, symbol?: string): Candle[] {
  const result = (json as { chart?: { result?: unknown[] } })?.chart?.result?.[0] as {
    timestamp?: number[];
    indicators?: {
      quote?:    { open: number[]; high: number[]; low: number[]; close: number[]; volume: number[] }[];
      adjclose?: { adjclose: number[] }[];
    };
  } | undefined;
  if (!result) return [];

  const timestamps: number[] = result.timestamp ?? [];
  const q   = result.indicators?.quote?.[0];
  const adj = result.indicators?.adjclose?.[0]?.adjclose as number[] | undefined;
  if (!q) return [];

  // TW 股票 Yahoo volume 單位是「股」，系統統一用「張」（1 張 = 1000 股）
  const isTW = !!symbol && /\.(TW|TWO)$/i.test(symbol);
  const volDivisor = isTW ? 1000 : 1;

  return timestamps
    .map((ts, i) => {
      const o = q.open[i]; const h = q.high[i];
      const l = q.low[i];  const c = q.close[i];
      const v = q.volume[i];
      if (o == null || h == null || l == null || c == null || isNaN(o)) return null;

      // 除權息調整：用 adjclose / close 比例同步調整所有 OHLC 和成交量
      // 確保均線、報酬率、量能在除權息日前後連續，不產生假跳空或量能斷層
      const adjFactor = (adj && adj[i] != null && c > 0) ? adj[i] / c : 1;

      const rawVol = v ?? 0;
      const adjustedVol = adjFactor !== 1 ? rawVol / adjFactor : rawVol;
      return {
        date:   new Date(ts * 1000).toISOString().split('T')[0],
        open:   +(o * adjFactor).toFixed(2),
        high:   +(h * adjFactor).toFixed(2),
        low:    +(l * adjFactor).toFixed(2),
        close:  +(c * adjFactor).toFixed(2),
        volume: Math.round(adjustedVol / volDivisor),
      };
    })
    .filter((c): c is Candle => c != null);
}

/**
 * 即時報價覆蓋：根據 symbol 自動判斷台股/A股/美股，用交易所 API 覆蓋最後一根日 K
 * @param dateRangeStart 若提供，表示 getCandlesRange 模式，需檢查 today 在範圍內
 * @param dateRangeEnd   同上
 */
async function overlayRealtimeQuote(
  symbol: string,
  candles: Candle[],
  dateRangeStart?: string,
  dateRangeEnd?: string,
): Promise<void> {
  // 判斷市場並取得即時報價
  const twCode = extractTWCode(symbol);
  const cnCode = extractCNCode(symbol);
  const usTicker = extractUSTicker(symbol);
  if (!twCode && !cnCode && !usTicker) return;

  try {
    const quote = twCode
      ? await getTWSEQuote(twCode)
      : cnCode
        ? await getEastMoneyQuote(cnCode, extractCNSuffix(symbol))
        : await getUSStockQuote(usTicker!);
    if (!quote || quote.close <= 0) return;

    // 用各市場當地日期判斷「今天」（自動處理夏令/冬令時）
    const todayStr = usTicker ? getUSDateStr() : getAsiaDateStr();

    // 週末不覆蓋（所有市場六日休市）
    const todayDate = new Date(todayStr + 'T12:00:00Z');
    const dayOfWeek = todayDate.getUTCDay(); // 0=Sun, 6=Sat
    if (dayOfWeek === 0 || dayOfWeek === 6) return;

    // getCandlesRange 模式：檢查 today 是否在請求範圍內
    if (dateRangeStart && dateRangeEnd) {
      if (todayStr < dateRangeStart || todayStr > dateRangeEnd) return;
    }

    const lastCandle = candles[candles.length - 1];

    // 過期資料防護 — 最可靠的方式：直接比對 quote 的日期欄位
    // TWSE STOCK_DAY_ALL / TPEx 會在日期欄位標明資料所屬交易日
    // 若 quote.date 存在且不等於 todayStr，代表 API 尚未更新，必須跳過
    const quoteDate = 'date' in quote ? (quote.date as string | undefined) : undefined;
    if (quoteDate && quoteDate !== todayStr) {
      return; // API 回傳的是舊日資料，不覆蓋
    }

    // 備用防護：若無 date 欄位，使用 previousClose 或時段檢查
    const prevClose = 'previousClose' in quote ? (quote.previousClose as number | undefined) : undefined;
    if (lastCandle.date === todayStr) {
      if (prevClose !== undefined) {
        const prevCandle = candles[candles.length - 2];
        if (prevCandle) {
          const staleness = Math.abs(prevClose - prevCandle.close) / (prevCandle.close || 1);
          if (staleness < 0.005) {
            // TWSE 的昨收 ≈ Yahoo 倒數第二根 K（昨日）→ TWSE 資料是昨日，跳過
            return;
          }
        }
      } else if (!usTicker) {
        // 無 previousClose 且非美股：檢查是否在灰區時段（收盤後~更新前）
        const nowAsia = new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei', hour12: false });
        const hour = parseInt(nowAsia.split(' ')[1]?.split(':')[0] ?? '0', 10);
        const min  = parseInt(nowAsia.split(' ')[1]?.split(':')[1] ?? '0', 10);
        const timeMin = hour * 60 + min;
        // 盤前 (< 09:00 = 540min)：STOCK_DAY_ALL 可能仍是前一日數據
        // 收盤灰區 (13:30~15:30 = 810~930min)：TWSE 尚未更新今日收盤
        if (timeMin < 540 || (timeMin >= 810 && timeMin < 930)) {
          return; // 不信任 STOCK_DAY_ALL 資料
        }
      }
    }

    if (lastCandle.date === todayStr) {
      lastCandle.open   = quote.open;
      lastCandle.high   = quote.high;
      lastCandle.low    = quote.low;
      lastCandle.close  = quote.close;
      lastCandle.volume = quote.volume;
    } else if (lastCandle.date < todayStr) {
      candles.push({
        date:   todayStr,
        open:   quote.open,
        high:   quote.high,
        low:    quote.low,
        close:  quote.close,
        volume: quote.volume,
      });
    }
  } catch {
    // Realtime overlay failed, use Yahoo data only
  }
}

/**
 * Yahoo Finance 資料提供者
 *
 * 實作 DataProvider 介面，包含：
 * - 自動快取（歷史資料 24h，近期資料 1min）
 * - 台股/A股即時報價自動覆蓋（消除 Yahoo 15-20 分鐘延遲）
 * - asOfDate 嚴格防止未來資料洩漏
 * - 錯誤處理與 timeout
 */
export class YahooDataProvider implements DataProvider {
  readonly name = 'Yahoo Finance';

  async getHistoricalCandles(
    symbol: string,
    period = '1y',
    asOfDate?: string,
    timeoutMs = 20000,
  ): Promise<CandleWithIndicators[]> {
    // 判斷是否為歷史資料（可以用更長的快取）
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
    const isHistorical = asOfDate && asOfDate < today;
    const ttl = isHistorical ? HISTORICAL_TTL : RECENT_TTL;

    const cacheKey = `yahoo:candles:${symbol}:${period}:${asOfDate ?? 'live'}`;
    const cached = globalCache.get<CandleWithIndicators[]>(cacheKey);
    if (cached) return cached;

    let url: string;
    if (asOfDate) {
      const endUnix   = Math.floor(new Date(asOfDate).getTime() / 1000) + 2 * 86400;
      const startUnix = endUnix - 400 * 86400;
      url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${startUnix}&period2=${endUnix}&includePrePost=false&events=div,split`;
    } else {
      url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${period}&includePrePost=false&events=div,split`;
    }

    const res = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`Yahoo Finance ${res.status} for ${symbol}`);

    const rawJson = await res.json();
    const rawCandles = parseYahooCandles(rawJson, symbol);
    const filtered = asOfDate
      ? rawCandles.filter(c => c.date <= asOfDate)
      : rawCandles;

    // Yahoo chart API 對當日未收盤的 bar 常回傳 volume=0（尤其是指數如 ^TWII）。
    // meta.regularMarketVolume 與歷史 timestamps 同源，單位相同，可直接補上。
    if (!isHistorical && filtered.length > 0) {
      const meta = (rawJson as {
        chart?: { result?: Array<{ meta?: { regularMarketVolume?: number; regularMarketTime?: number } }> }
      })?.chart?.result?.[0]?.meta;
      if (meta?.regularMarketVolume && meta.regularMarketVolume > 0) {
        const isUS = !symbol.includes('.');
        const todayStr = isUS ? getUSDateStr() : getAsiaDateStr();
        const isTW = /\.(TW|TWO)$/i.test(symbol);
        const volDivisor = isTW ? 1000 : 1;
        const last = filtered[filtered.length - 1];
        if (last.date === todayStr && last.volume === 0) {
          last.volume = Math.round(meta.regularMarketVolume / volDivisor);
        }
      }
    }

    // 即時報價覆蓋：用交易所 API 補上最新一根日 K（消除 Yahoo 15-20 分鐘延遲）
    if (!isHistorical && filtered.length > 0) {
      await overlayRealtimeQuote(symbol, filtered);
    }

    const result = computeIndicators(filtered);
    globalCache.set(cacheKey, result, ttl);
    return result;
  }

  async getCandlesRange(
    symbol: string,
    startDate: string,
    endDate: string,
    timeoutMs = 8000,
  ): Promise<Candle[]> {
    const cacheKey = `yahoo:range:${symbol}:${startDate}:${endDate}`;
    const cached = globalCache.get<Candle[]>(cacheKey);
    if (cached) return cached;

    const startUnix = Math.floor(new Date(startDate).getTime() / 1000);
    const endUnix   = Math.floor(new Date(endDate).getTime()   / 1000) + 86400;

    // events=split only（不傳 div），避免 adjclose 因為股息而調整基準
    // getCandlesRange 用於前向績效計算，需要原始 OHLC 避免跨窗口調整基準不一致
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${startUnix}&period2=${endUnix}&includePrePost=false&events=split`;

    const res = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`Yahoo Finance ${res.status} for ${symbol}`);

    const result = parseYahooCandlesRaw(await res.json(), symbol);

    const twoDaysAgo = new Date(Date.now() - 2 * 86400_000).toISOString().split('T')[0];
    const isRecent = endDate >= twoDaysAgo;

    // 即時報價覆蓋
    if (isRecent && result.length > 0) {
      await overlayRealtimeQuote(symbol, result, startDate, endDate);
    }

    globalCache.set(cacheKey, result, isRecent ? RECENT_TTL : HISTORICAL_TTL);
    return result;
  }
}

/** 全域 Yahoo provider 單例 */
export const yahooProvider = new YahooDataProvider();

// ── Yahoo v7 批次 quote（盤中 L2 備援，mis.twse WAF 封時接手） ──────────────

interface YahooV7QuoteRow {
  symbol: string;
  longName?: string;
  shortName?: string;
  regularMarketOpen?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  regularMarketPrice?: number;
  regularMarketVolume?: number;
  regularMarketPreviousClose?: number;
  regularMarketTime?: number;
}

/**
 * 以 TWSE / TPEx OpenAPI 取得全市場上市上櫃代號，批次打 Yahoo Finance v7 quote。
 * 2026-04-20 加入，作為 mis.twse 盤中 WAF 封鎖時的批次備援。
 * 1800 支股票 ~18 批 × 100 檔 並行 6，估 3~5 秒。
 *
 * 回傳 Map key 為純數字代碼（e.g. "2330"），value 對齊 TWSEQuote 介面讓上層共用處理。
 */
export async function getYahooTWRealtime(): Promise<Map<string, TWSEQuote>> {
  const out = new Map<string, TWSEQuote>();
  const todayTW = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());

  // Step 1: 取代碼清單（沿用 TWSE/TPEx OpenAPI — 這兩個端點很穩定）
  const [twseRes, tpexRes] = await Promise.allSettled([
    fetch('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', {
      signal: AbortSignal.timeout(10000),
    }),
    fetch('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes', {
      signal: AbortSignal.timeout(10000),
    }),
  ]);

  const symbols: string[] = [];
  if (twseRes.status === 'fulfilled' && twseRes.value.ok) {
    try {
      const rows = await twseRes.value.json() as Array<{ Code: string }>;
      for (const r of rows) if (/^\d{4,5}$/.test(r.Code)) symbols.push(`${r.Code}.TW`);
    } catch { /* skip */ }
  }
  if (tpexRes.status === 'fulfilled' && tpexRes.value.ok) {
    try {
      const rows = await tpexRes.value.json() as Array<{ SecuritiesCompanyCode: string }>;
      for (const r of rows) if (/^\d{4,5}$/.test(r.SecuritiesCompanyCode)) symbols.push(`${r.SecuritiesCompanyCode}.TWO`);
    } catch { /* skip */ }
  }

  if (symbols.length === 0) {
    console.warn('[YahooRealtime] 取不到代碼清單，放棄');
    return out;
  }

  // Step 2: 批次 100 檔打 v7 quote，並行 6
  const BATCH = 100;
  const CONCURRENCY = 6;
  const batches: string[][] = [];
  for (let i = 0; i < symbols.length; i += BATCH) {
    batches.push(symbols.slice(i, i + BATCH));
  }

  async function runBatch(batch: string[]): Promise<void> {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${batch.join(',')}`;
    try {
      const res = await fetch(url, {
        headers: YF_HEADERS,
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) return;
      const json = await res.json() as { quoteResponse?: { result?: YahooV7QuoteRow[] } };
      const rows = json?.quoteResponse?.result ?? [];
      for (const q of rows) {
        if (q.regularMarketPrice == null || q.regularMarketPrice <= 0) continue;
        const code = q.symbol.replace(/\.(TW|TWO)$/i, '');
        // 日期守門：Yahoo quote 可能回昨日收盤；regularMarketTime 換成台北日期比對 today
        const qDate = q.regularMarketTime
          ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date(q.regularMarketTime * 1000))
          : undefined;
        out.set(code, {
          code,
          name: q.longName || q.shortName || code,
          open: q.regularMarketOpen ?? 0,
          high: q.regularMarketDayHigh ?? 0,
          low: q.regularMarketDayLow ?? 0,
          close: q.regularMarketPrice,
          volume: Math.round((q.regularMarketVolume ?? 0) / 1000), // 股 → 張（對齊 TWSEQuote）
          previousClose: q.regularMarketPreviousClose,
          date: qDate ?? todayTW,
        });
      }
    } catch (err) {
      console.warn(`[YahooRealtime] batch fail (${batch.length} codes):`, (err as Error).message?.slice(0, 80));
    }
  }

  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const slice = batches.slice(i, i + CONCURRENCY);
    await Promise.all(slice.map(runBatch));
  }

  return out;
}

// ── Yahoo v8 chart 單檔並行版（v7 已被關，這條仍免認證可用） ──────────────

interface YahooV8ChartMeta {
  symbol: string;
  regularMarketPrice?: number;
  regularMarketOpen?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  regularMarketVolume?: number;
  chartPreviousClose?: number;
  regularMarketTime?: number;
}

/**
 * 用 Yahoo v8 chart 端點（免認證）並行抓全市場盤中即時報價
 * 2026-04-20 加入，作為 mis.twse 網頁防火牆封鎖時的主要備援。
 * v7 quote 2024 後關閉需認證，但 v8 chart 仍公開。
 *
 * 單檔發一個請求 → 並行 20 → 1800 支約 90 秒完成。
 */
export async function getYahooTWRealtimeViaChart(): Promise<Map<string, TWSEQuote>> {
  const out = new Map<string, TWSEQuote>();
  const todayTW = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());

  // Step 1: 取代碼清單
  const [twseRes, tpexRes] = await Promise.allSettled([
    fetch('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', {
      signal: AbortSignal.timeout(10000),
    }),
    fetch('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes', {
      signal: AbortSignal.timeout(10000),
    }),
  ]);
  const symbols: string[] = [];
  if (twseRes.status === 'fulfilled' && twseRes.value.ok) {
    try {
      const rows = await twseRes.value.json() as Array<{ Code: string }>;
      for (const r of rows) if (/^\d{4,5}$/.test(r.Code)) symbols.push(`${r.Code}.TW`);
    } catch { /* skip */ }
  }
  if (tpexRes.status === 'fulfilled' && tpexRes.value.ok) {
    try {
      const rows = await tpexRes.value.json() as Array<{ SecuritiesCompanyCode: string }>;
      for (const r of rows) if (/^\d{4,5}$/.test(r.SecuritiesCompanyCode)) symbols.push(`${r.SecuritiesCompanyCode}.TWO`);
    } catch { /* skip */ }
  }
  if (symbols.length === 0) {
    console.warn('[YahooV8] 取不到代碼清單，放棄');
    return out;
  }

  // Step 2: 並行 20 個請求，每檔打 v8 chart
  const CONCURRENCY = 20;
  let _processed = 0;
  async function fetchOne(sym: string): Promise<void> {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`;
      const res = await fetch(url, {
        headers: YF_HEADERS,
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return;
      const json = await res.json() as { chart?: { result?: Array<{ meta?: YahooV8ChartMeta }> } };
      const meta = json?.chart?.result?.[0]?.meta;
      if (!meta || meta.regularMarketPrice == null || meta.regularMarketPrice <= 0) return;
      const code = sym.replace(/\.(TW|TWO)$/i, '');
      const qDate = meta.regularMarketTime
        ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date(meta.regularMarketTime * 1000))
        : todayTW;
      out.set(code, {
        code,
        name: code, // Yahoo v8 meta 沒有 name，用代號當占位（L2 寫入時不依賴 name）
        open: meta.regularMarketOpen ?? 0,
        high: meta.regularMarketDayHigh ?? 0,
        low: meta.regularMarketDayLow ?? 0,
        close: meta.regularMarketPrice,
        volume: Math.round((meta.regularMarketVolume ?? 0) / 1000), // 股 → 張
        previousClose: meta.chartPreviousClose,
        date: qDate,
      });
    } catch { /* skip this symbol */ }
    _processed++;
  }

  // 分批並行
  for (let i = 0; i < symbols.length; i += CONCURRENCY) {
    const batch = symbols.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(fetchOne));
  }

  console.info(`[YahooV8] 並行完成: ${out.size}/${symbols.length} 支`);
  return out;
}
