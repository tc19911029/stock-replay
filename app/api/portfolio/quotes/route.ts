import { NextRequest } from 'next/server';
import { getEastMoneyQuote } from '@/lib/datasource/EastMoneyRealtime';
import { apiOk, apiError } from '@/lib/api/response';

// ═══════════════════════════════════════════════════════════════════════════════
// 輕量即時報價 API — 只回傳 price + changePercent，用於持倉 polling
// 支援台股（TWSE mis）+ 陸股（騰訊/東方財富）批次查詢
// ═══════════════════════════════════════════════════════════════════════════════

export interface QuoteTick {
  symbol: string;
  price: number;
  changePercent: number;
}

function parsePrice(s: string): number {
  const v = parseFloat(s);
  return isNaN(v) ? 0 : v;
}

// ── 台股即時報價（TWSE mis API）─────────────────────────────────────────────

async function fetchTWSEQuotes(symbols: string[]): Promise<QuoteTick[]> {
  if (symbols.length === 0) return [];

  const exCh = symbols.map(s => {
    const clean = s.replace(/\.(TW|TWO)$/i, '');
    if (s.toUpperCase().includes('.TWO') || s.toUpperCase().includes('TWO')) {
      return `otc_${clean}.tw`;
    }
    return `tse_${clean}.tw`;
  }).join('|');

  const results: QuoteTick[] = [];

  try {
    const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${exCh}&json=1&delay=0&_=${Date.now()}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000),
    });
    const json = await res.json();

    const found = new Set<string>();
    for (const d of json?.msgArray ?? []) {
      const price = parsePrice(d.z);
      const prevClose = parsePrice(d.y);
      const actualPrice = price > 0 ? price : parsePrice(d.l) || prevClose;
      const changePct = actualPrice > 0 && prevClose > 0
        ? +((actualPrice - prevClose) / prevClose * 100).toFixed(2)
        : 0;

      const sym = d.c as string;
      found.add(sym);

      // Find the original symbol with suffix
      const original = symbols.find(s => s.replace(/\.(TW|TWO)$/i, '') === sym);
      results.push({
        symbol: original ?? `${sym}.TW`,
        price: actualPrice,
        changePercent: changePct,
      });
    }

    // Retry missing as OTC
    const missing = symbols.filter(s => !found.has(s.replace(/\.(TW|TWO)$/i, '')));
    if (missing.length > 0) {
      const otcExCh = missing.map(c => `otc_${c.replace(/\.(TW|TWO)$/i, '')}.tw`).join('|');
      try {
        const otcRes = await fetch(
          `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${otcExCh}&json=1&delay=0&_=${Date.now()}`,
          { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) },
        );
        const otcJson = await otcRes.json();
        for (const d of otcJson?.msgArray ?? []) {
          const price = parsePrice(d.z);
          const prevClose = parsePrice(d.y);
          const actualPrice = price > 0 ? price : parsePrice(d.l) || prevClose;
          const changePct = actualPrice > 0 && prevClose > 0
            ? +((actualPrice - prevClose) / prevClose * 100).toFixed(2)
            : 0;
          const sym = d.c as string;
          const original = missing.find(s => s.replace(/\.(TW|TWO)$/i, '') === sym);
          results.push({
            symbol: original ?? `${sym}.TWO`,
            price: actualPrice,
            changePercent: changePct,
          });
        }
      } catch { /* OTC retry failed */ }
    }
  } catch { /* TWSE failed */ }

  return results;
}

// ── 陸股即時報價（騰訊 → 東方財富 fallback）────────────────────────────────

async function fetchCNQuotes(symbols: string[]): Promise<QuoteTick[]> {
  if (symbols.length === 0) return [];

  const results: QuoteTick[] = [];

  await Promise.allSettled(symbols.map(async (sym) => {
    const code = sym.replace(/\.(SS|SZ)$/i, '');
    try {
      const quote = await getEastMoneyQuote(code);
      if (quote && quote.close > 0) {
        // 騰訊 API 沒有直接回 prevClose，用 open 做近似（或從快取推算）
        // getEastMoneyQuote 回傳 close=最新價, open=開盤
        // 漲跌幅只能用 (close - open)/open 近似，除非我們另外取 prevClose
        // 改用騰訊 API 直接取 prevClose
        const prevClose = await fetchCNPrevClose(code);
        const changePct = prevClose > 0
          ? +((quote.close - prevClose) / prevClose * 100).toFixed(2)
          : 0;

        results.push({
          symbol: sym,
          price: quote.close,
          changePercent: changePct,
        });
      }
    } catch { /* skip failed symbol */ }
  }));

  return results;
}

/** 騰訊 API 取 prevClose（昨收）*/
async function fetchCNPrevClose(code: string): Promise<number> {
  try {
    const prefix = code[0] === '6' || code[0] === '9' ? 'sh' : 'sz';
    const url = `https://qt.gtimg.cn/q=${prefix}${code}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const text = await res.text();
    const match = text.match(/="(.+)"/);
    if (!match) return 0;
    const f = match[1].split('~');
    return parseFloat(f[4]) || 0; // f[4] = 昨收
  } catch {
    return 0;
  }
}

// ── Route Handler ────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbolsParam = searchParams.get('symbols');

  if (!symbolsParam) {
    return apiError('symbols required', 400);
  }

  const symbols = symbolsParam.split(',').map(s => s.trim()).filter(Boolean).slice(0, 50);
  if (symbols.length === 0) {
    return apiError('no valid symbols', 400);
  }

  // 分類台股 / 陸股
  const twSymbols = symbols.filter(s => /\.(TW|TWO)$/i.test(s));
  const cnSymbols = symbols.filter(s => /\.(SS|SZ)$/i.test(s));

  // 並行抓取
  const [twQuotes, cnQuotes] = await Promise.all([
    fetchTWSEQuotes(twSymbols),
    fetchCNQuotes(cnSymbols),
  ]);

  const quotes = [...twQuotes, ...cnQuotes];

  return apiOk(
    { quotes },
    { headers: { 'Cache-Control': 'max-age=15, stale-while-revalidate=30' } },
  );
}
