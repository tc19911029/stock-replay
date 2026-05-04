import { NextRequest } from 'next/server';
import { getEastMoneyQuote } from '@/lib/datasource/EastMoneyRealtime';
import { getFugleQuote, isFugleAvailable } from '@/lib/datasource/FugleProvider';
import { readIntradaySnapshot } from '@/lib/datasource/IntradayCache';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { apiOk, apiError } from '@/lib/api/response';

// mis.twse 需要 Referer=fibest.jsp，否則 WAF 回空 msgArray（2026-04-21）
const MIS_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://mis.twse.com.tw/stock/fibest.jsp',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
};

// ═══════════════════════════════════════════════════════════════════════════════
// 輕量即時報價 API — 只回傳 price + changePercent，用於持倉 polling
// 支援台股（TWSE mis）+ 陸股（騰訊/東方財富）批次查詢
// ═══════════════════════════════════════════════════════════════════════════════

export interface QuoteTick {
  symbol: string;
  price: number;
  changePercent: number;
  name?: string;
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
      headers: MIS_HEADERS,
      signal: AbortSignal.timeout(10000),
    });
    const json = await res.json();

    const found = new Set<string>();
    for (const d of json?.msgArray ?? []) {
      const sym = (d.c as string) || '';
      const price = parsePrice(d.z);
      const prevClose = parsePrice(d.y);
      const actualPrice = price > 0 ? price : parsePrice(d.l) || prevClose;

      // mis 對不存在的 channel（例如 6187 上櫃但被送 tse_）會回 d.c="" + 全 0 的空殼，
      // 直接跳過避免產生 ".TW" / ".TWO" 空殼結果
      if (!sym || actualPrice <= 0) continue;

      const changePct = prevClose > 0
        ? +((actualPrice - prevClose) / prevClose * 100).toFixed(2)
        : 0;

      found.add(sym);

      // Find the original symbol with suffix
      const original = symbols.find(s => s.replace(/\.(TW|TWO)$/i, '') === sym);
      results.push({
        symbol: original ?? `${sym}.TW`,
        price: actualPrice,
        changePercent: changePct,
        name: d.n as string || undefined,
      });
    }

    // Retry missing as OTC
    const missing = symbols.filter(s => !found.has(s.replace(/\.(TW|TWO)$/i, '')));
    if (missing.length > 0) {
      const otcExCh = missing.map(c => `otc_${c.replace(/\.(TW|TWO)$/i, '')}.tw`).join('|');
      try {
        const otcRes = await fetch(
          `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${otcExCh}&json=1&delay=0&_=${Date.now()}`,
          { headers: MIS_HEADERS, signal: AbortSignal.timeout(8000) },
        );
        const otcJson = await otcRes.json();
        for (const d of otcJson?.msgArray ?? []) {
          const sym = (d.c as string) || '';
          const price = parsePrice(d.z);
          const prevClose = parsePrice(d.y);
          const actualPrice = price > 0 ? price : parsePrice(d.l) || prevClose;
          if (!sym || actualPrice <= 0) continue;
          const changePct = prevClose > 0
            ? +((actualPrice - prevClose) / prevClose * 100).toFixed(2)
            : 0;
          const original = missing.find(s => s.replace(/\.(TW|TWO)$/i, '') === sym);
          results.push({
            symbol: original ?? `${sym}.TWO`,
            price: actualPrice,
            changePercent: changePct,
            name: d.n as string || undefined,
          });
        }
      } catch { /* OTC retry failed */ }
    }
  } catch { /* TWSE failed */ }

  // Fallback 1: Fugle（mis.twse 空回應時救場）
  const stillMissing = symbols.filter(
    s => !results.some(r => r.symbol.replace(/\.(TW|TWO)$/i, '') === s.replace(/\.(TW|TWO)$/i, '')),
  );
  if (stillMissing.length > 0 && isFugleAvailable()) {
    await Promise.allSettled(stillMissing.map(async (sym) => {
      const code = sym.replace(/\.(TW|TWO)$/i, '');
      try {
        const fq = await getFugleQuote(code);
        if (fq && fq.close > 0) {
          const changePct = fq.changePercent ?? (
            fq.prevClose && fq.prevClose > 0
              ? +((fq.close - fq.prevClose) / fq.prevClose * 100).toFixed(2)
              : 0
          );
          results.push({ symbol: sym, price: fq.close, changePercent: changePct, name: fq.name || undefined });
        }
      } catch { /* Fugle fallback failed */ }
    }));
  }

  // Fallback 2: L2 快照（Fugle 也失敗時用盤中快照）
  const afterFugle = symbols.filter(
    s => !results.some(r => r.symbol.replace(/\.(TW|TWO)$/i, '') === s.replace(/\.(TW|TWO)$/i, '')),
  );
  if (afterFugle.length > 0) {
    try {
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
      const snap = await readIntradaySnapshot('TW', today);
      if (snap) {
        for (const sym of afterFugle) {
          const code = sym.replace(/\.(TW|TWO)$/i, '');
          const q = snap.quotes.find(qq => qq.symbol === code);
          if (q && q.close > 0) {
            results.push({ symbol: sym, price: q.close, changePercent: q.changePercent ?? 0, name: q.name || undefined });
          }
        }
      }
    } catch { /* L2 fallback failed */ }
  }

  return results;
}

// ── 陸股即時報價（騰訊 → 東方財富 fallback）────────────────────────────────

/** 騰訊一次拿 close+prevClose+name；EastMoney clist 收盤後 f2 不等於日K收盤（疑似盤後參考價），改 fallback */
async function fetchCNTencentQuote(code: string): Promise<{ close: number; prevClose: number; name: string } | null> {
  try {
    const prefix = code[0] === '6' || code[0] === '9' ? 'sh' : 'sz';
    const url = `https://qt.gtimg.cn/q=${prefix}${code}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const buf = await res.arrayBuffer();
    const text = new TextDecoder('gbk').decode(buf);
    const match = text.match(/="(.+)"/);
    if (!match) return null;
    const f = match[1].split('~');
    const close = parseFloat(f[3]) || 0;
    const prevClose = parseFloat(f[4]) || 0;
    const name = f[1] || '';
    if (close <= 0) return null;
    return { close, prevClose, name };
  } catch {
    return null;
  }
}

async function fetchCNQuotes(symbols: string[]): Promise<QuoteTick[]> {
  if (symbols.length === 0) return [];

  const results: QuoteTick[] = [];

  await Promise.allSettled(symbols.map(async (sym) => {
    const code = sym.replace(/\.(SS|SZ)$/i, '');

    // Tencent 優先：close 與日K收盤一致
    const tencent = await fetchCNTencentQuote(code);
    if (tencent && tencent.close > 0) {
      const changePct = tencent.prevClose > 0
        ? +((tencent.close - tencent.prevClose) / tencent.prevClose * 100).toFixed(2)
        : 0;
      results.push({
        symbol: sym,
        price: tencent.close,
        changePercent: changePct,
        name: tencent.name || undefined,
      });
      return;
    }

    // Fallback: EastMoney
    try {
      const cnSuffix = /\.SS$/i.test(sym) ? 'SS' : /\.SZ$/i.test(sym) ? 'SZ' : undefined;
      const quote = await getEastMoneyQuote(code, cnSuffix);
      if (quote && quote.close > 0) {
        const prevClose = quote.prevClose ?? 0;
        const changePct = prevClose > 0
          ? +((quote.close - prevClose) / prevClose * 100).toFixed(2)
          : 0;
        results.push({
          symbol: sym,
          price: quote.close,
          changePercent: changePct,
          name: quote.name || undefined,
        });
      }
    } catch { /* skip failed symbol */ }
  }));

  return results;
}

// ── Route Handler ────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbolsParam = searchParams.get('symbols');

  if (!symbolsParam) {
    return apiError('symbols required', 400);
  }

  const rawSymbols = symbolsParam.split(',').map(s => s.trim()).filter(Boolean).slice(0, 50);
  if (rawSymbols.length === 0) {
    return apiError('no valid symbols', 400);
  }

  // 對沒有後綴的 symbol 依位數猜市場，並記住原始 key 以便回傳格式一致
  type SymbolEntry = { original: string; resolved: string; market: 'TW' | 'CN' | 'unknown' };
  const entries: SymbolEntry[] = rawSymbols.map(s => {
    if (/\.(TW|TWO)$/i.test(s)) return { original: s, resolved: s, market: 'TW' };
    if (/\.(SS|SZ)$/i.test(s)) return { original: s, resolved: s, market: 'CN' };
    const digits = s.replace(/\D/g, '');
    if (/^\d{6}$/.test(digits)) {
      const suffix = digits[0] === '6' || digits[0] === '9' ? 'SS' : 'SZ';
      return { original: s, resolved: `${digits}.${suffix}`, market: 'CN' };
    }
    if (/^\d{4,5}$/.test(digits)) {
      return { original: s, resolved: `${digits}.TWO`, market: 'TW' };
    }
    return { original: s, resolved: s, market: 'unknown' };
  });

  const twEntries = entries.filter(e => e.market === 'TW');
  const cnEntries = entries.filter(e => e.market === 'CN');

  // 並行抓取（傳入 resolved symbol，結果 symbol 改回 original）
  const [twQuotes, cnQuotes] = await Promise.all([
    fetchTWSEQuotes(twEntries.map(e => e.resolved)).then(qs =>
      qs.map(q => {
        const entry = twEntries.find(e => e.resolved.replace(/\.(TW|TWO)$/i, '') === q.symbol.replace(/\.(TW|TWO)$/i, ''));
        return entry ? { ...q, symbol: entry.original } : q;
      })
    ),
    fetchCNQuotes(cnEntries.map(e => e.resolved)).then(qs =>
      qs.map(q => {
        const entry = cnEntries.find(e => e.resolved.replace(/\.(SS|SZ)$/i, '') === q.symbol.replace(/\.(SS|SZ)$/i, ''));
        return entry ? { ...q, symbol: entry.original } : q;
      })
    ),
  ]);

  const quotes = [...twQuotes, ...cnQuotes];

  // CN L2 快照補漏（EastMoney/騰訊掛掉時 + 週末/假日無 live 報價時）
  const missingCN = cnEntries.filter(
    e => !quotes.some(q => q.symbol === e.original),
  );
  if (missingCN.length > 0) {
    // 週末/假日：用最近交易日；交易日：用今天（盤中快照可能還沒寫成今天）
    const todayCN = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
    const lookupCN = isTradingDay(todayCN, 'CN') ? todayCN : getLastTradingDay('CN');
    try {
      const cnSnap = await readIntradaySnapshot('CN', lookupCN);
      if (cnSnap) {
        for (const e of missingCN) {
          const code = e.resolved.replace(/\.(SS|SZ)$/i, '');
          const q = cnSnap.quotes.find(qq => qq.symbol === code);
          if (q && q.close > 0) {
            quotes.push({ symbol: e.original, price: q.close, changePercent: q.changePercent ?? 0, name: q.name || undefined });
          }
        }
      }
    } catch { /* CN L2 fallback failed */ }
  }

  // TW L2 快照補漏（同樣邏輯：週末/假日先補 L2）
  const missingTW = twEntries.filter(
    e => !quotes.some(q => q.symbol === e.original),
  );
  if (missingTW.length > 0) {
    const todayTW = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
    const lookupTW = isTradingDay(todayTW, 'TW') ? todayTW : getLastTradingDay('TW');
    try {
      const twSnap = await readIntradaySnapshot('TW', lookupTW);
      if (twSnap) {
        for (const e of missingTW) {
          const code = e.resolved.replace(/\.(TW|TWO)$/i, '');
          const q = twSnap.quotes.find(qq => qq.symbol === code);
          if (q && q.close > 0) {
            quotes.push({ symbol: e.original, price: q.close, changePercent: q.changePercent ?? 0, name: q.name || undefined });
          }
        }
      }
    } catch { /* TW L2 fallback failed */ }
  }

  return apiOk(
    { quotes },
    { headers: { 'Cache-Control': 'max-age=15, stale-while-revalidate=30' } },
  );
}
