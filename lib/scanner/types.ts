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

export interface SurgeComponentSummary {
  score: number;
  detail: string;
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
  // ── 飆股潛力分 ────────────────────────────────────────────────────────────
  surgeScore?: number;           // 0–100
  surgeGrade?: 'S' | 'A' | 'B' | 'C' | 'D';
  surgeFlags?: string[];
  surgeComponents?: {
    momentum:    SurgeComponentSummary;
    volatility:  SurgeComponentSummary;
    volume:      SurgeComponentSummary;
    breakout:    SurgeComponentSummary;
    trendQuality: SurgeComponentSummary;
    pricePosition: SurgeComponentSummary;
    kbarStrength: SurgeComponentSummary;
    indicatorConfluence: SurgeComponentSummary;
    longTermQuality: SurgeComponentSummary;
    volumePriceDivergence: SurgeComponentSummary;
  };
  // ── 歷史信號績效 ──────────────────────────────────────────────────────────
  histWinRate?: number;        // 歷史20日勝率 (%)
  histSignalCount?: number;    // 歷史信號次數
  // ── Smart Money / Multi-Factor ──────────────────────────────────────────
  smartMoneyScore?: number;       // 0-100 (institutional flow proxy)
  smartMoneyGrade?: 'S' | 'A' | 'B' | 'C' | 'D';
  compositeScore?: number;        // 0-100 (weighted multi-factor ranking)
  sectorHeat?: number;             // 0-20 bonus from hot sector momentum
  retailSentiment?: number;        // 0-100 (0=panic, 100=euphoria)
  contrarianSignal?: 'bullish' | 'bearish' | null;
  volatilityRegime?: 'LOW' | 'NORMAL' | 'HIGH' | 'EXTREME';
  // ── 壓力區 & 突破品質 ────────────────────────────────────────────────────
  pressureZoneAdjust?: number;       // composite 調整值 (-15 to +10)
  overheadPressure?: number;         // 0-100 上方壓力強度
  overheadDistancePct?: number;      // 距最近壓力區 %
  breakthroughScore?: number;        // 0-100 突破品質總分
  breakthroughGrade?: string;        // S/A/B/C/D
  nWaveDetected?: boolean;           // N字型攻擊
  retestConfirmed?: boolean;         // 回測確認
  srFlipDetected?: boolean;          // 壓力轉支撐
  // ── 高勝率進場位置 (朱老師《活用技術分析寶典》) ────────────────────────
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
    surgeScore: r.surgeScore != null ? num(r.surgeScore) : undefined,
    compositeScore: r.compositeScore != null ? num(r.compositeScore) : undefined,
    smartMoneyScore: r.smartMoneyScore != null ? num(r.smartMoneyScore) : undefined,
    histWinRate: r.histWinRate != null ? num(r.histWinRate) : undefined,
    chipScore: r.chipScore != null ? num(r.chipScore) : undefined,
  };
}

export interface MarketConfig {
  marketId: MarketId;
  name: string;
  scanTimeLocal: string;  // e.g. '13:00'
  timezone: string;
}

export interface TopPickRecord {
  symbol: string;
  name: string;
  surgeScore: number;
  surgeGrade: string;
  sixConditionsScore: number;
  histWinRate?: number;
  price: number;
  changePercent: number;
  aiRank?: number;
  aiReason?: string;
}

export interface ScanSession {
  id: string;            // e.g. 'TW-2026-03-25'
  market: MarketId;
  date: string;          // YYYY-MM-DD
  scanTime: string;      // ISO timestamp when scan ran
  resultCount: number;
  results: StockScanResult[];
  topPicks?: TopPickRecord[];  // 當日 Top 3 推薦
}

// ── Backtest types ─────────────────────────────────────────────────────────────

export interface ForwardCandle {
  date: string;
  open:  number;
  close: number;
  high:  number;
  low:   number;
  volume?: number;  // 成交量（SOP 出場規則需要）
  ma5?:    number;  // 5日均線（朱老師獲利方程式：獲利>10%跌破MA5出場）
}

export interface StockForwardPerformance {
  symbol: string;
  name: string;
  scanDate: string;
  scanPrice: number;
  // ── 以訊號日收盤（scanPrice）為基準 ──────────────────────────────────────
  openReturn: number | null;  // next trading day open vs scan close
  d1Return:   number | null;  // % return after 1 trading day close
  d2Return:   number | null;
  d3Return:   number | null;
  d4Return:   number | null;
  d5Return:   number | null;
  d10Return:  number | null;
  d20Return:  number | null;
  maxGain:    number;         // max intra-window % gain (vs scanPrice)
  maxLoss:    number;         // max intra-window % loss (negative, vs scanPrice)
  forwardCandles: ForwardCandle[];
  // ── 以隔日開盤（nextOpenPrice）為基準（與 BacktestEngine 進場一致）──────
  nextOpenPrice:     number | null;
  d1ReturnFromOpen:  number | null;
  d5ReturnFromOpen:  number | null;
  d10ReturnFromOpen: number | null;
  d20ReturnFromOpen: number | null;
}

export interface BacktestSession {
  id: string;
  market: MarketId;
  scanDate: string;
  createdAt: string;
  scanResults: StockScanResult[];
  performance: StockForwardPerformance[];
  /** 嚴謹回測結果（v2+，含完整進出場紀錄） */
  trades?: import('@/lib/backtest/BacktestEngine').BacktestTrade[];
  stats?:  import('@/lib/backtest/BacktestEngine').BacktestStats;
  strategyVersion?: string;
}
