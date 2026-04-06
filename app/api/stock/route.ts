import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getTWChineseName, getCNChineseName } from '@/lib/datasource/TWSENames';
import { dataProvider } from '@/lib/datasource/MultiMarketProvider';
import { getFugleIntradayCandles, isFugleAvailable } from '@/lib/datasource/FugleProvider';
import { loadLocalCandlesWithTolerance } from '@/lib/datasource/LocalCandleStore';
import { computeIndicators } from '@/lib/indicators';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';

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

  // ── 本地檔案快速路徑（日K混合模式：先讀本地秒開） ──
  if (localParam === '1' && !isMinuteInterval && (isTW || isCN)) {
    try {
      const market = isTW ? 'TW' as const : 'CN' as const;
      const today = new Date().toISOString().split('T')[0];
      // 容忍 5 個交易日差距（涵蓋週末 + 假日）
      const result = await loadLocalCandlesWithTolerance(candidates[0], market, today, 5);
      if (result && result.candles.length > 0) {
        const withIndicators = computeIndicators(
          result.candles.map(c => ({ date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }))
        );
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
    } catch {
      // 本地讀取失敗，fallthrough 到正常 API 路徑
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
    return apiError('股票資料暫時無法取得');
  }
}
