import { CandleWithIndicators } from '@/types';
import { ruleEngine } from '@/lib/rules/ruleEngine';
import { evaluateSixConditions, detectTrend, detectTrendPosition, TrendState } from '@/lib/analysis/trendAnalysis';
import { StockScanResult, MarketConfig, TriggeredRule } from './types';
import type { StrategyThresholds } from '@/lib/strategy/StrategyConfig';
import { ZHU_V1 } from '@/lib/strategy/StrategyConfig';
import { computeSurgeScore } from '@/lib/analysis/surgeScore';
import { computeSmartMoneyScore, computeCompositeScore, detectConsecutiveBullish } from '@/lib/analysis/smartMoneyScore';
import { computeFactorIC, blendWeights, type HistoricalSignalForIC } from '@/lib/analysis/factorIC';
import { computeRetailSentiment } from '@/lib/analysis/retailSentiment';
import { analyzeSupportResistance } from '@/lib/analysis/supportResistance';
import { detectVolatilityRegime } from '@/lib/analysis/volatilityRegime';
import { computeMarketBreadth } from '@/lib/analysis/marketBreadth';
import { computeSeasonality } from '@/lib/analysis/seasonality';
import { analyzeCrossTimeframe } from '@/lib/analysis/crossTimeframe';
import { computeRelativeStrength } from '@/lib/analysis/relativeStrength';
import { analyzeGaps } from '@/lib/analysis/gapAnalysis';
import { detectCandlePatterns } from '@/lib/analysis/candlePatterns';
import { analyzePressureZones } from '@/lib/analysis/pressureZoneAnalysis';
import { analyzeBreakthroughQuality } from '@/lib/analysis/breakthroughQuality';
import { filterByCorrelation } from '@/lib/analysis/correlationFilter';
import { computeMomentumComposite } from '@/lib/analysis/momentumComposite';
import { evaluateHighWinRateEntry } from '@/lib/analysis/highWinRateEntry';
import { evaluateWinnerPatterns } from '@/lib/rules/winnerPatternRules';
import { evaluateElimination } from '@/lib/scanner/eliminationFilter';
import { analyzeTrendlines } from '@/lib/analysis/trendlineAnalysis';

const CONCURRENCY = 15; // parallel requests per chunk

export type StockEntry = { symbol: string; name: string; industry?: string };

export abstract class MarketScanner {
  abstract getMarketConfig(): MarketConfig;
  abstract getStockList(): Promise<StockEntry[]>;
  abstract fetchCandles(symbol: string, asOfDate?: string): Promise<CandleWithIndicators[]>;
  abstract getMarketTrend(asOfDate?: string): Promise<TrendState>;

  /** Temporary candle cache used during a single scan pass for correlation filter */
  private _scanCandleCache = new Map<string, CandleWithIndicators[]>();

  /**
   * 根據大盤趨勢動態計算個股最低分數門檻
   * 使用策略設定的 bullMinScore / sidewaysMinScore / bearMinScore
   */
  private marketTrendToMinScore(marketTrend: TrendState, thresholds: StrategyThresholds): number {
    if (marketTrend === '多頭') return thresholds.bullMinScore;
    if (marketTrend === '盤整') return thresholds.sidewaysMinScore;
    return thresholds.bearMinScore; // 空頭
  }

  private async scanOne(
    symbol: string,
    rawName: string,
    config: MarketConfig,
    minScore: number,
    thresholds: StrategyThresholds,
    asOfDate?: string,
    industry?: string,
  ): Promise<StockScanResult | null> {
    try {
      // 陸股：用動態 API 取最新公司名（東方財富 f14 可能是舊名）
      let name = rawName;
      if (/\.(SZ|SS)$/i.test(symbol)) {
        try {
          const code = symbol.replace(/\.(SZ|SS)$/i, '');
          const { getCNChineseName } = await import('@/lib/datasource/TWSENames');
          const cnName = await getCNChineseName(code);
          if (cnName) name = cnName;
        } catch { /* 查不到就用東方財富的名字 */ }
      }

      const candles = await this.fetchCandles(symbol, asOfDate);
      if (candles.length < 30) return null;
      // Cache candles for correlation filter (only during scan pass)
      this._scanCandleCache.set(symbol, candles);

      const lastIdx  = candles.length - 1;
      const last     = candles[lastIdx];
      const prev     = candles[lastIdx - 1];
      const signals  = ruleEngine.evaluate(candles, lastIdx);
      const sixConds = evaluateSixConditions(candles, lastIdx, thresholds);
      const trend    = detectTrend(candles, lastIdx);
      const position = detectTrendPosition(candles, lastIdx);

      // ── 篩股條件（嚴格版 — 寧可錯過，不可做錯）────────────────────────────
      // 1. 空頭趨勢：嚴禁做多
      if (trend === '空頭') return null;

      // 先計算 surgeScore
      const surge = computeSurgeScore(candles, lastIdx);

      // 2. 六大條件門檻 — 不再降門檻，嚴格執行
      if (sixConds.totalScore < minScore) return null;

      // 2.5 六大條件滿分陷阱 — 全部滿足時通常股票已漲完，回測顯示 6/6 虧最多
      if (sixConds.totalScore >= 6) return null;

      // 3. 最低飆股潛力分 — 過濾弱勢股
      const minSurge = config.marketId === 'CN' ? 30 : 40;  // 陸股門檻稍低（波動結構不同）
      if (surge.totalScore < minSurge) return null;

      // 4. 乖離過大 — 所有股票都必須檢查（不再豁免高 surge 股票，它們更危險）
      if (last.ma20 && last.ma20 > 0) {
        const overExtended = (last.close - last.ma20) / last.ma20 > thresholds.deviationMax;
        if (overExtended) return null;
      }
      // 5. KD 超買 — 所有股票都必須檢查
      if (last.kdK != null && last.kdK > thresholds.kdMaxEntry) return null;

      // 5.5 複合過熱檢查 — 多個過熱指標同時觸發 = 頂部信號，直接拒絕
      {
        let overheatCount = 0;
        if (last.rsi14 != null && last.rsi14 > 75) overheatCount++;
        // 5 日漲幅：用前 5 根 K 棒的收盤價計算
        const bar5Ago = lastIdx >= 5 ? candles[lastIdx - 5] : undefined;
        if (bar5Ago && bar5Ago.close > 0) {
          const roc5 = ((last.close - bar5Ago.close) / bar5Ago.close) * 100;
          if (roc5 > 8) overheatCount++;
        }
        if (last.roc10 != null && last.roc10 > 15) overheatCount++;
        if (last.ma20 && last.ma20 > 0 && (last.close - last.ma20) / last.ma20 > 0.12) overheatCount++;
        if (last.kdK != null && last.kdK > 85) overheatCount++;
        if (overheatCount >= 3) return null;
      }

      // 6. 成交量太低 — 過濾冷門股（陸股量能單位不同，門檻不同）
      const minVolume = config.marketId === 'CN' ? 50000 : 1000;  // A股用手，台股用張
      if (last.volume < minVolume) return null;

      // 7. 漲停隔天不追 — 前一天漲幅過大的不進場
      if (prev && prev.close > 0) {
        const prevChange = (last.close - prev.close) / prev.close;
        let limitUp = 0.095; // 台股/A股主板 10%
        if (config.marketId === 'CN') {
          const code = symbol.replace(/\.(SS|SZ)$/i, '');
          // 科創板(688xxx)和創業板(300xxx)漲跌停幅度為 20%
          if (code.startsWith('688') || code.startsWith('300')) {
            limitUp = 0.195;
          }
        }
        if (prevChange >= limitUp) return null;
      }

      // 8. 末升段不進場 — 位置太高風險大
      if (position.includes('末升')) return null;

      // 9. A-share mean reversion filter: extremely overbought RSI + high
      //    short-term gains signal incoming mean reversion (A-shares are
      //    retail-dominated → overreaction → reversal)
      if (config.marketId === 'CN' && surge.totalScore < 75) {
        const rsi = last.rsi14;
        const roc10 = last.roc10;
        // RSI > 80 AND 10-day gain > 15% = very likely to mean-revert
        if (rsi != null && rsi > 80 && roc10 != null && roc10 > 15) return null;
      }

      // 10. 紅K必要條件 — 朱老師核心：黑K不進場
      if (last.close <= last.open) return null;

      // 11. 突破前5日高點 — 朱老師核心：突破才是真信號
      const recentHighs = candles.slice(Math.max(0, lastIdx - 5), lastIdx).map(c => c.high);
      const prev5High = Math.max(...recentHighs);
      if (prev5High > 0 && last.close < prev5High) return null;

      // 12. 新鮮訊號必要條件 — 當日必須觸發至少一個 BUY/ADD 訊號
      // 原因：單純「技術面好看」是靜態狀態，可能持續數月不變；
      //       真正的買點是「今天出現新催化劑」（突破、回踩確認等）
      const hasBuySignal = signals.some(s => s.type === 'BUY' || s.type === 'ADD');
      if (!hasBuySignal) return null;

      const changePercent = prev?.close > 0
        ? +((last.close - prev.close) / prev.close * 100).toFixed(2)
        : 0;

      const triggeredRules: TriggeredRule[] = signals.map(s => ({
        ruleId:     s.ruleId,
        ruleName:   s.label,
        signalType: s.type,
        reason:     s.description,
      }));

      // ── 歷史信號勝率（模擬真實交易：隔日開盤買→持有5天收盤賣）──────────
      let histWinRate: number | undefined;
      let histSignalCount = 0;
      let histWinCount = 0;
      let histGrossProfit = 0;   // 正報酬總和
      let histGrossLoss = 0;     // 負報酬總和（絕對值）
      let histMaxLoss = 0;       // 最大單筆虧損（負值）
      // 回測最近 120 天的信號（需預留 6 天 forward data）
      const histEnd = lastIdx - 6;
      const histStart = Math.max(60, lastIdx - 120);
      for (let h = histStart; h < histEnd; h++) {
        const hSix = evaluateSixConditions(candles, h, thresholds);
        if (hSix.totalScore < minScore) continue;  // 用實際門檻
        // 隔日開盤買入
        const entryIdx = h + 1;
        if (entryIdx >= candles.length) continue;
        const entryPrice = candles[entryIdx].open;
        if (!entryPrice || entryPrice <= 0) continue;
        // 5 天後收盤賣出
        const exitIdx = Math.min(entryIdx + 5, candles.length - 1);
        const exitPrice = candles[exitIdx].close;
        const returnPct = ((exitPrice - entryPrice) / entryPrice) * 100;
        histSignalCount++;
        if (exitPrice > entryPrice) {
          histWinCount++;
          histGrossProfit += returnPct;
        } else {
          histGrossLoss += Math.abs(returnPct);
          if (returnPct < histMaxLoss) histMaxLoss = returnPct;
        }
      }
      if (histSignalCount >= 8) {
        histWinRate = Math.round((histWinCount / histSignalCount) * 100);
      }
      const histProfitFactor = histGrossLoss > 0 ? histGrossProfit / histGrossLoss : (histGrossProfit > 0 ? 3.0 : 0);

      // 12. 歷史勝率過低 — 這支股票歷史上同類信號表現差，跳過（提高至 50%）
      if (histWinRate !== undefined && histWinRate < 50) return null;

      // ── Smart Money Score & Composite Ranking ────────────────────────────
      const smartMoney = computeSmartMoneyScore(candles, lastIdx);
      const { bonus: consecutiveBonus } = detectConsecutiveBullish(candles, lastIdx);
      const ma20Dev = last.ma20 && last.ma20 > 0
        ? ((last.close - last.ma20) / last.ma20) * 100
        : undefined;

      // ── IC-based dynamic factor weighting ─────────────────────────────
      // Build historical signal records for IC computation from the same
      // backtest loop we already ran above (reuse histSignalCount data)
      let icWeights: { tech: number; surge: number; smart: number; winRate: number } | undefined;
      if (histSignalCount >= 15) {
        const icSignals: HistoricalSignalForIC[] = [];
        for (let h = histStart; h < histEnd; h++) {
          const hSix = evaluateSixConditions(candles, h, thresholds);
          if (hSix.totalScore < minScore) continue;
          const entryIdx = h + 1;
          if (entryIdx >= candles.length) continue;
          const entryP = candles[entryIdx].open;
          if (!entryP || entryP <= 0) continue;
          const exitIdx = Math.min(entryIdx + 5, candles.length - 1);
          const exitP = candles[exitIdx].close;
          const fwdReturn = ((exitP - entryP) / entryP) * 100;
          const hSurge = computeSurgeScore(candles, h);
          const hSmart = computeSmartMoneyScore(candles, h);
          icSignals.push({
            techScore: (hSix.totalScore / 6) * 100,
            surgeScore: hSurge.totalScore,
            smartMoneyScore: hSmart.totalScore,
            histWinRate: histWinRate ?? 42,
            forwardReturn: fwdReturn,
          });
        }
        if (icSignals.length >= 10) {
          const icResult = computeFactorIC(icSignals);
          icWeights = blendWeights(icResult.weights, config.marketId);
        }
      }

      const composite = computeCompositeScore(
        sixConds.totalScore,
        surge.totalScore,
        smartMoney.totalScore,
        histWinRate,
        config.marketId,
        consecutiveBonus,
        {
          profitFactor: histSignalCount >= 8 ? histProfitFactor : undefined,
          maxSingleLoss: histSignalCount >= 8 ? histMaxLoss : undefined,
          ma20Deviation: ma20Dev,
          rsi: last.rsi14 ?? undefined,
          roc10: last.roc10 ?? undefined,
        },
        icWeights,
      );

      // ── Retail Sentiment Contrarian Filter ──────────────────────────────
      const sentiment = computeRetailSentiment(candles, lastIdx);
      if (sentiment.compositeAdjust !== 0) {
        composite.compositeScore = Math.max(0, Math.min(100,
          composite.compositeScore + sentiment.compositeAdjust
        ));
      }

      // ── Support/Resistance Proximity ────────────────────────────────────
      const sr = analyzeSupportResistance(candles, lastIdx);
      if (sr.proximityScore !== 0) {
        composite.compositeScore = Math.max(0, Math.min(100,
          composite.compositeScore + sr.proximityScore
        ));
      }

      // ── Calendar Seasonality ────────────────────────────────────────────
      const scanDate = asOfDate ?? new Date().toISOString().split('T')[0];
      const seasonality = computeSeasonality(scanDate, config.marketId);
      if (seasonality.adjustment !== 0) {
        composite.compositeScore = Math.max(0, Math.min(100,
          composite.compositeScore + seasonality.adjustment
        ));
      }

      // ── Cross-Timeframe Confirmation (weekly trend) ─────────────────────
      const weekly = analyzeCrossTimeframe(candles, lastIdx);
      if (weekly.compositeAdjust !== 0) {
        composite.compositeScore = Math.max(0, Math.min(100,
          composite.compositeScore + weekly.compositeAdjust
        ));
      }

      // ── Relative Strength ───────────────────────────────────────────────
      const rs = computeRelativeStrength(candles, lastIdx);
      if (rs.compositeAdjust !== 0) {
        composite.compositeScore = Math.max(0, Math.min(100,
          composite.compositeScore + rs.compositeAdjust
        ));
      }

      // ── Gap Analysis ───────────────────────────────────────────────────
      const gapResult = analyzeGaps(candles, lastIdx);
      if (gapResult.compositeAdjust !== 0) {
        composite.compositeScore = Math.max(0, Math.min(100,
          composite.compositeScore + gapResult.compositeAdjust
        ));
      }

      // ── Candlestick Patterns ────────────────────────────────────────────
      const candlePattern = detectCandlePatterns(candles, lastIdx);
      if (candlePattern.compositeAdjust !== 0) {
        composite.compositeScore = Math.max(0, Math.min(100,
          composite.compositeScore + candlePattern.compositeAdjust
        ));
      }

      // ── Low Volatility Breakout Bonus ──────────────────────────────────
      // Key finding from Python optimization: low ATR percentile (<25) with
      // price above MA20 is the single strongest entry signal. Stocks in
      // volatility squeeze that break out tend to have strong follow-through.
      const volRegime = detectVolatilityRegime(candles, lastIdx);
      if (volRegime.percentile <= 25 && last.ma20 && last.close > last.ma20) {
        // Low vol squeeze breakout: strong bonus
        composite.compositeScore = Math.max(0, Math.min(100,
          composite.compositeScore + 10
        ));
      } else if (volRegime.percentile <= 35 && last.ma20 && last.close > last.ma20) {
        // Moderate low vol: smaller bonus
        composite.compositeScore = Math.max(0, Math.min(100,
          composite.compositeScore + 5
        ));
      } else if (volRegime.percentile >= 80) {
        // High volatility: penalty (signals less reliable)
        composite.compositeScore = Math.max(0, Math.min(100,
          composite.compositeScore - 5
        ));
      }

      // ── Pressure Zone Analysis (壓力區偵測) ────────────────────────────────
      let pressureZone: ReturnType<typeof analyzePressureZones> = {
        compositeAdjust: 0, overheadPressure: 0, overheadDistancePct: 100, zones: [], detail: '',
      };
      try {
        pressureZone = analyzePressureZones(candles, lastIdx);
        if (pressureZone.compositeAdjust !== 0) {
          composite.compositeScore = Math.max(0, Math.min(100,
            composite.compositeScore + pressureZone.compositeAdjust
          ));
        }
      } catch { /* non-critical: skip pressure zone scoring on error */ }

      // ── Breakthrough Quality (突破品質) ─────────────────────────────────────
      let breakthrough: ReturnType<typeof analyzeBreakthroughQuality> = {
        compositeAdjust: 0, totalScore: 50, grade: 'C', nWaveDetected: false,
        retestConfirmed: false, srFlipDetected: false,
        components: { approachPattern: 50, candleQuality: 50, volumeProfile: 50, retestStatus: 50, srFlip: 50 },
        detail: '',
      };
      try {
        breakthrough = analyzeBreakthroughQuality(candles, lastIdx);
        if (breakthrough.compositeAdjust !== 0) {
          composite.compositeScore = Math.max(0, Math.min(100,
            composite.compositeScore + breakthrough.compositeAdjust
          ));
        }
      } catch { /* non-critical: skip breakthrough scoring on error */ }

      // ── Multi-Dimensional Momentum Composite ──────────────────────────────
      let momentumComposite: ReturnType<typeof computeMomentumComposite> = {
        totalScore: 50, components: { priceMomentum: 50, volumeMomentum: 50, relativeStrength: 50, trendAcceleration: 50 },
        compositeAdjust: 0, detail: '',
      };
      try {
        momentumComposite = computeMomentumComposite(candles, lastIdx);
        if (momentumComposite.compositeAdjust !== 0) {
          composite.compositeScore = Math.max(0, Math.min(100,
            composite.compositeScore + momentumComposite.compositeAdjust
          ));
        }
      } catch { /* non-critical */ }

      // ── 高勝率進場位置 (朱老師《活用技術分析寶典》Part 12) ──────────────
      let highWinRateEntry: ReturnType<typeof evaluateHighWinRateEntry> = {
        matched: false, types: [], score: 0, details: [],
      };
      try {
        highWinRateEntry = evaluateHighWinRateEntry(candles, lastIdx);
        if (highWinRateEntry.score > 0) {
          composite.compositeScore = Math.max(0, Math.min(100,
            composite.compositeScore + highWinRateEntry.score
          ));
        }
      } catch { /* non-critical */ }

      // ── 33 種贏家圖像 (朱老師 40 年精華) ──────────────────────────────
      let winnerPatterns: ReturnType<typeof evaluateWinnerPatterns> = {
        bearishPatterns: [], bullishPatterns: [], compositeAdjust: 0,
      };
      try {
        winnerPatterns = evaluateWinnerPatterns(candles, lastIdx);
        if (winnerPatterns.compositeAdjust !== 0) {
          composite.compositeScore = Math.max(0, Math.min(100,
            composite.compositeScore + winnerPatterns.compositeAdjust
          ));
        }
      } catch { /* non-critical */ }

      // ── 切線分析 ──────────────────────────────────────────────────────
      let trendline: ReturnType<typeof analyzeTrendlines> = {
        trendlines: [], breakAboveDescending: false, breakBelowAscending: false,
        ascendingSupport: null, descendingResistance: null, compositeAdjust: 0,
      };
      try {
        trendline = analyzeTrendlines(candles, lastIdx);
        if (trendline.compositeAdjust !== 0) {
          composite.compositeScore = Math.max(0, Math.min(100,
            composite.compositeScore + trendline.compositeAdjust
          ));
        }
      } catch { /* non-critical */ }

      // ── 淘汰法篩選 (負面扣分，不直接淘汰) ────────────────────────────
      let elimination: ReturnType<typeof evaluateElimination> = {
        eliminated: false, reasons: [], penalty: 0,
      };
      try {
        elimination = evaluateElimination(candles, lastIdx);
        if (elimination.penalty > 0) {
          composite.compositeScore = Math.max(0, Math.min(100,
            composite.compositeScore - elimination.penalty
          ));
        }
      } catch { /* non-critical */ }

      return {
        symbol,
        name,
        market: config.marketId,
        industry,
        price: last.close,
        changePercent,
        volume: last.volume,
        triggeredRules,
        sixConditionsScore: sixConds.totalScore,
        histWinRate,
        histSignalCount,
        sixConditionsBreakdown: {
          trend:     sixConds.trend.pass,
          position:  sixConds.position.pass,
          kbar:      sixConds.kbar.pass,
          ma:        sixConds.ma.pass,
          volume:    sixConds.volume.pass,
          indicator: sixConds.indicator.pass,
        },
        trendState: trend,
        trendPosition: position,
        scanTime: asOfDate ? `${asOfDate}T00:00:00.000Z` : new Date().toISOString(),
        surgeScore: surge.totalScore,
        surgeGrade: surge.grade,
        surgeFlags: surge.flags,
        surgeComponents: surge.components,
        smartMoneyScore: smartMoney.totalScore,
        smartMoneyGrade: smartMoney.grade,
        compositeScore: composite.compositeScore,
        retailSentiment: sentiment.sentimentScore,
        contrarianSignal: sentiment.contrarianSignal,
        volatilityRegime: detectVolatilityRegime(candles, lastIdx).regime,
        // ── 壓力區 & 突破品質 ──────────────────────────────────────────────
        pressureZoneAdjust: pressureZone.compositeAdjust,
        overheadPressure: pressureZone.overheadPressure,
        overheadDistancePct: pressureZone.overheadDistancePct,
        breakthroughScore: breakthrough.totalScore,
        breakthroughGrade: breakthrough.grade,
        nWaveDetected: breakthrough.nWaveDetected,
        retestConfirmed: breakthrough.retestConfirmed,
        srFlipDetected: breakthrough.srFlipDetected,
        // ── 高勝率進場位置 ────────────────────────────────────────────────
        highWinRateTypes: highWinRateEntry.types,
        highWinRateScore: highWinRateEntry.score,
        highWinRateDetails: highWinRateEntry.details,
        // ── 贏家圖像 ─────────────────────────────────────────────────────
        winnerBearishPatterns: winnerPatterns.bearishPatterns.map(p => p.name),
        winnerBullishPatterns: winnerPatterns.bullishPatterns.map(p => p.name),
        // ── 切線 ─────────────────────────────────────────────────────────
        trendlineBreakAbove: trendline.breakAboveDescending,
        trendlineBreakBelow: trendline.breakBelowAscending,
        // ── 淘汰法 ──────────────────────────────────────────────────────
        eliminationReasons: elimination.reasons,
        eliminationPenalty: elimination.penalty,
      };
    } catch {
      return null;
    }
  }

  /**
   * 純朱家泓選股：只保留六大條件 SOP 核心篩選，不加任何額外分析層
   * 用於 A/B 測試，對比完整管線 vs 純方法論的勝率差異
   */
  private async scanOnePure(
    symbol: string,
    rawName: string,
    config: MarketConfig,
    minScore: number,
    thresholds: StrategyThresholds,
    asOfDate?: string,
    industry?: string,
  ): Promise<StockScanResult | null> {
    try {
      let name = rawName;
      if (/\.(SZ|SS)$/i.test(symbol)) {
        try {
          const code = symbol.replace(/\.(SZ|SS)$/i, '');
          const { getCNChineseName } = await import('@/lib/datasource/TWSENames');
          const cnName = await getCNChineseName(code);
          if (cnName) name = cnName;
        } catch { /* fallback */ }
      }

      const candles = await this.fetchCandles(symbol, asOfDate);
      if (candles.length < 30) return null;

      const lastIdx = candles.length - 1;
      const last    = candles[lastIdx];
      const signals = ruleEngine.evaluate(candles, lastIdx);
      const sixConds = evaluateSixConditions(candles, lastIdx, thresholds);
      const trend    = detectTrend(candles, lastIdx);
      const position = detectTrendPosition(candles, lastIdx);

      // ── 純朱老師核心篩選（只有 8 條） ──
      if (trend === '空頭') return null;
      if (sixConds.totalScore < minScore) return null;
      if (last.close <= last.open) return null; // 非紅K
      // 乖離度
      if (last.ma20 && last.ma20 > 0) {
        if ((last.close - last.ma20) / last.ma20 > thresholds.deviationMax) return null;
      }
      // KD 超買
      if (last.kdK != null && last.kdK > thresholds.kdMaxEntry) return null;
      // 突破前5日高點
      const recentHighs = candles.slice(Math.max(0, lastIdx - 5), lastIdx).map(c => c.high);
      const prev5High = Math.max(...recentHighs);
      if (prev5High > 0 && last.close < prev5High) return null;
      // 有 BUY signal
      const hasBuySignal = signals.some(s => s.type === 'BUY' || s.type === 'ADD');
      if (!hasBuySignal) return null;

      const triggeredRules: TriggeredRule[] = signals.map(s => ({
        ruleId: s.ruleId, ruleName: s.label, reason: s.reason, signalType: s.type,
      }));

      const changePercent = last.open > 0
        ? +((last.close - last.open) / last.open * 100).toFixed(2)
        : 0;

      // 純模式：compositeScore = sixConditionsScore 正規化到 0-100
      const compositeScore = Math.round((sixConds.totalScore / 6) * 100);

      return {
        symbol, name,
        market: config.marketId,
        industry,
        price: last.close,
        changePercent,
        volume: last.volume,
        triggeredRules,
        sixConditionsScore: sixConds.totalScore,
        sixConditionsBreakdown: {
          trend:     sixConds.trend.pass,
          position:  sixConds.position.pass,
          kbar:      sixConds.kbar.pass,
          ma:        sixConds.ma.pass,
          volume:    sixConds.volume.pass,
          indicator: sixConds.indicator.pass,
        },
        trendState: trend,
        trendPosition: position,
        scanTime: asOfDate ? `${asOfDate}T00:00:00.000Z` : new Date().toISOString(),
        surgeScore: 0,
        compositeScore,
      };
    } catch {
      return null;
    }
  }

  /**
   * 純朱家泓掃描：用 scanOnePure，不做 correlation filter，按六大條件排序
   */
  async scanPure(
    thresholds?: StrategyThresholds,
    asOfDate?: string,
  ): Promise<{ results: StockScanResult[]; marketTrend?: TrendState }> {
    const config = this.getMarketConfig();
    const th = thresholds ?? ZHU_V1.thresholds;
    const marketTrend = await this.getMarketTrend(asOfDate);
    const minScore = this.marketTrendToMinScore(marketTrend, th);

    const stockList = await this.getStockList();
    const results: StockScanResult[] = [];

    // 並行掃描
    const chunks: StockEntry[][] = [];
    for (let i = 0; i < stockList.length; i += CONCURRENCY) {
      chunks.push(stockList.slice(i, i + CONCURRENCY));
    }

    for (const chunk of chunks) {
      const promises = chunk.map(s =>
        this.scanOnePure(s.symbol, s.name, config, minScore, th, asOfDate, s.industry)
      );
      const settled = await Promise.allSettled(promises);
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value) results.push(r.value);
      }
    }

    // 按六大條件分數排序（不用 composite）
    results.sort((a, b) => b.sixConditionsScore - a.sixConditionsScore);

    return { results, marketTrend };
  }

  /**
   * Compute full scan data for a single ticker WITHOUT any entry filters.
   * Used by the AI analysis engine to get accurate technical context.
   */
  async fetchStockScanData(symbol: string, name: string): Promise<StockScanResult | null> {
    try {
      const config = this.getMarketConfig();
      const thresholds = ZHU_V1.thresholds;
      const candles = await this.fetchCandles(symbol);
      if (candles.length < 30) return null;

      const lastIdx = candles.length - 1;
      const last    = candles[lastIdx];
      const prev    = candles[lastIdx - 1];

      const signals  = ruleEngine.evaluate(candles, lastIdx);
      const sixConds = evaluateSixConditions(candles, lastIdx, thresholds);
      const trend    = detectTrend(candles, lastIdx);
      const position = detectTrendPosition(candles, lastIdx);
      const surge    = computeSurgeScore(candles, lastIdx);
      const smartMoney = computeSmartMoneyScore(candles, lastIdx);
      const { bonus: consecutiveBonus } = detectConsecutiveBullish(candles, lastIdx);
      const composite = computeCompositeScore(sixConds.totalScore, surge.totalScore, smartMoney.totalScore, undefined, config.marketId, consecutiveBonus);
      const sentiment  = computeRetailSentiment(candles, lastIdx);
      const chip       = analyzeSupportResistance(candles, lastIdx);

      const changePercent = prev?.close > 0
        ? +((last.close - prev.close) / prev.close * 100).toFixed(2) : 0;

      const triggeredRules: TriggeredRule[] = signals.map(s => ({
        ruleId: s.ruleId, ruleName: s.label, signalType: s.type, reason: s.description,
      }));

      // Build chip detail text from nearestSupport/nearestResistance
      const chipDetail = chip
        ? `支撐 ${chip.nearestSupport?.toFixed(0) ?? '—'} / 壓力 ${chip.nearestResistance?.toFixed(0) ?? '—'}`
        : undefined;

      return {
        symbol,
        name,
        market: config.marketId,
        price: last.close,
        changePercent,
        volume: last.volume,
        triggeredRules,
        sixConditionsScore: sixConds.totalScore,
        sixConditionsBreakdown: {
          trend:     sixConds.trend.pass,
          position:  sixConds.position.pass,
          kbar:      sixConds.kbar.pass,
          ma:        sixConds.ma.pass,
          volume:    sixConds.volume.pass,
          indicator: sixConds.indicator.pass,
        },
        trendState: trend,
        trendPosition: position,
        scanTime: new Date().toISOString(),
        surgeScore: surge.totalScore,
        surgeGrade: surge.grade,
        surgeComponents: surge.components,
        smartMoneyScore: smartMoney.totalScore,
        smartMoneyGrade: smartMoney.grade,
        compositeScore: composite.compositeScore,
        retailSentiment: sentiment.sentimentScore,
        chipDetail,
      };
    } catch {
      return null;
    }
  }

  /** Scan a provided sub-list of stocks (used by chunked parallel scanning) */
  async scanList(
    stocks: StockEntry[],
    thresholds?: StrategyThresholds,
  ): Promise<{ results: StockScanResult[]; marketTrend: TrendState }> {
    return this._scanChunk(stocks, undefined, thresholds);
  }

  /** Scan a provided sub-list of stocks as of a specific historical date (backtest mode) */
  async scanListAtDate(
    stocks: StockEntry[],
    asOfDate: string,
    thresholds?: StrategyThresholds,
  ): Promise<{ results: StockScanResult[]; marketTrend: TrendState }> {
    return this._scanChunk(stocks, asOfDate, thresholds);
  }

  /**
   * 純朱家泓掃描（歷史日期版）：只用六大條件核心篩選
   */
  async scanListAtDatePure(
    stocks: StockEntry[],
    asOfDate: string,
    thresholds?: StrategyThresholds,
  ): Promise<{ results: StockScanResult[]; marketTrend: TrendState }> {
    const config = this.getMarketConfig();
    const th = thresholds ?? ZHU_V1.thresholds;
    const results: StockScanResult[] = [];

    let minScore = th.minScore;
    let marketTrend: TrendState = '多頭';
    try {
      marketTrend = await this.getMarketTrend(asOfDate);
      if (th.marketTrendFilter) {
        minScore = this.marketTrendToMinScore(marketTrend, th);
      }
    } catch { /* fallback */ }

    for (let i = 0; i < stocks.length; i += CONCURRENCY) {
      const batch = stocks.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(({ symbol, name, industry }) =>
          this.scanOnePure(symbol, name, config, minScore, th, asOfDate, industry)
        )
      );
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value) results.push(r.value);
      }
    }

    // 純模式：按六大條件排序，不限制結果數量
    results.sort((a, b) => b.sixConditionsScore - a.sixConditionsScore);
    return { results, marketTrend };
  }

  private async _scanChunk(
    stocks: StockEntry[],
    asOfDate: string | undefined,
    thresholds?: StrategyThresholds,
  ): Promise<{ results: StockScanResult[]; marketTrend: TrendState }> {
    const config = this.getMarketConfig();
    const th = thresholds ?? ZHU_V1.thresholds;
    const results: StockScanResult[] = [];
    const DEADLINE = Date.now() + 110_000; // 110s per chunk

    // ── 大盤趨勢過濾：動態調整最低分數門檻 ──────────────────────────────────
    let minScore = th.minScore;
    let marketTrend: TrendState = '多頭';
    try {
      marketTrend = await this.getMarketTrend(asOfDate);
      if (th.marketTrendFilter) {
        minScore = this.marketTrendToMinScore(marketTrend, th);
      }
    } catch {
      // 大盤趨勢取得失敗，使用預設門檻
    }

    for (let i = 0; i < stocks.length; i += CONCURRENCY) {
      if (Date.now() > DEADLINE) {
        break;
      }
      const batch = stocks.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(({ symbol, name, industry }) => this.scanOne(symbol, name, config, minScore, th, asOfDate, industry))
      );
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value) results.push(r.value);
      }
    }
    this.applySectorMomentum(results);
    // 市場環境嚴格模式：同 scan() 的限制邏輯
    let maxResults = results.length;
    if (marketTrend === '盤整') maxResults = Math.min(results.length, 8);
    if (marketTrend === '空頭') maxResults = Math.min(results.length, 3);
    const sortedResults = results.sort((a, b) =>
      (b.compositeScore ?? 0) - (a.compositeScore ?? 0)
    ).slice(0, maxResults);
    return { results: sortedResults, marketTrend };
  }

  async scan(thresholds?: StrategyThresholds): Promise<{ results: StockScanResult[]; partial: boolean; marketTrend?: TrendState }> {
    const config = this.getMarketConfig();
    const th = thresholds ?? ZHU_V1.thresholds;
    const stocks = await this.getStockList();
    const results: StockScanResult[] = [];
    const DEADLINE = Date.now() + 240_000;

    // ── 大盤趨勢過濾 ────────────────────────────────────────────────────────
    let minScore = th.minScore;
    let marketTrend: TrendState = '多頭';
    try {
      marketTrend = await this.getMarketTrend();
      if (th.marketTrendFilter) {
        minScore = this.marketTrendToMinScore(marketTrend, th);
      }
    } catch {
      // 大盤趨勢取得失敗，使用預設門檻
    }

    for (let i = 0; i < stocks.length; i += CONCURRENCY) {
      if (Date.now() > DEADLINE) {
        this.applySectorMomentum(results);
        const sorted = results.sort((a, b) =>
          (b.compositeScore ?? 0) !== (a.compositeScore ?? 0)
            ? (b.compositeScore ?? 0) - (a.compositeScore ?? 0)
            : (b.surgeScore ?? 0) !== (a.surgeScore ?? 0)
            ? (b.surgeScore ?? 0) - (a.surgeScore ?? 0)
            : b.sixConditionsScore - a.sixConditionsScore
        );
        return { results: sorted, partial: true, marketTrend };
      }
      const batch = stocks.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(({ symbol, name, industry }) => this.scanOne(symbol, name, config, minScore, th, undefined, industry))
      );
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value) results.push(r.value);
      }
    }

    // ── Sector momentum: hot sectors get bonus ──────────────────────────────
    this.applySectorMomentum(results);

    // ── Crowding Penalty (A-share specific) ──────────────────────────────
    // When too many candidates show synchronized volume spikes, it may indicate
    // quant crowding — same algo signals across many stocks simultaneously.
    if (config.marketId === 'CN' && results.length > 10) {
      const highVolCount = results.filter(r => {
        const cached = this._scanCandleCache.get(r.symbol);
        if (!cached || cached.length < 6) return false;
        const last = cached[cached.length - 1];
        return last.avgVol5 && last.avgVol5 > 0 && last.volume > last.avgVol5 * 2.5;
      }).length;
      // If >60% of candidates have extreme volume, apply crowding penalty
      if (highVolCount / results.length > 0.6) {
        for (const r of results) {
          r.compositeScore = Math.max(0, (r.compositeScore ?? 0) - 8);
        }
      }
    }

    // ── Market breadth: adjust all scores by overall market health ────────
    const breadth = computeMarketBreadth(results, stocks.length);
    if (breadth.compositeAdjust !== 0) {
      for (const r of results) {
        r.compositeScore = Math.max(0, Math.min(100,
          (r.compositeScore ?? 0) + breadth.compositeAdjust
        ));
      }
    }

    // 市場環境嚴格模式：盤整/空頭時限制輸出數量，避免低品質信號
    const sorted = results.sort((a, b) =>
      (b.compositeScore ?? 0) !== (a.compositeScore ?? 0)
        ? (b.compositeScore ?? 0) - (a.compositeScore ?? 0)
        : (b.surgeScore ?? 0) !== (a.surgeScore ?? 0)
        ? (b.surgeScore ?? 0) - (a.surgeScore ?? 0)
        : b.sixConditionsScore - a.sixConditionsScore
    );

    let maxResults = sorted.length; // 多頭不限制
    if (marketTrend === '盤整') maxResults = Math.min(sorted.length, 8);
    if (marketTrend === '空頭') maxResults = Math.min(sorted.length, 3);

    // ── Correlation Filter: remove highly correlated stocks ──────────────
    const preCorrelation = sorted.slice(0, maxResults);
    const candlesRecord: Record<string, CandleWithIndicators[]> = {};
    for (const r of preCorrelation) {
      const cached = this._scanCandleCache.get(r.symbol);
      if (cached) candlesRecord[r.symbol] = cached;
    }
    const corrFilter = filterByCorrelation(
      preCorrelation.map(r => r.symbol),
      candlesRecord,
      0.7,  // correlation threshold
      20,   // lookback days
    );
    const keptSet = new Set(corrFilter.kept);
    const finalResults = preCorrelation.filter(r => keptSet.has(r.symbol));

    // Clear candle cache after scan
    this._scanCandleCache.clear();

    return {
      results: finalResults,
      partial: false,
      marketTrend,
    };
  }

  /**
   * Sector momentum scoring: when multiple stocks from the same sector/industry
   * pass the scanner filters, it indicates institutional rotation into that sector.
   * Hot sectors get a compositeScore bonus (up to +20).
   *
   * Thresholds:
   * - 2 stocks in same sector: +5 bonus
   * - 3 stocks: +10 bonus
   * - 4 stocks: +15 bonus
   * - 5+ stocks: +20 bonus (max)
   */
  private applySectorMomentum(results: StockScanResult[]): void {
    // Group by industry/sector
    const sectorCounts = new Map<string, number>();
    for (const r of results) {
      const sector = r.industry;
      if (!sector) continue;
      sectorCounts.set(sector, (sectorCounts.get(sector) ?? 0) + 1);
    }

    // Apply bonus to stocks in hot sectors
    for (const r of results) {
      const sector = r.industry;
      if (!sector) continue;
      const count = sectorCounts.get(sector) ?? 0;
      let bonus = 0;
      if (count >= 5) bonus = 10;
      else if (count >= 4) bonus = 8;
      else if (count >= 3) bonus = 5;
      else if (count >= 2) bonus = 3;

      if (bonus > 0) {
        r.sectorHeat = bonus;
        r.compositeScore = Math.min(100, (r.compositeScore ?? 0) + bonus);
      }
    }
  }
}
