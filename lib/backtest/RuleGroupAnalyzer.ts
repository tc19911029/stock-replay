/**
 * RuleGroupAnalyzer.ts — 規則群組回測分析器
 *
 * 對 18 個規則群組分別回測，找出每個市場最有效的規則組合。
 *
 * 做法：
 * 1. 每支股票抓 1 年 K 線（一次性，複用 Yahoo 快取）
 * 2. 在記憶體中逐日滑動，對 18 個群組各自跑 RuleEngine
 * 3. 有 BUY/ADD 訊號就從 candle array 直接算前向報酬
 * 4. 按群組統計勝率、報酬率、Sharpe 等
 * 5. 排名 → 產出推薦組合
 */

import { CandleWithIndicators } from '@/types';
import { RuleEngine } from '@/lib/rules/ruleEngine';
import { DEFAULT_REGISTRY, RuleGroupId } from '@/lib/rules/ruleRegistry';
import { yahooProvider } from '@/lib/datasource/YahooDataProvider';
import { MarketId } from '@/lib/scanner/types';
import { StockEntry } from '@/lib/scanner/MarketScanner';
import {
  RuleGroupStats,
  MarketAnalysisResult,
  RuleGroupAnalysisResult,
  CrossMarketComparison,
  SignalRecord,
  AnalysisProgressEvent,
} from './ruleGroupAnalyzerTypes';
import { evaluateSixConditions } from '@/lib/analysis/trendAnalysis';

// ── 常數 ─────────────────────────────────────────────────────────────────────

const CONCURRENCY = 12;          // 並發抓取數（保守一點避免被 Yahoo 擋）
const LOOKBACK = 60;             // 留 60 根給指標計算
const FORWARD_DAYS = 20;         // 前向報酬最長看 20 天
const MIN_SIGNALS = 10;          // 訊號數低於此值自動 F 級
const VERSION = '1.0.0';

/** 扣除交易成本的近似百分比（買+賣） */
const COST_PCT: Record<MarketId, number> = {
  TW: 0.48,   // 手續費 0.1425%×2×0.6折 + 證交稅 0.3% ≈ 0.47%
  CN: 0.26,   // 佣金 0.03%×2 + 印花稅 0.1% + 過戶費 ≈ 0.26%
};

// ── 工具函式 ──────────────────────────────────────────────────────────────────

/** 計算前向報酬 %（扣成本） */
function forwardReturn(
  candles: CandleWithIndicators[],
  entryIdx: number,
  days: number,
  costPct: number,
): number | null {
  const exitIdx = entryIdx + days;
  if (exitIdx >= candles.length) return null;

  const entryPrice = candles[entryIdx + 1]?.open;  // 隔日開盤進場
  const exitPrice  = candles[exitIdx]?.close;       // N 日後收盤出場
  if (!entryPrice || !exitPrice || entryPrice <= 0) return null;

  const grossReturn = ((exitPrice - entryPrice) / entryPrice) * 100;
  return grossReturn - costPct;
}

/** 模擬實戰停損交易：隔日開盤進場，觸發停損/跌破MA5/最長20天 三擇一出場 */
interface TradeResult {
  returnPct: number;    // 報酬率%（扣成本）
  holdDays: number;     // 持有天數
  exitReason: 'stop-loss' | 'trail-ma5' | 'max-hold';
}

function simulateTrade(
  candles: CandleWithIndicators[],
  entryIdx: number,
  costPct: number,
  stopLossPct: number,     // 停損百分比，如 5 代表 -5%
  maxHold = 20,
): TradeResult | null {
  if (entryIdx + 1 >= candles.length) return null;
  const entryPrice = candles[entryIdx + 1]?.open;  // 隔日開盤進場
  if (!entryPrice || entryPrice <= 0) return null;

  const stopPrice = entryPrice * (1 - stopLossPct / 100);
  let exitPrice = entryPrice;
  let exitDay = 0;
  let exitReason: TradeResult['exitReason'] = 'max-hold';

  // 從進場隔天開始掃描
  for (let d = 1; d <= maxHold; d++) {
    const idx = entryIdx + 1 + d;
    if (idx >= candles.length) break;
    const c = candles[idx];

    // 停損：盤中最低價觸及停損價
    if (c.low <= stopPrice) {
      exitPrice = stopPrice;  // 假設停損在停損價成交
      exitDay = d;
      exitReason = 'stop-loss';
      break;
    }

    // 跌破 MA5 停利/停損（朱老師 SOP）
    if (d >= 2 && c.ma5 != null && c.close < c.ma5 && c.close < c.open) {
      // 黑K收盤跌破MA5
      exitPrice = c.close;
      exitDay = d;
      exitReason = 'trail-ma5';
      break;
    }

    // 最後一天強制出場
    if (d === maxHold) {
      exitPrice = c.close;
      exitDay = d;
      exitReason = 'max-hold';
    }
  }

  if (exitDay === 0) return null;

  const grossReturn = ((exitPrice - entryPrice) / entryPrice) * 100;
  return {
    returnPct: +(grossReturn - costPct).toFixed(2),
    holdDays: exitDay,
    exitReason,
  };
}

/** 並發控制器 */
async function parallelMap<T, R>(
  items: T[],
  fn: (item: T, idx: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIdx = 0;

  async function worker(): Promise<void> {
    while (nextIdx < items.length) {
      const idx = nextIdx++;
      results[idx] = await fn(items[idx], idx);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

/** Sharpe ratio（年化，假設 252 交易日） */
function calcSharpe(returns: number[]): number {
  if (returns.length < 5) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  // 用 5 天報酬，年化 ≈ √(252/5)
  return (mean / std) * Math.sqrt(252 / 5);
}

/** Profit factor = 總獲利 / |總虧損| */
function calcProfitFactor(returns: number[]): number {
  let gains = 0;
  let losses = 0;
  for (const r of returns) {
    if (r > 0) gains += r;
    else losses += Math.abs(r);
  }
  if (losses === 0) return gains > 0 ? 99.9 : 0;
  return +(gains / losses).toFixed(2);
}

/** 評分 + 評級 */
function gradeGroup(stats: Omit<RuleGroupStats, 'compositeScore' | 'grade'>): {
  compositeScore: number;
  grade: string;
} {
  if (stats.signalCount < MIN_SIGNALS) {
    return { compositeScore: 0, grade: 'F' };
  }

  // 加權綜合分數（滿分 100）
  const score =
    stats.winRate5d   * 0.15 +   // 短期勝率
    stats.winRate10d  * 0.20 +   // 中期勝率（最重要）
    stats.winRate20d  * 0.10 +   // 長期勝率
    Math.min(stats.avgReturn10d * 5, 20) +  // 報酬率（cap 20 分）
    Math.min(stats.sharpeRatio * 5, 15) +   // Sharpe（cap 15 分）
    Math.min(stats.profitFactor * 3, 10) +  // 獲利因子（cap 10 分）
    Math.min(stats.signalCount / 50, 1) * 5; // 訊號量足夠度（cap 5 分）

  const capped = Math.max(0, Math.min(100, score));

  let grade: string;
  if (capped >= 75) grade = 'S';
  else if (capped >= 60) grade = 'A';
  else if (capped >= 45) grade = 'B';
  else if (capped >= 30) grade = 'C';
  else if (capped >= 15) grade = 'D';
  else grade = 'F';

  return { compositeScore: +capped.toFixed(1), grade };
}

// ── 核心分析類別 ──────────────────────────────────────────────────────────────

export class RuleGroupAnalyzer {
  private groupIds: RuleGroupId[];
  private engines: Map<RuleGroupId, RuleEngine>;

  constructor() {
    // 為每個群組建立獨立的 RuleEngine 實例
    this.groupIds = DEFAULT_REGISTRY.getGroupIds();
    this.engines = new Map();
    for (const gid of this.groupIds) {
      this.engines.set(gid, new RuleEngine(DEFAULT_REGISTRY, [gid]));
    }
  }

  /**
   * 分析單一市場
   */
  async analyzeMarket(
    market: MarketId,
    stocks: StockEntry[],
    onProgress?: (event: AnalysisProgressEvent) => void,
    options?: { stockCount?: number; period?: string },
  ): Promise<MarketAnalysisResult> {
    const costPct = COST_PCT[market];
    const stockCount = options?.stockCount ?? 100;
    const period = options?.period ?? '1y';
    const topN = stocks.slice(0, stockCount);

    // ── Step 1: 抓取所有股票的 K 線 ──
    onProgress?.({ type: 'status', market, message: `正在抓取 ${topN.length} 支股票的 K 線資料（${period}）...` });

    const candlesMap = new Map<string, CandleWithIndicators[]>();
    let fetchDone = 0;

    await parallelMap(
      topN,
      async (stock) => {
        try {
          const candles = await yahooProvider.getHistoricalCandles(stock.symbol, period);
          if (candles.length >= LOOKBACK + FORWARD_DAYS + 10) {
            candlesMap.set(stock.symbol, candles);
          }
        } catch {
          // 抓不到就跳過
        }
        fetchDone++;
        if (fetchDone % 10 === 0 || fetchDone === topN.length) {
          onProgress?.({ type: 'fetching', market, done: fetchDone, total: topN.length });
        }
      },
      CONCURRENCY,
    );

    onProgress?.({ type: 'status', market, message: `資料抓取完成，${candlesMap.size} 支可用。開始分析...` });

    // ── Step 1.5: 抓大盤指數，建立多頭日期集合 ──
    const marketSymbol = market === 'TW' ? '0050.TW' : '000001.SS';
    const bullishDates = new Set<string>();
    try {
      onProgress?.({ type: 'status', market, message: `正在抓取大盤指數 ${marketSymbol}...` });
      const marketCandles = await yahooProvider.getHistoricalCandles(marketSymbol, period);
      for (let i = 20; i < marketCandles.length; i++) {
        const mc = marketCandles[i];
        // 大盤多頭：MA5 > MA20 且 收盤 > MA20
        if (mc.ma5 != null && mc.ma20 != null && mc.ma5 > mc.ma20 && mc.close > mc.ma20) {
          bullishDates.add(mc.date);
        }
      }
      onProgress?.({ type: 'status', market, message: `大盤多頭交易日：${bullishDates.size} 天` });
    } catch {
      onProgress?.({ type: 'status', market, message: `大盤指數抓取失敗，跳過大盤過濾` });
    }

    // ── Step 2: 逐股逐日評估所有群組 ──
    const signalsByGroup = new Map<RuleGroupId, SignalRecord[]>();
    for (const gid of this.groupIds) {
      signalsByGroup.set(gid, []);
    }

    let analyzeDone = 0;
    let dateFrom = '9999-12-31';
    let dateTo   = '0000-01-01';

    // 六大條件過濾統計：按通過條件數分桶
    const signalsByCondCount = new Map<number, SignalRecord[]>();
    for (let n = 0; n <= 6; n++) signalsByCondCount.set(n, []);

    // 大盤多頭過濾的訊號
    const marketBullSignals: SignalRecord[] = [];
    // 大盤多頭 + 六條件組合
    const mktCondSignals = new Map<number, SignalRecord[]>();
    for (let n = 4; n <= 6; n++) mktCondSignals.set(n, []);

    // 停損模擬用：記錄每筆信號的 candles 引用和 index
    interface SignalContext { candles: CandleWithIndicators[]; entryIdx: number; record: SignalRecord; condScore: number; isMktBull: boolean }
    const allSignalContexts: SignalContext[] = [];

    for (const [symbol, candles] of candlesMap) {
      const startIdx = LOOKBACK;
      const endIdx   = candles.length - FORWARD_DAYS - 1; // 留前向空間

      for (let i = startIdx; i <= endIdx; i++) {
        const currentDate = candles[i].date;
        if (currentDate < dateFrom) dateFrom = currentDate;
        if (currentDate > dateTo)   dateTo = currentDate;

        // 六大條件只算一次（跟群組無關）
        let condScore: number | null = null;

        // 對每個群組評估
        for (const gid of this.groupIds) {
          const engine = this.engines.get(gid)!;
          const signals = engine.evaluate(candles, i);

          // 只關心 BUY / ADD 訊號
          const buySignals = signals.filter(s => s.type === 'BUY' || s.type === 'ADD');
          if (buySignals.length === 0) continue;

          // 同一天同群組只記一筆（避免重複計算）
          const record: SignalRecord = {
            symbol,
            date: currentDate,
            ruleId: buySignals[0].ruleId,
            signalType: buySignals[0].type as 'BUY' | 'ADD',
            return5d:  forwardReturn(candles, i, 5,  costPct),
            return10d: forwardReturn(candles, i, 10, costPct),
            return20d: forwardReturn(candles, i, 20, costPct),
          };
          signalsByGroup.get(gid)!.push(record);

          // 延遲計算六大條件（有 BUY 訊號時才算）
          if (condScore === null) {
            condScore = evaluateSixConditions(candles, i).totalScore;
          }
          // 按條件數分桶記錄
          for (let n = 1; n <= 6; n++) {
            if (condScore >= n) signalsByCondCount.get(n)!.push(record);
          }

          // 大盤多頭過濾
          const isMktBull = bullishDates.has(currentDate);
          if (isMktBull) {
            marketBullSignals.push(record);
            // 大盤多頭 + 六條件組合
            for (let n = 4; n <= 6; n++) {
              if (condScore >= n) mktCondSignals.get(n)!.push(record);
            }
          }

          // 收集停損模擬上下文（每 stock/date 只記一筆）
          allSignalContexts.push({ candles, entryIdx: i, record, condScore: condScore ?? 0, isMktBull });
        }
      }

      analyzeDone++;
      if (analyzeDone % 10 === 0 || analyzeDone === candlesMap.size) {
        onProgress?.({ type: 'analyzing', market, done: analyzeDone, total: candlesMap.size });
      }
    }

    // ── Step 2.5: 建立共振虛擬群組（2+ 群組同日同股 BUY） ──
    const resonanceMap = new Map<string, { groups: Set<string>; record: SignalRecord }>();
    for (const [gid, records] of signalsByGroup) {
      for (const r of records) {
        const key = `${r.symbol}:${r.date}`;
        const existing = resonanceMap.get(key);
        if (existing) {
          existing.groups.add(gid);
        } else {
          resonanceMap.set(key, { groups: new Set([gid]), record: r });
        }
      }
    }
    // 共振 ×2 和 ×3 虛擬群組
    const resonance2Records: SignalRecord[] = [];
    const resonance3Records: SignalRecord[] = [];
    for (const { groups, record } of resonanceMap.values()) {
      if (groups.size >= 2) resonance2Records.push(record);
      if (groups.size >= 3) resonance3Records.push(record);
    }

    // ── Step 3: 按群組聚合統計 ──
    const groupStats: RuleGroupStats[] = [];

    for (const gid of this.groupIds) {
      const group = DEFAULT_REGISTRY.getGroup(gid)!;
      const records = signalsByGroup.get(gid)!;

      const returns5d  = records.map(r => r.return5d).filter((v): v is number => v !== null);
      const returns10d = records.map(r => r.return10d).filter((v): v is number => v !== null);
      const returns20d = records.map(r => r.return20d).filter((v): v is number => v !== null);

      const uniqueStocks = new Set(records.map(r => r.symbol)).size;

      const baseStats = {
        groupId:   gid,
        groupName: group.name,
        author:    group.author,
        ruleCount: group.rules.length,

        signalCount:   records.length,
        stocksCovered: uniqueStocks,

        winRate5d:  returns5d.length  > 0 ? +(returns5d.filter(r => r > 0).length / returns5d.length * 100).toFixed(1) : 0,
        winRate10d: returns10d.length > 0 ? +(returns10d.filter(r => r > 0).length / returns10d.length * 100).toFixed(1) : 0,
        winRate20d: returns20d.length > 0 ? +(returns20d.filter(r => r > 0).length / returns20d.length * 100).toFixed(1) : 0,

        avgReturn5d:  returns5d.length  > 0 ? +(returns5d.reduce((a, b) => a + b, 0) / returns5d.length).toFixed(2) : 0,
        avgReturn10d: returns10d.length > 0 ? +(returns10d.reduce((a, b) => a + b, 0) / returns10d.length).toFixed(2) : 0,
        avgReturn20d: returns20d.length > 0 ? +(returns20d.reduce((a, b) => a + b, 0) / returns20d.length).toFixed(2) : 0,

        maxGain: returns5d.length > 0 ? +Math.max(...returns5d).toFixed(2) : 0,
        maxLoss: returns5d.length > 0 ? +Math.min(...returns5d).toFixed(2) : 0,

        profitFactor: calcProfitFactor(returns5d),
        sharpeRatio:  +calcSharpe(returns5d).toFixed(2),
      };

      const { compositeScore, grade } = gradeGroup(baseStats);
      groupStats.push({ ...baseStats, compositeScore, grade });
    }

    // 加入共振虛擬群組的統計
    for (const [rid, rname, rrecords] of [
      ['resonance-2' as RuleGroupId, '共振 ×2（2群組同意）', resonance2Records],
      ['resonance-3' as RuleGroupId, '共振 ×3（3群組同意）', resonance3Records],
    ] as const) {
      const rr5  = rrecords.map(r => r.return5d).filter((v): v is number => v !== null);
      const rr10 = rrecords.map(r => r.return10d).filter((v): v is number => v !== null);
      const rr20 = rrecords.map(r => r.return20d).filter((v): v is number => v !== null);
      const rStocks = new Set(rrecords.map(r => r.symbol)).size;
      const rBase = {
        groupId: rid, groupName: rname, author: '系統共振', ruleCount: 0,
        signalCount: rrecords.length, stocksCovered: rStocks,
        winRate5d:  rr5.length  > 0 ? +(rr5.filter(r => r > 0).length / rr5.length * 100).toFixed(1) : 0,
        winRate10d: rr10.length > 0 ? +(rr10.filter(r => r > 0).length / rr10.length * 100).toFixed(1) : 0,
        winRate20d: rr20.length > 0 ? +(rr20.filter(r => r > 0).length / rr20.length * 100).toFixed(1) : 0,
        avgReturn5d:  rr5.length  > 0 ? +(rr5.reduce((a, b) => a + b, 0) / rr5.length).toFixed(2) : 0,
        avgReturn10d: rr10.length > 0 ? +(rr10.reduce((a, b) => a + b, 0) / rr10.length).toFixed(2) : 0,
        avgReturn20d: rr20.length > 0 ? +(rr20.reduce((a, b) => a + b, 0) / rr20.length).toFixed(2) : 0,
        maxGain: rr5.length > 0 ? +Math.max(...rr5).toFixed(2) : 0,
        maxLoss: rr5.length > 0 ? +Math.min(...rr5).toFixed(2) : 0,
        profitFactor: calcProfitFactor(rr5),
        sharpeRatio:  +calcSharpe(rr5).toFixed(2),
      };
      const { compositeScore, grade } = gradeGroup(rBase);
      groupStats.push({ ...rBase, compositeScore, grade });
    }

    // 加入六大條件過濾虛擬群組
    for (let n = 2; n <= 6; n++) {
      const cid = `cond-${n}` as RuleGroupId;
      const cname = `六條件≥${n}/6`;
      // 去重：同 stock+date 只算一筆
      const dedupMap = new Map<string, SignalRecord>();
      for (const r of signalsByCondCount.get(n) ?? []) {
        const key = `${r.symbol}:${r.date}`;
        if (!dedupMap.has(key)) dedupMap.set(key, r);
      }
      const crecords = [...dedupMap.values()];
      const cr5  = crecords.map(r => r.return5d).filter((v): v is number => v !== null);
      const cr10 = crecords.map(r => r.return10d).filter((v): v is number => v !== null);
      const cr20 = crecords.map(r => r.return20d).filter((v): v is number => v !== null);
      const cStocks = new Set(crecords.map(r => r.symbol)).size;
      const cBase = {
        groupId: cid, groupName: cname, author: '六條件過濾', ruleCount: 0,
        signalCount: crecords.length, stocksCovered: cStocks,
        winRate5d:  cr5.length  > 0 ? +(cr5.filter(r => r > 0).length / cr5.length * 100).toFixed(1) : 0,
        winRate10d: cr10.length > 0 ? +(cr10.filter(r => r > 0).length / cr10.length * 100).toFixed(1) : 0,
        winRate20d: cr20.length > 0 ? +(cr20.filter(r => r > 0).length / cr20.length * 100).toFixed(1) : 0,
        avgReturn5d:  cr5.length  > 0 ? +(cr5.reduce((a, b) => a + b, 0) / cr5.length).toFixed(2) : 0,
        avgReturn10d: cr10.length > 0 ? +(cr10.reduce((a, b) => a + b, 0) / cr10.length).toFixed(2) : 0,
        avgReturn20d: cr20.length > 0 ? +(cr20.reduce((a, b) => a + b, 0) / cr20.length).toFixed(2) : 0,
        maxGain: cr5.length > 0 ? +Math.max(...cr5).toFixed(2) : 0,
        maxLoss: cr5.length > 0 ? +Math.min(...cr5).toFixed(2) : 0,
        profitFactor: calcProfitFactor(cr5),
        sharpeRatio:  +calcSharpe(cr5).toFixed(2),
      };
      const { compositeScore, grade } = gradeGroup(cBase);
      groupStats.push({ ...cBase, compositeScore, grade });
    }

    // 加入大盤多頭過濾虛擬群組
    const mktVirtualGroups: [RuleGroupId, string, SignalRecord[]][] = [
      ['mkt-bull', '大盤多頭才買', marketBullSignals],
      ['mkt-cond4', '大盤多頭+六條件≥4', mktCondSignals.get(4) ?? []],
      ['mkt-cond5', '大盤多頭+六條件≥5', mktCondSignals.get(5) ?? []],
      ['mkt-cond6', '大盤多頭+六條件=6', mktCondSignals.get(6) ?? []],
    ];
    for (const [mid, mname, mrecords] of mktVirtualGroups) {
      // 去重
      const dedupMap = new Map<string, SignalRecord>();
      for (const r of mrecords) {
        const key = `${r.symbol}:${r.date}`;
        if (!dedupMap.has(key)) dedupMap.set(key, r);
      }
      const dedupRecords = [...dedupMap.values()];
      const mr5  = dedupRecords.map(r => r.return5d).filter((v): v is number => v !== null);
      const mr10 = dedupRecords.map(r => r.return10d).filter((v): v is number => v !== null);
      const mr20 = dedupRecords.map(r => r.return20d).filter((v): v is number => v !== null);
      const mStocks = new Set(dedupRecords.map(r => r.symbol)).size;
      const mBase = {
        groupId: mid, groupName: mname, author: '大盤過濾', ruleCount: 0,
        signalCount: dedupRecords.length, stocksCovered: mStocks,
        winRate5d:  mr5.length  > 0 ? +(mr5.filter(r => r > 0).length / mr5.length * 100).toFixed(1) : 0,
        winRate10d: mr10.length > 0 ? +(mr10.filter(r => r > 0).length / mr10.length * 100).toFixed(1) : 0,
        winRate20d: mr20.length > 0 ? +(mr20.filter(r => r > 0).length / mr20.length * 100).toFixed(1) : 0,
        avgReturn5d:  mr5.length  > 0 ? +(mr5.reduce((a, b) => a + b, 0) / mr5.length).toFixed(2) : 0,
        avgReturn10d: mr10.length > 0 ? +(mr10.reduce((a, b) => a + b, 0) / mr10.length).toFixed(2) : 0,
        avgReturn20d: mr20.length > 0 ? +(mr20.reduce((a, b) => a + b, 0) / mr20.length).toFixed(2) : 0,
        maxGain: mr5.length > 0 ? +Math.max(...mr5).toFixed(2) : 0,
        maxLoss: mr5.length > 0 ? +Math.min(...mr5).toFixed(2) : 0,
        profitFactor: calcProfitFactor(mr5),
        sharpeRatio:  +calcSharpe(mr5).toFixed(2),
      };
      const { compositeScore, grade } = gradeGroup(mBase);
      groupStats.push({ ...mBase, compositeScore, grade });
    }

    // ── Step 4: 停損模擬虛擬群組 ──
    onProgress?.({ type: 'status', market, message: `正在模擬停損策略...` });

    // 去重：每個 stock+date 只保留一筆
    const dedupContexts = new Map<string, SignalContext>();
    for (const ctx of allSignalContexts) {
      const key = `${ctx.record.symbol}:${ctx.record.date}`;
      if (!dedupContexts.has(key)) dedupContexts.set(key, ctx);
    }
    const uniqueContexts = [...dedupContexts.values()];

    // 定義停損策略組合
    const slStrategies: { id: RuleGroupId; name: string; slPct: number; filter: (ctx: SignalContext) => boolean }[] = [
      { id: 'sl-3pct', name: '停損3%+MA5出場', slPct: 3, filter: () => true },
      { id: 'sl-5pct', name: '停損5%+MA5出場', slPct: 5, filter: () => true },
      { id: 'sl-7pct', name: '停損7%+MA5出場', slPct: 7, filter: () => true },
      { id: 'mkt-sl3-c4', name: '大盤多頭+停損3%+六條件≥4', slPct: 3, filter: ctx => ctx.isMktBull && ctx.condScore >= 4 },
      { id: 'mkt-sl5-c4', name: '大盤多頭+停損5%+六條件≥4', slPct: 5, filter: ctx => ctx.isMktBull && ctx.condScore >= 4 },
      { id: 'mkt-sl3-c5', name: '大盤多頭+停損3%+六條件≥5', slPct: 3, filter: ctx => ctx.isMktBull && ctx.condScore >= 5 },
      { id: 'mkt-sl5-c5', name: '大盤多頭+停損5%+六條件≥5', slPct: 5, filter: ctx => ctx.isMktBull && ctx.condScore >= 5 },
    ];

    for (const strat of slStrategies) {
      const filtered = uniqueContexts.filter(strat.filter);
      const trades: TradeResult[] = [];

      for (const ctx of filtered) {
        const result = simulateTrade(ctx.candles, ctx.entryIdx, costPct, strat.slPct);
        if (result) trades.push(result);
      }

      if (trades.length < MIN_SIGNALS) {
        groupStats.push({
          groupId: strat.id, groupName: strat.name, author: '停損模擬', ruleCount: 0,
          signalCount: trades.length, stocksCovered: 0,
          winRate5d: 0, winRate10d: 0, winRate20d: 0,
          avgReturn5d: 0, avgReturn10d: 0, avgReturn20d: 0,
          maxGain: 0, maxLoss: 0, profitFactor: 0, sharpeRatio: 0,
          compositeScore: 0, grade: 'F',
        });
        continue;
      }

      const returns = trades.map(t => t.returnPct);
      const wins = returns.filter(r => r > 0);
      const avgHold = +(trades.reduce((s, t) => s + t.holdDays, 0) / trades.length).toFixed(1);
      const stopLossCount = trades.filter(t => t.exitReason === 'stop-loss').length;
      const trailCount = trades.filter(t => t.exitReason === 'trail-ma5').length;
      const winRate = +(wins.length / returns.length * 100).toFixed(1);
      const avgReturn = +(returns.reduce((a, b) => a + b, 0) / returns.length).toFixed(2);
      const slStocks = new Set(filtered.map(c => c.record.symbol)).size;

      const sBase = {
        groupId: strat.id,
        groupName: `${strat.name}（均持${avgHold}天，停損${stopLossCount}次/MA5出${trailCount}次）`,
        author: '停損模擬',
        ruleCount: 0,
        signalCount: trades.length,
        stocksCovered: slStocks,
        // 用實戰報酬填入所有欄位（因為不再是固定持有期）
        winRate5d: winRate, winRate10d: winRate, winRate20d: winRate,
        avgReturn5d: avgReturn, avgReturn10d: avgReturn, avgReturn20d: avgReturn,
        maxGain: +Math.max(...returns).toFixed(2),
        maxLoss: +Math.min(...returns).toFixed(2),
        profitFactor: calcProfitFactor(returns),
        sharpeRatio: +calcSharpe(returns).toFixed(2),
      };
      const { compositeScore, grade } = gradeGroup(sBase);
      groupStats.push({ ...sBase, compositeScore, grade });
    }

    // 按綜合分數排序
    groupStats.sort((a, b) => b.compositeScore - a.compositeScore);

    // 推薦群組：grade A 以上，至少 3 個，最多 8 個
    const recommended = groupStats
      .filter(g => g.grade === 'S' || g.grade === 'A')
      .map(g => g.groupId);

    // 如果不足 3 個，補到 3 個
    if (recommended.length < 3) {
      const extra = groupStats
        .filter(g => !recommended.includes(g.groupId) && g.grade !== 'F')
        .slice(0, 3 - recommended.length)
        .map(g => g.groupId);
      recommended.push(...extra);
    }

    const result: MarketAnalysisResult = {
      market,
      stockCount: candlesMap.size,
      dateRange: { from: dateFrom, to: dateTo },
      tradingDays: dateTo > dateFrom
        ? Math.round((new Date(dateTo).getTime() - new Date(dateFrom).getTime()) / (1000 * 60 * 60 * 24))
        : 0,
      totalSignals: groupStats.reduce((sum, g) => sum + g.signalCount, 0),
      groupStats,
      recommendedGroups: recommended.slice(0, 8),
    };

    onProgress?.({ type: 'market_complete', market, result });
    return result;
  }

  /**
   * 分析兩個市場 + 交叉比較
   */
  async analyzeAll(
    twStocks: StockEntry[],
    cnStocks: StockEntry[],
    onProgress?: (event: AnalysisProgressEvent) => void,
    options?: { stockCount?: number; period?: string },
  ): Promise<RuleGroupAnalysisResult> {
    // 先跑台股
    onProgress?.({ type: 'status', market: 'TW', message: '開始分析台股...' });
    const tw = await this.analyzeMarket('TW', twStocks, onProgress, options);

    // 再跑陸股
    onProgress?.({ type: 'status', market: 'CN', message: '開始分析陸股...' });
    const cn = await this.analyzeMarket('CN', cnStocks, onProgress, options);

    // 交叉比較
    const comparison = this.crossCompare(tw, cn);

    const result: RuleGroupAnalysisResult = {
      tw,
      cn,
      comparison,
      createdAt: new Date().toISOString(),
      version: VERSION,
    };

    onProgress?.({ type: 'complete', result });
    return result;
  }

  /** 交叉比較兩個市場 */
  private crossCompare(tw: MarketAnalysisResult, cn: MarketAnalysisResult): CrossMarketComparison {
    const twMap = new Map(tw.groupStats.map(g => [g.groupId, g.grade]));
    const cnMap = new Map(cn.groupStats.map(g => [g.groupId, g.grade]));

    const isGood = (grade: string) => grade === 'S' || grade === 'A' || grade === 'B';
    const isBad  = (grade: string) => grade === 'D' || grade === 'F';

    const strongBoth: RuleGroupId[] = [];
    const twOnly:     RuleGroupId[] = [];
    const cnOnly:     RuleGroupId[] = [];
    const weakBoth:   RuleGroupId[] = [];

    for (const gid of this.groupIds) {
      const twGrade = twMap.get(gid) ?? 'F';
      const cnGrade = cnMap.get(gid) ?? 'F';

      if (isGood(twGrade) && isGood(cnGrade))      strongBoth.push(gid);
      else if (isGood(twGrade) && !isGood(cnGrade)) twOnly.push(gid);
      else if (!isGood(twGrade) && isGood(cnGrade))  cnOnly.push(gid);
      else if (isBad(twGrade) && isBad(cnGrade))     weakBoth.push(gid);
    }

    return { strongBoth, twOnly, cnOnly, weakBoth };
  }
}
