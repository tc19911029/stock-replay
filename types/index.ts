// ============================================================
// Core type definitions for the Stock Replay Trainer
// ============================================================

/** Raw OHLCV candle data */
export interface Candle {
  date: string;       // ISO date string e.g. "2023-01-05"
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Candle with computed technical indicators */
export interface CandleWithIndicators extends Candle {
  // Moving Averages
  ma5?: number;
  ma10?: number;
  ma20?: number;
  ma60?: number;
  ma240?: number;
  /** 3-day MA — 三條均線戰法用 */
  ma3?: number;
  /** 24-day MA — 三條/二條均線戰法用 */
  ma24?: number;
  /** 100-day MA — 近似20週均線 */
  ma100?: number;
  /** Average volume over last 5 bars */
  avgVol5?: number;

  // MACD (params: fast=10, slow=20, signal=10 — 朱家泓/林穎書中推薦參數)
  macdDIF?: number;   // fast EMA - slow EMA
  macdSignal?: number; // signal line (EMA of DIF)
  macdOSC?: number;   // histogram (DIF - signal), positive=red bar, negative=green bar

  // KD Stochastic (params: period=5, k=3, d=3 — 朱家泓/林穎書中推薦參數)
  kdK?: number;       // K value (0–100)
  kdD?: number;       // D value (0–100)

  // ── 飆股偵測用指標 ──────────────────────────────────────────────────────────
  /** RSI(14) — 0–100, >70=超買, <30=超賣 */
  rsi14?: number;
  /** ATR(14) — 平均真實波幅 */
  atr14?: number;
  /** Bollinger Band 上軌 (MA20 + 2σ) */
  bbUpper?: number;
  /** Bollinger Band 下軌 (MA20 - 2σ) */
  bbLower?: number;
  /** BB 帶寬 = (upper - lower) / MA20 */
  bbBandwidth?: number;
  /** BB %B = (close - lower) / (upper - lower), >1=超出上軌 */
  bbPercentB?: number;
  /** Rate of Change 10 日 (%) */
  roc10?: number;
  /** Rate of Change 20 日 (%) */
  roc20?: number;
  /** MACD 柱狀體 3 日斜率 */
  macdSlope?: number;
  /** 20 日平均成交量 */
  avgVol20?: number;
}

/** Stock info returned from API */
export interface StockInfo {
  ticker: string;
  name: string;
}

/** A triggered rule signal */
export interface RuleSignal {
  type: 'BUY' | 'ADD' | 'REDUCE' | 'SELL' | 'WATCH';
  label: string;         // Short display label e.g. "可能買點"
  description: string;   // What happened (technical fact)
  reason: string;        // Why this matters + what to consider doing (book logic)
  ruleId: string;        // Which rule triggered this
}

/** A single trade record */
export interface Trade {
  id: string;
  date: string;
  action: 'BUY' | 'SELL';
  price: number;
  shares: number;
  amount: number;        // price * shares
  fee: number;           // transaction fee
  realizedPnL?: number;  // only for SELL trades
}

/** Account state at current replay position */
export interface AccountState {
  initialCapital: number;
  cash: number;
  shares: number;        // current holding shares
  avgCost: number;       // average cost per share
  realizedPnL: number;   // total realized P&L
  trades: Trade[];
}

/** Computed account metrics (derived from AccountState + current price) */
export interface AccountMetrics {
  cash: number;
  shares: number;
  avgCost: number;
  holdingValue: number;       // shares * currentPrice
  unrealizedPnL: number;      // holdingValue - shares * avgCost
  realizedPnL: number;
  totalAssets: number;        // cash + holdingValue
  returnRate: number;         // (totalAssets - initialCapital) / initialCapital
}

/** Performance statistics */
export interface PerformanceStats {
  totalTrades: number;        // total SELL trades
  winCount: number;
  lossCount: number;
  winRate: number;            // winCount / totalTrades
  totalRealizedPnL: number;
  totalReturnRate: number;
  equityCurve: { date: string; totalAssets: number }[];
}

/** Rule definition — implement this interface to add new rules */
export interface TradingRule {
  id: string;
  name: string;
  description: string;
  /** Returns a signal if the rule is triggered, otherwise null */
  evaluate(
    candles: CandleWithIndicators[],
    currentIndex: number
  ): RuleSignal | null;
}

/** Enriched signal with group metadata (from evaluateDetailed) */
export interface EnrichedSignal extends RuleSignal {
  groupId: string;
  groupName: string;
}

/** Conflict between opposing signals on the same candle */
export interface SignalConflict {
  buySignals: EnrichedSignal[];
  sellSignals: EnrichedSignal[];
  resolution: EnrichedSignal;
}

/** Detailed evaluation result (from evaluateDetailed) */
export interface EvaluationResult {
  /** Same as evaluate() — filtered signals */
  signals: RuleSignal[];
  /** All signals with group metadata */
  allSignals: EnrichedSignal[];
  /** Conflicts between opposing signals */
  conflicts: SignalConflict[];
}

/** A signal marker to draw on the candlestick chart */
export interface ChartSignalMarker {
  date: string;
  type: RuleSignal['type'];
  label: string;
  /** 共振強度：同方向觸發的不同群組數 */
  strength?: number;
}

/** Replay engine state */
export interface ReplayState {
  allCandles: CandleWithIndicators[];
  currentIndex: number;       // index of the last visible candle
  isPlaying: boolean;
  playSpeed: number;          // ms per candle during auto-play
}
