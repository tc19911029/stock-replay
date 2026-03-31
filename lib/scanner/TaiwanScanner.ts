import { CandleWithIndicators } from '@/types';
import { fetchCandlesYahoo } from '@/lib/datasource/YahooFinanceDS';
import { fetchCandlesTWSE } from '@/lib/datasource/TWSEDataSource';
import { MarketScanner, StockEntry } from './MarketScanner';
import { MarketConfig } from './types';
import { detectTrend, TrendState } from '@/lib/analysis/trendAnalysis';
import { getTWSERealtime } from '@/lib/datasource/TWSERealtime';
import { getTWConcept } from './conceptMap';

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

type TWSERow = { Code: string; Name: string; TradeVolume?: string };
type TPExRow = { SecuritiesCompanyCode: string; CompanyName: string; TradingShares?: string };

// ── 產業分類 ──────────────────────────────────────────────────────────────────

/** TWSE 產業代碼 → 中文名稱 */
const TWSE_INDUSTRY_MAP: Record<string, string> = {
  '01': '水泥', '02': '食品', '03': '塑膠', '04': '紡織',
  '05': '電機機械', '06': '電器電纜', '08': '玻璃陶瓷', '09': '造紙',
  '10': '鋼鐵', '11': '橡膠', '12': '汽車', '14': '營建',
  '15': '航運', '16': '觀光', '17': '金融保險', '18': '貿易百貨',
  '20': '其他', '21': '化學', '22': '生技醫療', '23': '油電燃氣',
  '24': '半導體', '25': '電腦週邊', '26': '光電', '27': '通信網路',
  '28': '電子零組件', '29': '電子通路', '30': '資訊服務', '31': '其他電子',
  '32': '文化創意', '33': '農業科技', '34': '電子商務', '35': '綠能環保',
  '36': '數位雲端', '37': '運動休閒', '38': '居家生活',
  '91': '存託憑證',
};

let industryCache: Map<string, string> | null = null;
let industryCacheTime = 0;
const INDUSTRY_CACHE_TTL = 24 * 60 * 60 * 1000; // 24小時

/**
 * 從 TWSE/TPEx 取得全部公司產業分類
 * TWSE API 回傳「產業別」欄位為代碼（如 "24"），需轉換為中文名稱
 */
async function fetchTWIndustryMap(): Promise<Map<string, string>> {
  if (industryCache && Date.now() - industryCacheTime < INDUSTRY_CACHE_TTL) {
    return industryCache;
  }

  const map = new Map<string, string>();
  try {
    // TWSE 上市公司基本資料
    const res = await fetch(
      'https://openapi.twse.com.tw/v1/opendata/t187ap03_L',
      { signal: AbortSignal.timeout(10000) }
    );
    if (res.ok) {
      const data = await res.json() as Array<{
        公司代號: string;
        產業別: string;
      }>;
      for (const row of data) {
        const code = row.公司代號?.trim();
        const indCode = row.產業別?.trim();
        if (code && indCode) {
          map.set(code, TWSE_INDUSTRY_MAP[indCode] ?? indCode);
        }
      }
    }
  } catch {
    // 取得上市產業分類失敗，忽略
  }

  try {
    // TPEx 上櫃公司基本資料（欄位名稱與上市不同）
    const res2 = await fetch(
      'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O',
      { signal: AbortSignal.timeout(10000) }
    );
    if (res2.ok) {
      const data2 = await res2.json() as Array<Record<string, string>>;
      for (const row of data2) {
        const code = (row['SecuritiesCompanyCode'] || '').trim();
        const indCode = (row['SecuritiesIndustryCode'] || '').trim();
        if (code && indCode) {
          map.set(code, TWSE_INDUSTRY_MAP[indCode] ?? indCode);
        }
      }
    }
  } catch {
    // 取得上櫃產業分類失敗，忽略
  }

  if (map.size > 0) {
    industryCache = map;
    industryCacheTime = Date.now();
  }
  return map;
}

/** 從 TWSE 取得上市股票，按當日成交量排序 */
async function fetchTWSEStocks(): Promise<(StockEntry & { vol: number })[]> {
  const res = await fetch(
    'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
    { signal: AbortSignal.timeout(15000) }
  );
  if (!res.ok) throw new Error('TWSE API error');
  const data = await res.json() as TWSERow[];
  return data
    .filter(s => /^[1-9]\d{3}$/.test(s.Code)) // 4碼且首碼1-9：排除ETF(00xx)、權證、受益憑證
    .map(s => ({
      symbol: `${s.Code}.TW`,
      name: s.Name.trim(),
      vol: parseInt((s.TradeVolume ?? '0').replace(/,/g, ''), 10) || 0,
    }))
    .sort((a, b) => b.vol - a.vol);
}

/** 從 TPEx 取得上櫃股票，按當日成交量排序 */
async function fetchTPExStocks(): Promise<(StockEntry & { vol: number })[]> {
  const res = await fetch(
    'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes',
    { signal: AbortSignal.timeout(15000) }
  );
  if (!res.ok) throw new Error('TPEx API error');
  const data = await res.json() as TPExRow[];
  return data
    .filter(s => /^[1-9]\d{3}$/.test(s.SecuritiesCompanyCode)) // 4碼且首碼1-9：排除ETF、權證
    .map(s => ({
      symbol: `${s.SecuritiesCompanyCode}.TWO`,
      name: s.CompanyName.trim(),
      vol: parseInt((s.TradingShares ?? '0').replace(/,/g, ''), 10) || 0,
    }))
    .sort((a, b) => b.vol - a.vol);
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
    const [listed, otc, industryMap] = await Promise.allSettled([
      fetchTWSEStocks(),
      fetchTPExStocks(),
      fetchTWIndustryMap(),
    ]);

    const withVol: (StockEntry & { vol: number })[] = [
      ...(listed.status === 'fulfilled' ? listed.value : []),
      ...(otc.status    === 'fulfilled' ? otc.value    : []),
    ];

    if (withVol.length === 0) {
      return FALLBACK_TW_STOCKS;
    }

    const indMap = industryMap.status === 'fulfilled' ? industryMap.value : new Map<string, string>();

    // Deduplicate, sort by volume (highest first) — 全部台股不設上限
    const deduped = Array.from(new Map(withVol.map(s => [s.symbol, s])).values());
    const sorted  = deduped.sort((a, b) => b.vol - a.vol);
    return sorted.map(({ symbol, name }) => {
      const code = symbol.replace(/\.(TW|TWO)$/i, '');
      return { symbol, name, industry: getTWConcept(code, indMap.get(code)) };
    });
  }

  async fetchCandles(symbol: string, asOfDate?: string): Promise<CandleWithIndicators[]> {
    // Primary: Yahoo Finance
    try {
      const candles = await fetchCandlesYahoo(symbol, '1y', 8000, asOfDate);
      if (candles.length >= 30) return candles;
    } catch {
      // Yahoo failed, try fallback
    }

    // Fallback: TWSE direct API (listed stocks only, no asOfDate support)
    if (/\.TW$/i.test(symbol) && !asOfDate) {
      const ticker = symbol.replace(/\.TW$/i, '');
      try {
        const candles = await fetchCandlesTWSE(ticker);
        if (candles.length >= 30) return candles;
      } catch {
        // TWSE fallback also failed
      }
    }

    return [];
  }

  /**
   * 大盤趨勢：以 0050.TW（元大台灣50 ETF）作為台股大盤代理指標
   *
   * 三重檢驗：
   * 1. 長期趨勢 (detectTrend)：確保大方向多頭結構
   * 2. 短期動能：若 close < MA5 且 MA5 < MA10 → 短期修正，降為「盤整」
   * 3. 過熱乖離：若大盤收盤 > MA20 × 1.08（乖離>8%）→ 末升段過高，降為「盤整」
   *    防止在大盤到頂區域還進場（朱老師：乖離過大不追高）
   */
  async getMarketTrend(asOfDate?: string): Promise<TrendState> {
    try {
      const candles = await fetchCandlesYahoo('0050.TW', '1y', 8000, asOfDate);
      if (candles.length < 20) return '盤整'; // 資料不足，保守預設

      const lastIdx = candles.length - 1;
      const longTrend = detectTrend(candles, lastIdx);

      const last = candles[lastIdx];

      // ── 短期動能檢驗（防止在修正初期進場）──────────────────────────────
      const shortTermBearish =
        last.ma5 != null && last.ma10 != null &&
        last.close < last.ma5 && last.ma5 < last.ma10;

      // ── 大盤過熱檢驗（防止在高檔追漲）─────────────────────────────────
      // 大盤收盤若超過MA20的8%乖離 → 高檔過熱，不宜進場
      const marketOverheat =
        last.ma20 != null && last.ma20 > 0 &&
        last.close > last.ma20 * 1.08;

      if (longTrend === '多頭' && (shortTermBearish || marketOverheat)) {
        // 長期多頭但短期走弱或過熱 → 保守降為盤整（minScore=5）
        return '盤整';
      }

      return longTrend;
    } catch {
      return '盤整'; // 取得失敗時保守預設盤整（minScore=5）
    }
  }
}
