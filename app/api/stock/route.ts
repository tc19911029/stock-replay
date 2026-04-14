import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getTWChineseName, getCNChineseName } from '@/lib/datasource/TWSENames';
import { dataProvider } from '@/lib/datasource/MultiMarketProvider';
import { getFugleIntradayCandles, isFugleAvailable } from '@/lib/datasource/FugleProvider';
import { loadLocalCandlesWithTolerance } from '@/lib/datasource/LocalCandleStore';
import { aggregateCandles } from '@/lib/datasource/aggregateCandles';
import { computeIndicators } from '@/lib/indicators';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import { getTWSESingleIntraday, getTWSEQuote } from '@/lib/datasource/TWSERealtime';
import { getEastMoneySingleQuote } from '@/lib/datasource/EastMoneyRealtime';
import { readIntradaySnapshot } from '@/lib/datasource/IntradayCache';

// ── 週K/月K 聚合結果快取（避免重複聚合 + computeIndicators） ──
const aggregateCache = new Map<string, { data: unknown; expires: number }>();
const AGGREGATE_CACHE_TTL = 5 * 60 * 1000; // 5 分鐘

/**
 * API Route: /api/stock?symbol=2330&interval=1d&period=2y
 *
 * 使用 MultiMarketProvider 多源備援：
 *   台股 → FinMind → TWSE/TPEx（備援）+ TWSE 即時覆蓋
 *   陸股 → 騰訊 → 東方財富（備援）+ 東方財富即時覆蓋
 *   美股 → 騰訊 → 東方財富（備援）+ 東方財富即時覆蓋
 *
 * interval: 1d (日K) | 1wk (週K) | 1mo (月K)
 * period:   1y | 2y | 3y | 5y | 10y
 */

const stockQuerySchema = z.object({
  symbol:   z.string().min(1),
  interval: z.enum(['1m', '5m', '15m', '30m', '60m', '1d', '1wk', '1mo']).default('1d'),
  period:   z.string().default('2y'),
  local:    z.enum(['1', '0']).optional(), // '1' = 本地檔案優先（日K混合模式用）
});

/** 解析 symbol 並加上交易所後綴 */
function resolveSymbol(symbol: string): { ticker: string; candidates: string[]; isTW: boolean; isCN: boolean } {
  const isTW = /^\d{4,5}$/.test(symbol) || /^\d{4,5}\.(TW|TWO)$/i.test(symbol);
  const isCN = /^\d{6}$/.test(symbol) || /^\d{6}\.(SZ|SS)$/i.test(symbol);
  const pureCode = symbol.replace(/\.(SZ|SS|TW|TWO)$/i, '');

  let candidates: string[];
  if (isCN) {
    if (/\.(SZ|SS)$/i.test(symbol)) {
      candidates = [symbol.toUpperCase()];
    } else {
      candidates = pureCode[0] === '6' || pureCode[0] === '9'
        ? [`${pureCode}.SS`, `${pureCode}.SZ`]
        : [`${pureCode}.SZ`, `${pureCode}.SS`];
    }
  } else if (isTW) {
    if (/\.(TW|TWO)$/i.test(symbol)) {
      candidates = [symbol.toUpperCase()];
    } else {
      candidates = [`${pureCode}.TW`, `${pureCode}.TWO`];
    }
  } else {
    candidates = [symbol.toUpperCase()];
  }

  return { ticker: candidates[0], candidates, isTW, isCN };
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const parsed = stockQuerySchema.safeParse(Object.fromEntries(searchParams));
  if (!parsed.success) {
    return apiValidationError(parsed.error);
  }
  const { symbol, interval, period, local: localParam } = parsed.data;
  const { candidates, isTW, isCN } = resolveSymbol(symbol);
  const pureCode = symbol.replace(/\.(SZ|SS|TW|TWO)$/i, '');

  const isMinuteInterval = ['1m', '5m', '15m', '30m', '60m'].includes(interval);

  // ── 本地檔案快速路徑（先讀本地秒開 → 即時覆蓋今日 K） ──
  // 支援日K(1d)直接使用，以及週K(1wk)/月K(1mo)本地聚合
  if (localParam === '1' && !isMinuteInterval && (isTW || isCN)) {
    try {
      const market = isTW ? 'TW' as const : 'CN' as const;
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
      // 容忍 5 個交易日差距（涵蓋週末 + 假日）
      // 遍歷所有候選（如 2330.TW → 2330.TWO），避免只試第一個就 fallthrough 到 API
      let result: Awaited<ReturnType<typeof loadLocalCandlesWithTolerance>> = null;
      for (const candidate of candidates) {
        result = await loadLocalCandlesWithTolerance(candidate, market, today, 5);
        if (result && result.candles.length > 0) break;
      }
      if (result && result.candles.length > 0) {
        // ── 盤中即時覆蓋：若 lastDate < today，主動拉即時報價湊今日 K 棒 ──
        const lastCandle = result.candles[result.candles.length - 1];
        if (lastCandle && lastCandle.date < today) {
          let todayQuote: { open: number; high: number; low: number; close: number; volume: number } | null = null;
          try {
            if (isTW) {
              const twCode = pureCode;
              const q = await getTWSESingleIntraday(twCode) ?? await getTWSEQuote(twCode);
              if (q && q.close > 0 && (!q.date || q.date === today)) {
                todayQuote = q;
              }
            } else if (isCN) {
              const q = await getEastMoneySingleQuote(pureCode);
              if (q && q.close > 0) {
                todayQuote = q;
              }
            }
          } catch (err) {
            console.warn(`[stock] 即時報價失敗 ${symbol}:`, err instanceof Error ? err.message : err);
          }

          // fallback: 從 L2 全市場快照中找該股報價
          if (!todayQuote) {
            try {
              const snapshot = await readIntradaySnapshot(market as 'TW' | 'CN', today);
              if (snapshot) {
                const sq = snapshot.quotes.find(q => q.symbol === pureCode);
                if (sq && sq.close > 0) {
                  todayQuote = { open: sq.open, high: sq.high, low: sq.low, close: sq.close, volume: sq.volume };
                }
              }
            } catch (err) {
              console.warn(`[stock] L2 fallback 失敗 ${symbol}:`, err instanceof Error ? err.message : err);
            }
          }

          if (todayQuote) {
            result.candles.push({
              date: today,
              open: todayQuote.open,
              high: todayQuote.high,
              low: todayQuote.low,
              close: todayQuote.close,
              volume: todayQuote.volume,
            });
          }
        }

        let withIndicators = computeIndicators(
          result.candles.map(c => ({ date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }))
        );

        // 週K/月K：本地日K聚合（省去 API 請求）+ memory cache
        if (interval === '1wk' || interval === '1mo') {
          const cacheKey = `${symbol}:${interval}`;
          const cached = aggregateCache.get(cacheKey);
          if (cached && cached.expires > Date.now()) {
            withIndicators = cached.data as typeof withIndicators;
          } else {
            const rawDaily = result.candles.map(c => ({ date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
            const aggregated = aggregateCandles(rawDaily, interval);
            withIndicators = computeIndicators(aggregated);
            aggregateCache.set(cacheKey, { data: withIndicators, expires: Date.now() + AGGREGATE_CACHE_TTL });
          }
        }

        let name = candidates[0];
        if (isTW) {
          const twName = await getTWChineseName(pureCode).catch(() => null);
          if (twName) name = twName;
        } else if (isCN) {
          const cnName = await getCNChineseName(pureCode);
          if (cnName) name = cnName;
        }
        return apiOk({
          ticker: candidates[0],
          name,
          currency: '',
          interval,
          candles: withIndicators.map(c => ({ date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })),
          totalBars: withIndicators.length,
          source: 'local',
          staleDays: result.staleDays,
        });
      }
    } catch (localErr) {
      // 本地讀取失敗，fallthrough 到正常 API 路徑
      console.warn(`[stock] 本地資料載入失敗 (${symbol}):`, localErr instanceof Error ? localErr.message : localErr);
    }
  }

  try {
    let candles: { date: string; open: number; high: number; low: number; close: number; volume: number }[] = [];
    let ticker = candidates[0];

    // 台股分鐘 K 線：優先用 Fugle（即時、不延遲）
    if (isTW && isMinuteInterval && isFugleAvailable()) {
      try {
        const fugleCandles = await getFugleIntradayCandles(pureCode, interval);
        if (fugleCandles.length > 0) {
          ticker = candidates[0];
          candles = fugleCandles;
        }
      } catch {
        // Fugle 失敗，走 MultiMarketProvider 備援
      }
    }

    // MultiMarketProvider 多源備援（日K 主要路徑，或分鐘 K 的備援）
    if (candles.length === 0) {
      for (const candidate of candidates) {
        try {
          const result = await dataProvider.getHistoricalCandles(candidate, period, undefined, interval);
          if (result.length > 0) {
            ticker = candidate;
            candles = result.map(c => ({
              date: c.date,
              open: c.open,
              high: c.high,
              low: c.low,
              close: c.close,
              volume: c.volume,
            }));
            break;
          }
        } catch {
          continue;
        }
      }
    }

    if (candles.length === 0) {
      return apiError(
        `找不到股票代號 ${symbol}。台股格式：2330（上市）/8299（上櫃）、陸股：603986（上海）/000858（深圳）、美股：AAPL`,
        404,
      );
    }

    // 中文名稱查詢
    let name = ticker;
    if (isTW) {
      const twName = await getTWChineseName(pureCode).catch(() => null);
      if (twName) name = twName;
    } else if (isCN) {
      const cnName = await getCNChineseName(pureCode);
      if (cnName) name = cnName;
    }

    return apiOk({ ticker, name, currency: '', interval, candles, totalBars: candles.length });
  } catch (err: unknown) {
    console.error('[stock] error:', err);
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = msg.includes('timeout') || msg.includes('ETIMEDOUT') || msg.includes('abort');
    const isRateLimit = msg.includes('429') || msg.includes('rate') || msg.includes('limit');
    if (isTimeout) {
      return apiError(`${symbol} 資料請求逾時，請稍後重試`, 504);
    }
    if (isRateLimit) {
      return apiError(`${symbol} 資料來源限流中，請等待 1-2 分鐘後重試`, 429);
    }
    return apiError(`${symbol} 資料暫時無法取得：${msg.slice(0, 100)}`);
  }
}
