export interface StrategySignals {
  A: boolean; // 六大條件   (isCoreReady)
  B: boolean; // 回後買上漲 (detectBreakoutEntry)
  C: boolean; // 盤整突破   (detectConsolidationBreakout)
  D: boolean; // 一字底     (detectStrategyE → isFlatBottom)
  E: boolean; // 缺口進場   (detectStrategyD → isGapEntry)
  F: boolean; // V形反轉    (detectVReversal)
}

export interface HoldingWithStrategies {
  symbol: string;
  name: string;
  weight: number;
  price: number;
  changePct: number;
  strategies: StrategySignals;
}
