/**
 * 打板掃描器 — A 股漲停板戰法
 *
 * 掃描今日漲停的股票，過濾 ST/一字板/低成交，
 * 按首板優先 + 成交額排序，輸出明天的買入候選清單。
 *
 * 不繼承 MarketScanner（朱家泓管道不適用），獨立實作。
 */

import { computeIndicators } from '@/lib/indicators';
import type { CandleWithIndicators } from '@/types';
import type { DabanScanResult, DabanScanSession, DabanSentiment, LimitUpType } from './types';
import type { EastMoneyQuote } from '@/lib/datasource/EastMoneyRealtime';

// ── 參數 ────────────────────────────────────────────────────────────────────

const LIMIT_UP_MAIN = 9.5;    // 主板漲停判定 %（10% 容差）
const LIMIT_UP_GEM  = 19.5;   // 創業板/科創板漲停判定 %（20% 容差）
const MIN_TURNOVER  = 5e6;    // 最低成交額 500 萬
const GAP_UP_FACTOR = 1.02;   // 高開門檻 = 收盤 × 1.02

// ── Helpers ─────────────────────────────────────────────────────────────────

function isGemOrStar(symbol: string): boolean {
  // 創業板 300xxx.SZ, 科創板 688xxx.SS
  return symbol.startsWith('300') || symbol.startsWith('688');
}

function getLimitUpThreshold(symbol: string): number {
  return isGemOrStar(symbol) ? LIMIT_UP_GEM : LIMIT_UP_MAIN;
}

function getDayReturn(candles: CandleWithIndicators[], idx: number): number {
  if (idx <= 0) return 0;
  return (candles[idx].close - candles[idx - 1].close) / candles[idx - 1].close * 100;
}

function getConsecutiveBoards(candles: CandleWithIndicators[], idx: number, symbol: string): number {
  const threshold = getLimitUpThreshold(symbol);
  let count = 0;
  for (let i = idx; i >= 1; i--) {
    if (getDayReturn(candles, i) >= threshold) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

function getBoardType(boards: number): LimitUpType {
  if (boards <= 1) return '首板';
  if (boards === 2) return '二板';
  if (boards === 3) return '三板';
  return '四板+';
}

function getAvgVolume(candles: CandleWithIndicators[], idx: number, period: number): number {
  let sum = 0;
  const start = Math.max(0, idx - period + 1);
  for (let i = start; i <= idx; i++) sum += (candles[i].volume ?? 0);
  return sum / (idx - start + 1);
}

// ── 情緒過濾參數 ────────────────────────────────────────────────────────────
const SENTIMENT_MIN_LIMIT_UP = 15;   // 漲停家數 < 15 視為冰點
const SENTIMENT_MIN_YEST_AVG = -3;   // 昨漲停今均 < -3% 視為冰點

// ── Main Scanner ────────────────────────────────────────────────────────────

export interface DabanScanInput {
  stocks: Map<string, { name: string; candles: CandleWithIndicators[] }>;
  date: string; // YYYY-MM-DD
}

/**
 * 計算全市場情緒指標
 */
function computeSentiment(
  stocks: Map<string, { name: string; candles: CandleWithIndicators[] }>,
  date: string,
): DabanSentiment {
  let limitUpCount = 0;
  let yesterdayLimitUpCount = 0;
  let yesterdayAvgReturn = 0;

  for (const [symbol, stockData] of stocks) {
    const candles = stockData.candles;
    const idx = candles.findIndex(c => c.date?.slice(0, 10) === date);
    if (idx < 2) continue;

    const threshold = getLimitUpThreshold(symbol);
    const todayReturn = getDayReturn(candles, idx);
    const yesterdayReturn = getDayReturn(candles, idx - 1);

    if (todayReturn >= threshold) limitUpCount++;
    if (yesterdayReturn >= threshold) {
      yesterdayLimitUpCount++;
      yesterdayAvgReturn += todayReturn;
    }
  }

  if (yesterdayLimitUpCount > 0) {
    yesterdayAvgReturn /= yesterdayLimitUpCount;
  }

  const isCold = limitUpCount < SENTIMENT_MIN_LIMIT_UP || yesterdayAvgReturn < SENTIMENT_MIN_YEST_AVG;
  let reason: string | undefined;
  if (isCold) {
    const reasons: string[] = [];
    if (limitUpCount < SENTIMENT_MIN_LIMIT_UP) reasons.push(`漲停${limitUpCount}家<${SENTIMENT_MIN_LIMIT_UP}`);
    if (yesterdayAvgReturn < SENTIMENT_MIN_YEST_AVG) reasons.push(`昨漲停今均${yesterdayAvgReturn.toFixed(1)}%<${SENTIMENT_MIN_YEST_AVG}%`);
    reason = reasons.join('、');
  }

  return {
    limitUpCount,
    yesterdayLimitUpCount,
    yesterdayAvgReturn: +yesterdayAvgReturn.toFixed(2),
    isCold,
    reason,
  };
}

/**
 * 掃描指定日期的漲停股（含情緒過濾）
 */
export function scanDaban(input: DabanScanInput): DabanScanSession {
  const { stocks, date } = input;
  const sentiment = computeSentiment(stocks, date);
  const results: DabanScanResult[] = [];

  for (const [symbol, stockData] of stocks) {
    const candles = stockData.candles;
    const idx = candles.findIndex(c => c.date?.slice(0, 10) === date);
    if (idx < 2) continue;

    const today = candles[idx];
    const yesterday = candles[idx - 1];

    // 1. 判斷今日是否漲停
    const dayReturn = getDayReturn(candles, idx);
    const threshold = getLimitUpThreshold(symbol);
    if (dayReturn < threshold) continue;
    // Sanity check：主板漲停上限 +10%、創業板 +20%，若 dayReturn > threshold × 1.5
    // 代表 L1 缺了中間某日 K 棒（idx-1 跳到前天），pct 是跨兩日累計 → reject
    if (dayReturn > threshold * 1.5) {
      console.warn(`[DabanScanner] ${symbol} ${date} dayReturn=${dayReturn.toFixed(2)}% 超過閾值 ${threshold} × 1.5，可能 L1 缺 K 棒，跳過`);
      continue;
    }

    // 2. 過濾 ST（名稱檢查）
    if (stockData.name.includes('ST') || stockData.name.includes('*ST')) continue;

    // 3. 過濾一字板（開盤=最高=收盤，散戶買不到）
    const isYiZiBan = today.open === today.high && today.high === today.close;

    // 4. 成交額門檻
    const vol = today.volume ?? 0;
    const turnover = vol * today.close;
    if (turnover < MIN_TURNOVER) continue;

    // 5. 計算連板天數
    const consecutiveBoards = getConsecutiveBoards(candles, idx, symbol);
    const limitUpType = getBoardType(consecutiveBoards);

    // 6. 量比
    const avgVol5 = getAvgVolume(candles, idx, 5);
    const volumeRatio = avgVol5 > 0 ? +(vol / avgVol5).toFixed(2) : 0;

    // 7. 排序分數：純成交額（2025-2026年1年回測最佳，+449%）
    //    多因子版本在CN 2025-2026大幅跑輸，已棄用
    const rankScore = turnover;

    // 8. 買入門檻價
    const buyThresholdPrice = +(today.close * GAP_UP_FACTOR).toFixed(2);

    results.push({
      symbol,
      name: stockData.name,
      closePrice: today.close,
      prevClose: yesterday.close,
      limitUpPct: +dayReturn.toFixed(2),
      limitUpType,
      consecutiveBoards,
      turnover: Math.round(turnover),
      volumeRatio,
      isYiZiBan,
      rankScore,
      buyThresholdPrice,
      scanDate: date,
    });
  }

  // 排序：分數高的在前，一字板放最後（買不到）
  results.sort((a, b) => {
    if (a.isYiZiBan !== b.isYiZiBan) return a.isYiZiBan ? 1 : -1;
    return b.rankScore - a.rankScore;
  });

  return {
    id: `daban-CN-${date}-${Date.now()}`,
    market: 'CN',
    date,
    scanTime: new Date().toISOString(),
    resultCount: results.length,
    results,
    sentiment,
    sortedBy: 'turnover',
  };
}

/**
 * 從本地快取 JSON 載入股票資料並掃描（回測用，大檔案）
 */
export async function scanDabanFromCache(date: string): Promise<DabanScanSession> {
  const fs = await import('fs');
  const path = await import('path');

  const cacheFile = path.join(process.cwd(), 'data', 'backtest-candles-cn.json');
  if (!fs.existsSync(cacheFile)) {
    throw new Error('找不到 CN 快取: ' + cacheFile);
  }

  const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
  const stocks = new Map<string, { name: string; candles: CandleWithIndicators[] }>();

  for (const [sym, data] of Object.entries(raw.stocks as Record<string, { name: string; candles: unknown[] }>)) {
    if (!data.candles || data.candles.length < 30) continue;
    try {
      stocks.set(sym, { name: data.name, candles: computeIndicators(data.candles as CandleWithIndicators[]) });
    } catch { /* skip */ }
  }

  return scanDaban({ stocks, date });
}

// ── 批次並行讀取 ───────────────────────────────────────────────────────────────

const CONCURRENCY = 50;

/**
 * 從 per-symbol 本地快取讀取 K 線並掃描（支援近期資料）
 *
 * 讀取 data/candles/CN/{symbol}.json，透過 loadLocalCandlesWithTolerance。
 *
 * 重要：打板掃描需要精確的日漲跌幅，容忍度必須 ≤ 1 天。
 * 如果 K 線差距 > 1 天，算出的「漲跌幅」會跨越多天累計，
 * 導致非漲停股被誤判為漲停（例如 +22%）。
 */
export async function scanDabanFromLocalCandles(date: string): Promise<DabanScanSession> {
  const { ChinaScanner } = await import('./ChinaScanner');
  const { loadLocalCandlesWithTolerance } = await import('@/lib/datasource/LocalCandleStore');

  const scanner = new ChinaScanner();
  const stockList = await scanner.getStockList();
  const stocks = new Map<string, { name: string; candles: CandleWithIndicators[] }>();

  let loaded = 0;
  let skipped = 0;
  let staleSkipped = 0;

  for (let i = 0; i < stockList.length; i += CONCURRENCY) {
    const batch = stockList.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (entry) => {
        // 容忍度 1 天：確保漲跌幅計算不會跨越多天
        const local = await loadLocalCandlesWithTolerance(entry.symbol, 'CN', date, 1);
        if (!local || local.candles.length < 30) return null;
        // staleDays > 0 表示 K 線沒有掃描日當天的資料，漲跌幅會錯位
        if (local.staleDays > 0) return 'stale';
        return { symbol: entry.symbol, name: entry.name, candles: local.candles };
      }),
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value === 'stale') {
        staleSkipped++;
      } else if (r.status === 'fulfilled' && r.value && r.value !== 'stale') {
        stocks.set(r.value.symbol, { name: r.value.name, candles: r.value.candles });
        loaded++;
      } else {
        skipped++;
      }
    }
  }

  console.log(`[DabanScanner] 從本地快取載入 ${loaded}/${stockList.length} 檔（跳過 ${skipped}, 資料過舊 ${staleSkipped}）`);

  // 警告：如果載入率太低，掃描結果可能不完整
  const loadRate = loaded / stockList.length;
  if (loadRate < 0.5) {
    console.warn(`[DabanScanner] ⚠️ 載入率僅 ${(loadRate * 100).toFixed(0)}%，掃描結果可能不完整。請確保 K 線已下載到最新。`);
  }

  return scanDaban({ stocks, date });
}

/**
 * P2A: 打板掃描用 IntradayCache 預篩
 *
 * 先讀 IntradayCache CN 快照（1 次 Blob read），篩選 changePercent >= 9.5%
 * 的候選股（~50-200支），再只對這些讀 per-symbol K 線。
 * 預期從 2-3 分鐘（5000 支）降到 10-20 秒（50-200 支）。
 *
 * Fallback: 若 IntradayCache 不存在或候選為空，降級為全量掃描。
 */
export async function scanDabanWithPrefilter(date: string): Promise<DabanScanSession> {
  const { readIntradaySnapshot } = await import('@/lib/datasource/IntradayCache');
  const { loadLocalCandlesWithTolerance } = await import('@/lib/datasource/LocalCandleStore');

  const snapshot = await readIntradaySnapshot('CN', date);

  // ── 快照校驗：日期不匹配或資料異常 → fallback 全量 L1 掃描 ──
  if (!snapshot || snapshot.quotes.length === 0) {
    console.log(`[DabanScanner] 無 CN 快照 → fallback 全量 L1`);
    return scanDabanFromLocalCandles(date);
  }
  const snapshotDate = (snapshot as { date?: string }).date?.slice(0, 10) ?? '';
  if (snapshotDate && snapshotDate !== date) {
    console.warn(`[DabanScanner] ⚠️ 快照日期 ${snapshotDate} ≠ 掃描日期 ${date} → fallback 全量 L1`);
    return scanDabanFromLocalCandles(date);
  }
  // 健全檢查：high 欄位不應大於 close × 10（防時間戳跑進來）
  const sampleQuote = snapshot.quotes.find(q => q.close > 0);
  if (sampleQuote && sampleQuote.high > sampleQuote.close * 10) {
    console.warn(`[DabanScanner] ⚠️ 快照數據異常（high=${sampleQuote.high} >> close=${sampleQuote.close}）→ fallback 全量 L1`);
    return scanDabanFromLocalCandles(date);
  }

  // 預篩：只取漲幅 >= 主板漲停閾值的候選股
  const candidates = snapshot.quotes.filter(q => {
    if (q.close <= 0 || q.volume <= 0 || q.prevClose <= 0) return false;
    const threshold = isGemOrStar(q.symbol + '.SZ') || isGemOrStar(q.symbol + '.SS')
      ? LIMIT_UP_GEM : LIMIT_UP_MAIN;
    return q.changePercent >= threshold;
  });

  if (candidates.length === 0) {
    // 無漲停股 → 返回空結果而非全量掃描
    return {
      id: `daban-CN-${date}`,
      market: 'CN',
      date,
      scanTime: new Date().toISOString(),
      resultCount: 0,
      results: [],
      sentiment: { limitUpCount: 0, yesterdayLimitUpCount: 0, yesterdayAvgReturn: 0, isCold: true },
      sortedBy: 'turnover',
    };
  }

  console.log(`[DabanScanner] 預篩候選：${candidates.length}/${snapshot.count} 支`);

  // 對候選股讀取 K 線（遠少於全量 5000 支）
  const stocks = new Map<string, { name: string; candles: CandleWithIndicators[] }>();
  let loaded = 0;
  let staleSkipped = 0;

  // 需要從 stockList 取得完整 symbol（帶 .SS/.SZ 後綴）
  const { ChinaScanner } = await import('./ChinaScanner');
  const scanner = new ChinaScanner();
  const stockList = await scanner.getStockList();
  const stockMap = new Map(stockList.map(s => [s.symbol.replace(/\.(SS|SZ)$/, ''), s]));

  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (q) => {
        const entry = stockMap.get(q.symbol);
        if (!entry) return null;
        const local = await loadLocalCandlesWithTolerance(entry.symbol, 'CN', date, 1);
        if (!local || local.candles.length < 30) return null;

        let candles = local.candles;
        if (local.staleDays > 0) {
          // Layer 1 尚未更新到今日 → 用 IntradayCache 快照合成今日 K棒
          if (q.close > 0) {
            candles = mergeRealtimeCandle(candles, q, date);
          } else {
            return 'stale';
          }
        }

        return { symbol: entry.symbol, name: entry.name, candles };
      }),
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value === 'stale') {
        staleSkipped++;
      } else if (r.status === 'fulfilled' && r.value && r.value !== 'stale') {
        stocks.set(r.value.symbol, { name: r.value.name, candles: r.value.candles });
        loaded++;
      }
    }
  }

  console.log(`[DabanScanner] 預篩後載入 ${loaded}/${candidates.length} 檔（資料過舊 ${staleSkipped}）`);

  return scanDaban({ stocks, date });
}

/**
 * 即時打板掃描：合併本地 K 線 + 東方財富即時報價
 *
 * 盤中使用：即時報價作為今日 K 棒，合併到歷史 K 線後掃描。
 * 盤後使用：自動降級為 scanDabanWithPrefilter（先預篩再讀 K 線）。
 */
export async function scanDabanRealtime(date: string): Promise<DabanScanSession> {
  const { isMarketOpen } = await import('@/lib/datasource/marketHours');

  if (!isMarketOpen('CN')) {
    return scanDabanWithPrefilter(date);
  }

  const { ChinaScanner } = await import('./ChinaScanner');
  const { loadLocalCandlesWithTolerance } = await import('@/lib/datasource/LocalCandleStore');
  const { getEastMoneyRealtime } = await import('@/lib/datasource/EastMoneyRealtime');

  const scanner = new ChinaScanner();
  const stockList = await scanner.getStockList();

  // 1. 取得全市場即時報價
  const realtimeMap = await getEastMoneyRealtime();

  // 2. 批次讀取本地歷史 K 線 + 合併即時報價
  const stocks = new Map<string, { name: string; candles: CandleWithIndicators[] }>();
  let loaded = 0;

  for (let i = 0; i < stockList.length; i += CONCURRENCY) {
    const batch = stockList.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (entry) => {
        // 即時模式：容忍 2 天（因為即時報價會補上今天的 K 棒）
        const local = await loadLocalCandlesWithTolerance(entry.symbol, 'CN', date, 2);
        if (!local || local.candles.length < 10) return null;

        let candles = local.candles;

        // 合併即時報價為今日 K 棒
        const code = entry.symbol.replace(/\.(SS|SZ)$/, '');
        const quote = realtimeMap.get(code);
        if (quote && quote.close > 0) {
          candles = mergeRealtimeCandle(candles, quote, date);
        }

        return { symbol: entry.symbol, name: entry.name, candles };
      }),
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        stocks.set(r.value.symbol, { name: r.value.name, candles: r.value.candles });
        loaded++;
      }
    }
  }

  console.log(`[DabanScanner] 即時掃描：${loaded} 檔（即時報價 ${realtimeMap.size} 檔）`);
  return scanDaban({ stocks, date });
}

/**
 * 將即時報價合併到歷史 K 線尾部
 * 同 MarketScanner.fetchCandlesForScan 的合併邏輯
 * 接受任何包含 OHLCV 欄位的物件（EastMoneyQuote / IntradayQuote 皆可）
 */
function mergeRealtimeCandle(
  candles: CandleWithIndicators[],
  quote: { open: number; high: number; low: number; close: number; volume: number },
  today: string,
): CandleWithIndicators[] {
  const last = candles[candles.length - 1];
  const lastDate = last.date?.slice(0, 10) ?? '';

  if (lastDate === today) {
    // 今天的 K 棒已存在 → 用即時報價覆蓋
    const updated = [...candles];
    updated[updated.length - 1] = {
      ...last,
      open: quote.open || last.open,
      high: Math.max(quote.high, last.high),
      low: Math.min(quote.low, last.low),
      close: quote.close,
      volume: quote.volume || last.volume,
    };
    return computeIndicators(updated);
  }

  if (lastDate < today) {
    // 今天的 K 棒不存在 → 附加新 K 棒
    const newCandle: CandleWithIndicators = {
      date: today,
      open: quote.open || quote.close,
      high: quote.high || quote.close,
      low: quote.low || quote.close,
      close: quote.close,
      volume: quote.volume || 0,
    };
    return computeIndicators([...candles, newCandle]);
  }

  // lastDate > today → 資料比即時更新，不合併
  return candles;
}

/**
 * 9:25 AM 開盤確認：讀取前一交易日的打板掃描結果，
 * 對照當日集合競價後的 IntradayCache 快照，標記每支候選股是否確認進場。
 *
 * @param scanDate  打板掃描日（前一交易日，如 "2026-04-13"）
 * @param openDate  開盤確認日（今日，如 "2026-04-14"）
 */
export async function confirmDabanAtOpen(
  scanDate: string,
  openDate: string,
): Promise<DabanScanSession | null> {
  const { loadDabanSession, saveDabanSession } = await import('@/lib/storage/dabanStorage');
  const { readIntradaySnapshot, refreshIntradaySnapshot } = await import('@/lib/datasource/IntradayCache');

  const session = await loadDabanSession(scanDate);
  if (!session || session.results.length === 0) {
    console.warn(`[DabanScanner] confirmDabanAtOpen: 找不到 ${scanDate} 的打板結果`);
    return null;
  }

  // 讀取開盤日快照
  // 即時模式：openDate 是今天 → 若無快照則 refresh 抓現在的 L2
  // 歷史重算：openDate 是過去 → 只讀歷史 L2，不能 refresh（會抓到當前盤 L2 污染）
  const todayCN = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const isLive = openDate >= todayCN;
  let snapshot = await readIntradaySnapshot('CN', openDate);
  if (!snapshot && isLive) {
    snapshot = await refreshIntradaySnapshot('CN');
  }

  // symbol 在打板結果中帶後綴（如 "600519.SS"），snapshot 中只有純代碼（"600519"）
  const quoteMap = snapshot ? new Map(snapshot.quotes.map(q => [q.symbol, q])) : null;

  // 歷史重算：L2 缺時從 L1 讀 openDate 那天的 OHLC
  // 不能只回 session 否則舊的錯誤 openConfirmed 不會修正
  const { readCandleFile } = await import('@/lib/datasource/CandleStorageAdapter');

  const updatedResults = await Promise.all(session.results.map(async result => {
    const code = result.symbol.replace(/\.(SS|SZ)$/, '');
    // 1. 優先 L2 snapshot 的 q.open（真正的 9:25 集合競價開盤價）
    //    q.close 是盤中最新價，會被漲停價污染不能用
    let openPrice = 0;
    const q = quoteMap?.get(code);
    if (q && q.open > 0) {
      openPrice = q.open;
    } else {
      // 2. L2 無資料 → 從 L1 讀 openDate 當天的 open
      try {
        const l1 = await readCandleFile(result.symbol, 'CN');
        const bar = l1?.candles.find(c => c.date === openDate);
        if (bar && bar.open > 0) openPrice = bar.open;
      } catch { /* ignore */ }
    }
    if (openPrice <= 0) return result;
    // 高開幅度 = (openDate 開盤 - 前一交易日收盤) / 前一交易日收盤
    // 前一交易日 = scanDate，其收盤存在 result.closePrice（非 result.prevClose，那是 scanDate-1）
    const gapUpPct = result.closePrice > 0
      ? Math.round(((openPrice - result.closePrice) / result.closePrice) * 10000) / 100
      : 0;
    return {
      ...result,
      openPrice,
      gapUpPct,
      openConfirmed: openPrice >= result.buyThresholdPrice,
    };
  }));

  // 按高開幅度降序排列（回測證明高開幅度是最強排序因子，勝率70%>多因子58%）
  updatedResults.sort((a, b) => (b.gapUpPct ?? -999) - (a.gapUpPct ?? -999));

  const confirmedCount = updatedResults.filter(r => r.openConfirmed).length;
  const updatedSession: DabanScanSession = {
    ...session,
    results: updatedResults,
    openConfirmDate: openDate,
    openConfirmTime: new Date().toISOString(),
    sortedBy: 'gapUpPct',
  };

  await saveDabanSession(updatedSession);
  console.log(`[DabanScanner] 開盤確認：${confirmedCount}/${session.resultCount} 支確認進場，按高開幅度排序（${scanDate} → ${openDate}）`);
  return updatedSession;
}
