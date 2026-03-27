import { NextRequest, NextResponse } from 'next/server';
import type { IntradayTimeframe } from '@/lib/daytrade/types';
import { getTWChineseName } from '@/lib/datasource/TWSENames';
import { unixToTW, todayTW } from '@/lib/timezone';

/**
 * API Route: /api/daytrade/intraday-data?symbol=6770&timeframe=5m&todayOnly=1
 *
 * 使用 Yahoo Finance 真實分鐘數據，時間已轉換為台灣時間 (UTC+8)
 */

const TF_TO_YAHOO: Record<string, { interval: string; range: string }> = {
  '1m':  { interval: '1m',  range: '5d' },
  '3m':  { interval: '5m',  range: '5d' },
  '5m':  { interval: '5m',  range: '5d' },
  '15m': { interval: '15m', range: '5d' },
  '30m': { interval: '30m', range: '5d' },
  '60m': { interval: '60m', range: '1mo' },
  '1d':  { interval: '1d',  range: '1y' },
  '1wk': { interval: '1wk', range: '2y' },
  '1mo': { interval: '1mo', range: '5y' },
};

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbol    = searchParams.get('symbol') ?? '2330';
  const timeframe = (searchParams.get('timeframe') ?? '5m') as IntradayTimeframe;
  const todayOnly = searchParams.get('todayOnly') === '1';

  if (!TF_TO_YAHOO[timeframe]) {
    return NextResponse.json({ error: 'Invalid timeframe' }, { status: 400 });
  }

  const isTwDigits = /^\d{4,5}$/.test(symbol);
  let candidates: string[];
  if (isTwDigits) {
    candidates = [`${symbol}.TW`, `${symbol}.TWO`];
  } else if (/^\d{6}$/.test(symbol)) {
    candidates = symbol[0] === '6' ? [`${symbol}.SS`, `${symbol}.SZ`] : [`${symbol}.SZ`, `${symbol}.SS`];
  } else {
    candidates = [symbol.toUpperCase()];
  }

  const { interval, range } = TF_TO_YAHOO[timeframe];

  async function fetchYahoo(ticker: string) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}&includePrePost=false`;
    return fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });
  }

  try {
    let res = await fetchYahoo(candidates[0]);
    let ticker = candidates[0];

    if (!res.ok && candidates.length > 1) {
      const res2 = await fetchYahoo(candidates[1]);
      if (res2.ok) { res = res2; ticker = candidates[1]; }
    }

    if (!res.ok) {
      return NextResponse.json({ error: `找不到 ${symbol} 的分鐘數據` }, { status: 502 });
    }

    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) {
      return NextResponse.json({ error: '無分鐘數據' }, { status: 404 });
    }

    const timestamps: number[] = result.timestamp ?? [];
    const q = result.indicators.quote[0];
    const meta = result.meta;

    // Build candles with Taiwan time
    let candles = timestamps
      .map((ts, i) => {
        const o = q.open[i];
        const h = q.high[i];
        const l = q.low[i];
        const c = q.close[i];
        const v = q.volume[i];
        if (o == null || h == null || l == null || c == null || isNaN(o)) return null;
        return {
          time: unixToTW(ts),
          open:   +o.toFixed(2),
          high:   +h.toFixed(2),
          low:    +l.toFixed(2),
          close:  +c.toFixed(2),
          volume: v ?? 0,
          timeframe,
        };
      })
      .filter(Boolean) as Array<{ time: string; open: number; high: number; low: number; close: number; volume: number; timeframe: string }>;

    // 只保留今日數據
    if (todayOnly && candles.length > 0) {
      // 找最後一個交易日
      const lastDate = candles[candles.length - 1].time.split('T')[0];
      candles = candles.filter(c => c.time.split('T')[0] === lastDate);
    }

    // 過濾台股交易時間 09:00-13:30（僅分鐘級）
    const isIntraday = ['1m','3m','5m','15m','30m','60m'].includes(timeframe);
    if (isTwDigits && isIntraday) {
      candles = candles.filter(c => {
        const hm = c.time.split('T')[1];
        if (!hm) return true;
        const hour = parseInt(hm.split(':')[0]);
        const min = parseInt(hm.split(':')[1]);
        const totalMin = hour * 60 + min;
        return totalMin >= 540 && totalMin <= 810; // 09:00 ~ 13:30
      });
    }

    // 找可用的日期列表
    const availableDates = [...new Set(candles.map(c => c.time.split('T')[0]))].sort();

    // Get name
    let name = meta.longName ?? meta.shortName ?? ticker;
    if (isTwDigits) {
      const twName = await getTWChineseName(symbol).catch(() => null);
      if (twName) name = twName;
    }

    return NextResponse.json({
      symbol,
      ticker,
      name,
      timeframe,
      count: candles.length,
      candles,
      availableDates,
      lastDate: availableDates[availableDates.length - 1] ?? null,
    });
  } catch (e) {
    return NextResponse.json({ error: `取得數據失敗: ${String(e)}` }, { status: 500 });
  }
}
