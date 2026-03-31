/**
 * ruleGroupAnalyzerTypes.ts — 規則群組回測分析器型別定義
 *
 * 用途：對 18 個規則群組分別回測台股/陸股前 100 大，
 * 找出每個市場最有效的規則組合。
 */

import { RuleGroupId } from '@/lib/rules/ruleRegistry';
import { MarketId } from '@/lib/scanner/types';

// ── 單一群組的統計結果 ────────────────────────────────────────────────────────

export interface RuleGroupStats {
  groupId:    RuleGroupId;
  groupName:  string;
  author:     string;
  ruleCount:  number;        // 群組內規則數

  // 訊號統計
  signalCount:    number;    // 總 BUY/ADD 訊號數
  stocksCovered:  number;    // 有觸發訊號的股票數

  // 勝率（扣成本後 > 0 即為勝）
  winRate5d:   number;       // 5 天勝率 %
  winRate10d:  number;       // 10 天勝率 %
  winRate20d:  number;       // 20 天勝率 %

  // 平均報酬（扣成本後）
  avgReturn5d:  number;      // 5 天平均報酬 %
  avgReturn10d: number;      // 10 天平均報酬 %
  avgReturn20d: number;      // 20 天平均報酬 %

  // 風險指標
  maxGain:      number;      // 最大單筆獲利 %
  maxLoss:      number;      // 最大單筆虧損 %
  profitFactor: number;      // 獲利因子 = 總獲利 / 總虧損
  sharpeRatio:  number;      // Sharpe ratio (以 5 天報酬計算)

  // 綜合評分
  compositeScore: number;    // 0-100 綜合分數
  grade:          string;    // S / A / B / C / D / F
}

// ── 單一市場的分析結果 ────────────────────────────────────────────────────────

export interface MarketAnalysisResult {
  market:        MarketId;
  stockCount:    number;           // 實際分析的股票數
  dateRange:     { from: string; to: string };
  tradingDays:   number;           // 回測涵蓋的交易日數
  totalSignals:  number;           // 所有群組的總訊號數

  groupStats:        RuleGroupStats[];  // 18 群組，按 compositeScore 排序
  recommendedGroups: RuleGroupId[];     // 推薦組合（grade A 以上）
}

// ── 交叉比較 ──────────────────────────────────────────────────────────────────

export interface CrossMarketComparison {
  /** 兩邊都好（TW 和 CN 都 grade B+ 以上） */
  strongBoth:   RuleGroupId[];
  /** 只適合台股 */
  twOnly:       RuleGroupId[];
  /** 只適合陸股 */
  cnOnly:       RuleGroupId[];
  /** 兩邊都差 */
  weakBoth:     RuleGroupId[];
}

// ── 完整分析結果 ──────────────────────────────────────────────────────────────

export interface RuleGroupAnalysisResult {
  tw:         MarketAnalysisResult;
  cn:         MarketAnalysisResult;
  comparison: CrossMarketComparison;
  createdAt:  string;              // ISO timestamp
  version:    string;              // 分析器版本
}

// ── SSE 進度事件 ──────────────────────────────────────────────────────────────

export type AnalysisProgressEvent =
  | { type: 'status';   market: MarketId; message: string }
  | { type: 'fetching'; market: MarketId; done: number; total: number }
  | { type: 'analyzing'; market: MarketId; done: number; total: number }
  | { type: 'market_complete'; market: MarketId; result: MarketAnalysisResult }
  | { type: 'complete'; result: RuleGroupAnalysisResult }
  | { type: 'error'; message: string };

// ── 內部用：單筆訊號記錄 ──────────────────────────────────────────────────────

export interface SignalRecord {
  symbol:     string;
  date:       string;
  ruleId:     string;
  signalType: 'BUY' | 'ADD';
  return5d:   number | null;   // null = 資料不足
  return10d:  number | null;
  return20d:  number | null;
}
