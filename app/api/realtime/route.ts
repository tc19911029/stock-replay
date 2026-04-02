import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';

// ═══════════════════════════════════════════════════════════════════════════════
// TWSE 即時報價 API — 延遲約 5-15 秒（盤中）
// 來源：mis.twse.com.tw（證交所官方）
// ═══════════════════════════════════════════════════════════════════════════════

export interface RealtimeQuote {
  symbol: string;
  name: string;
  price: number;       // 最新成交價
  open: number;        // 開盤價
  high: number;        // 最高價
  low: number;         // 最低價
  prevClose: number;   // 昨收
  change: number;      // 漲跌
  changePct: number;   // 漲跌幅 %
  volume: number;      // 成交量（張，mis.twse.com.tw d.v 單位為張=1000股）
  time: string;        // 成交時間 HH:MM:SS
}

const realtimeQuerySchema = z.object({
  symbols: z.string().min(1),
});

function parsePrice(s: string): number {
  const v = parseFloat(s);
  return isNaN(v) ? 0 : v;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const parsed = realtimeQuerySchema.safeParse(Object.fromEntries(searchParams));
  if (!parsed.success) {
    return apiValidationError(parsed.error);
  }
  const { symbols } = parsed.data;

  const codes = symbols.split(',').map(s => s.trim()).filter(Boolean).slice(0, 50); // 最多 50 支
  if (codes.length === 0) {
    return apiError('no valid symbols', 400);
  }

  // TWSE 格式：tse_2330.tw|tse_2317.tw|otc_6770.tw
  // 上市用 tse_，上櫃用 otc_
  // 簡單判斷：4位數字通常是上市，但也有例外。先全用 tse_ 試，失敗再用 otc_
  const exCh = codes.map(c => {
    const clean = c.replace(/\.(TW|TWO)$/i, '');
    // 如果原始 symbol 有 .TWO 後綴，用 otc
    if (c.toUpperCase().includes('.TWO') || c.toUpperCase().includes('TWO')) {
      return `otc_${clean}.tw`;
    }
    return `tse_${clean}.tw`;
  }).join('|');

  try {
    const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${exCh}&json=1&delay=0&_=${Date.now()}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000),
    });
    const json = await res.json();

    const quotes: RealtimeQuote[] = [];
    for (const d of json?.msgArray ?? []) {
      const price = parsePrice(d.z);  // 最新成交價（盤中可能是 '-'）
      const prevClose = parsePrice(d.y);
      const actualPrice = price > 0 ? price : parsePrice(d.l) || prevClose; // fallback

      quotes.push({
        symbol: d.c,
        name: d.n?.trim() || '',
        price: actualPrice,
        open: parsePrice(d.o),
        high: parsePrice(d.h),
        low: parsePrice(d.l),
        prevClose,
        change: actualPrice > 0 && prevClose > 0 ? +(actualPrice - prevClose).toFixed(2) : 0,
        changePct: actualPrice > 0 && prevClose > 0 ? +((actualPrice - prevClose) / prevClose * 100).toFixed(2) : 0,
        volume: parseInt(d.v?.replace(/,/g, '') || '0', 10),
        time: d.t || '',
      });
    }

    // 如果有些股票用 tse_ 查不到，可能是上櫃股，用 otc_ 重試
    const found = new Set(quotes.map(q => q.symbol));
    const missing = codes.filter(c => !found.has(c.replace(/\.(TW|TWO)$/i, '')));

    if (missing.length > 0) {
      const otcExCh = missing.map(c => `otc_${c.replace(/\.(TW|TWO)$/i, '')}.tw`).join('|');
      try {
        const otcRes = await fetch(`https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${otcExCh}&json=1&delay=0&_=${Date.now()}`, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(8000),
        });
        const otcJson = await otcRes.json();
        for (const d of otcJson?.msgArray ?? []) {
          const price = parsePrice(d.z);
          const prevClose = parsePrice(d.y);
          const actualPrice = price > 0 ? price : parsePrice(d.l) || prevClose;
          quotes.push({
            symbol: d.c,
            name: d.n?.trim() || '',
            price: actualPrice,
            open: parsePrice(d.o),
            high: parsePrice(d.h),
            low: parsePrice(d.l),
            prevClose,
            change: actualPrice > 0 && prevClose > 0 ? +(actualPrice - prevClose).toFixed(2) : 0,
            changePct: actualPrice > 0 && prevClose > 0 ? +((actualPrice - prevClose) / prevClose * 100).toFixed(2) : 0,
            volume: parseInt(d.v?.replace(/,/g, '') || '0', 10),
            time: d.t || '',
          });
        }
      } catch { /* OTC retry failed, skip */ }
    }

    return apiOk({ count: quotes.length, quotes });
  } catch (e) {
    return apiError(String(e));
  }
}
