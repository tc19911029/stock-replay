/**
 * L1SpotCheck — L1 每日自動抽查
 *
 * L2→L1 注入或 API 下載後，隨機抽 20 支從獨立數據源（Yahoo）
 * 抓取今日收盤價比對，確保寫入 L1 的數據是正確的。
 *
 * 設計原則：
 *   - 抽樣而非全量（20 支 < 10 秒）
 *   - 只比對今日 K 棒的收盤價（最關鍵的數字）
 *   - 告警但不阻塞（non-fatal）
 */

import { readCandleFile } from './CandleStorageAdapter';

export interface SpotCheckResult {
  market: 'TW' | 'CN';
  date: string;
  sampleSize: number;
  checked: number;
  passed: number;
  failed: number;
  failRate: number;
  suspicious: boolean;
  details: { symbol: string; l1Close: number; refClose: number; diffPct: number }[];
}

const SPOT_CHECK_SAMPLE = 20;
const SPOT_CHECK_TOLERANCE = 0.01; // 1% 偏差容忍
const SPOT_CHECK_ALERT_THRESHOLD = 5; // 超過 5 支不一致則告警

/**
 * 從 Yahoo Finance 抓取單支股票今日收盤價
 */
async function fetchYahooClose(symbol: string, market: 'TW' | 'CN'): Promise<number | null> {
  const yahooSymbol = market === 'TW'
    ? `${symbol}.TW`
    : symbol.startsWith('6') || symbol.startsWith('9')
      ? `${symbol}.SS`
      : `${symbol}.SZ`;

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=5d&includePrePost=false`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;

    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;

    const closes = result.indicators?.quote?.[0]?.close;
    if (!closes || closes.length === 0) return null;

    // 取最後一根有效收盤價
    for (let i = closes.length - 1; i >= 0; i--) {
      if (closes[i] != null && closes[i] > 0) return closes[i];
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * L1 抽查：隨機抽 N 支，比對 L1 收盤價 vs Yahoo 收盤價
 *
 * @param market 市場
 * @param date 要抽查的日期（通常是今日）
 * @param symbols 全市場股票代碼清單（從中抽樣）
 */
export async function spotCheckL1(
  market: 'TW' | 'CN',
  date: string,
  symbols: string[],
): Promise<SpotCheckResult> {
  // 隨機抽樣
  const shuffled = [...symbols].sort(() => Math.random() - 0.5);
  const sample = shuffled.slice(0, SPOT_CHECK_SAMPLE);

  const details: SpotCheckResult['details'] = [];
  let checked = 0;
  let passed = 0;
  let failed = 0;

  // 並發抽查（每批 5 支避免限流）
  const BATCH = 5;
  for (let i = 0; i < sample.length; i += BATCH) {
    const batch = sample.slice(i, i + BATCH);
    await Promise.allSettled(
      batch.map(async (symbol) => {
        // 讀 L1
        const l1Data = await readCandleFile(symbol, market);
        if (!l1Data || l1Data.lastDate !== date) return; // L1 沒有今日數據，跳過

        const lastCandle = l1Data.candles[l1Data.candles.length - 1];
        if (!lastCandle || lastCandle.date !== date) return;

        // 從 Yahoo 抓
        const refClose = await fetchYahooClose(symbol, market);
        if (!refClose) return; // Yahoo 沒數據，跳過

        checked++;
        const diffPct = Math.abs(lastCandle.close - refClose) / refClose;

        if (diffPct <= SPOT_CHECK_TOLERANCE) {
          passed++;
        } else {
          failed++;
          details.push({
            symbol,
            l1Close: lastCandle.close,
            refClose: Math.round(refClose * 100) / 100,
            diffPct: Math.round(diffPct * 10000) / 100,
          });
        }
      }),
    );
  }

  const suspicious = failed >= SPOT_CHECK_ALERT_THRESHOLD;
  const result: SpotCheckResult = {
    market,
    date,
    sampleSize: sample.length,
    checked,
    passed,
    failed,
    failRate: checked > 0 ? Math.round((failed / checked) * 100) / 100 : 0,
    suspicious,
    details: details.slice(0, 10),
  };

  if (suspicious) {
    console.error(
      `[L1SpotCheck] ★ ${market} ${date} 抽查可疑！` +
      `${failed}/${checked} 支偏差 > 1%`,
    );
    for (const d of details.slice(0, 5)) {
      console.error(`  ${d.symbol}: L1=${d.l1Close} Yahoo=${d.refClose} (${d.diffPct}%)`);
    }
  } else if (checked > 0) {
    console.info(
      `[L1SpotCheck] ${market} ${date} 抽查通過: ${passed}/${checked} 一致`,
    );
  } else {
    console.warn(`[L1SpotCheck] ${market} ${date} 無可抽查的股票`);
  }

  return result;
}
