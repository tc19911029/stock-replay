import { NextRequest, NextResponse } from 'next/server';
import { getTWChineseName, getCNChineseName } from '@/lib/datasource/TWSENames';
import { unixToTW } from '@/lib/timezone';
import { getTWSEQuote } from '@/lib/datasource/TWSERealtime';

/**
 * API Route: /api/stock?symbol=2330&interval=1d&period=2y
 *
 * interval: 1d (日K) | 1wk (週K) | 1mo (月K)
 * period:   1y | 2y | 3y | 5y | 10y
 *
 * Taiwan stocks: pure digits → append .TW automatically
 * US stocks: use ticker directly (AAPL, TSLA, etc.)
 */

// Valid combinations for Yahoo Finance
const PERIOD_MAP: Record<string, string> = {
  '1d_1y':  '1y',
  '1d_2y':  '2y',
  '1d_3y':  '3y',
  '1d_5y':  '5y',
  '1wk_2y': '2y',
  '1wk_5y': '5y',
  '1wk_10y':'10y',
  '1mo_5y': '5y',
  '1mo_10y':'10y',
  '1mo_20y':'20y',
};

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbol   = searchParams.get('symbol')   ?? '';
  const interval = searchParams.get('interval') ?? '1d';
  const period   = searchParams.get('period')   ?? '2y';

  if (!symbol) {
    return NextResponse.json({ error: 'Missing symbol' }, { status: 400 });
  }

  // Taiwan: 4-digit (main board) or 5-digit (OTC)
  const isTwDigits = /^\d{4,5}$/.test(symbol) || /^\d{4,5}\.(TW|TWO)$/i.test(symbol);
  // China A-shares: exactly 6 digits, or with .SZ/.SS suffix
  const isCnDigits = /^\d{6}$/.test(symbol) || /^\d{6}\.(SZ|SS)$/i.test(symbol);

  // 提取純數字代碼（去掉 .SZ/.SS/.TW/.TWO 後綴）
  const pureCode = symbol.replace(/\.(SZ|SS|TW|TWO)$/i, '');

  let candidates: string[];
  if (isCnDigits) {
    if (/\.(SZ|SS)$/i.test(symbol)) {
      // 已帶後綴，直接用
      candidates = [symbol.toUpperCase()];
    } else {
      const firstDigit = pureCode[0];
      if (firstDigit === '6' || firstDigit === '9') {
        candidates = [`${pureCode}.SS`, `${pureCode}.SZ`];
      } else {
        candidates = [`${pureCode}.SZ`, `${pureCode}.SS`];
      }
    }
  } else if (isTwDigits) {
    if (/\.(TW|TWO)$/i.test(symbol)) {
      candidates = [symbol.toUpperCase()];
    } else {
      candidates = [`${pureCode}.TW`, `${pureCode}.TWO`];
    }
  } else {
    candidates = [symbol.toUpperCase()];
  }

  async function fetchYahoo(ticker: string) {
    const url = [
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`,
      `?interval=${interval}`,
      `&range=${period}`,
      `&includePrePost=false`,
    ].join('');
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(30000),
    });
    return res;
  }

  try {
    let res = await fetchYahoo(candidates[0]);
    let ticker = candidates[0];

    // If first candidate fails and we have a fallback, try it
    if (!res.ok && candidates.length > 1) {
      const res2 = await fetchYahoo(candidates[1]);
      if (res2.ok) {
        res   = res2;
        ticker = candidates[1];
      }
    }

    if (!res.ok) {
      return NextResponse.json(
        { error: `找不到股票代號 ${symbol}。台股格式：2330（上市）/8299（上櫃）、陸股：603986（上海）/000858（深圳）、美股：AAPL` },
        { status: 502 }
      );
    }

    const json = await res.json();
    const result = json?.chart?.result?.[0];

    if (!result) {
      return NextResponse.json(
        { error: '找不到該股票資料，請確認代號。台股格式：2330（上市）/8299（上櫃）、陸股：603986（上海）/000858（深圳）、美股：AAPL' },
        { status: 404 }
      );
    }

    const timestamps: number[] = result.timestamp ?? [];
    const q = result.indicators.quote[0];

    // Build candles, skip null/zero-volume bars
    const candles = timestamps
      .map((ts, i) => {
        const o = q.open[i];
        const h = q.high[i];
        const l = q.low[i];
        const c = q.close[i];
        const v = q.volume[i];
        if (o == null || h == null || l == null || c == null || isNaN(o)) return null;
        return {
          date:   unixToTW(ts).split('T')[0],
          open:   +o.toFixed(2),
          high:   +h.toFixed(2),
          low:    +l.toFixed(2),
          close:  +c.toFixed(2),
          volume: v ?? 0,
        };
      })
      .filter(Boolean);

    if (candles.length === 0) {
      return NextResponse.json({ error: '資料為空，請嘗試其他期間' }, { status: 404 });
    }

    // 台股即時報價覆蓋：用 TWSE/TPEx 即時 OHLCV 取代 Yahoo 延遲數據
    if (isTwDigits && interval === '1d') {
      try {
        const quote = await getTWSEQuote(pureCode);
        if (quote && quote.close > 0) {
          const todayStr = new Date(Date.now() + 8 * 3600_000).toISOString().split('T')[0];
          const lastCandle = candles[candles.length - 1] as { date: string; open: number; high: number; low: number; close: number; volume: number } | undefined;
          if (lastCandle) {
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
          }
        }
      } catch { /* TWSE 失敗不影響主流程 */ }
    }

    const meta     = result.meta;
    const yahooName = meta.longName ?? meta.shortName ?? ticker;
    const currency  = meta.currency ?? '';

    // 台灣股票優先使用 TWSE/TPEx 中文名稱（動態查詢，快取24h）
    // A股優先使用靜態中文名稱對照表
    let name = yahooName;
    if (isTwDigits) {
      const twName = await getTWChineseName(pureCode).catch(() => null);
      if (twName) name = twName;
    } else if (isCnDigits) {
      const cnName = await getCNChineseName(pureCode);
      if (cnName) name = cnName;
    }

    return NextResponse.json({
      ticker,
      name,
      currency,
      interval,
      candles,
      totalBars: candles.length,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `伺服器錯誤：${msg}` }, { status: 500 });
  }
}
