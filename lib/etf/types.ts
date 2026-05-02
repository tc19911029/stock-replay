/**
 * 主動式 ETF 追蹤器 — 共用型別
 *
 * 涵蓋：
 *   - ETFHolding 單筆持股
 *   - ETFSnapshot 一檔 ETF 在某交易日的完整持股快照
 *   - ETFChange 兩期快照比對結果
 *   - ETFTrackingEntry 個股被納入後的 forward return tracking
 *   - ETFPerformanceEntry 一檔 ETF 多期間報酬率
 *   - ETFConsensusEntry 被多檔 ETF 同期買入的個股
 */

export interface ETFHolding {
  /** 純股票代號，如 "2330"，無 .TW 後綴 */
  symbol: string;
  name: string;
  /** 持股比重 %，如 12.5 */
  weight: number;
  /** 持股股數（股，非張）。1 張 = 1000 股。MoneyDJ 有揭露，其他 source 可能無 */
  shares?: number;
}

export interface ETFSnapshot {
  etfCode: string;
  etfName: string;
  /** 揭露日期 YYYY-MM-DD（每個交易日一筆） */
  disclosureDate: string;
  /** ISO 時間戳，記錄資料抓取時間 */
  fetchedAt: string;
  holdings: ETFHolding[];
  source: 'twse' | 'issuer' | 'finmind' | 'manual' | 'stub';
}

export interface ETFHoldingDelta extends ETFHolding {
  prevWeight: number;
  delta: number;
  /** 股數變動（股）。兩期都有 shares 時才有值 */
  deltaShares?: number;
  /** 前期股數（股）。用於計算變動幅度 % */
  priorShares?: number;
}

export interface ETFChange {
  etfCode: string;
  etfName: string;
  /** 前一個交易日 */
  fromDate: string;
  /** 當日 */
  toDate: string;
  newEntries: ETFHolding[];
  exits: ETFHolding[];
  increased: ETFHoldingDelta[];
  decreased: ETFHoldingDelta[];
}

export interface ETFTrackingEntry {
  etfCode: string;
  etfName: string;
  symbol: string;
  stockName: string;
  /** ETF 納入/加碼當日 YYYY-MM-DD */
  addedDate: string;
  /** 'new' = 新增，'increased' = 加碼 */
  changeType: 'new' | 'increased';
  /** 納入時持股權重 % */
  addedWeight: number;
  /** 納入當日（或最近交易日）收盤價 */
  priceAtAdd: number;
  d1Return: number | null;
  d3Return: number | null;
  d5Return: number | null;
  d10Return: number | null;
  d20Return: number | null;
  /** 窗口內最大累積漲幅 % */
  maxGain: number | null;
  /** 窗口內最大累積跌幅 % (負數) */
  maxDrawdown: number | null;
  /** ISO 時間戳，最後一次重算時間 */
  lastUpdated: string;
  /** 已過 20 個交易日後鎖定，不再重算 */
  windowClosed: boolean;
}

export interface ETFPerformanceEntry {
  etfCode: string;
  etfName: string;
  latestPrice: number;
  latestDate: string;
  inceptionDate: string | null;
  returns: {
    d1: number | null;
    w1: number | null;
    m1: number | null;
    ytd: number | null;
    inception: number | null;
  };
}

export interface ETFConsensusEntry {
  symbol: string;
  stockName: string;
  /** 在窗口期間內，這幾檔 ETF 對該股做了「新增/加碼」 */
  etfCodes: string[];
  etfNames: string[];
  /** 窗口內最早的動作日期 */
  firstAddedDate: string;
  /** 平均納入權重 % */
  avgWeight: number;
  /** 動作種類個別計數 */
  newCount: number;
  increasedCount: number;
}

export interface ETFListItem {
  etfCode: string;
  etfName: string;
  /** 'TW' 上市 / 'TWO' 上櫃 */
  market: 'TW' | 'TWO';
  inceptionDate: string | null;
  inceptionPrice: number | null;
  /** 發行公司中文名稱（用於 source resolver） */
  issuer: string;
}
