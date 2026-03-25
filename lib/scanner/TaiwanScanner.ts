import { CandleWithIndicators } from '@/types';
import { fetchCandlesYahoo } from '@/lib/datasource/YahooFinanceDS';
import { MarketScanner } from './MarketScanner';
import { MarketConfig } from './types';

// Top 50 台灣大型股（市值排名）
const TW_STOCKS: Array<{ symbol: string; name: string }> = [
  { symbol: '2330.TW', name: '台積電' },
  { symbol: '2317.TW', name: '鴻海' },
  { symbol: '2454.TW', name: '聯發科' },
  { symbol: '2308.TW', name: '台達電' },
  { symbol: '2382.TW', name: '廣達' },
  { symbol: '3711.TW', name: '日月光投控' },
  { symbol: '2303.TW', name: '聯電' },
  { symbol: '2891.TW', name: '中信金' },
  { symbol: '2882.TW', name: '國泰金' },
  { symbol: '2886.TW', name: '兆豐金' },
  { symbol: '2884.TW', name: '玉山金' },
  { symbol: '2881.TW', name: '富邦金' },
  { symbol: '2885.TW', name: '元大金' },
  { symbol: '2892.TW', name: '第一金' },
  { symbol: '5880.TW', name: '合庫金' },
  { symbol: '2912.TW', name: '統一超' },
  { symbol: '2002.TW', name: '中鋼' },
  { symbol: '1303.TW', name: '南亞' },
  { symbol: '1301.TW', name: '台塑' },
  { symbol: '6505.TW', name: '台塑化' },
  { symbol: '2412.TW', name: '中華電' },
  { symbol: '3045.TW', name: '台灣大' },
  { symbol: '4904.TW', name: '遠傳' },
  { symbol: '2207.TW', name: '和泰車' },
  { symbol: '2395.TW', name: '研華' },
  { symbol: '3008.TW', name: '大立光' },
  { symbol: '2409.TW', name: '友達' },
  { symbol: '3481.TW', name: '群創' },
  { symbol: '2408.TW', name: '南亞科' },
  { symbol: '2498.TW', name: '宏達電' },
  { symbol: '2357.TW', name: '華碩' },
  { symbol: '2353.TW', name: '宏碁' },
  { symbol: '2376.TW', name: '技嘉' },
  { symbol: '2344.TW', name: '華邦電' },
  { symbol: '6669.TW', name: '緯穎' },
  { symbol: '2379.TW', name: '瑞昱' },
  { symbol: '2360.TW', name: '致茂' },
  { symbol: '3034.TW', name: '聯詠' },
  { symbol: '6770.TW', name: '力積電' },
  { symbol: '2337.TW', name: '旺宏' },
  { symbol: '2049.TW', name: '上銀' },
  { symbol: '6415.TW', name: '矽力-KY' },
  { symbol: '4958.TW', name: '臻鼎-KY' },
  { symbol: '2301.TW', name: '光寶科' },
  { symbol: '2347.TW', name: '聯強' },
  { symbol: '1216.TW', name: '統一' },
  { symbol: '1102.TW', name: '亞泥' },
  { symbol: '1101.TW', name: '台泥' },
  { symbol: '9910.TW', name: '豐泰' },
  { symbol: '2610.TW', name: '華航' },
];

export class TaiwanScanner extends MarketScanner {
  getMarketConfig(): MarketConfig {
    return {
      marketId:      'TW',
      name:          '台灣股市',
      scanTimeLocal: '13:00',
      timezone:      'Asia/Taipei',
    };
  }

  async getStockList() {
    return TW_STOCKS;
  }

  async fetchCandles(symbol: string): Promise<CandleWithIndicators[]> {
    return fetchCandlesYahoo(symbol, '1y');
  }
}
