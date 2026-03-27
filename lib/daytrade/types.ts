/**
 * 實盤當沖提示平台 — 型別定義
 */

// ── 時間週期 ──────────────────────────────────────────────────────────────────
export type IntradayTimeframe = '1m' | '3m' | '5m' | '15m' | '30m' | '60m' | '1d' | '1wk' | '1mo';

export const TIMEFRAME_MINUTES: Record<string, number> = {
  '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30, '60m': 60,
  '1d': 1440, '1wk': 10080, '1mo': 43200,
};

// ── K 線 ──────────────────────────────────────────────────────────────────────
export interface IntradayCandle {
  time: string;           // ISO datetime "2026-03-27T09:01:00"
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timeframe: IntradayTimeframe;
}

export interface IntradayCandleWithIndicators extends IntradayCandle {
  ma5?: number;
  ma10?: number;
  ma20?: number;
  ma60?: number;
  vwap?: number;
  vwapUpper?: number;
  vwapLower?: number;
  avgVol5?: number;
  avgVol20?: number;
  macdDIF?: number;
  macdSignal?: number;
  macdOSC?: number;
  kdK?: number;
  kdD?: number;
  rsi14?: number;
  atr14?: number;
  bbUpper?: number;
  bbLower?: number;
  bbBandwidth?: number;
  bbPercentB?: number;
  cumulativeVolume?: number;
}

// ── 訊號 ──────────────────────────────────────────────────────────────────────
export type IntradaySignalType =
  | 'BUY' | 'SELL' | 'ADD' | 'REDUCE'
  | 'STOP_LOSS' | 'RISK' | 'WATCH';

export interface IntradaySignal {
  id: string;
  type: IntradaySignalType;
  ruleId: string;
  label: string;
  description: string;
  reason: string;
  score: number;              // 0-100 信心分
  triggeredAt: string;        // ISO datetime
  timeframe: IntradayTimeframe;
  price: number;              // 觸發時價格
  metadata: {
    entryPrice?: number;
    stopLossPrice?: number;
    targetPrice?: number;
    riskRewardRatio?: number;
    confluenceFactors?: string[];
  };
}

// ── 當沖規則介面 ──────────────────────────────────────────────────────────────
export interface IntradayTradingRule {
  id: string;
  name: string;
  description: string;
  applicableTimeframes: IntradayTimeframe[];
  evaluate(
    candles: IntradayCandleWithIndicators[],
    currentIndex: number,
    context: IntradayRuleContext,
  ): IntradaySignal | null;
}

export interface IntradayRuleContext {
  timeframe: IntradayTimeframe;
  mtfState?: MultiTimeframeState;
  openRangeHigh?: number;     // 前 30 分鐘最高
  openRangeLow?: number;      // 前 30 分鐘最低
  prevDayClose?: number;      // 前一日收盤
}

// ── 多週期共振 ────────────────────────────────────────────────────────────────
export interface TimeframeState {
  timeframe: IntradayTimeframe;
  trend: 'bullish' | 'bearish' | 'neutral';
  trendStrength: number;      // 0-100
  maAlignment: 'bullish' | 'bearish' | 'mixed';
  lastPrice: number;
  vwapRelation: 'above' | 'below' | 'at';
}

export interface MultiTimeframeState {
  timeframes: Record<IntradayTimeframe, TimeframeState>;
  overallBias: 'bullish' | 'bearish' | 'neutral';
  confluenceScore: number;    // 0-100
  description: string;
}

// ── 模擬交易 ──────────────────────────────────────────────────────────────────
export interface PaperTrade {
  id: string;
  symbol: string;
  action: 'BUY' | 'SELL';
  price: number;
  shares: number;
  amount: number;
  fee: number;
  timestamp: string;
  signalId?: string;
  realizedPnL?: number;
}

export interface PaperPosition {
  symbol: string;
  shares: number;
  avgCost: number;
  currentPrice: number;
  unrealizedPnL: number;
  unrealizedPnLPct: number;
}

export interface DayTradeSession {
  id: string;
  symbol: string;
  date: string;
  startTime: string;
  endTime?: string;
  initialCapital: number;
  currentCapital: number;
  trades: PaperTrade[];
  signals: IntradaySignal[];
  position: PaperPosition | null;
  realizedPnL: number;
  unrealizedPnL: number;
  totalPnL: number;
  returnPct: number;
  maxDrawdown: number;
  peakCapital: number;
  winCount: number;
  lossCount: number;
}

// ── 訊號驗證 ──────────────────────────────────────────────────────────────────
export interface SignalValidation {
  signal: IntradaySignal;
  forwardReturns: {
    bars3: number | null;
    bars5: number | null;
    bars10: number | null;
  };
  maxFavorableExcursion: number;
  maxAdverseExcursion: number;
  wasAccurate: boolean;
  hitTarget: boolean;
  hitStopLoss: boolean;
}

export interface ValidationStatistics {
  totalSignals: number;
  buySignals: number;
  sellSignals: number;
  accuracyRate: number;
  avgReturn3Bar: number;
  avgReturn5Bar: number;
  avgReturn10Bar: number;
  avgMFE: number;
  avgMAE: number;
  stopLossRate: number;
  targetHitRate: number;
  profitFactor?: number;
  medianReturn?: number;
  byType: Record<string, {
    count: number;
    accuracyRate: number;
    avgReturn: number;
  }>;
  byTimeframe: Record<IntradayTimeframe, {
    count: number;
    accuracyRate: number;
    avgReturn: number;
  }>;
}

// ── 數據提供者介面 ────────────────────────────────────────────────────────────
export interface IntradayDataProvider {
  getCandles(
    symbol: string,
    timeframe: IntradayTimeframe,
    date?: string,
  ): Promise<IntradayCandle[]>;

  subscribe?(
    symbol: string,
    timeframe: IntradayTimeframe,
    callback: (candle: IntradayCandle) => void,
  ): () => void;
}

// ── 回測配置 ──────────────────────────────────────────────────────────────────
export interface IntradayBacktestConfig {
  symbol: string;
  dates: string[];
  timeframe: IntradayTimeframe;
  rules: IntradayTradingRule[];
  forwardBars: number[];
}

export interface IntradayBacktestResult {
  totalDays: number;
  totalSignals: number;
  validations: SignalValidation[];
  statistics: ValidationStatistics;
  byDate: Record<string, IntradaySignal[]>;
}
