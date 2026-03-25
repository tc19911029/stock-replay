import { CandleWithIndicators } from '@/types';
import { fetchCandlesYahoo } from '@/lib/datasource/YahooFinanceDS';
import { MarketScanner } from './MarketScanner';
import { MarketConfig } from './types';

type StockEntry = { symbol: string; name: string };

// Fallback list if exchange APIs are unavailable
const FALLBACK_TW_STOCKS: StockEntry[] = [
  { symbol: '2330.TW', name: '台積電' }, { symbol: '2454.TW', name: '聯發科' },
  { symbol: '2317.TW', name: '鴻海' },   { symbol: '2382.TW', name: '廣達' },
  { symbol: '2308.TW', name: '台達電' }, { symbol: '3711.TW', name: '日月光投控' },
  { symbol: '2303.TW', name: '聯電' },   { symbol: '2891.TW', name: '中信金' },
  { symbol: '2882.TW', name: '國泰金' }, { symbol: '2886.TW', name: '兆豐金' },
  { symbol: '2884.TW', name: '玉山金' }, { symbol: '2881.TW', name: '富邦金' },
  { symbol: '2885.TW', name: '元大金' }, { symbol: '2892.TW', name: '第一金' },
  { symbol: '5880.TW', name: '合庫金' }, { symbol: '2412.TW', name: '中華電' },
  { symbol: '3045.TW', name: '台灣大' }, { symbol: '4904.TW', name: '遠傳' },
  { symbol: '2002.TW', name: '中鋼' },   { symbol: '1303.TW', name: '南亞' },
  { symbol: '1301.TW', name: '台塑' },   { symbol: '6505.TW', name: '台塑化' },
  { symbol: '2912.TW', name: '統一超' }, { symbol: '2603.TW', name: '長榮' },
  { symbol: '2609.TW', name: '陽明' },   { symbol: '2615.TW', name: '萬海' },
  { symbol: '3008.TW', name: '大立光' }, { symbol: '2357.TW', name: '華碩' },
  { symbol: '2376.TW', name: '技嘉' },   { symbol: '2353.TW', name: '宏碁' },
];

/** 從 TWSE 開放資料取得所有上市股票（4碼普通股） */
async function fetchTWSEStocks(): Promise<StockEntry[]> {
  const res = await fetch(
    'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
    { signal: AbortSignal.timeout(15000) }
  );
  if (!res.ok) throw new Error('TWSE API error');
  const data = await res.json() as Array<{ Code: string; Name: string }>;
  return data
    .filter(s => /^\d{4}$/.test(s.Code))  // 4碼普通股，排除 ETF(00xx)、權證等
    .map(s => ({ symbol: `${s.Code}.TW`, name: s.Name }));
}

/** 從 TPEx 取得所有上櫃股票（4碼普通股） */
async function fetchTPExStocks(): Promise<StockEntry[]> {
  const res = await fetch(
    'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes',
    { signal: AbortSignal.timeout(15000) }
  );
  if (!res.ok) throw new Error('TPEx API error');
  const data = await res.json() as Array<{ SecuritiesCompanyCode: string; CompanyName: string }>;
  return data
    .filter(s => /^\d{4}$/.test(s.SecuritiesCompanyCode))
    .map(s => ({ symbol: `${s.SecuritiesCompanyCode}.TWO`, name: s.CompanyName }));
}

export class TaiwanScanner extends MarketScanner {
  getMarketConfig(): MarketConfig {
    return {
      marketId:      'TW',
      name:          '台灣全市場',
      scanTimeLocal: '13:00',
      timezone:      'Asia/Taipei',
    };
  }

  async getStockList(): Promise<StockEntry[]> {
    const [listed, otc] = await Promise.allSettled([
      fetchTWSEStocks(),
      fetchTPExStocks(),
    ]);

    const stocks: StockEntry[] = [
      ...(listed.status === 'fulfilled' ? listed.value : []),
      ...(otc.status    === 'fulfilled' ? otc.value    : []),
    ];

    if (stocks.length === 0) {
      console.warn('[TaiwanScanner] Exchange APIs failed, using fallback list');
      return FALLBACK_TW_STOCKS;
    }

    // Deduplicate by symbol
    return Array.from(new Map(stocks.map(s => [s.symbol, s])).values());
  }

  async fetchCandles(symbol: string): Promise<CandleWithIndicators[]> {
    return fetchCandlesYahoo(symbol, '1y', 8000);
  }
}
