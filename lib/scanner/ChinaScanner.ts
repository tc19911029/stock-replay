import { CandleWithIndicators } from '@/types';
import { computeIndicators } from '@/lib/indicators';
import { MarketScanner } from './MarketScanner';
import { MarketConfig } from './types';

// Top 20 A股大型股（滬深）— MVP 使用 Yahoo Finance（.SS / .SZ 後綴）
const CN_STOCKS: Array<{ symbol: string; name: string }> = [
  { symbol: '601398.SS', name: '工商銀行' },
  { symbol: '601288.SS', name: '農業銀行' },
  { symbol: '601939.SS', name: '建設銀行' },
  { symbol: '601988.SS', name: '中國銀行' },
  { symbol: '601628.SS', name: '中國人壽' },
  { symbol: '601318.SS', name: '中國平安' },
  { symbol: '600519.SS', name: '貴州茅台' },
  { symbol: '601166.SS', name: '興業銀行' },
  { symbol: '600036.SS', name: '招商銀行' },
  { symbol: '601688.SS', name: '華泰證券' },
  { symbol: '000858.SZ', name: '五糧液' },
  { symbol: '000333.SZ', name: '美的集團' },
  { symbol: '002594.SZ', name: 'BYD比亞迪' },
  { symbol: '000651.SZ', name: '格力電器' },
  { symbol: '000002.SZ', name: '萬科A' },
  { symbol: '002415.SZ', name: '海康威視' },
  { symbol: '300750.SZ', name: '寧德時代' },
  { symbol: '000568.SZ', name: '瀘州老窖' },
  { symbol: '601899.SS', name: '紫金礦業' },
  { symbol: '600900.SS', name: '長江電力' },
];

export class ChinaScanner extends MarketScanner {
  getMarketConfig(): MarketConfig {
    return {
      marketId:      'CN',
      name:          '中國A股',
      scanTimeLocal: '14:30',
      timezone:      'Asia/Shanghai',
    };
  }

  async getStockList() {
    return CN_STOCKS;
  }

  async fetchCandles(symbol: string): Promise<CandleWithIndicators[]> {
    // MVP: try Yahoo Finance — A-shares have limited coverage, fallback to mock on error
    try {
      const { fetchCandlesYahoo } = await import('@/lib/datasource/YahooFinanceDS');
      return fetchCandlesYahoo(symbol, '1y');
    } catch {
      // Return empty array to skip this symbol gracefully
      return [];
    }
  }
}
