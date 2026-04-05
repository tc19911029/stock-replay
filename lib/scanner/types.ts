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
  // ── 潛力評分 ──────────────────────────────────────────────────────────────
  surgeScore?: number;           // 0-100 爆發潛力分
  surgeGrade?: string;           // S/A/B/C/D
  surgeFlags?: string[];         // 潛力標記
  surgeComponents?: Record<string, { score: number; detail: string }>;
  compositeScore?: number;       // 綜合評分
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
  d10Return?: number | null;
  d20Return?: number | null;
  d1ReturnFromOpen?: number | null;
  d5ReturnFromOpen?: number | null;
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

export interface ScanSession {
  id: string;
  market: MarketId;
  date: string;
  scanTime: string;
  resultCount: number;
  results: StockScanResult[];
  topPicks?: ScanSessionTopPick[];
}
