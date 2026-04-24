import { CandleWithIndicators } from '@/types';
import { dataProvider } from '@/lib/datasource/MultiMarketProvider';
import { MarketScanner, StockEntry } from './MarketScanner';
import { MarketConfig } from './types';
import { detectTrend, TrendState } from '@/lib/analysis/trendAnalysis';
import { CN_STOCKS } from './cnStocks';
import { fetchEastMoneyStockList } from './eastMoneyApi';

export class ChinaScanner extends MarketScanner {
  getMarketConfig(): MarketConfig {
    return {
      marketId:      'CN',
      name:          '中國A股全市場',
      scanTimeLocal: '14:30',
      timezone:      'Asia/Shanghai',
    };
  }

  async getStockList(): Promise<StockEntry[]> {
    // 嘗試從東方財富 API 動態取得全部 A 股清單
    try {
      const stocks = await fetchEastMoneyStockList();
      if (stocks.length > 500) {
        return stocks;
      }
    } catch {
      // 東方財富 API 失敗，使用靜態名單
    }
    return CN_STOCKS;
  }

  async fetchCandles(symbol: string, asOfDate?: string): Promise<CandleWithIndicators[]> {
    // 取 2 年日K（~500根）以支援多時間框架分析（月K需要 MA10 = 24 根月K）
    return dataProvider.getHistoricalCandles(symbol, '2y', asOfDate);
  }

  /**
   * 大盤趨勢：以滬深300指數（000300.SS）作為A股大盤代理指標
   *
   * 三重檢驗（同台股邏輯）：
   * 1. 長期趨勢 (detectTrend)
   * 2. 短期動能：close < MA5 且 MA5 < MA10 → 降為「盤整」
   * 3. 過熱乖離：close > MA20 × 1.08 → 降為「盤整」
   */
  async getMarketTrend(asOfDate?: string): Promise<TrendState> {
    try {
      // 優先讀本地快取（避免每次掃描都打 API）
      let candles: CandleWithIndicators[] = [];
      try {
        const { loadLocalCandlesWithTolerance } = await import('@/lib/datasource/LocalCandleStore');
        const targetDate = asOfDate || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
        const local = await loadLocalCandlesWithTolerance('000300.SS', 'CN', targetDate, 5);
        if (local && local.candles.length >= 20) {
          candles = local.candles;
        }
      } catch { /* local read failed, fallback to API */ }

      // 歷史重掃時不打 API（000300.SS 不在 L1，打 API 只會 timeout）
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
      const isHistorical = !!asOfDate && asOfDate < today;
      if (candles.length < 20 && !isHistorical) {
        const fetched = await dataProvider.getHistoricalCandles('000300.SS', '1y', asOfDate);
        if (fetched.length >= 20) {
          // 存進 L1，下次直接從 cache 讀（省掉每次 13s API 呼叫）
          const { saveLocalCandles } = await import('@/lib/datasource/LocalCandleStore');
          const raw = fetched.map(c => ({
            date: c.date, open: c.open, high: c.high,
            low: c.low, close: c.close, volume: c.volume,
          }));
          saveLocalCandles('000300.SS', 'CN', raw).catch(() => {});
        }
        candles = fetched;
      }
      if (candles.length < 20) return '多頭'; // 資料不足時歷史預設多頭（TW 統計同期大多是多頭）

      const lastIdx = candles.length - 1;
      const longTrend = detectTrend(candles, lastIdx);

      const last = candles[lastIdx];
      const shortTermBearish =
        last.ma5 != null && last.ma10 != null &&
        last.close < last.ma5 && last.ma5 < last.ma10;

      const marketOverheat =
        last.ma20 != null && last.ma20 > 0 &&
        last.close > last.ma20 * 1.08;

      if (longTrend === '多頭' && (shortTermBearish || marketOverheat)) {
        return '盤整';
      }

      return longTrend;
    } catch {
      return '盤整'; // 取得失敗時保守預設盤整（minScore=5）
    }
  }
}
