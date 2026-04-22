import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getTWChineseName, getCNChineseName } from '@/lib/datasource/TWSENames';
import { dataProvider } from '@/lib/datasource/MultiMarketProvider';
import { getFugleIntradayCandles, getFugleQuote, isFugleAvailable } from '@/lib/datasource/FugleProvider';
import { loadLocalCandlesWithTolerance } from '@/lib/datasource/LocalCandleStore';
import { aggregateCandles } from '@/lib/datasource/aggregateCandles';
import { computeIndicators } from '@/lib/indicators';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import { getTWSESingleIntraday, getTWSEQuote } from '@/lib/datasource/TWSERealtime';
import { getEastMoneySingleQuote } from '@/lib/datasource/EastMoneyRealtime';
import { readIntradaySnapshot } from '@/lib/datasource/IntradayCache';
import { checkQuoteSanity } from '@/lib/datasource/QuoteSanityCheck';
import { isMarketOpen, isPostCloseWindow } from '@/lib/datasource/marketHours';

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
  scanDate: z.string().optional(),         // 'YYYY-MM-DD' 掃描日期，若 L1 缺該日則從 L2 快照補入
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
  const { symbol, interval, period, local: localParam, scanDate } = parsed.data;
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
        // 盤中/盤後窗口：可用即時 API 拉；窗口外（晚上/凌晨）：只靠 L2 快照（若有今日數據也允許注入）
        // 避免凌晨用舊 API 產生假的今日 K 棒，但 L2 有當日 snapshot 時就允許
        const marketKey = isTW ? 'TW' as const : 'CN' as const;
        const inLiveWindow = isMarketOpen(marketKey) || isPostCloseWindow(marketKey);
        let l2HasToday = false;
        if (!inLiveWindow) {
          try {
            const snap = await readIntradaySnapshot(marketKey, today);
            l2HasToday = !!snap && snap.date === today && snap.quotes.some(q => q.symbol === pureCode && q.close > 0);
          } catch { /* ignore */ }
        }
        const shouldInjectToday = inLiveWindow || l2HasToday;
        const lastCandle = result.candles[result.candles.length - 1];
        // 注入條件：
        //   a) lastCandle.date < today → append 今日 K（正常路徑）
        //   b) lastCandle.date === today → 覆蓋（append-today 腳本寫進 L1 的盤中快照價，需用即時報價刷新）
        const lastIsToday = !!lastCandle && lastCandle.date === today;
        if (shouldInjectToday && lastCandle && (lastCandle.date < today || lastIsToday)) {
          let todayQuote: { open: number; high: number; low: number; close: number; volume: number } | null = null;
          try {
            if (isTW) {
              const twCode = pureCode;
              const q = await getTWSESingleIntraday(twCode) ?? await getTWSEQuote(twCode);
              if (q && q.close > 0 && (!q.date || q.date === today)) {
                todayQuote = q;
              } else if (q) {
                console.warn(`[stock] 即時報價跳過 ${symbol}: close=${q.close}, date=${(q as { date?: string }).date}, today=${today}`);
              }
            } else if (isCN) {
              const q = await getEastMoneySingleQuote(pureCode);
              if (q && q.close > 0) {
                todayQuote = q;
              } else if (q) {
                console.warn(`[stock] CN即時報價跳過 ${symbol}: close=${q.close}`);
              }
            }
          } catch (err) {
            console.warn(`[stock] 即時報價失敗 ${symbol}:`, err instanceof Error ? err.message : err);
          }

          // fallback 2: Fugle 即時報價（分鐘K已驗證可用，比 mis.twse 穩定）
          if (!todayQuote && isTW && isFugleAvailable()) {
            try {
              const fq = await getFugleQuote(pureCode);
              if (fq && fq.close > 0 && (!fq.date || fq.date === today)) {
                todayQuote = { open: fq.open || fq.close, high: fq.high || fq.close, low: fq.low || fq.close, close: fq.close, volume: fq.volume };
              }
            } catch (err) {
              console.warn(`[stock] Fugle 報價失敗 ${symbol}:`, err instanceof Error ? err.message : err);
            }
          }

          // fallback 3: 從 L2 全市場快照中找該股報價
          if (!todayQuote) {
            try {
              const snapshot = await readIntradaySnapshot(market as 'TW' | 'CN', today);
              if (snapshot) {
                const sq = snapshot.quotes.find(q => q.symbol === pureCode);
                if (sq && sq.close > 0) {
                  todayQuote = { open: sq.open, high: sq.high, low: sq.low, close: sq.close, volume: sq.volume };
                } else {
                  console.warn(`[stock] L2快照找不到 ${symbol} (pureCode=${pureCode}), 快照有${snapshot.quotes.length}檔, 取樣: ${snapshot.quotes.slice(0, 3).map(q => q.symbol).join(',')}`);
                }
              } else {
                console.warn(`[stock] L2快照不存在 market=${market} date=${today}`);
              }
            } catch (err) {
              console.warn(`[stock] L2 fallback 失敗 ${symbol}:`, err instanceof Error ? err.message : err);
            }
          }

          if (todayQuote) {
            // L3 報價健全檢查：防止千倍誤差等數據異常傳到前端
            const sanity = checkQuoteSanity(
              todayQuote.close,
              todayQuote.volume,
              lastCandle.close,
              lastCandle.volume,
              market,
            );
            if (sanity.level === 'critical') {
              console.error(
                `[stock] ★ ${symbol} 報價異常 (critical): ${sanity.message} ` +
                `即時=${todayQuote.close} vs L1=${lastCandle.close}`
              );
              // critical → 不使用此報價，用 L1 最後收盤價替代
              todayQuote = null;
            } else if (sanity.level === 'warning') {
              console.warn(
                `[stock] ${symbol} 報價偏差 (warning): ${sanity.message} ` +
                `即時=${todayQuote.close} vs L1=${lastCandle.close}`
              );
            }
          }

          if (todayQuote) {
            // OHLC 一致性修正：push2 API 有時回傳垃圾值（日期拼接、漲跌幅當價格）
            const { open, high, low, close } = todayQuote;
            const safeOpen  = (open > 0 && open > close * 0.5 && open < close * 1.5)  ? open  : close;
            const safeHigh  = (high > 0 && high >= close && high < close * 1.5)        ? high  : Math.max(safeOpen, close);
            const safeLow   = (low > 0  && low <= close && low > close * 0.5)          ? low   : Math.min(safeOpen, close);
            const todayBar = {
              date: today,
              open: safeOpen,
              high: safeHigh,
              low: safeLow,
              close: todayQuote.close,
              volume: todayQuote.volume,
            };
            if (lastIsToday) {
              result.candles[result.candles.length - 1] = todayBar;
            } else {
              result.candles.push(todayBar);
            }
          }
        }

        // ── 補注入 scanDate K 棒（掃描日期在 L1 缺失時從 L2 快照補入） ──
        // 常見情境：scanDate=04-14，但 L1 只到 04-13（下載未完成），
        // 今日 bar 已注入為 04-15，但圖表定位到 04-14 時找不到對應 K 棒 → 顯示 04-13
        if (scanDate && scanDate < today) {
          const hasScanDateBar = result.candles.some(c => c.date === scanDate);
          if (!hasScanDateBar) {
            try {
              const scanSnapshot = await readIntradaySnapshot(market as 'TW' | 'CN', scanDate);
              if (scanSnapshot) {
                const sq = scanSnapshot.quotes.find(q => q.symbol === pureCode);
                if (sq && sq.close > 0) {
                  // 插入 scanDate K 棒（按日期順序）
                  const scanCandle = {
                    date: scanDate,
                    open: sq.open || sq.close,
                    high: sq.high || sq.close,
                    low: sq.low || sq.close,
                    close: sq.close,
                    volume: sq.volume || 0,
                  };
                  // 找到插入位置（保持日期升序）
                  const insertIdx = result.candles.findIndex(c => c.date > scanDate);
                  if (insertIdx === -1) {
                    result.candles.push(scanCandle);
                  } else {
                    result.candles.splice(insertIdx, 0, scanCandle);
                  }
                  console.log(`[stock] 補注入 scanDate=${scanDate} K 棒 ${symbol}: close=${sq.close} from L2 snapshot`);
                }
              }
            } catch (err) {
              console.warn(`[stock] scanDate L2 補注入失敗 ${symbol} ${scanDate}:`, err instanceof Error ? err.message : err);
            }
          }
        }

        let withIndicators = computeIndicators(
          result.candles.map(c => ({ date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }))
        );

        // 週K/月K：本地日K聚合（省去 API 請求）+ memory cache
        if (interval === '1wk' || interval === '1mo') {
          // cache key 包含 today close，價格變動時自動失效
          const todayClose = result.candles[result.candles.length - 1]?.close ?? 0;
          const cacheKey = `${symbol}:${interval}:${todayClose}`;
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

    // 台股分鐘 K 線：Fugle intraday（今日盤中資料）
    if (isTW && isMinuteInterval && isFugleAvailable()) {
      try {
        const intradayCandles = await getFugleIntradayCandles(pureCode, interval);
        if (intradayCandles.length > 0) {
          ticker = candidates[0];
          candles = intradayCandles;
        }
      } catch {
        // Fugle 例外，繼續往下
      }
    }

    // MultiMarketProvider 多源備援（日K 主要路徑，或 CN/US 分鐘 K 的備援）
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
