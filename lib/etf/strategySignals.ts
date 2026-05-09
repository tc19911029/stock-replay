export interface StrategySignals {
  A: boolean; // 六大條件   (isCoreReady)
  B: boolean; // 回後買上漲 (detectBreakoutEntry)
  C: boolean; // 盤整突破   (detectConsolidationBreakout)
  D: boolean; // 一字底     (detectStrategyE → isFlatBottom)
  E: boolean; // 缺口進場   (detectStrategyD → isGapEntry)
  F: boolean; // V形反轉    (detectVReversal)
  G: boolean; // ABC 突破   (detectABCBreakout，寶典 Part 11-1 位置 6) — v12 改字母為 J
  H: boolean; // 突破大量黑K (detectBlackKBreakout，寶典 Part 11-1 位置 8) — v12 改字母為 L
  I: boolean; // K線橫盤突破 (detectKlineConsolidationBreakout，寶典 Part 11-1 位置 3) — v12 改字母為 K
  // v12 新字母（議題 33/65/93）— 已接上 ETF detector
  J: boolean;   // ABC 突破（多頭軌）— alias of G
  K: boolean;   // K線橫盤突破（多頭軌）— alias of I
  L: boolean;   // 突破大量黑K高（多頭軌）— alias of H
  M: boolean;   // 突破軌道線（多頭軌）
  N: boolean;   // 型態確認（轉折軌，走 LockWatch）
  O: boolean;   // 打底完成（轉折軌）
  P: boolean;   // 高檔拉回（多頭軌）
  Q: boolean;   // 三條均線戰法（戰法軌）
}

export interface HoldingWithStrategies {
  symbol: string;
  name: string;
  weight: number;
  price: number;
  changePct: number;
  strategies: StrategySignals;
}
