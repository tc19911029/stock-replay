/**
 * TencentRealtime.ts — 騰訊財經即時報價（A 股全市場）
 *
 * 用途：東方財富 push2 API 失敗時的 L2 快照 fallback
 *
 * API: https://qt.gtimg.cn/q=sh600519,sz000001,...
 * 回傳格式（GBK）: v_sh600519="1~貴州茅台~600519~1750.00~1735.00~1740.00~15234~..."
 *
 * 欄位（~分隔）:
 *   [1]=名稱, [2]=代碼, [3]=現價, [4]=昨收, [5]=開盤,
 *   [6]=成交量(手), [30]=最高, [32]=最低
 */

import type { EastMoneyQuote } from './EastMoneyRealtime';

const BATCH_SIZE = 80; // 每次請求最多80支，避免URL過長
const TIMEOUT_MS = 8_000;

/**
 * 將 symbol (000001.SZ / 600519.SS) 轉為騰訊格式 (sz000001 / sh600519)
 */
function toTencentCode(symbol: string): string {
  const code = symbol.split('.')[0];
  // 6/9 開頭 = 上海(sh)，其他 = 深圳(sz)
  return (code[0] === '6' || code[0] === '9') ? `sh${code}` : `sz${code}`;
}

/**
 * 解析騰訊報價字串
 *
 * qt.gtimg.cn 實測欄位（2026-04-17 驗證）：
 *   [2]=代碼, [3]=現價, [4]=昨收, [5]=開盤, [6]=成交量(手)
 *   [30]=成交時間(YYYYMMDDHHMMSS), [31]=漲跌, [32]=漲跌幅%
 *   [33]=最高, [34]=最低
 */
function parseTencentLine(line: string): EastMoneyQuote | null {
  // 提取引號內的內容
  const match = line.match(/="([^"]+)"/);
  if (!match) return null;

  const parts = match[1].split('~');
  if (parts.length < 35) return null;

  const code = parts[2];
  const name = parts[1];
  const close = parseFloat(parts[3]);
  const prevClose = parseFloat(parts[4]);
  const open = parseFloat(parts[5]);
  const volume = parseFloat(parts[6]); // 手（1手=100股=1張），統一以「張」存儲
  const high = parseFloat(parts[33]);
  const low = parseFloat(parts[34]);

  if (!code || !close || close <= 0) return null;
  // 只保留主板
  if (!/^(00[0-3]|60[0135])\d{3}$/.test(code)) return null;

  return {
    code,
    name: name || code,
    open: open > 0 ? open : close,
    high: high > 0 ? high : close,
    low: low > 0 ? low : close,
    close,
    volume: volume > 0 ? volume : 0,
    prevClose: prevClose > 0 ? prevClose : undefined,
  };
}

/**
 * 批量抓取一組股票的即時報價
 */
async function fetchBatch(tencentCodes: string[]): Promise<EastMoneyQuote[]> {
  const url = `https://qt.gtimg.cn/q=${tencentCodes.join(',')}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return [];

    const buf = await res.arrayBuffer();
    const text = new TextDecoder('gbk').decode(buf);

    const quotes: EastMoneyQuote[] = [];
    for (const line of text.split(';')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.length < 10) continue;
      const q = parseTencentLine(trimmed);
      if (q) quotes.push(q);
    }
    return quotes;
  } catch {
    return [];
  }
}

/**
 * 取得全市場 A 股即時報價（騰訊來源）
 * @param symbols  股票清單，格式 "000001.SZ" / "600519.SS"
 * @returns Map<code, EastMoneyQuote>（code = 6位純數字）
 */
export async function getTencentRealtime(
  symbols: string[],
): Promise<Map<string, EastMoneyQuote>> {
  const map = new Map<string, EastMoneyQuote>();

  // 轉換格式
  const tencentCodes = symbols.map(toTencentCode);

  // 分批抓取（每批80支，並行10批）
  const PARALLEL = 10;
  for (let i = 0; i < tencentCodes.length; i += BATCH_SIZE * PARALLEL) {
    const parallelBatches: string[][] = [];
    for (let j = 0; j < PARALLEL; j++) {
      const start = i + j * BATCH_SIZE;
      const batch = tencentCodes.slice(start, start + BATCH_SIZE);
      if (batch.length > 0) parallelBatches.push(batch);
    }

    const results = await Promise.allSettled(
      parallelBatches.map(batch => fetchBatch(batch))
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        for (const q of result.value) {
          map.set(q.code, q);
        }
      }
    }
  }

  return map;
}
