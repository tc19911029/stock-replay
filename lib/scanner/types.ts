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
  price: number;
  changePercent: number;
  volume: number;
  triggeredRules: TriggeredRule[];
  sixConditionsScore: number;   // 0–6
  sixConditionsBreakdown: SixConditionsBreakdown;
  trendState: '多頭' | '空頭' | '盤整';
  trendPosition: string;
  scanTime: string;             // ISO timestamp
}

export interface MarketConfig {
  marketId: MarketId;
  name: string;
  scanTimeLocal: string;  // e.g. '13:00'
  timezone: string;
}

export interface ScanSession {
  id: string;            // e.g. 'TW-2026-03-25'
  market: MarketId;
  date: string;          // YYYY-MM-DD
  scanTime: string;      // ISO timestamp when scan ran
  resultCount: number;
  results: StockScanResult[];
}
