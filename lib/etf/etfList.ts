/**
 * 主動式 ETF 靜態清單（TWSE 上市的 20 檔 A 後綴股票型主動 ETF，截至 2026-05）
 *
 * 來源：TWSE OpenAPI STOCK_DAY_ALL 過濾「主動」開頭名稱，扣除 D 後綴收益型 3 檔。
 *
 * 注意事項：
 *   - inceptionDate / inceptionPrice 為「成立以來報酬率」計算依據；
 *     未確認的填 null，performanceCalc 會 fallback 到「自最早 K 棒」。
 *   - 上市市場欄位 (TW/TWO) 影響 K 棒下載 batch 與 quote 路由。
 *     20 檔目前皆上市於 TWSE（tse），使用 'TW'。
 *   - 績效排行 top=20 即為這份清單按報酬排名後的前 20。
 */
import type { ETFListItem } from './types';

export const ACTIVE_ETF_LIST: ETFListItem[] = [
  { etfCode: '00400A', etfName: '主動國泰動能高息',  market: 'TW', inceptionDate: null, inceptionPrice: null, issuer: '國泰投信' },
  { etfCode: '00401A', etfName: '主動摩根台灣鑫收',  market: 'TW', inceptionDate: null, inceptionPrice: null, issuer: '摩根投信' },
  { etfCode: '00980A', etfName: '主動野村臺灣優選',  market: 'TW', inceptionDate: null, inceptionPrice: null, issuer: '野村投信' },
  { etfCode: '00981A', etfName: '主動統一台股增長',  market: 'TW', inceptionDate: null, inceptionPrice: null, issuer: '統一投信' },
  { etfCode: '00982A', etfName: '主動群益台灣強棒',  market: 'TW', inceptionDate: null, inceptionPrice: null, issuer: '群益投信' },
  { etfCode: '00983A', etfName: '主動中信ARK創新',   market: 'TW', inceptionDate: null, inceptionPrice: null, issuer: '中信投信' },
  { etfCode: '00984A', etfName: '主動安聯台灣高息',  market: 'TW', inceptionDate: null, inceptionPrice: null, issuer: '安聯投信' },
  { etfCode: '00985A', etfName: '主動野村台灣50',    market: 'TW', inceptionDate: null, inceptionPrice: null, issuer: '野村投信' },
  { etfCode: '00986A', etfName: '主動台新龍頭成長',  market: 'TW', inceptionDate: null, inceptionPrice: null, issuer: '台新投信' },
  { etfCode: '00987A', etfName: '主動台新優勢成長',  market: 'TW', inceptionDate: null, inceptionPrice: null, issuer: '台新投信' },
  { etfCode: '00988A', etfName: '主動統一全球創新',  market: 'TW', inceptionDate: null, inceptionPrice: null, issuer: '統一投信' },
  { etfCode: '00989A', etfName: '主動摩根美國科技',  market: 'TW', inceptionDate: null, inceptionPrice: null, issuer: '摩根投信' },
  { etfCode: '00990A', etfName: '主動元大AI新經濟',  market: 'TW', inceptionDate: null, inceptionPrice: null, issuer: '元大投信' },
  { etfCode: '00991A', etfName: '主動復華未來50',    market: 'TW', inceptionDate: null, inceptionPrice: null, issuer: '復華投信' },
  { etfCode: '00992A', etfName: '主動群益科技創新',  market: 'TW', inceptionDate: null, inceptionPrice: null, issuer: '群益投信' },
  { etfCode: '00993A', etfName: '主動安聯台灣',      market: 'TW', inceptionDate: null, inceptionPrice: null, issuer: '安聯投信' },
  { etfCode: '00994A', etfName: '主動第一金台股優',  market: 'TW', inceptionDate: null, inceptionPrice: null, issuer: '第一金投信' },
  { etfCode: '00995A', etfName: '主動中信台灣卓越',  market: 'TW', inceptionDate: null, inceptionPrice: null, issuer: '中信投信' },
  { etfCode: '00996A', etfName: '主動兆豐台灣豐收',  market: 'TW', inceptionDate: null, inceptionPrice: null, issuer: '兆豐投信' },
  { etfCode: '00997A', etfName: '主動群益美國增長',  market: 'TW', inceptionDate: null, inceptionPrice: null, issuer: '群益投信' },
];

export function findETF(etfCode: string): ETFListItem | null {
  return ACTIVE_ETF_LIST.find((e) => e.etfCode === etfCode) ?? null;
}

/** 去掉「主動」前綴的短名（用於 chip / button 顯示） */
export function shortETFName(etfName: string): string {
  return etfName.replace(/^主動/, '');
}

/**
 * 為持股 symbol 推導走圖載入路徑
 *   - 台股代號（4-5 位數字，可帶字母後綴 ETF）→ "2330.TW"
 *   - 美股代號（純大寫字母）→ "TSLA"（不加 .TW）
 *   - 不符合任一格式 → null（呼叫端不要產 link）
 */
export function chartLoadSymbol(symbol: string): string | null {
  if (/^\d{4,6}[A-Z]?$/.test(symbol)) return `${symbol}.TW`;
  if (/^[A-Z]{1,5}$/.test(symbol)) return symbol;
  return null;
}

/** 判斷 symbol 是否為美股（CMoney "TSLA US" 拆掉後綴的純字母代號） */
export function isUSSymbol(symbol: string): boolean {
  return /^[A-Z]{1,5}$/.test(symbol);
}

/**
 * 持股股數顯示（依 symbol 自動判斷單位）
 *   - 台股：原始值是「股」，÷1000 顯示「張」
 *   - 美股：原始值是「股」，直接顯示「股」（不除）
 */
export function formatHoldingShares(shares: number, symbol: string): string {
  if (isUSSymbol(symbol)) return `${shares.toLocaleString('zh-TW')}股`;
  return `${Math.round(shares / 1000).toLocaleString('zh-TW')}張`;
}

/** 持股股數變動顯示（依 symbol 自動判斷單位，含正負號） */
export function formatHoldingShareDelta(delta: number, symbol: string): string {
  const abs = Math.abs(delta);
  const sign = delta >= 0 ? '+' : '-';
  if (isUSSymbol(symbol)) return `${sign}${abs.toLocaleString('zh-TW')}股`;
  if (abs >= 1000) return `${sign}${Math.round(abs / 1000).toLocaleString('zh-TW')}張`;
  return `${sign}${abs.toLocaleString('zh-TW')}股`;
}
