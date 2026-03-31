// lib/datasource/YahooDataProvider.ts
import { Candle, CandleWithIndicators } from '@/types';
import { computeIndicators } from '@/lib/indicators';
import { DataProvider } from './DataProvider';
import { globalCache } from './MemoryCache';
import { getTWSEQuote } from './TWSERealtime';
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
function parseYahooCandlesRaw(json: unknown): Candle[] {
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
        volume: v ?? 0,
      };
    })
    .filter((c): c is Candle => c != null);
}

function parseYahooCandles(json: unknown): Candle[] {
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

  return timestamps
    .map((ts, i) => {
      const o = q.open[i]; const h = q.high[i];
      const l = q.low[i];  const c = q.close[i];
      const v = q.volume[i];
      if (o == null || h == null || l == null || c == null || isNaN(o)) return null;

      // 除權息調整：用 adjclose / close 比例同步調整所有 OHLC 和成交量
      // 確保均線、報酬率、量能在除權息日前後連續，不產生假跳空或量能斷層
      const adjFactor = (adj && adj[i] != null && c > 0) ? adj[i] / c : 1;

      return {
        date:   new Date(ts * 1000).toISOString().split('T')[0],
        open:   +(o * adjFactor).toFixed(2),
        high:   +(h * adjFactor).toFixed(2),
        low:    +(l * adjFactor).toFixed(2),
        close:  +(c * adjFactor).toFixed(2),
        volume: adjFactor !== 1 ? Math.round((v ?? 0) / adjFactor) : (v ?? 0),
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
        ? await getEastMoneyQuote(cnCode)
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

    // 過期資料防護：TWSE STOCK_DAY_ALL 在收盤後灰區（~13:30-15:30）可能仍回傳前一交易日數據。
    // 策略一：若有 previousClose 欄位，檢查 TWSE 昨收 ≈ Yahoo 倒數第二根 K（代表 TWSE 是昨日資料）。
    // 策略二：若無 previousClose，用時段防護（台股/A股盤後灰區不覆蓋）。
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
    const today = new Date().toISOString().split('T')[0];
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

    const rawCandles = parseYahooCandles(await res.json());
    const filtered = asOfDate
      ? rawCandles.filter(c => c.date <= asOfDate)
      : rawCandles;

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

    const result = parseYahooCandlesRaw(await res.json());

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
