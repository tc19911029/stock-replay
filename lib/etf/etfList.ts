/**
 * 主動式 ETF 靜態清單（2024–2025 上市的 11 檔 A 後綴 ETF）
 *
 * 資料來源對照：yp-finance.com/active-etf 排行榜
 *
 * 注意事項：
 *   - inceptionDate / inceptionPrice 為「成立以來報酬率」計算依據；
 *     未確認的填 null，performanceCalc 會 fallback 到「自最早 K 棒」。
 *   - 上市市場欄位 (TW/TWO) 影響 K 棒下載 batch 與 quote 路由。
 *     11 檔目前皆上市於 TWSE（tse），使用 'TW'。
 */
import type { ETFListItem } from './types';

export const ACTIVE_ETF_LIST: ETFListItem[] = [
  { etfCode: '00980A', etfName: '主動野村臺灣優選',  market: 'TW', inceptionDate: null, inceptionPrice: null, issuer: '野村投信' },
  { etfCode: '00981A', etfName: '主動統一台股增長',  market: 'TW', inceptionDate: null, inceptionPrice: null, issuer: '統一投信' },
  { etfCode: '00982A', etfName: '主動群益台灣強棒',  market: 'TW', inceptionDate: null, inceptionPrice: null, issuer: '群益投信' },
  { etfCode: '00984A', etfName: '主動安聯台灣高息',  market: 'TW', inceptionDate: null, inceptionPrice: null, issuer: '安聯投信' },
  { etfCode: '00985A', etfName: '主動野村台灣50',    market: 'TW', inceptionDate: null, inceptionPrice: null, issuer: '野村投信' },
  { etfCode: '00987A', etfName: '主動台新優勢成長',  market: 'TW', inceptionDate: null, inceptionPrice: null, issuer: '台新投信' },
  { etfCode: '00991A', etfName: '主動復華未來50',    market: 'TW', inceptionDate: null, inceptionPrice: null, issuer: '復華投信' },
  { etfCode: '00992A', etfName: '主動群益科技創新',  market: 'TW', inceptionDate: null, inceptionPrice: null, issuer: '群益投信' },
  { etfCode: '00993A', etfName: '主動安聯台灣',      market: 'TW', inceptionDate: null, inceptionPrice: null, issuer: '安聯投信' },
  { etfCode: '00994A', etfName: '主動第一金台股優',  market: 'TW', inceptionDate: null, inceptionPrice: null, issuer: '第一金投信' },
  { etfCode: '00995A', etfName: '主動中信台灣卓越',  market: 'TW', inceptionDate: null, inceptionPrice: null, issuer: '中信投信' },
];

export function findETF(etfCode: string): ETFListItem | null {
  return ACTIVE_ETF_LIST.find((e) => e.etfCode === etfCode) ?? null;
}
