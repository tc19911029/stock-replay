import { CandleWithIndicators } from '@/types';
import { fetchCandlesYahoo } from '@/lib/datasource/YahooFinanceDS';
import { MarketScanner } from './MarketScanner';
import { MarketConfig } from './types';

type StockEntry = { symbol: string; name: string };

// Fallback：滬深主板大型股（Eastmoney API 失敗時使用）
const FALLBACK_CN_STOCKS: StockEntry[] = [
  { symbol: '600519.SS', name: '貴州茅台' }, { symbol: '601398.SS', name: '工商銀行' },
  { symbol: '601288.SS', name: '農業銀行' }, { symbol: '601939.SS', name: '建設銀行' },
  { symbol: '601988.SS', name: '中國銀行' }, { symbol: '601628.SS', name: '中國人壽' },
  { symbol: '601318.SS', name: '中國平安' }, { symbol: '600036.SS', name: '招商銀行' },
  { symbol: '600900.SS', name: '長江電力' }, { symbol: '601899.SS', name: '紫金礦業' },
  { symbol: '000858.SZ', name: '五糧液' },   { symbol: '000333.SZ', name: '美的集團' },
  { symbol: '002594.SZ', name: '比亞迪' },   { symbol: '000651.SZ', name: '格力電器' },
  { symbol: '000002.SZ', name: '萬科A' },    { symbol: '002415.SZ', name: '海康威視' },
  { symbol: '000568.SZ', name: '瀘州老窖' }, { symbol: '000001.SZ', name: '平安銀行' },
  { symbol: '600030.SS', name: '中信證券' }, { symbol: '601166.SS', name: '興業銀行' },
];

/**
 * 從東方財富 API 取得滬深主板全股
 * fs = m:1+t:2  → 上交所 A股主板
 *      m:0+t:6  → 深交所 A股主板
 *      m:0+t:80 → 深交所 中小板（已合併入主板）
 * 排除：創業板 300xxx（不在查詢範圍）、科創板 688xxx
 */
async function fetchChinaMainBoardStocks(): Promise<StockEntry[]> {
  const url =
    'https://push2.eastmoney.com/api/qt/clist/get' +
    '?pn=1&pz=6000&po=1&np=1&fltt=2&invt=2&fid=f3' +
    '&fs=m:1+t:2,m:0+t:6,m:0+t:80' +
    '&fields=f12,f14';

  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error('Eastmoney API error');

  const json = await res.json() as {
    data?: { diff?: Array<{ f12: string; f14: string }> };
  };

  const diff = json?.data?.diff ?? [];
  if (diff.length === 0) throw new Error('Empty stock list from Eastmoney');

  return diff
    .filter(s => {
      const code = s.f12;
      const name = s.f14 ?? '';
      // 排除 ST / *ST / 退市
      if (/ST/i.test(name) || name.includes('退')) return false;
      // 只保留滬市主板(6開頭) 和深市主板(0、1、2開頭，不包含3開頭的創業板)
      if (/^6\d{5}$/.test(code)) return true;  // 滬市主板
      if (/^[012]\d{5}$/.test(code)) return true; // 深市主板
      return false;
    })
    .map(s => {
      const code = s.f12;
      const suffix = /^6/.test(code) ? '.SS' : '.SZ';
      return { symbol: `${code}${suffix}`, name: s.f14 };
    });
}

export class ChinaScanner extends MarketScanner {
  getMarketConfig(): MarketConfig {
    return {
      marketId:      'CN',
      name:          '中國A股主板',
      scanTimeLocal: '14:30',
      timezone:      'Asia/Shanghai',
    };
  }

  async getStockList(): Promise<StockEntry[]> {
    try {
      const stocks = await fetchChinaMainBoardStocks();
      if (stocks.length > 0) return stocks;
    } catch (e) {
      console.warn('[ChinaScanner] Eastmoney API failed, using fallback:', e);
    }
    return FALLBACK_CN_STOCKS;
  }

  async fetchCandles(symbol: string): Promise<CandleWithIndicators[]> {
    return fetchCandlesYahoo(symbol, '1y', 8000);
  }
}
