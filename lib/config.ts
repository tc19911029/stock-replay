/**
 * Centralized configuration constants
 *
 * All magic numbers and configurable thresholds should be defined here
 * instead of being scattered across the codebase.
 */

// ── 台股交易成本 ─────────────────────────────────────────────────────────────
export const TW_TRADING = {
  /** 手續費率 0.1425% */
  FEE_RATE: 0.001425,
  /** 手續費折扣（六折） */
  FEE_DISCOUNT: 0.6,
  /** 當沖證交稅 0.15%（優惠稅率） */
  DAY_TRADE_TAX: 0.0015,
  /** 一般證交稅 0.3% */
  NORMAL_TAX: 0.003,
  /** 最低手續費（元） */
  MIN_FEE: 20,
} as const;

// ── 當沖引擎 ─────────────────────────────────────────────────────────────────
export const INTRADAY = {
  /** 開盤區間計算分鐘數 */
  OPEN_RANGE_MINUTES: 30,
  /** 預設初始資金 */
  DEFAULT_CAPITAL: 1_000_000,
  /** 自動交易下單比例（佔總資金） */
  AUTO_TRADE_POSITION_RATIO: 0.1,
  /** 最小下單張數 */
  MIN_SHARES: 1000,
} as const;

// ── 掃描器 ───────────────────────────────────────────────────────────────────
export const SCANNER = {
  /** 歷史勝率低於此值直接過濾 */
  MIN_HIST_WIN_RATE: 35,
  /** AI 排名最大送出股數 */
  AI_RANK_MAX_STOCKS: 15,
  /** 飆股分最低門檻（用於 Top Picks 篩選） */
  SURGE_SCORE_THRESHOLD: 40,
  /** 掃描歷史最大保留筆數 */
  MAX_HISTORY: 10,
  /** localStorage 壓縮保留結果數 */
  COMPACT_TOP_N: 20,
} as const;

// ── 回測引擎 ─────────────────────────────────────────────────────────────────
export const BACKTEST = {
  /** 各等級預設持有天數 */
  HOLD_DAYS: { S: 8, A: 7, B: 5, C: 4, D: 4 } as Record<string, number>,
  /** 嚴格停損比例 */
  TIGHT_STOP_LOSS: -0.04,
  /** 最大停損比例 */
  MAX_STOP_LOSS: -0.07,
  /** 複合分數斷點 */
  COMPOSITE_BREAKPOINTS: { HIGH: 70, LOW: 40 },
} as const;

// ── 技術分析指標 ─────────────────────────────────────────────────────────────
export const INDICATORS = {
  /** RSI 超買門檻 */
  RSI_OVERBOUGHT: 70,
  /** RSI 超賣門檻 */
  RSI_OVERSOLD: 30,
  /** RSI 計算週期 */
  RSI_PERIOD: 14,
  /** 短期均線 */
  MA_SHORT: 5,
  /** 中期均線 */
  MA_MID: 10,
  /** 長期均線 */
  MA_LONG: 20,
  /** 季線 */
  MA_QUARTER: 60,
} as const;

// ── 快取 ─────────────────────────────────────────────────────────────────────
export const CACHE = {
  /** 即時報價快取 TTL（毫秒） */
  REALTIME_TTL: 5 * 60 * 1000,
  /** 歷史數據快取 TTL（毫秒） */
  HISTORICAL_TTL: 24 * 60 * 60 * 1000,
  /** 籌碼數據快取 TTL（毫秒） */
  CHIP_TTL: 10 * 60 * 1000,
  /** 顏色主題快取 TTL（毫秒） */
  THEME_TTL: 5000,
} as const;

// ── 顯示限制 ─────────────────────────────────────────────────────────────────
export const DISPLAY = {
  /** 最大 K 線顯示數量（防止記憶體洩漏） */
  MAX_CANDLES: 2000,
} as const;
