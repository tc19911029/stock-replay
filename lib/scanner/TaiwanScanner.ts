import { CandleWithIndicators } from '@/types';
import { fetchCandlesYahoo } from '@/lib/datasource/YahooFinanceDS';
import { MarketScanner } from './MarketScanner';
import { MarketConfig } from './types';

// Top 100 台灣股票（涵蓋大型股 + 活躍股）
const TW_STOCKS: Array<{ symbol: string; name: string }> = [
  // 半導體
  { symbol: '2330.TW', name: '台積電' },
  { symbol: '2454.TW', name: '聯發科' },
  { symbol: '3711.TW', name: '日月光投控' },
  { symbol: '2303.TW', name: '聯電' },
  { symbol: '3034.TW', name: '聯詠' },
  { symbol: '2379.TW', name: '瑞昱' },
  { symbol: '6415.TW', name: '矽力-KY' },
  { symbol: '2344.TW', name: '華邦電' },
  { symbol: '6770.TW', name: '力積電' },
  { symbol: '2337.TW', name: '旺宏' },
  { symbol: '2408.TW', name: '南亞科' },
  { symbol: '2449.TW', name: '京元電子' },
  { symbol: '3443.TW', name: '創意' },
  { symbol: '6239.TW', name: '力成' },
  { symbol: '5274.TW', name: '信驊' },
  { symbol: '6271.TW', name: '同欣電' },
  { symbol: '6488.TW', name: '環球晶' },
  { symbol: '5483.TW', name: '中美晶' },
  // 電子組裝 / ODM / AI 伺服器
  { symbol: '2317.TW', name: '鴻海' },
  { symbol: '2382.TW', name: '廣達' },
  { symbol: '2308.TW', name: '台達電' },
  { symbol: '6669.TW', name: '緯穎' },
  { symbol: '3231.TW', name: '緯創' },
  { symbol: '4938.TW', name: '和碩' },
  { symbol: '2356.TW', name: '英業達' },
  { symbol: '2395.TW', name: '研華' },
  { symbol: '4958.TW', name: '臻鼎-KY' },
  { symbol: '2301.TW', name: '光寶科' },
  { symbol: '2347.TW', name: '聯強' },
  { symbol: '3017.TW', name: '奇鋐' },
  { symbol: '2059.TW', name: '川湖' },
  { symbol: '2383.TW', name: '台光電' },
  { symbol: '3037.TW', name: '欣興' },
  { symbol: '8046.TW', name: '南電' },
  // 電腦 / 周邊
  { symbol: '2357.TW', name: '華碩' },
  { symbol: '2376.TW', name: '技嘉' },
  { symbol: '2353.TW', name: '宏碁' },
  { symbol: '2474.TW', name: '可成' },
  // 面板 / 光電
  { symbol: '2409.TW', name: '友達' },
  { symbol: '3481.TW', name: '群創' },
  { symbol: '3008.TW', name: '大立光' },
  { symbol: '2360.TW', name: '致茂' },
  { symbol: '2393.TW', name: '億光' },
  // 金融
  { symbol: '2891.TW', name: '中信金' },
  { symbol: '2882.TW', name: '國泰金' },
  { symbol: '2886.TW', name: '兆豐金' },
  { symbol: '2884.TW', name: '玉山金' },
  { symbol: '2881.TW', name: '富邦金' },
  { symbol: '2885.TW', name: '元大金' },
  { symbol: '2892.TW', name: '第一金' },
  { symbol: '5880.TW', name: '合庫金' },
  { symbol: '2880.TW', name: '華南金' },
  { symbol: '2887.TW', name: '台新金' },
  { symbol: '2883.TW', name: '開發金' },
  { symbol: '2890.TW', name: '永豐金' },
  { symbol: '2888.TW', name: '新光金' },
  // 電信
  { symbol: '2412.TW', name: '中華電' },
  { symbol: '3045.TW', name: '台灣大' },
  { symbol: '4904.TW', name: '遠傳' },
  // 石化 / 塑化
  { symbol: '1303.TW', name: '南亞' },
  { symbol: '1301.TW', name: '台塑' },
  { symbol: '6505.TW', name: '台塑化' },
  { symbol: '1326.TW', name: '台化' },
  // 鋼鐵 / 水泥
  { symbol: '2002.TW', name: '中鋼' },
  { symbol: '1101.TW', name: '台泥' },
  { symbol: '1102.TW', name: '亞泥' },
  { symbol: '2027.TW', name: '大成鋼' },
  // 零售 / 食品
  { symbol: '2912.TW', name: '統一超' },
  { symbol: '1216.TW', name: '統一' },
  // 汽車 / 機械
  { symbol: '2207.TW', name: '和泰車' },
  { symbol: '2049.TW', name: '上銀' },
  { symbol: '1590.TW', name: '亞德客-KY' },
  // 航運
  { symbol: '2603.TW', name: '長榮' },
  { symbol: '2609.TW', name: '陽明' },
  { symbol: '2615.TW', name: '萬海' },
  { symbol: '2610.TW', name: '華航' },
  { symbol: '2618.TW', name: '長榮航' },
  // 紡織
  { symbol: '1476.TW', name: '儒鴻' },
  { symbol: '1477.TW', name: '聚陽' },
  // PCB / 被動元件
  { symbol: '2367.TW', name: '燿華' },
  { symbol: '6274.TW', name: '台燿' },
  { symbol: '3533.TW', name: '嘉澤' },
  { symbol: '2360.TW', name: '致茂' },
  // 其他科技
  { symbol: '9910.TW', name: '豐泰' },
  { symbol: '9941.TW', name: '裕融' },
  { symbol: '3035.TW', name: '智原' },
  { symbol: '6533.TW', name: '晶心科' },
  { symbol: '6789.TW', name: '采鈺' },
  { symbol: '5269.TW', name: '祥碩' },
  { symbol: '6278.TW', name: '台表科' },
  { symbol: '3006.TW', name: '晶豪科' },
  { symbol: '4743.TW', name: '合一' },
  { symbol: '6409.TW', name: '旭隼' },
  { symbol: '3029.TW', name: '零壹' },
  { symbol: '4961.TW', name: '天鈺' },
  { symbol: '6550.TW', name: '北極星藥業-KY' },
  { symbol: '2496.TW', name: '卓越' },
  { symbol: '6510.TW', name: '精測' },
];

// Deduplicate by symbol
const DEDUPED = Array.from(new Map(TW_STOCKS.map(s => [s.symbol, s])).values());

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
    return DEDUPED;
  }

  async fetchCandles(symbol: string): Promise<CandleWithIndicators[]> {
    return fetchCandlesYahoo(symbol, '1y');
  }
}
