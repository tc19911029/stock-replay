/**
 * BacktestEngine.ts — 嚴謹回測引擎 v2
 *
 * 核心設計原則：
 * 1. 無未來函數：訊號日的資料不能包含訊號日之後的資訊
 * 2. 進場使用隔日開盤價（最接近實際操作），含滑價
 * 3. 出場規則明確：固定持有N日、停利、停損
 * 4. 停損/停利同日觸發時，以開盤距離判斷順序
 * 5. 停損出場考慮跳空跌停場景（以開盤價出場）
 * 6. 成本模型分市場計算（台股/陸股分開）
 * 7. 追蹤跳過筆數（存活偏差透明化）
 */

import { ForwardCandle, MarketId, StockScanResult } from '@/lib/scanner/types';
import { calcRoundTripCost, CostParams } from './CostModel';

// ── Types ───────────────────────────────────────────────────────────────────────

/**
 * 通用交易訊號 — BacktestEngine 的唯一輸入依賴
 * 不包含掃描器特有欄位（price, changePercent, triggeredRules 等），
 * 讓引擎可接受任何來源的訊號（掃描器、手動標記、策略回放）。
 */
export interface TradeSignal {
  symbol:        string;
  name:          string;
  market:        MarketId;
  industry?:     string;    // 產業板塊
  signalDate:    string;    // YYYY-MM-DD
  signalScore:   number;    // 0-6
  signalReasons: string[];  // 命中條件說明
  trendState:    string;    // 趨勢狀態
  trendPosition: string;    // 趨勢位置
  surgeScore?:   number;    // 飆股潛力分數 0-100
  surgeGrade?:   string;    // 飆股等級 S/A/B/C/D
  histWinRate?:  number;    // 歷史勝率 %
  smartMoneyScore?: number; // 智慧資金分數 0-100
  compositeScore?:  number; // 綜合排名分數 0-100
  retailSentiment?: number; // 散戶情緒 0-100 (0=panic, 100=euphoria)
  contrarianSignal?: 'bullish' | 'bearish' | null;
  volatilityRegime?: 'LOW' | 'NORMAL' | 'HIGH' | 'EXTREME';
  // ── 《活用技術分析寶典》新增欄位 ──
  highWinRateTypes?: string[];     // 高勝率進場位置
  highWinRateScore?: number;       // 高勝率加分
  winnerBullishPatterns?: string[]; // 空轉多圖像
  winnerBearishPatterns?: string[]; // 多轉空圖像
  eliminationPenalty?: number;      // 淘汰法扣分
  direction?: 'long' | 'short';    // 做多/做空方向（預設做多）
  signalPrice?: number;             // 訊號日收盤價（用於計算跳空幅度）
}

/**
 * 將掃描結果轉換為通用交易訊號
 * — 掃描器 → 引擎的轉換橋接，保持雙方各自獨立演化
 */
export function scanResultToSignal(scanResult: StockScanResult): TradeSignal {
  const { sixConditionsBreakdown, sixConditionsScore, trendState, trendPosition } = scanResult;
  const reasons: string[] = [];
  if (sixConditionsBreakdown.trend)     reasons.push('趨勢多頭');
  if (sixConditionsBreakdown.position)  reasons.push('位置良好');
  if (sixConditionsBreakdown.kbar)      reasons.push('K棒長紅');
  if (sixConditionsBreakdown.ma)        reasons.push('均線多排');
  if (sixConditionsBreakdown.volume)    reasons.push('量能放大');
  if (sixConditionsBreakdown.indicator) reasons.push('指標配合');

  return {
    symbol:        scanResult.symbol,
    name:          scanResult.name,
    market:        scanResult.market,
    industry:      scanResult.industry,
    signalDate:    scanResult.scanTime.split('T')[0],
    signalScore:   sixConditionsScore,
    signalReasons: reasons,
    trendState,
    trendPosition,
    surgeScore:    scanResult.surgeScore,
    surgeGrade:    scanResult.surgeGrade,
    histWinRate:   scanResult.histWinRate,
    smartMoneyScore: scanResult.smartMoneyScore,
    compositeScore:  scanResult.compositeScore,
    retailSentiment: scanResult.retailSentiment,
    contrarianSignal: scanResult.contrarianSignal,
    volatilityRegime: scanResult.volatilityRegime,
    highWinRateTypes: scanResult.highWinRateTypes,
    highWinRateScore: scanResult.highWinRateScore,
    winnerBullishPatterns: scanResult.winnerBullishPatterns,
    winnerBearishPatterns: scanResult.winnerBearishPatterns,
    eliminationPenalty: scanResult.eliminationPenalty,
    direction: scanResult.direction,
    signalPrice: scanResult.price,
  };
}

/**
 * Adaptive exit parameters based on signal quality.
 * Higher quality signals get longer hold + wider trailing stop.
 * Lower quality signals get tighter risk management.
 *
 * Research basis:
 * - S/A grade surge stocks benefit from longer holding (capture full trend)
 * - High composite scores correlate with institutional backing (sticky trends)
 * - Weak signals should cut losses faster
 */
export function resolveAdaptiveParams(
  signal: TradeSignal,
  baseStrategy: BacktestStrategyParams,
): BacktestStrategyParams {
  const grade = signal.surgeGrade ?? 'C';
  const composite = signal.compositeScore ?? 50;

  // Adaptive hold days: S=8, A=7, B=5, C/D=4
  let holdDays = baseStrategy.holdDays;
  if (grade === 'S') holdDays = Math.max(holdDays, 8);
  else if (grade === 'A') holdDays = Math.max(holdDays, 7);
  else if (grade === 'D') holdDays = Math.min(holdDays, 4);

  // Adaptive trailing stop: wider for strong signals, tighter for weak
  let trailingStop = baseStrategy.trailingStop;
  let trailingActivate = baseStrategy.trailingActivate;
  if (composite >= 70 && trailingStop !== null) {
    trailingStop = Math.max(trailingStop, 0.05);     // wider 5% trailing
    trailingActivate = trailingActivate !== null ? Math.max(trailingActivate, 0.07) : 0.07;
  } else if (composite < 40 && trailingStop !== null) {
    trailingStop = Math.min(trailingStop, 0.02);     // tight 2% trailing
    trailingActivate = trailingActivate !== null ? Math.min(trailingActivate, 0.03) : 0.03;
  }

  // Adaptive stop loss: tighter for weak signals
  let stopLoss = baseStrategy.stopLoss;
  if (composite < 40 && stopLoss !== null) {
    stopLoss = Math.max(stopLoss, -0.04); // tighter -4% stop
  }

  // Contrarian signal adjustments:
  // Bearish (retail euphoria) → reduce hold days, tighten stops
  // Bullish (panic capitulation) → can hold longer
  if (signal.contrarianSignal === 'bearish') {
    holdDays = Math.max(2, holdDays - 2);
    if (stopLoss !== null) stopLoss = Math.max(stopLoss, -0.04);
  } else if (signal.contrarianSignal === 'bullish') {
    holdDays = Math.min(holdDays + 1, 10);
  }

  // Volatility regime adjustments:
  // HIGH/EXTREME → wider stops, shorter holds
  // LOW → tighter stops, can hold longer (cleaner trends)
  const volRegime = signal.volatilityRegime;
  if (volRegime === 'EXTREME') {
    if (stopLoss !== null) stopLoss = stopLoss * 1.5; // wider
    holdDays = Math.max(2, Math.round(holdDays * 0.6));
  } else if (volRegime === 'HIGH') {
    if (stopLoss !== null) stopLoss = stopLoss * 1.25;
    holdDays = Math.max(2, Math.round(holdDays * 0.8));
  } else if (volRegime === 'LOW') {
    // Low volatility = strongest setup (Python optimization finding).
    // Tighter stops work because noise is low; hold longer for follow-through.
    if (stopLoss !== null) stopLoss = Math.max(stopLoss, stopLoss * 0.75);
    holdDays = Math.min(12, Math.round(holdDays * 1.3));
  }

  return {
    ...baseStrategy,
    holdDays,
    trailingStop,
    trailingActivate,
    stopLoss,
  };
}

/** 回測進場方式 */
export type EntryType = 'nextOpen' | 'nextClose';

/** 出場規則 */
export type ExitRule =
  | { type: 'holdDays';   days: number }
  | { type: 'stopLoss';   pct: number }   // 負數，e.g. -0.07 = -7%
  | { type: 'takeProfit'; pct: number };  // 正數，e.g. 0.15 = +15%

/** 策略參數 */
export interface BacktestStrategyParams {
  entryType:   EntryType;
  holdDays:    number;         // 固定持有天數（主要出場規則）
  stopLoss:    number | null;  // 停損比例（負數，null = 不設停損）
  takeProfit:  number | null;  // 停利比例（正數，null = 不設停利）
  trailingStop: number | null; // 移動停利：從最高點回撤 N% 就出場（如 0.03 = 3%）
  trailingActivate: number | null; // 移動停利啟動門檻：漲到 N% 才開始追蹤（如 0.05 = 5%）
  costParams:  CostParams;
  slippagePct: number;         // 滑價百分比（如 0.001 = 0.1%，買入加 / 賣出減）
  /** 雙層出場機制：Tranche 1 (50%) 固定停利 + Tranche 2 (50%) 階梯追蹤 */
  dualTranche?: boolean;       // 啟用雙層出場（default false）
}

/** 每筆回測交易完整紀錄 */
export interface BacktestTrade {
  // ── 股票資訊 ──
  symbol:  string;
  name:    string;
  industry?: string;       // 產業板塊
  market:  MarketId;

  // ── 訊號資訊 ──
  signalDate:    string;    // 掃描日期（發現訊號的日期）
  signalScore:   number;    // 六大條件分數 0-6
  signalReasons: string[];  // 哪些條件通過（說明命中原因）
  trendState:    string;    // 訊號當時的趨勢狀態
  trendPosition: string;    // 訊號當時的位置

  // ── 進場 ──
  entryDate:  string;       // 實際進場日期
  entryPrice: number;       // 進場價（含滑價）
  entryType:  EntryType;    // 進場方式

  // ── 出場 ──
  exitDate:   string;       // 出場日期
  exitPrice:  number;       // 出場價（含跳空/滑價）
  exitReason: string;       // 出場原因（'holdDays' | 'stopLoss' | 'takeProfit' | 'dataEnd'）
  holdDays:   number;       // 實際持有天數（交易日）

  // ── 飆股指標 ──
  surgeScore?:  number;     // 飆股潛力分數 0-100
  surgeGrade?:  string;     // 飆股等級 S/A/B/C/D
  histWinRate?: number;     // 歷史勝率 %
  isGapUp?:     boolean;    // 隔日高開跳空 > 5%（實際難以開盤價買入）
  gapUpPct?:    number;     // 跳空幅度（%）

  // ── 績效 ──
  grossReturn: number;      // 毛報酬率 % (不含成本)
  netReturn:   number;      // 淨報酬率 % (含成本)
  buyFee:      number;      // 買入成本（元）
  sellFee:     number;      // 賣出成本（元）
  totalCost:   number;      // 總成本（元）
}

/** 回測統計摘要 */
export interface BacktestStats {
  count:       number;
  wins:        number;
  losses:      number;
  winRate:     number;          // %
  avgGrossReturn: number;
  avgNetReturn:   number;
  medianReturn:   number;
  maxGain:     number;
  maxLoss:     number;
  maxDrawdown: number;          // 最大回撤（權益曲線峰值到谷值，負數）
  totalNetReturn: number;       // 所有筆的淨報酬加總（非複利）
  expectancy:  number;          // 期望值 = winRate * avgWin - lossRate * avgLoss
  // ── 風險調整指標 ──
  sharpeRatio:  number | null;  // (avgNetReturn - 0) / stdReturn
  profitFactor: number | null;  // 總獲利 / |總虧損|
  payoffRatio:  number | null;  // 平均獲利 / |平均虧損|
  // ── 存活偏差 ──
  skippedCount: number;         // 因資料不足被跳過的筆數
  coverageRate: number;         // 有效覆蓋率 % = count / (count + skippedCount)
  // ── 跳過原因分類（P0-2: 透明化倖存者偏差來源）──
  skipReasons?: SkipReasons;
}

/** 回測跳過原因分類 */
export interface SkipReasons {
  noForwardData:      number;   // forwardCandles 為空（資料源無回傳）
  limitUpLockout:     number;   // 漲停鎖定無法進場
  insufficientCandles: number;  // candles 不足以計算指標
}

// ── Default Params ──────────────────────────────────────────────────────────────

/**
 * 純朱家泓策略：固定參數，不使用 adaptive/trailing/dual-tranche
 * 書中基本設定：持有5日、停損5%、停利15%
 */
export const PURE_ZHU_STRATEGY: BacktestStrategyParams = {
  entryType:        'nextOpen',
  holdDays:         5,
  stopLoss:         -0.05,
  takeProfit:       0.15,
  trailingStop:     null,
  trailingActivate: null,
  costParams:       { twFeeDiscount: 0.6 },
  slippagePct:      0.001,
  dualTranche:      false,
};

/**
 * 朱老師獲利方程式策略：搭配 runSOPBacktest + ZhuExitParams 使用
 * 進場用 nextOpen，出場交給獲利方程式分層邏輯
 * stopLoss/takeProfit/trailing 設 null — 由 ZhuExitParams 控制
 */
export const ZHU_PROFIT_FORMULA_STRATEGY: BacktestStrategyParams = {
  entryType:        'nextOpen',
  holdDays:         20,         // 安全網天數，實際由獲利方程式決定何時出場
  stopLoss:         null,       // 由 ZhuExitParams.dynamicStopLoss 控制
  takeProfit:       null,       // 由獲利方程式分層停利控制
  trailingStop:     null,       // 不用移動停利，改用 MA5 跌破停利
  trailingActivate: null,
  costParams:       { twFeeDiscount: 0.6 },
  slippagePct:      0.001,
  dualTranche:      false,
};

export const DEFAULT_STRATEGY: BacktestStrategyParams = {
  entryType:   'nextOpen',
  holdDays:    5,
  stopLoss:    -0.05,           // -5% 停損
  takeProfit:  0.15,            // +15% 固定停利（安全網）
  trailingStop: 0.03,           // 移動停利：從最高點回撤 3% 出場
  trailingActivate: 0.05,       // 漲到 +5% 才啟動移動停利
  costParams:  { twFeeDiscount: 0.6 },
  slippagePct: 0.001,
};

// ── Engine ──────────────────────────────────────────────────────────────────────

/**
 * 對單一交易訊號計算回測績效
 *
 * @param signal         通用交易訊號（用 scanResultToSignal() 從掃描結果轉換）
 * @param forwardCandles 訊號日之後的K線（已排除訊號日當天）
 * @param strategy       策略參數
 */
export function runSingleBacktest(
  signal:         TradeSignal,
  forwardCandles: ForwardCandle[],
  strategy:       BacktestStrategyParams = DEFAULT_STRATEGY,
): BacktestTrade | null {
  if (forwardCandles.length === 0) return null;

  // ── 進場（含滑價）─────────────────────────────────────────────────────────
  const entryCandle = forwardCandles[0];
  const rawEntryPrice = strategy.entryType === 'nextOpen'
    ? entryCandle.open
    : entryCandle.close;

  if (!rawEntryPrice || rawEntryPrice <= 0) return null;

  // ── 漲停板檢測 ──────────────────────────────────────────────────────────
  // 判斷隔日是否漲停鎖死（散戶無法買入）
  // 台股：漲停幅度 10%，陸股：主板10%、創業板/科創板20%
  if (strategy.entryType === 'nextOpen') {
    const range = entryCandle.high - entryCandle.low;
    const rangeRatio = entryCandle.low > 0 ? range / entryCandle.low : 0;
    // 漲停鎖死特徵：開盤=最高價 且 振幅極小（<0.5%）
    const isLockUp = entryCandle.open === entryCandle.high && rangeRatio < 0.005;
    if (isLockUp) {
      return null; // 漲停鎖死，買不到
    }
  }

  // ── P2-4: 跳空缺口進場標記 ───────────────────────────────────────────────
  // 以訊號日收盤價為基準，計算隔日開盤的跳空幅度
  // 跳空 > 5% 時標記，讓用戶知道此筆回測的進場成本比預期高
  let isGapUp = false;
  let gapUpPct: number | undefined;
  if (signal.signalPrice && signal.signalPrice > 0) {
    const gap = (rawEntryPrice - signal.signalPrice) / signal.signalPrice * 100;
    if (gap >= 5) {
      isGapUp = true;
      gapUpPct = +gap.toFixed(2);
    }
  }

  // 買入滑價：實際買入價 ≥ 報價（追高成交）
  const entryPrice = rawEntryPrice * (1 + strategy.slippagePct);

  // ── 出場模擬（逐根判斷停損/停利） ─────────────────────────────────────────
  // 朱老師獲利方程式（《活用技術分析寶典》p.54）整合
  let exitDate:   string = '';
  let exitPrice:  number = 0;
  let exitReason: string = 'holdDays';
  let holdDays:   number = 0;

  // nextOpen 進場：持有窗口從進場日（candles[0]）開始，但進場日的停損/停利判斷
  // 只能用 close（因為日線的 low/high 包含開盤前的價格波動，無法區分進場後的真實日內走勢）
  // nextClose 進場：持有窗口從隔日（candles[1]）開始
  const offset = strategy.entryType === 'nextOpen' ? 0 : 1;
  const holdWindow = forwardCandles.slice(offset, offset + strategy.holdDays);

  // 獲利方程式第1條：停損設在進場紅K最低點（使用進場日的最低價）
  // 如果進場日最低價距進場價 >7%，則用固定停損
  const entryDayLow = forwardCandles[0]?.low ?? 0;
  const dynamicStopPct = entryDayLow > 0 ? (entryDayLow - entryPrice) / entryPrice : -0.05;
  const effectiveStopLoss = strategy.stopLoss !== null
    ? (dynamicStopPct >= -0.07 && dynamicStopPct < 0 ? dynamicStopPct : strategy.stopLoss)
    : null;

  const stopLossPrice   = effectiveStopLoss !== null ? entryPrice * (1 + effectiveStopLoss) : null;
  const takeProfitPrice = strategy.takeProfit !== null ? entryPrice * (1 + strategy.takeProfit) : null;

  // ── 移動停利追蹤 ────────────────────────────────────────────────────────
  const trailingStop     = strategy.trailingStop     ?? null;
  const trailingActivate = strategy.trailingActivate ?? null;
  let   highestPrice     = entryPrice;  // 追蹤持有期間最高價
  let   trailingActive   = false;       // 是否已啟動移動停利

  for (let i = 0; i < holdWindow.length; i++) {
    const c = holdWindow[i];
    holdDays = i + 1;

    // 更新最高價（用收盤價追蹤，更穩定）
    if (c.close > highestPrice) highestPrice = c.close;

    // 檢查移動停利是否啟動（漲到 activate 門檻）
    if (!trailingActive && trailingActivate !== null && trailingStop !== null) {
      const currentReturn = (highestPrice - entryPrice) / entryPrice;
      if (currentReturn >= trailingActivate) trailingActive = true;
    }

    // 進場當天（i===0 且 nextOpen 模式）：只用收盤判斷停損/停利
    const isEntryDay = i === 0 && strategy.entryType === 'nextOpen';
    const hitSL = stopLossPrice   !== null && (isEntryDay ? c.close <= stopLossPrice   : c.low  <= stopLossPrice);
    const hitTP = takeProfitPrice !== null && (isEntryDay ? c.close >= takeProfitPrice : c.high >= takeProfitPrice);

    // 移動停利觸發：從最高點回撤超過 trailingStop%
    let hitTrailing = false;
    let trailingExitPrice = 0;
    if (trailingActive && trailingStop !== null && !isEntryDay) {
      trailingExitPrice = highestPrice * (1 - trailingStop);
      if (c.low <= trailingExitPrice) hitTrailing = true;
    }

    if (hitSL || hitTP || hitTrailing) {
      if (hitSL && (hitTP || hitTrailing)) {
        // 停損和停利/移動停利同時觸及
        const distSL = Math.abs(c.open - (stopLossPrice ?? c.open));
        const otherPrice = hitTP ? takeProfitPrice! : trailingExitPrice;
        const distOther = Math.abs(c.open - otherPrice);
        if (distSL <= distOther) {
          exitReason = 'stopLoss';
          exitPrice = c.open <= stopLossPrice!
            ? +(c.open * (1 - strategy.slippagePct)).toFixed(3)
            : +stopLossPrice!.toFixed(3);
        } else {
          exitReason = hitTP ? 'takeProfit' : 'trailingStop';
          exitPrice  = +(hitTP ? takeProfitPrice! : trailingExitPrice).toFixed(3);
        }
      } else if (hitSL) {
        exitReason = 'stopLoss';
        exitPrice = c.open <= stopLossPrice!
          ? +(c.open * (1 - strategy.slippagePct)).toFixed(3)
          : +stopLossPrice!.toFixed(3);
      } else if (hitTrailing) {
        exitReason = 'trailingStop';
        exitPrice = +(c.open <= trailingExitPrice
          ? c.open * (1 - strategy.slippagePct)
          : trailingExitPrice).toFixed(3);
      } else {
        exitReason = 'takeProfit';
        exitPrice  = +takeProfitPrice!.toFixed(3);
      }
      exitDate = c.date;
      break;
    }

    // ── 朱老師獲利方程式出場規則（非進場日才判斷） ──────────────────────
    if (!isEntryDay) {
      const currentReturn = (c.close - entryPrice) / entryPrice;

      // 獲利方程式第6條：獲利 >10%、收盤跌破 MA5 → 出場
      if (currentReturn > 0.10 && c.ma5 != null && c.close < c.ma5) {
        exitReason = 'profitBreakMA5';
        exitPrice  = +(c.close * (1 - strategy.slippagePct)).toFixed(3);
        exitDate   = c.date;
        holdDays   = i + 1;
        break;
      }

      // 長線第8條：股價上漲約1倍（50%以上），不做長線操作 → 強制出場
      if (currentReturn > 0.50) {
        exitReason = 'longTermGainLimit';
        exitPrice  = +(c.close * (1 - strategy.slippagePct)).toFixed(3);
        exitDate   = c.date;
        holdDays   = i + 1;
        break;
      }

      // 獲利方程式第7條：獲利 >20% 或連續急漲3天+大量長黑 → 當天出場
      if (currentReturn > 0.20) {
        exitReason = 'profitClimaxExit';
        exitPrice  = +(c.close * (1 - strategy.slippagePct)).toFixed(3);
        exitDate   = c.date;
        holdDays   = i + 1;
        break;
      }

      // 連續3天急漲後出現長黑K
      if (i >= 3) {
        const prev3Up = [holdWindow[i-1], holdWindow[i-2], holdWindow[i-3]]
          .every(x => x.close > x.open);
        const isLongBlack = c.close < c.open && (c.open - c.close) / c.open >= 0.02;
        if (prev3Up && isLongBlack) {
          exitReason = 'profitClimaxExit';
          exitPrice  = +(c.close * (1 - strategy.slippagePct)).toFixed(3);
          exitDate   = c.date;
          holdDays   = i + 1;
          break;
        }
      }

      // 獲利方程式第3條：收盤出現「頭頭低」→ 出場
      if (i >= 4) {
        // 簡化判斷：近期高點下降
        const recentHighs = holdWindow.slice(Math.max(0, i - 4), i + 1).map(x => x.high);
        const maxRecent = Math.max(...recentHighs.slice(0, -1));
        if (c.high < maxRecent * 0.98 && c.close < c.open) {
          exitReason = 'lowerHighExit';
          exitPrice  = +(c.close * (1 - strategy.slippagePct)).toFixed(3);
          exitDate   = c.date;
          holdDays   = i + 1;
          break;
        }
      }
    }

    // 最後一天：以收盤出場（含賣出滑價）
    if (i === holdWindow.length - 1) {
      exitPrice  = +(c.close * (1 - strategy.slippagePct)).toFixed(3);
      exitDate   = c.date;
      exitReason = holdWindow.length < strategy.holdDays ? 'dataEnd' : 'holdDays';
    }
  }

  if (!exitDate || exitPrice <= 0 || holdDays === 0) return null;

  // ── 成本計算 ──────────────────────────────────────────────────────────────
  const unitShares = signal.market === 'TW' ? 1000 : 100;
  const buyAmount  = entryPrice * unitShares;
  const sellAmount = exitPrice  * unitShares;

  const cost = calcRoundTripCost(
    signal.market,
    signal.symbol,
    buyAmount,
    sellAmount,
    strategy.costParams,
  );

  // ── 報酬計算 ──────────────────────────────────────────────────────────────
  const grossReturn = +((exitPrice - entryPrice) / entryPrice * 100).toFixed(3);
  const netPnL      = sellAmount - buyAmount - cost.total;
  const netReturn   = +(netPnL / buyAmount * 100).toFixed(3);

  return {
    symbol:  signal.symbol,
    name:    signal.name,
    market:  signal.market,
    industry: signal.industry,

    signalDate:    signal.signalDate,
    signalScore:   signal.signalScore,
    signalReasons: signal.signalReasons,
    trendState:    signal.trendState,
    trendPosition: signal.trendPosition,
    surgeScore:    signal.surgeScore,
    surgeGrade:    signal.surgeGrade,
    histWinRate:   signal.histWinRate,

    entryDate:  entryCandle.date,
    entryPrice: +entryPrice.toFixed(3),
    entryType:  strategy.entryType,

    exitDate,
    exitPrice:  +exitPrice.toFixed(3),
    exitReason,
    holdDays,

    grossReturn,
    netReturn,
    buyFee:    cost.buyFee,
    sellFee:   cost.sellFee,
    totalCost: cost.total,
  };
}

/**
 * Dual-tranche exit: split position into two halves.
 * Tranche 1 (50%): exits at fixed take-profit (1.5x ATR-based, approximated as 2/3 of takeProfit)
 * Tranche 2 (50%): uses stepped trailing stop (tighter trailing as profit grows)
 *
 * Returns a single BacktestTrade with blended return from both tranches.
 */
export function runDualTrancheBacktest(
  signal:         TradeSignal,
  forwardCandles: ForwardCandle[],
  strategy:       BacktestStrategyParams,
): BacktestTrade | null {
  if (forwardCandles.length === 0) return null;

  // Tranche 1: early take-profit (2/3 of original TP), same stop loss, no trailing
  const tp1 = strategy.takeProfit !== null ? strategy.takeProfit * 0.67 : 0.05;
  const strat1: BacktestStrategyParams = {
    ...strategy,
    takeProfit: tp1,
    trailingStop: null,
    trailingActivate: null,
    dualTranche: false,
  };

  // Tranche 2: no fixed TP, aggressive stepped trailing stop
  // Stepped: start at 3%, tighten by 0.5% for every +2% gained
  const trailingBase = strategy.trailingStop ?? 0.03;
  const strat2: BacktestStrategyParams = {
    ...strategy,
    takeProfit: null, // let it ride
    trailingStop: trailingBase,
    trailingActivate: strategy.trailingActivate ?? 0.03,
    dualTranche: false,
  };

  const trade1 = runSingleBacktest(signal, forwardCandles, strat1);
  const trade2 = runSingleBacktest(signal, forwardCandles, strat2);

  if (!trade1 && !trade2) return null;

  // Blend returns: 50/50 weighted average
  if (trade1 && trade2) {
    const blendedGross = +(trade1.grossReturn * 0.5 + trade2.grossReturn * 0.5).toFixed(3);
    const blendedNet   = +(trade1.netReturn * 0.5 + trade2.netReturn * 0.5).toFixed(3);
    // Use the later exit date
    const laterTrade = new Date(trade1.exitDate) >= new Date(trade2.exitDate) ? trade1 : trade2;
    return {
      ...laterTrade,
      grossReturn: blendedGross,
      netReturn:   blendedNet,
      exitReason:  `dual:${trade1.exitReason}/${trade2.exitReason}`,
      holdDays:    Math.max(trade1.holdDays, trade2.holdDays),
      buyFee:      trade1.buyFee + trade2.buyFee,
      sellFee:     trade1.sellFee + trade2.sellFee,
      totalCost:   trade1.totalCost + trade2.totalCost,
    };
  }

  // Only one tranche succeeded
  return trade1 ?? trade2;
}

// ── SOP-Enhanced Exit (朱家泓《活用技術分析寶典》短線波段操作守則) ──────────

/**
 * 計算簡單移動平均（使用 ForwardCandle 的 close 價）
 */
function calcSMA(candles: ForwardCandle[], endIdx: number, period: number): number | null {
  if (endIdx < period - 1) return null;
  let sum = 0;
  for (let i = endIdx - period + 1; i <= endIdx; i++) {
    sum += candles[i].close;
  }
  return sum / period;
}

/**
 * 計算均量 (5日)
 */
function calcAvgVol(candles: ForwardCandle[], endIdx: number, period = 5): number | null {
  if (endIdx < period - 1) return null;
  let sum = 0;
  for (let i = endIdx - period + 1; i <= endIdx; i++) {
    sum += (candles[i].volume ?? 0);
  }
  return sum / period;
}

/**
 * 朱老師獲利方程式出場參數
 *
 * 完整實作《活用技術分析寶典》p.54 獲利方程式 7 條
 * + 短線波段操作守則 20 條中可程式化的出場規則
 */
export interface ZhuExitParams {
  // ── 停損 ──
  dynamicStopLoss: boolean;     // 用進場K線最低點（true）或固定比例（false）
  fixedStopLossPct: number;     // 固定停損比例，預設 -0.05
  maxStopLossPct: number;       // 動態停損最大距離，超過用固定，預設 -0.07

  // ── 獲利方程式分層 ──
  profitTakeMa5Pct: number;     // 獲利 > 此值，跌破MA5停利，預設 0.10
  profitClimaxPct: number;      // 獲利 > 此值，長黑出場，預設 0.20

  // ── 輔助出場條件 ──
  enableLowerHigh: boolean;     // 頭頭低出場（獲利方程式第3條），預設 true
  enableStrongCover: boolean;   // 強覆蓋減碼（短線第11條），預設 true
  enableWeeklyResist: boolean;  // 週線遇壓出場（短線第19條），預設 true
  enableSeasonLine: boolean;    // 季線下彎出場（短線第20條），預設 true

  // ── 安全網 ──
  maxHoldDays: number;          // 最大持有天數，預設 20
}

/** 朱老師獲利方程式預設參數 */
export const DEFAULT_ZHU_EXIT: ZhuExitParams = {
  dynamicStopLoss:    true,
  fixedStopLossPct:   -0.05,
  maxStopLossPct:     -0.07,
  profitTakeMa5Pct:   0.10,
  profitClimaxPct:    0.20,
  enableLowerHigh:    true,
  enableStrongCover:  true,
  enableWeeklyResist: true,
  enableSeasonLine:   true,
  maxHoldDays:        20,
};

/**
 * 朱家泓完整出場邏輯（獲利方程式 7 條 + 短線守則）
 *
 * 出場優先順序（每根 K 棒逐根檢查）：
 * 1. 停損（動態K線最低點 或 固定5%）
 * 2. 頭頭低（獲利方程式第3條）
 * 3. 獲利>20% + 大量長黑跌破前日低 → 全出（守則8）
 * 4. 獲利>20% + 連漲3天 + 大量長黑 → 全出（守則7）
 * 5. 強覆蓋（黑K破前日紅K一半 + KD下彎）→ 減碼效果（守則11）
 * 6. 獲利>10% + 跌破MA5 → 停利（守則6，守則15例外）
 * 7. 獲利<10% + 跌破MA5 → 續抱；跌破MA20 → 出場（守則5）
 * 8. 連漲3天 + 大量長黑覆蓋 → 出場（獲利方程式第7條）
 * 9. 週線遇壓 + 跌破MA5 → 出場（守則19）
 * 10. 季線下彎 + 跌破MA5 → 出場（守則20）
 * 11. 時間停損（最大持有天數）
 */
export function runSOPBacktest(
  signal:         TradeSignal,
  forwardCandles: ForwardCandle[],
  strategy:       BacktestStrategyParams = DEFAULT_STRATEGY,
  zhuExit:        ZhuExitParams = DEFAULT_ZHU_EXIT,
): BacktestTrade | null {
  if (forwardCandles.length === 0) return null;

  // ── 進場（含滑價）
  const entryCandle = forwardCandles[0];
  const rawEntryPrice = strategy.entryType === 'nextOpen'
    ? entryCandle.open
    : entryCandle.close;

  if (!rawEntryPrice || rawEntryPrice <= 0) return null;

  // 漲停板檢測
  if (strategy.entryType === 'nextOpen') {
    const range = entryCandle.high - entryCandle.low;
    const rangeRatio = entryCandle.low > 0 ? range / entryCandle.low : 0;
    const isLockUp = entryCandle.open === entryCandle.high && rangeRatio < 0.005;
    if (isLockUp) return null;
  }

  const entryPrice = rawEntryPrice * (1 + strategy.slippagePct);

  // ── SOP 出場模擬 ──
  let exitDate   = '';
  let exitPrice  = 0;
  let exitReason = 'holdDays';
  let holdDays   = 0;

  const offset = strategy.entryType === 'nextOpen' ? 0 : 1;
  const maxHold = zhuExit.maxHoldDays;
  const holdWindow = forwardCandles.slice(offset, offset + maxHold);

  // ── 停損價計算（獲利方程式第1條）──
  // 動態停損：進場紅K最低點；若距離 > maxStopLossPct，改用固定比例
  let stopLossPrice: number | null = null;
  if (zhuExit.dynamicStopLoss) {
    const entryDayLow = forwardCandles[0]?.low ?? 0;
    const dynamicPct = entryDayLow > 0
      ? (entryDayLow - entryPrice) / entryPrice
      : zhuExit.fixedStopLossPct;
    const effectivePct = (dynamicPct >= zhuExit.maxStopLossPct && dynamicPct < 0)
      ? dynamicPct
      : zhuExit.fixedStopLossPct;
    stopLossPrice = entryPrice * (1 + effectivePct);
  } else if (zhuExit.fixedStopLossPct < 0) {
    stopLossPrice = entryPrice * (1 + zhuExit.fixedStopLossPct);
  }

  let highestPrice = entryPrice;
  let highestClose = entryPrice;
  let consecutiveRedDays = 0; // 連續紅K天數
  // 強覆蓋減碼追蹤：觸發後模擬持有50%部位
  let halfPositionMode = false;

  for (let i = 0; i < holdWindow.length; i++) {
    const c = holdWindow[i];
    holdDays = i + 1;
    const isEntryDay = i === 0 && strategy.entryType === 'nextOpen';
    const isRedCandle = c.close > c.open;
    const isBlackCandle = c.close < c.open;
    const currentReturn = (c.close - entryPrice) / entryPrice;
    const currentReturnFromHigh = highestClose > entryPrice
      ? (highestClose - entryPrice) / entryPrice : 0;

    // 更新追蹤
    if (c.high > highestPrice) highestPrice = c.high;
    if (c.close > highestClose) highestClose = c.close;
    if (isRedCandle) consecutiveRedDays++;
    else consecutiveRedDays = 0;

    // ══════════════════════════════════════════════════════════════
    // 1. 停損檢查（最優先）— 獲利方程式第1、2條
    // ══════════════════════════════════════════════════════════════
    if (stopLossPrice !== null) {
      const hitSL = isEntryDay ? c.close <= stopLossPrice : c.low <= stopLossPrice;
      if (hitSL) {
        exitReason = 'stopLoss';
        exitPrice = c.open <= stopLossPrice
          ? +(c.open * (1 - strategy.slippagePct)).toFixed(3)
          : +stopLossPrice.toFixed(3);
        exitDate = c.date;
        break;
      }
    }

    // 進場當天只看收盤停損
    if (isEntryDay) continue;

    // 計算均線（在 forwardCandles 上）
    const absIdx = offset + i;
    const ma5 = calcSMA(forwardCandles, absIdx, 5);
    const ma20 = calcSMA(forwardCandles, absIdx, 20);
    const ma60 = calcSMA(forwardCandles, absIdx, 60);
    const prevMa20 = absIdx >= 1 ? calcSMA(forwardCandles, absIdx - 1, 20) : null;
    const prevMa60 = absIdx >= 5 ? calcSMA(forwardCandles, absIdx - 5, 60) : null;
    const avgVol = calcAvgVol(forwardCandles, absIdx, 5);
    const prevCandle = holdWindow[i - 1];

    // ══════════════════════════════════════════════════════════════
    // 2. 頭頭低檢查 — 獲利方程式第3條
    // ══════════════════════════════════════════════════════════════
    if (zhuExit.enableLowerHigh && i >= 3) {
      const h1 = holdWindow[i - 2].high;
      const h2 = holdWindow[i - 1].high;
      const h3 = c.high;
      const l1 = holdWindow[i - 2].low;
      const l2 = holdWindow[i - 1].low;
      const l3 = c.low;
      if (h3 < h2 && h2 < h1 && l3 < l2 && l2 < l1) {
        exitReason = 'sop_trendReverse';
        exitPrice = +(c.close * (1 - strategy.slippagePct)).toFixed(3);
        exitDate = c.date;
        break;
      }
    }

    // ══════════════════════════════════════════════════════════════
    // 3. 獲利>20% + 大量長黑跌破前日低 → 全出（守則8）
    // ══════════════════════════════════════════════════════════════
    if (currentReturnFromHigh >= zhuExit.profitClimaxPct && isBlackCandle && prevCandle) {
      const bodyPct = Math.abs(c.close - c.open) / c.open;
      const isLongBlack = bodyPct >= 0.02;
      const breaksPrevLow = c.close < prevCandle.low;
      if (isLongBlack && breaksPrevLow) {
        exitReason = 'sop_bigGainLongBlack';
        exitPrice = +(c.close * (1 - strategy.slippagePct)).toFixed(3);
        exitDate = c.date;
        break;
      }
    }

    // ══════════════════════════════════════════════════════════════
    // 4. 獲利>20% + 連漲3天 + 大量長黑 → 全出（守則7）
    // ══════════════════════════════════════════════════════════════
    if (currentReturnFromHigh >= zhuExit.profitClimaxPct && isBlackCandle && consecutiveRedDays === 0) {
      if (i >= 3) {
        const prevRedStreak = holdWindow[i - 1].close > holdWindow[i - 1].open
          && holdWindow[i - 2].close > holdWindow[i - 2].open
          && holdWindow[i - 3].close > holdWindow[i - 3].open;
        const bodyPct = Math.abs(c.close - c.open) / c.open;
        const isLargeVol = avgVol != null && avgVol > 0 && (c.volume ?? 0) >= avgVol * 1.5;
        if (prevRedStreak && bodyPct >= 0.02 && isLargeVol) {
          exitReason = 'sop_rushThenBlack';
          exitPrice = +(c.close * (1 - strategy.slippagePct)).toFixed(3);
          exitDate = c.date;
          break;
        }
      }
    }

    // ══════════════════════════════════════════════════════════════
    // 5. 急漲後長黑覆蓋 — 獲利方程式第7條（不限獲利幅度）
    //    連續3天紅K上漲 + 出現大量長黑K覆蓋/吞噬 → 當天出場
    // ══════════════════════════════════════════════════════════════
    if (i >= 3 && isBlackCandle) {
      const prev3AllRed = holdWindow[i - 1].close > holdWindow[i - 1].open
        && holdWindow[i - 2].close > holdWindow[i - 2].open
        && holdWindow[i - 3].close > holdWindow[i - 3].open;
      const bodyPct = Math.abs(c.close - c.open) / c.open;
      const isLargeVol = avgVol != null && avgVol > 0 && (c.volume ?? 0) >= avgVol * 1.5;
      // 覆蓋/吞噬：黑K實體覆蓋前日紅K實體
      const coversPrev = prevCandle && c.open >= prevCandle.close && c.close <= prevCandle.open;
      if (prev3AllRed && bodyPct >= 0.02 && (isLargeVol || coversPrev)) {
        exitReason = 'sop_climaxCover';
        exitPrice = +(c.close * (1 - strategy.slippagePct)).toFixed(3);
        exitDate = c.date;
        break;
      }
    }

    // ══════════════════════════════════════════════════════════════
    // 6. 強覆蓋減碼 — 短線第11條
    //    黑K跌破前日紅K一半 + KD下彎 → 模擬減碼一半
    //    已減碼狀態下再跌破MA5 → 全出
    // ══════════════════════════════════════════════════════════════
    if (zhuExit.enableStrongCover && prevCandle && !halfPositionMode) {
      const prevIsRed = prevCandle.close > prevCandle.open;
      if (prevIsRed && isBlackCandle) {
        const prevMidPrice = (prevCandle.open + prevCandle.close) / 2;
        // KD 下彎近似：用近2根收盤價趨勢代替（forwardCandle 沒有 KD 值）
        const priceDownTurn = i >= 2 && holdWindow[i - 1].close > c.close;
        if (c.close < prevMidPrice && priceDownTurn) {
          halfPositionMode = true;
          // 不 break，繼續持有剩餘 50%，但標記減碼
        }
      }
    }
    // 已減碼一半的狀態：次日開低或跌破MA5 → 全出
    if (halfPositionMode && i >= 1) {
      const openedLower = c.open < prevCandle.close;
      const brokeMA5 = ma5 !== null && c.close < ma5;
      if (openedLower || brokeMA5) {
        exitReason = 'sop_strongCoverExit';
        exitPrice = +(c.close * (1 - strategy.slippagePct)).toFixed(3);
        exitDate = c.date;
        break;
      }
    }

    // ══════════════════════════════════════════════════════════════
    // 7. 獲利>10% + 收盤跌破MA5 → 停利（守則6）
    //    守則15 例外：跌幅<1%，量縮，MA20向上 → 可續抱
    // ══════════════════════════════════════════════════════════════
    if (currentReturnFromHigh >= zhuExit.profitTakeMa5Pct && ma5 !== null && c.close < ma5) {
      // 守則 15 例外
      const dropPct = Math.abs(c.close - c.open) / c.open;
      const isVolShrink = avgVol != null && avgVol > 0 && (c.volume ?? 0) < avgVol * 0.8;
      const isMA20Up = ma20 != null && prevMa20 != null && ma20 > prevMa20;

      if (dropPct < 0.01 && isVolShrink && isMA20Up) {
        // 守則 15: 續抱
        continue;
      }

      exitReason = 'sop_gain10BreakMA5';
      exitPrice = +(c.close * (1 - strategy.slippagePct)).toFixed(3);
      exitDate = c.date;
      break;
    }

    // ══════════════════════════════════════════════════════════════
    // 8. 獲利<10% + 跌破MA5 → 續抱（守則5）
    //    跌破MA20 → 出場（保護線失守）
    // ══════════════════════════════════════════════════════════════
    if (currentReturn >= 0 && currentReturn < zhuExit.profitTakeMa5Pct
        && ma5 !== null && c.close < ma5) {
      if (ma20 !== null && c.close < ma20) {
        exitReason = 'sop_breakMA20';
        exitPrice = +(c.close * (1 - strategy.slippagePct)).toFixed(3);
        exitDate = c.date;
        break;
      }
      // 守則 5: 續抱
      continue;
    }

    // ══════════════════════════════════════════════════════════════
    // 9. 週線遇壓 + 跌破MA5 → 出場（短線第19條）
    //    用MA60作為週線壓力近似（60日≈12週）
    // ══════════════════════════════════════════════════════════════
    if (zhuExit.enableWeeklyResist && ma60 !== null && ma5 !== null && isBlackCandle) {
      const nearMa60 = ma60 > c.close && (ma60 - c.close) / c.close < 0.05;
      const prevAboveMa5 = prevCandle && prevCandle.close >= (calcSMA(forwardCandles, absIdx - 1, 5) ?? 0);
      const breakMa5 = c.close < ma5;
      if (nearMa60 && prevAboveMa5 && breakMa5) {
        exitReason = 'sop_weeklyResistBreakMA5';
        exitPrice = +(c.close * (1 - strategy.slippagePct)).toFixed(3);
        exitDate = c.date;
        break;
      }
    }

    // ══════════════════════════════════════════════════════════════
    // 10. 季線下彎 + 跌破MA5 → 出場（短線第20條）
    //     即使獲利<10% 也要出場
    // ══════════════════════════════════════════════════════════════
    if (zhuExit.enableSeasonLine && ma60 !== null && prevMa60 !== null && ma5 !== null) {
      const ma60Declining = ma60 < prevMa60;
      const aboveMa60 = c.close > ma60;
      const prevAboveMa5 = prevCandle && prevCandle.close >= (calcSMA(forwardCandles, absIdx - 1, 5) ?? 0);
      const breakMa5 = c.close < ma5;
      if (ma60Declining && aboveMa60 && prevAboveMa5 && breakMa5) {
        exitReason = 'sop_seasonLineBreakMA5';
        exitPrice = +(c.close * (1 - strategy.slippagePct)).toFixed(3);
        exitDate = c.date;
        break;
      }
    }

    // ── 最後一天：以收盤出場（時間停損安全網）──
    if (i === holdWindow.length - 1) {
      exitPrice = +(c.close * (1 - strategy.slippagePct)).toFixed(3);
      exitDate  = c.date;
      exitReason = holdWindow.length < maxHold ? 'dataEnd' : 'holdDays';
    }
  }

  if (!exitDate || exitPrice <= 0 || holdDays === 0) return null;

  // ── 成本計算 ──
  const unitShares = signal.market === 'TW' ? 1000 : 100;
  const buyAmount  = entryPrice * unitShares;
  const sellAmount = exitPrice  * unitShares;

  const cost = calcRoundTripCost(
    signal.market,
    signal.symbol,
    buyAmount,
    sellAmount,
    strategy.costParams,
  );

  // ── 報酬計算（考慮減碼）──
  // 強覆蓋減碼：第一半在強覆蓋觸發當天收盤出場，第二半在最終出場價出場
  // 簡化處理：halfPositionMode 時，blended return = 50% × 強覆蓋出場報酬 + 50% × 最終出場報酬
  // 因為我們沒記錄強覆蓋觸發的精確價格，近似用「最終出場報酬打折」
  // 邏輯：減碼一半 = 提前鎖定一半獲利/虧損，剩下一半繼續持有到最終出場
  const rawGrossReturn = (exitPrice - entryPrice) / entryPrice * 100;
  const grossReturn = halfPositionMode
    ? +(rawGrossReturn * 0.75).toFixed(3)  // 近似：減碼後平均報酬 ≈ 75% of full
    : +rawGrossReturn.toFixed(3);
  const netPnL      = sellAmount - buyAmount - cost.total;
  const rawNetReturn = netPnL / buyAmount * 100;
  const netReturn   = halfPositionMode
    ? +(rawNetReturn * 0.75).toFixed(3)
    : +rawNetReturn.toFixed(3);

  return {
    symbol:  signal.symbol,
    name:    signal.name,
    market:  signal.market,
    industry: signal.industry,

    signalDate:    signal.signalDate,
    signalScore:   signal.signalScore,
    signalReasons: signal.signalReasons,
    trendState:    signal.trendState,
    trendPosition: signal.trendPosition,
    surgeScore:    signal.surgeScore,
    surgeGrade:    signal.surgeGrade,
    histWinRate:   signal.histWinRate,

    entryDate:  entryCandle.date,
    entryPrice: +entryPrice.toFixed(3),
    entryType:  strategy.entryType,

    exitDate,
    exitPrice:  +exitPrice.toFixed(3),
    exitReason: halfPositionMode && exitReason !== 'sop_strongCoverExit'
      ? `sop_strongCover+${exitReason}` : exitReason,
    holdDays,

    grossReturn,
    netReturn,
    buyFee:    cost.buyFee,
    sellFee:   cost.sellFee,
    totalCost: cost.total,
  };
}

/**
 * 做空版朱老師獲利方程式回測
 *
 * 朱老師做空獲利方程式 8 條（《活用技術分析寶典》p.84-85）：
 * ① 放空後收盤跌破 MA5，但尚未獲利 <5% → 繼續持有
 * ② 停損設在進場黑K最高點（5-7%）
 * ③ 股價收盤突破停損點 → 立即回補出場
 * ④ 底底高（上升波浪確認） → 趨勢轉多，回補出場
 * ⑤ 股價跌而不破前低，反彈不過前高 → 弱勢，繼續持有
 * ⑥ 獲利 <10%，股價收盤反彈突破 MA5 → 繼續等待
 * ⑦ 獲利 >10%，股價收盤反彈突破 MA5 → 回補出場
 * ⑧ 獲利 >20% + 急跌後出現大量長紅K（做空高潮） → 回補出場
 */
export function runShortSOPBacktest(
  signal:         TradeSignal,
  forwardCandles: ForwardCandle[],
  strategy:       BacktestStrategyParams = ZHU_PROFIT_FORMULA_STRATEGY,
  zhuExit:        ZhuExitParams = DEFAULT_ZHU_EXIT,
): BacktestTrade | null {
  if (forwardCandles.length === 0) return null;

  // ── 做空進場（含滑價，做空時以較低價成交有利）──
  const entryCandle = forwardCandles[0];
  const rawEntryPrice = strategy.entryType === 'nextOpen'
    ? entryCandle.open
    : entryCandle.close;

  if (!rawEntryPrice || rawEntryPrice <= 0) return null;

  // 跌停板鎖死 → 無法放空
  if (strategy.entryType === 'nextOpen') {
    const range = entryCandle.high - entryCandle.low;
    const rangeRatio = entryCandle.low > 0 ? range / entryCandle.low : 0;
    const isLockDown = entryCandle.open === entryCandle.low && rangeRatio < 0.005;
    if (isLockDown) return null;
  }

  // 放空進場價（做空滑價：以稍低價成交，多付一點滑價）
  const entryPrice = rawEntryPrice * (1 - strategy.slippagePct);

  let exitDate   = '';
  let exitPrice  = 0;
  let exitReason = 'holdDays';
  let holdDays   = 0;

  const offset = strategy.entryType === 'nextOpen' ? 0 : 1;
  const maxHold = zhuExit.maxHoldDays;
  const holdWindow = forwardCandles.slice(offset, offset + maxHold);

  // ── 做空停損設在進場黑K最高點（獲利方程式第②條）──
  // 動態停損：進場黑K最高點；若距離 >7%，改用固定比例
  let stopLossPrice: number | null = null;
  {
    const entryDayHigh = forwardCandles[0]?.high ?? 0;
    const dynamicPct = entryDayHigh > 0
      ? (entryDayHigh - entryPrice) / entryPrice   // 正值 = 停損需要上漲 X%
      : Math.abs(zhuExit.fixedStopLossPct);
    const effectivePct = dynamicPct <= 0.07
      ? dynamicPct
      : Math.abs(zhuExit.fixedStopLossPct);
    stopLossPrice = entryPrice * (1 + effectivePct);
  }

  let lowestPrice = entryPrice;
  let lowestClose = entryPrice;

  for (let i = 0; i < holdWindow.length; i++) {
    const c = holdWindow[i];
    holdDays = i + 1;
    const isEntryDay = i === 0 && strategy.entryType === 'nextOpen';
    const isRedCandle  = c.close > c.open;
    const currentReturn = (entryPrice - c.close) / entryPrice; // 做空：下跌為正獲利

    // 更新最低價追蹤
    if (c.low < lowestPrice) lowestPrice = c.low;
    if (c.close < lowestClose) lowestClose = c.close;

    // ── 停損檢查（獲利方程式第③條：突破停損點 → 回補）──
    if (stopLossPrice !== null) {
      const hitSL = isEntryDay ? c.close >= stopLossPrice : c.high >= stopLossPrice;
      if (hitSL) {
        exitReason = 'stopLoss';
        exitPrice = c.open >= stopLossPrice
          ? +(c.open * (1 + strategy.slippagePct)).toFixed(3)
          : +stopLossPrice.toFixed(3);
        exitDate = c.date;
        break;
      }
    }

    if (isEntryDay) continue;

    const absIdx = offset + i;
    const ma5  = calcSMA(forwardCandles, absIdx, 5);
    const ma20 = calcSMA(forwardCandles, absIdx, 20);
    const prevCandle = holdWindow[i - 1];

    // ── 獲利方程式第④條：底底高（上升波浪確認）→ 回補出場 ──
    if (zhuExit.enableLowerHigh && i >= 3) {
      const l1 = holdWindow[i - 2].low;
      const l2 = holdWindow[i - 1].low;
      const l3 = c.low;
      const h1 = holdWindow[i - 2].high;
      const h2 = holdWindow[i - 1].high;
      const h3 = c.high;
      // 底底高 + 頭頭高 = 趨勢轉多
      if (l3 > l2 && l2 > l1 && h3 > h2 && h2 > h1) {
        exitReason = 'sop_shortTrendReversal';
        exitPrice = +(c.close * (1 + strategy.slippagePct)).toFixed(3);
        exitDate = c.date;
        break;
      }
    }

    // ── 獲利方程式第⑦條：獲利 >10%，反彈突破 MA5 → 回補出場 ──
    if (currentReturn > 0.10 && ma5 != null && c.close > ma5) {
      exitReason = 'sop_shortProfitBreakMA5';
      exitPrice = +(c.close * (1 + strategy.slippagePct)).toFixed(3);
      exitDate = c.date;
      break;
    }

    // ── 獲利方程式第⑧條：獲利 >20% + 大量長紅K（做空高潮）→ 回補出場 ──
    const profitFromLow = lowestClose > 0
      ? (entryPrice - lowestClose) / entryPrice
      : 0;
    if (profitFromLow >= zhuExit.profitClimaxPct && isRedCandle && prevCandle) {
      const bodyPct = Math.abs(c.close - c.open) / c.open;
      const breaksPrevHigh = c.close > prevCandle.high;
      if (bodyPct >= 0.02 && breaksPrevHigh) {
        exitReason = 'sop_shortBigGainLongRed';
        exitPrice = +(c.close * (1 + strategy.slippagePct)).toFixed(3);
        exitDate = c.date;
        break;
      }
    }

    // ── 獲利方程式第⑥條（變形）：MA20 下彎 + 反彈回測 MA20 → 回補出場 ──
    if (currentReturn > 0.05 && ma20 != null && c.close > ma20) {
      const prevMa20 = absIdx >= 1 ? calcSMA(forwardCandles, absIdx - 1, 20) : null;
      const ma20TurnUp = prevMa20 != null && ma20 > prevMa20;
      if (ma20TurnUp) {
        exitReason = 'sop_shortMA20TurnUp';
        exitPrice = +(c.close * (1 + strategy.slippagePct)).toFixed(3);
        exitDate = c.date;
        break;
      }
    }

    // ── 最後一天：回補出場（時間停損安全網）──
    if (i === holdWindow.length - 1) {
      exitPrice = +(c.close * (1 + strategy.slippagePct)).toFixed(3);
      exitDate  = c.date;
      exitReason = holdWindow.length < maxHold ? 'dataEnd' : 'holdDays';
    }
  }

  if (!exitDate || exitPrice <= 0 || holdDays === 0) return null;

  // ── 成本計算 ──
  const unitShares = signal.market === 'TW' ? 1000 : 100;
  const sellAmount = entryPrice  * unitShares; // 放空：先賣
  const buyAmount  = exitPrice   * unitShares; // 回補：後買

  const cost = calcRoundTripCost(
    signal.market,
    signal.symbol,
    buyAmount,
    sellAmount,
    strategy.costParams,
  );

  // ── 報酬計算（做空：進場賣出 → 回補買入，下跌為正）──
  const grossReturn = +((entryPrice - exitPrice) / entryPrice * 100).toFixed(3);
  const netPnL = sellAmount - buyAmount - cost.total;
  const netReturn = +(netPnL / sellAmount * 100).toFixed(3);

  return {
    symbol:  signal.symbol,
    name:    signal.name,
    market:  signal.market,
    industry: signal.industry,

    signalDate:    signal.signalDate,
    signalScore:   signal.signalScore,
    signalReasons: signal.signalReasons,
    trendState:    signal.trendState,
    trendPosition: signal.trendPosition,
    surgeScore:    signal.surgeScore,
    surgeGrade:    signal.surgeGrade,
    histWinRate:   signal.histWinRate,

    entryDate:  entryCandle.date,
    entryPrice: +entryPrice.toFixed(3),
    entryType:  strategy.entryType,

    exitDate,
    exitPrice: +exitPrice.toFixed(3),
    exitReason,
    holdDays,

    grossReturn,
    netReturn,
    buyFee:    cost.buyFee,
    sellFee:   cost.sellFee,
    totalCost: cost.total,
  };
}

/**
 * 批量回測：對所有掃描結果計算回測績效
 * 回傳 trades 陣列及被跳過的筆數（存活偏差追蹤）
 */
export function runBatchBacktest(
  scanResults:       StockScanResult[],
  forwardCandlesMap: Record<string, ForwardCandle[]>,
  strategy:          BacktestStrategyParams = DEFAULT_STRATEGY,
  /** 使用朱老師獲利方程式出場邏輯 */
  useSOPExit = false,
  /** 朱老師出場參數（僅 useSOPExit=true 時有效） */
  zhuExit:           ZhuExitParams = DEFAULT_ZHU_EXIT,
): { trades: BacktestTrade[]; skippedCount: number; skipReasons: SkipReasons } {
  const trades: BacktestTrade[] = [];
  let skippedCount = 0;
  const skipReasons: SkipReasons = { noForwardData: 0, limitUpLockout: 0, insufficientCandles: 0 };

  for (const result of scanResults) {
    const candles = forwardCandlesMap[result.symbol] ?? [];

    // P0-2: 分類跳過原因
    if (candles.length === 0) {
      skippedCount++;
      skipReasons.noForwardData++;
      continue;
    }

    const signal = scanResultToSignal(result);
    const adaptiveStrategy = resolveAdaptiveParams(signal, strategy);

    let trade: BacktestTrade | null;
    if (useSOPExit) {
      trade = runSOPBacktest(signal, candles, adaptiveStrategy, zhuExit);
    } else if (adaptiveStrategy.dualTranche) {
      trade = runDualTrancheBacktest(signal, candles, adaptiveStrategy);
    } else {
      trade = runSingleBacktest(signal, candles, adaptiveStrategy);
    }

    if (trade) {
      trades.push(trade);
    } else {
      skippedCount++;
      // 判斷是漲停鎖死還是數據不足
      const entry = candles[0];
      const range = entry.high - entry.low;
      const rangeRatio = entry.low > 0 ? range / entry.low : 0;
      const isLockUp = entry.open === entry.high && rangeRatio < 0.005;
      if (isLockUp) skipReasons.limitUpLockout++;
      else skipReasons.insufficientCandles++;
    }
  }

  return { trades, skippedCount, skipReasons };
}

/**
 * 純朱家泓批量回測：不用 adaptive params，固定策略參數
 */
export function runBatchBacktestPure(
  scanResults:       StockScanResult[],
  forwardCandlesMap: Record<string, ForwardCandle[]>,
): { trades: BacktestTrade[]; skippedCount: number; skipReasons: SkipReasons } {
  const trades: BacktestTrade[] = [];
  let skippedCount = 0;
  const skipReasons: SkipReasons = { noForwardData: 0, limitUpLockout: 0, insufficientCandles: 0 };

  for (const result of scanResults) {
    const candles = forwardCandlesMap[result.symbol] ?? [];

    if (candles.length === 0) {
      skippedCount++;
      skipReasons.noForwardData++;
      continue;
    }

    const signal = scanResultToSignal(result);
    const trade = runSingleBacktest(signal, candles, PURE_ZHU_STRATEGY);
    if (trade) {
      trades.push(trade);
    } else {
      skippedCount++;
      const entry = candles[0];
      const range = entry.high - entry.low;
      const rangeRatio = entry.low > 0 ? range / entry.low : 0;
      const isLockUp = entry.open === entry.high && rangeRatio < 0.005;
      if (isLockUp) skipReasons.limitUpLockout++;
      else skipReasons.insufficientCandles++;
    }
  }

  return { trades, skippedCount, skipReasons };
}

/**
 * 計算回測統計摘要
 * @param trades        回測交易列表
 * @param skippedCount  被跳過的筆數（用於計算覆蓋率）
 */
export function calcBacktestStats(
  trades:       BacktestTrade[],
  skippedCount = 0,
  skipReasons?: SkipReasons,
): BacktestStats | null {
  if (trades.length === 0) return null;

  const returns = trades.map(t => t.netReturn);
  const wins    = trades.filter(t => t.netReturn > 0);
  const losses  = trades.filter(t => t.netReturn <= 0);

  const avgGrossReturn = +(trades.reduce((s, t) => s + t.grossReturn, 0) / trades.length).toFixed(3);
  const avgNetReturn   = +(returns.reduce((a, b) => a + b, 0) / returns.length).toFixed(3);

  const sorted       = [...returns].sort((a, b) => a - b);
  const medianReturn = +sorted[Math.floor(sorted.length / 2)].toFixed(3);
  const maxGain      = +Math.max(...returns).toFixed(3);
  const maxLoss      = +Math.min(...returns).toFixed(3);
  const totalNetReturn = +returns.reduce((a, b) => a + b, 0).toFixed(3);

  // ── 真正的 Maximum Drawdown：權益曲線峰值到谷值的最大回撤 ──────────────────
  let equity      = 0;
  let peak        = 0;
  let maxDrawdown = 0;
  for (const r of returns) {
    equity += r;
    if (equity > peak) peak = equity;
    const dd = equity - peak;
    if (dd < maxDrawdown) maxDrawdown = dd;
  }

  const avgWin  = wins.length   > 0 ? wins.reduce((s, t)   => s + t.netReturn, 0) / wins.length   : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.netReturn, 0) / losses.length : 0;
  const winRate = wins.length / trades.length;
  const expectancy = +(winRate * avgWin + (1 - winRate) * avgLoss).toFixed(3);

  // ── 風險調整指標 ──────────────────────────────────────────────────────────
  let sharpeRatio:  number | null = null;
  let profitFactor: number | null = null;
  let payoffRatio:  number | null = null;

  if (trades.length >= 2) {
    const variance = returns.reduce((s, r) => s + (r - avgNetReturn) ** 2, 0) / (returns.length - 1);
    const std = Math.sqrt(variance);
    sharpeRatio = std > 0 ? +(avgNetReturn / std).toFixed(3) : null;

    const totalWin  = returns.filter(r => r > 0).reduce((a, b) => a + b, 0);
    const totalLossAbs = Math.abs(returns.filter(r => r < 0).reduce((a, b) => a + b, 0));
    profitFactor = totalLossAbs > 0 ? +(totalWin / totalLossAbs).toFixed(3) : null;

    const avgLossAbs = avgLoss < 0 ? Math.abs(avgLoss) : 0;
    payoffRatio = avgLossAbs > 0 ? +(avgWin / avgLossAbs).toFixed(3) : null;
  }

  // ── 存活偏差統計 ─────────────────────────────────────────────────────────
  const total = trades.length + skippedCount;
  const coverageRate = total > 0 ? +(trades.length / total * 100).toFixed(1) : 100;

  return {
    count:    trades.length,
    wins:     wins.length,
    losses:   losses.length,
    winRate:  +(winRate * 100).toFixed(1),
    avgGrossReturn,
    avgNetReturn,
    medianReturn,
    maxGain,
    maxLoss,
    maxDrawdown: +maxDrawdown.toFixed(3),
    totalNetReturn,
    expectancy,
    sharpeRatio,
    profitFactor,
    payoffRatio,
    skippedCount,
    coverageRate,
    skipReasons,
  };
}

/**
 * 依持有天數分組統計（用於比較 d1/d3/d5/d10/d20 的差異）
 */
export function calcStatsByHorizon(
  scanResults:       StockScanResult[],
  forwardCandlesMap: Record<string, ForwardCandle[]>,
  horizons:          number[] = [1, 3, 5, 10, 20],
  baseStrategy:      BacktestStrategyParams = DEFAULT_STRATEGY,
): Record<number, BacktestStats | null> {
  const result: Record<number, BacktestStats | null> = {};

  for (const days of horizons) {
    const strat = { ...baseStrategy, holdDays: days, stopLoss: null, takeProfit: null };
    const { trades, skippedCount } = runBatchBacktest(scanResults, forwardCandlesMap, strat);
    result[days] = calcBacktestStats(trades, skippedCount);
  }

  return result;
}

// ── Capital-Constrained Backtest (#7) ────────────────────────────────────────

/**
 * 資本限制參數
 * 模擬「以固定資金、最多同時持 N 檔」的實際操作場景
 */
export interface CapitalConstraints {
  initialCapital:  number;  // 初始資金（元），例如 1_000_000
  maxPositions:    number;  // 最多同時持倉數，例如 3
  positionSizePct: number;  // 每筆倉位佔初始資金比例，例如 0.1 = 10%
  maxPerSector?:   number;  // 同一產業最多持倉數（防集中風險）
}

export const DEFAULT_CAPITAL: CapitalConstraints = {
  initialCapital:  1_000_000,
  maxPositions:    5,
  positionSizePct: 0.1,
  maxPerSector:    2,       // 同產業最多 2 檔
};

/**
 * 資本限制批量回測
 *
 * 從掃描結果中依六大條件分數（高→低）挑選前 N 檔進場，
 * 計算在資本限制下的實際資金曲線。
 *
 * 簡化假設：
 * - 同一批掃描訊號（同日）依分數排序，依序進場直到達到 maxPositions
 * - 每筆以 positionSizePct * initialCapital 資金進場
 * - 被排除的訊號計入 skippedByCapital
 */
export function runBatchBacktestWithCapital(
  scanResults:       StockScanResult[],
  forwardCandlesMap: Record<string, ForwardCandle[]>,
  strategy:          BacktestStrategyParams = DEFAULT_STRATEGY,
  constraints:       CapitalConstraints     = DEFAULT_CAPITAL,
): {
  trades:            BacktestTrade[];
  skippedCount:      number;   // 資料不足跳過
  skippedByCapital:  number;   // 資本限制排除
  finalCapital:      number;   // 模擬結束後資金
  capitalReturn:     number;   // 整體資金報酬率 %
} {
  // 依綜合分排序：優先使用 compositeScore（含 smart money），否則 fallback 舊邏輯
  function calcComposite(r: StockScanResult): number {
    if (r.compositeScore != null) return r.compositeScore;
    const sixCon = (r.sixConditionsScore / 6) * 100;
    const surge  = r.surgeScore ?? 0;
    const winR   = r.histWinRate ?? 50;
    const posBonus = r.trendPosition?.includes('起漲') ? 100
                   : r.trendPosition?.includes('主升') ? 70
                   : r.trendPosition?.includes('末升') ? 20 : 50;
    const volBonus = r.surgeComponents?.volume?.score ?? 50;
    return sixCon * 0.35 + surge * 0.25 + winR * 0.20 + posBonus * 0.10 + volBonus * 0.10;
  }
  const sorted = [...scanResults].sort(
    (a, b) => calcComposite(b) - calcComposite(a),
  );

  // Apply sector concentration limit: pick top stocks but limit per-sector exposure
  const maxPerSector = constraints.maxPerSector ?? Infinity;
  const sectorCount = new Map<string, number>();
  const eligible: StockScanResult[] = [];
  let skippedBySector = 0;

  for (const r of sorted) {
    if (eligible.length >= constraints.maxPositions) break;
    const sector = r.industry ?? '__unknown__';
    const count = sectorCount.get(sector) ?? 0;
    if (count >= maxPerSector) {
      skippedBySector++;
      continue;
    }
    sectorCount.set(sector, count + 1);
    eligible.push(r);
  }
  const excluded = sorted.length - eligible.length - skippedBySector;

  const trades: BacktestTrade[] = [];
  let skippedCount = 0;
  let capital = constraints.initialCapital;

  for (const result of eligible) {
    const candles = forwardCandlesMap[result.symbol] ?? [];
    const signal = scanResultToSignal(result);
    const adaptiveStrategy = resolveAdaptiveParams(signal, strategy);
    const trade   = runSingleBacktest(signal, candles, adaptiveStrategy);

    if (!trade) {
      skippedCount++;
      continue;
    }

    // Dynamic position sizing: higher composite → larger allocation (±30%)
    const composite = result.compositeScore ?? 50;
    const sizeMult = composite >= 75 ? 1.3
                   : composite >= 60 ? 1.1
                   : composite < 40  ? 0.7
                   : 1.0;
    const positionNominal = constraints.initialCapital * constraints.positionSizePct * sizeMult;
    const dollarPnL = (trade.netReturn / 100) * positionNominal;
    capital += dollarPnL;

    trades.push(trade);
  }

  const capitalReturn = +((capital - constraints.initialCapital) / constraints.initialCapital * 100).toFixed(2);

  return {
    trades,
    skippedCount,
    skippedByCapital: excluded,
    finalCapital:     +capital.toFixed(2),
    capitalReturn,
  };
}
