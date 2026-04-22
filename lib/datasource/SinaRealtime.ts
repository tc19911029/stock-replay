/**
 * SinaRealtime.ts — 新浪財經即時報價（A 股全市場）
 *
 * 用途：EastMoney + Tencent 都失敗時的第三層 fallback
 *
 * API: https://hq.sinajs.cn/list=sh600519,sz000001,...
 * 需要 Referer: https://finance.sina.com.cn（否則被 WAF 擋）
 * 回傳格式（GBK）: var hq_str_sh600519="贵州茅台,1415.000,1412.010,1406.120,1419.000,1406.000,...";
 *
 * 欄位（逗號分隔，索引 0 起）:
 *   [0]=名稱, [1]=開盤, [2]=昨收, [3]=現價, [4]=最高, [5]=最低,
 *   [8]=成交量(股), [9]=成交額(元), [30]=日期, [31]=時間
 */

import type { EastMoneyQuote } from './EastMoneyRealtime';

const BATCH_SIZE = 80;
const TIMEOUT_MS = 8_000;

function toSinaCode(symbol: string): string {
  const code = symbol.split('.')[0];
  return (code[0] === '6' || code[0] === '9') ? `sh${code}` : `sz${code}`;
}

function parseSinaLine(line: string): EastMoneyQuote | null {
  // var hq_str_sh600519="贵州茅台,1415.000,...";
  const codeMatch = line.match(/hq_str_(sh|sz)(\d{6})="([^"]*)"/);
  if (!codeMatch) return null;
  const code = codeMatch[2];
  const payload = codeMatch[3];
  if (!payload) return null;

  const parts = payload.split(',');
  if (parts.length < 32) return null;

  const name = parts[0];
  const open = parseFloat(parts[1]);
  const prevClose = parseFloat(parts[2]);
  const close = parseFloat(parts[3]);
  const high = parseFloat(parts[4]);
  const low = parseFloat(parts[5]);
  // 新浪成交量單位為「股」，直接存儲（東財/騰訊已各自 ×100 轉為「股」）
  const volumeShares = parseFloat(parts[8]);
  const volume = volumeShares > 0 ? Math.round(volumeShares) : 0;

  if (!close || close <= 0) return null;
  // 只保留主板
  if (!/^(00[0-3]|60[0135])\d{3}$/.test(code)) return null;

  return {
    code,
    name: name || code,
    open: open > 0 ? open : close,
    high: high > 0 ? high : close,
    low: low > 0 ? low : close,
    close,
    volume,
    prevClose: prevClose > 0 ? prevClose : undefined,
  };
}

async function fetchBatch(sinaCodes: string[]): Promise<EastMoneyQuote[]> {
  const url = `https://hq.sinajs.cn/list=${sinaCodes.join(',')}`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://finance.sina.com.cn',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return [];

    const buf = await res.arrayBuffer();
    const text = new TextDecoder('gbk').decode(buf);

    const quotes: EastMoneyQuote[] = [];
    for (const line of text.split(';')) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('var hq_str_')) continue;
      const q = parseSinaLine(trimmed);
      if (q) quotes.push(q);
    }
    return quotes;
  } catch {
    return [];
  }
}

/**
 * 取得全市場 A 股即時報價（新浪來源）
 * @param symbols  股票清單，格式 "000001.SZ" / "600519.SS"
 */
export async function getSinaRealtime(
  symbols: string[],
): Promise<Map<string, EastMoneyQuote>> {
  const map = new Map<string, EastMoneyQuote>();
  const sinaCodes = symbols.map(toSinaCode);

  const PARALLEL = 10;
  for (let i = 0; i < sinaCodes.length; i += BATCH_SIZE * PARALLEL) {
    const parallelBatches: string[][] = [];
    for (let j = 0; j < PARALLEL; j++) {
      const start = i + j * BATCH_SIZE;
      const batch = sinaCodes.slice(start, start + BATCH_SIZE);
      if (batch.length > 0) parallelBatches.push(batch);
    }

    const results = await Promise.allSettled(
      parallelBatches.map(b => fetchBatch(b)),
    );

    for (const r of results) {
      if (r.status === 'fulfilled') {
        for (const q of r.value) map.set(q.code, q);
      }
    }
  }

  return map;
}
