import { loadLocalCandles } from '@/lib/datasource/LocalCandleStore';
import { fetchCandlesRange } from '@/lib/datasource/YahooFinanceDS';
import { rateLimiter } from '@/lib/datasource/UnifiedRateLimiter';
import { StockForwardPerformance, ForwardCandle } from '@/lib/scanner/types';
import type { Candle } from '@/types';

// 增加到 45 曆天，確保春節/國慶長假後仍能覆蓋 20+ 個交易日
const FORWARD_WINDOW_DAYS = 45;
const CONCURRENCY = 10;

/** 判斷股票所屬市場 */
function detectMarket(symbol: string): 'TW' | 'CN' {
  if (/\.(SS|SZ)$/i.test(symbol)) return 'CN';
  return 'TW';
}

/** 取得下一個曆日的日期字串 */
function nextDay(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
}

/** 計算兩個日期字串之間的天數差 */
function daysBetween(a: string, b: string): number {
  return (Date.parse(b) - Date.parse(a)) / 86400_000;
}

/** 取得市場時區的今日日期 */
function getMarketToday(market: 'TW' | 'CN'): string {
  const tz = market === 'CN' ? 'Asia/Shanghai' : 'Asia/Taipei';
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}

/**
 * 從本地 K 線檔案提取指定日期範圍的 candles
 * 本地檔案存的是完整歷史（2年+），只需要 filter 出 scanDate 之後的部分
 *
 * 注意：回傳的數據可能不完整（如連假後本地尚未更新），
 * 呼叫端應檢查 lastDate 是否涵蓋到 safeEndStr，不足時用 API 補足。
 */
async function loadForwardFromLocal(
  symbol: string,
  startStr: string,
  safeEndStr: string,
): Promise<Candle[]> {
  const market = detectMarket(symbol);
  const localCandles = await loadLocalCandles(symbol, market);
  if (!localCandles || localCandles.length === 0) return [];

  return localCandles
    .filter(c => c.date >= startStr && c.date <= safeEndStr)
    .map(c => ({ date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
}

/**
 * Analyse forward performance for a single stock after a scan date.
 * Returns null if data unavailable (caller should track for survivorship bias).
 *
 * 資料優先順序：本地 K 線 → Yahoo API（帶限流）
 */
async function analyzeOne(
  symbol:    string,
  name:      string,
  scanDate:  string,
  scanPrice: number,
): Promise<StockForwardPerformance | null> {
  try {
    const startMs  = Date.parse(scanDate) + 86400_000;
    const endMs    = startMs + FORWARD_WINDOW_DAYS * 86400_000;
    const startStr = new Date(startMs).toISOString().split('T')[0];
    const endStr   = new Date(endMs).toISOString().split('T')[0];

    // 今天的日期（用市場時區，防止取到未來數據）
    const market = detectMarket(symbol);
    const todayStr = getMarketToday(market);
    const safeEndStr = endStr > todayStr ? todayStr : endStr;

    // 優先讀本地 K 線（可能不完整，下方 needSupplement 會檢查並用 API 補足）
    let candles = await loadForwardFromLocal(symbol, startStr, safeEndStr);

    // 檢查本地數據是否涵蓋到最新交易日
    // 若最後一根 K 棒日期 < safeEndStr 且距今超過 1 天，用 API 補足缺口
    const lastLocalDate = candles.length > 0 ? candles[candles.length - 1].date : '';
    const needSupplement = candles.length === 0
      || (lastLocalDate < safeEndStr && daysBetween(lastLocalDate, safeEndStr) > 1);

    if (needSupplement) {
      const fetchStart = candles.length > 0 ? nextDay(lastLocalDate) : startStr;
      const provider = market === 'TW' ? 'finmind' : 'eastmoney';
      await rateLimiter.acquire(provider);
      const extra = await fetchCandlesRange(symbol, fetchStart, safeEndStr, 8000);
      if (extra.length === 0 && candles.length === 0) {
        // 完全沒數據時 retry 一次
        await new Promise(r => setTimeout(r, 2000));
        await rateLimiter.acquire(provider);
        const retry = await fetchCandlesRange(symbol, fetchStart, safeEndStr, 8000);
        if (retry.length > 0) {
          candles = [...candles, ...retry];
          rateLimiter.reportSuccess(provider);
        }
      } else if (extra.length > 0) {
        candles = [...candles, ...extra];
        rateLimiter.reportSuccess(provider);
      }
    }

    // P0-4: 若 scanDate 距今不超過 3 個曆天（週五掃描、長假前），
    // 數據可能尚未產生，回傳「待定」空結果而非 null（避免被計為倖存者偏差）
    if (candles.length === 0) {
      const daysSinceScan = (Date.now() - Date.parse(scanDate)) / 86400_000;
      if (daysSinceScan <= 3) {
        // 近期掃描：回傳帶空 forwardCandles 的結構，讓 UI 顯示「等待數據」
        return {
          symbol, name, scanDate, scanPrice,
          openReturn: null, d1Return: null, d2Return: null, d3Return: null,
          d4Return: null, d5Return: null, d6Return: null, d7Return: null,
          d8Return: null, d9Return: null, d10Return: null, d20Return: null,
          maxGain: 0, maxLoss: 0, forwardCandles: [],
          nextOpenPrice: null,
          d1ReturnFromOpen: null, d5ReturnFromOpen: null,
          d6ReturnFromOpen: null, d7ReturnFromOpen: null,
          d8ReturnFromOpen: null, d9ReturnFromOpen: null,
          d10ReturnFromOpen: null, d20ReturnFromOpen: null,
        };
      }
      return null; // 確實無數據（歷史數據源問題）
    }

    // 嚴格過濾：
    // 1. 必須 > scanDate（排除信號日當天被 Yahoo 回傳的情況）
    // 2. 必須 <= todayStr（排除未來數據）
    const filteredCandles = candles.filter(c => c.date > scanDate && c.date <= todayStr);
    const forwardCandles: ForwardCandle[] = filteredCandles.map((c, i) => {
      // 計算 MA5：取包含自身的最近5根收盤價平均
      let ma5: number | undefined;
      if (i >= 4) {
        const sum5 = filteredCandles.slice(i - 4, i + 1).reduce((s, x) => s + x.close, 0);
        ma5 = +(sum5 / 5).toFixed(2);
      }
      return {
        date: c.date, open: c.open, close: c.close, high: c.high, low: c.low,
        volume: c.volume,
        ma5,
      };
    });

    // 以訊號日收盤價（scanPrice）為基準的報酬率
    function retFromScan(idx: number): number | null {
      if (idx >= forwardCandles.length) return null;
      return +((forwardCandles[idx].close - scanPrice) / scanPrice * 100).toFixed(2);
    }

    // 以隔日開盤價為基準的報酬率（與 BacktestEngine 進場價一致）
    const nextOpenPrice = forwardCandles.length > 0 ? forwardCandles[0].open : null;
    function retFromOpen(idx: number): number | null {
      if (nextOpenPrice == null || nextOpenPrice <= 0) return null;
      if (idx >= forwardCandles.length) return null;
      return +((forwardCandles[idx].close - nextOpenPrice) / nextOpenPrice * 100).toFixed(2);
    }

    const openReturn: number | null = nextOpenPrice != null
      ? +((nextOpenPrice - scanPrice) / scanPrice * 100).toFixed(2)
      : null;

    let maxGain = 0;
    let maxLoss = 0;
    for (const c of forwardCandles) {
      const highRet = (c.high - scanPrice) / scanPrice * 100;
      const lowRet  = (c.low  - scanPrice) / scanPrice * 100;
      if (highRet > maxGain) maxGain = highRet;
      if (lowRet  < maxLoss) maxLoss = lowRet;
    }

    return {
      symbol,
      name,
      scanDate,
      scanPrice,
      openReturn,
      d1Return:  retFromScan(0),
      d2Return:  retFromScan(1),
      d3Return:  retFromScan(2),
      d4Return:  retFromScan(3),
      d5Return:  retFromScan(4),
      d6Return:  retFromScan(5),
      d7Return:  retFromScan(6),
      d8Return:  retFromScan(7),
      d9Return:  retFromScan(8),
      d10Return: retFromScan(9),
      d20Return: retFromScan(19),
      maxGain:   +maxGain.toFixed(2),
      maxLoss:   +maxLoss.toFixed(2),
      forwardCandles,
      // 以隔日開盤為基準（與 BacktestEngine 進場一致）
      nextOpenPrice,
      d1ReturnFromOpen:  retFromOpen(0),
      d5ReturnFromOpen:  retFromOpen(4),
      d6ReturnFromOpen:  retFromOpen(5),
      d7ReturnFromOpen:  retFromOpen(6),
      d8ReturnFromOpen:  retFromOpen(7),
      d9ReturnFromOpen:  retFromOpen(8),
      d10ReturnFromOpen: retFromOpen(9),
      d20ReturnFromOpen: retFromOpen(19),
    };
  } catch {
    return null;
  }
}

export interface ForwardBatchResult {
  results: StockForwardPerformance[];
  /** 無法取得前瞻數據的股票數（存活偏差指標） */
  nullCount: number;
  /** 總請求數 */
  totalRequested: number;
}

/**
 * Batch-analyze forward performance for a list of stocks.
 * Returns results + null count for survivorship bias tracking.
 */
export async function analyzeForwardBatch(
  stocks:   Array<{ symbol: string; name: string; scanPrice: number }>,
  scanDate: string,
): Promise<ForwardBatchResult> {
  const results: StockForwardPerformance[] = [];
  let nullCount = 0;

  for (let i = 0; i < stocks.length; i += CONCURRENCY) {
    const batch = stocks.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(({ symbol, name, scanPrice }) =>
        analyzeOne(symbol, name, scanDate, scanPrice)
      )
    );
    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value) {
        results.push(r.value);
      } else {
        nullCount++;
      }
    }
  }

  return { results, nullCount, totalRequested: stocks.length };
}

/**
 * Calculate summary statistics over a list of forward performances.
 */
export function calcBacktestSummary(
  perf: StockForwardPerformance[],
  horizon: 'open' | 'd1' | 'd2' | 'd3' | 'd4' | 'd5' | 'd10' | 'd20',
) {
  const key = (horizon === 'open' ? 'openReturn' : `${horizon}Return`) as keyof StockForwardPerformance;
  const returns = perf
    .map(p => p[key] as number | null)
    .filter((r): r is number => r !== null);

  if (returns.length === 0) return null;

  const wins    = returns.filter(r => r > 0).length;
  const avg     = returns.reduce((a, b) => a + b, 0) / returns.length;
  const sorted  = [...returns].sort((a, b) => a - b);
  const median  = sorted[Math.floor(sorted.length / 2)];
  const maxGain = Math.max(...returns);
  const maxLoss = Math.min(...returns);

  return {
    count:    returns.length,
    wins,
    losses:   returns.length - wins,
    winRate:  +(wins / returns.length * 100).toFixed(1),
    avgReturn: +avg.toFixed(2),
    median:   +median.toFixed(2),
    maxGain:  +maxGain.toFixed(2),
    maxLoss:  +maxLoss.toFixed(2),
  };
}
