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
  // ── AI 排名 ───────────────────────────────────────────────────────────────
  aiRank?: number;
  aiConfidence?: 'high' | 'medium' | 'low';
  aiReason?: string;
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
