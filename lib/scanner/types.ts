export type MarketId = 'TW' | 'CN';

export interface TriggeredRule {
  ruleId: string;
  ruleName: string;
  signalType: 'BUY' | 'SELL' | 'WATCH' | 'ADD' | 'REDUCE';
  reason: string;
}

export interface SixConditionsBreakdown {
  trend: boolean;
  position: boolean;
  kbar: boolean;
  ma: boolean;
  volume: boolean;
  indicator: boolean;
}

export interface StockScanResult {
  symbol: string;
  name: string;
  market: MarketId;
  industry?: string;          // 產業板塊，e.g. "半導體", "記憶體", "金融保險"
  price: number;
  changePercent: number;
  volume: number;
  triggeredRules: TriggeredRule[];
  sixConditionsScore: number;   // 0–6
  sixConditionsBreakdown: SixConditionsBreakdown;
  trendState: '多頭' | '空頭' | '盤整';
  trendPosition: string;
  scanTime: string;             // ISO timestamp
  // ── 歷史信號績效 ──────────────────────────────────────────────────────────
  histWinRate?: number;        // 歷史20日勝率 (%)
  histSignalCount?: number;    // 歷史信號次數
  // ── 排序因子：共振 ─────────────────────────────────────────────────────
  resonanceScore?: number;           // BUY/ADD 訊號數 + 跨群組共振數
  // ── 排序因子：高勝率進場位置 (朱老師《活用技術分析寶典》) ─────────────────
  highWinRateTypes?: string[];       // 匹配的高勝率位置類型
  highWinRateScore?: number;         // 高勝率加分 0-30
  highWinRateDetails?: string[];     // 匹配說明
  // ── 33 種贏家圖像 ──────────────────────────────────────────────────────
  winnerBearishPatterns?: string[];   // 多轉空圖像名稱
  winnerBullishPatterns?: string[];   // 空轉多圖像名稱
  // ── 切線分析 ───────────────────────────────────────────────────────────
  trendlineBreakAbove?: boolean;      // 突破下降切線
  trendlineBreakBelow?: boolean;      // 跌破上升切線
  // ── 淘汰法 ────────────────────────────────────────────────────────────
  eliminationReasons?: string[];      // 淘汰原因
  eliminationPenalty?: number;        // 淘汰扣分
  // ── 做空方向 ──────────────────────────────────────────────────────────────
  direction?: 'long' | 'short';              // 做多/做空方向
  shortSixConditionsScore?: number;          // 0–6
  shortSixConditionsBreakdown?: {
    trend: boolean;
    ma: boolean;
    position: boolean;
    volume: boolean;
    kbar: boolean;
    indicator: boolean;
  };
  // ── 長線保護短線（多時間框架） ───────────────────────────────────────────
  mtfScore?: number;                          // 0-4 多時間框架總分
  mtfWeeklyTrend?: string;                    // '多頭'/'空頭'/'盤整'
  mtfWeeklyPass?: boolean;
  mtfWeeklyDetail?: string;
  mtfMonthlyTrend?: string;
  mtfMonthlyPass?: boolean;
  mtfMonthlyDetail?: string;
  mtfWeeklyNearResistance?: boolean;          // 週線接近前高壓力區
  // ── 10大戒律 ──────────────────────────────────────────────────────────────
  entryProhibitionReasons?: string[];        // 觸發的戒律說明（有值代表被禁止）
  // ── AI 排名 ───────────────────────────────────────────────────────────────
  aiRank?: number;
  aiConfidence?: 'high' | 'medium' | 'low';
  aiReason?: string;
  // ── 籌碼面 ────────────────────────────────────────────────────────────────
  chipScore?: number;            // 0–100 籌碼面評分
  chipGrade?: string;            // S/A/B/C/D
  chipSignal?: string;           // 主力進場/法人偏多/散戶追高/主力出貨/中性
  chipDetail?: string;           // 籌碼面摘要（外資買超50M；投信買超10M）
  foreignBuy?: number;           // 外資買賣超（元）
  trustBuy?: number;             // 投信買賣超（元）
  dealerBuy?: number;            // 自營商買賣超（元）
  marginNet?: number;            // 融資增減（張）
  shortNet?: number;             // 融券增減（張）
  marginBalance?: number;        // 融資餘額（張）
  shortBalance?: number;         // 融券餘額（張）
  dayTradeRatio?: number;        // 當沖比例 %
  largeTraderNet?: number;       // 大額交易人淨買超
  // ── FinMind 歷史法人（近5日）──────────────────────────────────────────────
  foreignNet5d?: number;         // 外資近5日淨買賣超（張）
  trustNet5d?: number;           // 投信近5日淨買賣超（張）
  consecutiveForeignBuy?: number;// 外資連續買超天數
  // ── 潛力評分 ──────────────────────────────────────────────────────────────
  surgeScore?: number;           // 0-100 爆發潛力分
  surgeGrade?: string;           // S/A/B/C/D
  surgeFlags?: string[];         // 潛力標記
  surgeComponents?: Record<string, { score: number; detail: string }>;
  compositeScore?: number;       // 綜合評分
  // ── 數據新鮮度 ────────────────────────────────────────────────────────────
  /** 掃描時使用的 K 線數據新鮮度 */
  dataFreshness?: {
    lastCandleDate: string;               // K線最後日期（如 "2026-04-09"）
    daysStale: number;                    // 落後幾個交易日（0=最新）
    source: 'memory' | 'local' | 'api';  // 數據來源
  };
}

/**
 * Sanitize scan result — replace NaN/undefined numeric fields with safe defaults.
 * Prevents NaN propagation when external APIs return unexpected data.
 */
export function sanitizeScanResult(r: StockScanResult): StockScanResult {
  const num = (v: unknown, fallback = 0) => (typeof v === 'number' && !Number.isNaN(v) ? v : fallback);
  return {
    ...r,
    price: num(r.price),
    changePercent: num(r.changePercent),
    volume: num(r.volume),
    sixConditionsScore: num(r.sixConditionsScore),
    histWinRate: r.histWinRate != null ? num(r.histWinRate) : undefined,
    chipScore: r.chipScore != null ? num(r.chipScore) : undefined,
  };
}

// ── 掃描診斷 ────────────────────────────────────────────────────────────────

export interface ScanDiagnostics {
  totalStocks: number;
  memoryCacheHits: number;
  localCacheHits: number;
  localCacheStale: number;    // 容忍性命中（數據差 1-5 交易日）
  apiCalls: number;
  apiFailed: number;
  tooFewCandles: number;      // candles.length < 30
  filteredOut: number;        // 被六條件/戒律/淘汰法過濾
  processedCount: number;     // 實際處理完的股票數
  errorSamples: string[];     // 前 5 個錯誤訊息
  // ── 資料完整度（Phase 2 新增）────────────────────────────────────────────
  dataMissing: number;        // 本地無資料的股票數
  missingSymbols: string[];   // 缺失股票清單（前 20 個）
  coverageRate: number;       // 0-100% 本地資料覆蓋率
  /** complete: 覆蓋率 >= 95%, partial: 70-95%, insufficient: < 70% */
  dataStatus: 'complete' | 'partial' | 'insufficient';
  // ── 掃描前補缺統計 ──────────────────────────────────────────────────────
  ingestDownloaded: number;   // 掃描前補缺下載的股票數
  ingestFailed: number;       // 補缺失敗的股票數
}

export function createEmptyDiagnostics(): ScanDiagnostics {
  return {
    totalStocks: 0, memoryCacheHits: 0, localCacheHits: 0,
    localCacheStale: 0, apiCalls: 0, apiFailed: 0, tooFewCandles: 0,
    filteredOut: 0, processedCount: 0, errorSamples: [],
    dataMissing: 0, missingSymbols: [], coverageRate: 100,
    dataStatus: 'complete', ingestDownloaded: 0, ingestFailed: 0,
  };
}

export function mergeDiagnostics(a: ScanDiagnostics, b: ScanDiagnostics): ScanDiagnostics {
  const merged = {
    totalStocks:      a.totalStocks + b.totalStocks,
    memoryCacheHits:  a.memoryCacheHits + b.memoryCacheHits,
    localCacheHits:   a.localCacheHits + b.localCacheHits,
    localCacheStale:  a.localCacheStale + b.localCacheStale,
    apiCalls:         a.apiCalls + b.apiCalls,
    apiFailed:        a.apiFailed + b.apiFailed,
    tooFewCandles:    a.tooFewCandles + b.tooFewCandles,
    filteredOut:      a.filteredOut + b.filteredOut,
    processedCount:   a.processedCount + b.processedCount,
    errorSamples:     [...a.errorSamples, ...b.errorSamples].slice(0, 5),
    dataMissing:      a.dataMissing + b.dataMissing,
    missingSymbols:   [...a.missingSymbols, ...b.missingSymbols].slice(0, 20),
    ingestDownloaded: a.ingestDownloaded + b.ingestDownloaded,
    ingestFailed:     a.ingestFailed + b.ingestFailed,
    coverageRate: 100,
    dataStatus: 'complete' as ScanDiagnostics['dataStatus'],
  };
  // 計算合併後的覆蓋率與狀態
  if (merged.totalStocks > 0) {
    merged.coverageRate = Math.round((1 - merged.dataMissing / merged.totalStocks) * 100);
  }
  merged.dataStatus = merged.coverageRate >= 95 ? 'complete'
    : merged.coverageRate >= 70 ? 'partial'
    : 'insufficient';
  return merged;
}

/** 將診斷資訊轉為人類可讀的摘要 */
export function diagnosticsSummary(d: ScanDiagnostics): string {
  const parts: string[] = [];
  parts.push(`已掃描 ${d.processedCount}/${d.totalStocks} 檔`);
  if (d.coverageRate < 100) parts.push(`覆蓋率 ${d.coverageRate}%`);
  if (d.localCacheHits > 0) parts.push(`本地快取 ${d.localCacheHits}`);
  if (d.localCacheStale > 0) parts.push(`容忍性快取 ${d.localCacheStale}`);
  if (d.memoryCacheHits > 0) parts.push(`記憶體快取 ${d.memoryCacheHits}`);
  if (d.ingestDownloaded > 0) parts.push(`補缺下載 ${d.ingestDownloaded}`);
  if (d.ingestFailed > 0) parts.push(`補缺失敗 ${d.ingestFailed}`);
  if (d.apiCalls > 0) parts.push(`API ${d.apiCalls}`);
  if (d.apiFailed > 0) parts.push(`API失敗 ${d.apiFailed}`);
  if (d.dataMissing > 0) parts.push(`缺資料 ${d.dataMissing}`);
  if (d.tooFewCandles > 0) parts.push(`數據不足 ${d.tooFewCandles}`);
  if (d.filteredOut > 0) parts.push(`被過濾 ${d.filteredOut}`);
  if (d.errorSamples.length > 0) parts.push(`錯誤: ${d.errorSamples[0]}`);
  return parts.join('、');
}

export interface MarketConfig {
  marketId: MarketId;
  name: string;
  scanTimeLocal: string;  // e.g. '13:00'
  timezone: string;
}

// ── Forward Performance ─────────────────────────────────────────────────────

export interface ForwardCandle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  ma5?: number;
  ma10?: number;
  ma20?: number;
}

export interface StockForwardPerformance {
  symbol: string;
  name: string;
  scanDate?: string;
  scanPrice: number;
  nextOpenPrice?: number | null;
  openReturn?: number | null;
  d1Return?: number | null;
  d2Return?: number | null;
  d3Return?: number | null;
  d4Return?: number | null;
  d5Return?: number | null;
  d6Return?: number | null;
  d7Return?: number | null;
  d8Return?: number | null;
  d9Return?: number | null;
  d10Return?: number | null;
  d20Return?: number | null;
  d1ReturnFromOpen?: number | null;
  d5ReturnFromOpen?: number | null;
  d6ReturnFromOpen?: number | null;
  d7ReturnFromOpen?: number | null;
  d8ReturnFromOpen?: number | null;
  d9ReturnFromOpen?: number | null;
  d10ReturnFromOpen?: number | null;
  d20ReturnFromOpen?: number | null;
  ret1d?: number | null;
  ret5d?: number | null;
  ret10d?: number | null;
  ret20d?: number | null;
  maxDrawdown?: number;
  maxGain?: number;
  maxLoss?: number;
  forwardCandles?: ForwardCandle[];
  candles?: ForwardCandle[];
}

// ── Backtest Session ────────────────────────────────────────────────────────

export interface BacktestSession {
  id: string;
  market: MarketId;
  scanDate: string;
  createdAt: string;
  scanResults: StockScanResult[];
  performance: StockForwardPerformance[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  trades: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stats?: any;
  strategyVersion?: string;
}

// ── Scan Session ────────────────────────────────────────────────────────────

export interface ScanSessionTopPick {
  symbol: string;
  name: string;
  sixConditionsScore: number;
  histWinRate?: number;
  price: number;
  changePercent: number;
  aiRank?: number;
  aiReason?: string;
  surgeGrade?: string;
  surgeScore?: number;
}

export type ScanDirection = 'long' | 'short' | 'daban';
export type MtfMode = 'daily' | 'mtf';

// ── 打板掃描結果 ────────────────────────────────────────────────────────────

export type LimitUpType = '首板' | '二板' | '三板' | '四板+';

export interface DabanScanResult {
  symbol: string;
  name: string;
  closePrice: number;           // 今日收盤（漲停價）
  prevClose: number;            // 昨日收盤
  limitUpPct: number;           // 漲停幅度 %
  limitUpType: LimitUpType;     // 首板/二板/三板/四板+
  consecutiveBoards: number;    // 連板天數
  turnover: number;             // 成交額（元）
  volumeRatio: number;          // 量比（日量/5日均量）
  isYiZiBan: boolean;           // 是否一字板（買不到）
  rankScore: number;            // 排序分數
  buyThresholdPrice: number;    // 買入門檻 = 收盤 × 1.02
  scanDate: string;             // 掃描日期
}

export interface DabanSentiment {
  limitUpCount: number;          // 今日漲停家數
  yesterdayLimitUpCount: number;  // 昨日漲停家數
  yesterdayAvgReturn: number;     // 昨日漲停股今日平均漲跌 %
  isCold: boolean;               // 情緒冰點（不建議進場）
  reason?: string;               // 冰點原因
}

export interface DabanScanSession {
  id: string;
  market: 'CN';
  date: string;
  scanTime: string;
  resultCount: number;
  results: DabanScanResult[];
  sentiment?: DabanSentiment;     // 市場情緒指標
}

/** 掃描時段類型：盤中快照 vs 收盤後正式結果 */
export type SessionType = 'intraday' | 'post_close';

export interface ScanSession {
  id: string;
  market: MarketId;
  date: string;
  direction?: ScanDirection;
  multiTimeframeEnabled?: boolean;  // true = 週月線過濾已啟用
  /** 掃描時段：intraday=盤中快照, post_close=收盤後正式結果 */
  sessionType?: SessionType;
  scanTime: string;
  resultCount: number;
  results: StockScanResult[];
  topPicks?: ScanSessionTopPick[];
  /** 掃描時數據新鮮度摘要 */
  dataFreshness?: {
    avgStaleDays: number;       // 平均落後天數
    maxStaleDays: number;       // 最大落後天數
    staleCount: number;         // 使用過期數據的股票數
    totalScanned: number;       // 總掃描數
    coverageRate: number;       // 0-100%
    dataStatus: 'complete' | 'partial' | 'insufficient';
  };
}
