/**
 * 分鐘級數據適配器
 *
 * MockIntradayProvider: 產生模擬的 1m/5m/15m/60m K 線
 * 架構預留未來 WebSocket 即時行情接口
 */

import type {
  IntradayCandle,
  IntradayDataProvider,
  IntradayTimeframe,
} from './types';

// ── 聚合工具 ──────────────────────────────────────────────────────────────────

/** 將 1m K 線聚合為更大週期 */
export function aggregateCandles(
  minuteCandles: IntradayCandle[],
  targetTimeframe: IntradayTimeframe,
): IntradayCandle[] {
  if (targetTimeframe === '1m') return minuteCandles;

  const minuteMap: Record<string, number> = { '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30, '60m': 60 };
  const minutes = minuteMap[targetTimeframe];
  if (!minutes) return minuteCandles; // daily/weekly/monthly - no aggregation needed
  const result: IntradayCandle[] = [];

  for (let i = 0; i < minuteCandles.length; i += minutes) {
    const group = minuteCandles.slice(i, i + minutes);
    if (group.length === 0) continue;

    result.push({
      time: group[0].time,
      open: group[0].open,
      high: Math.max(...group.map(c => c.high)),
      low: Math.min(...group.map(c => c.low)),
      close: group[group.length - 1].close,
      volume: group.reduce((s, c) => s + c.volume, 0),
      timeframe: targetTimeframe,
    });
  }

  return result;
}

// ── Mock 數據生成 ──────────────────────────────────────────────────────────────

type DayType = 'trending_up' | 'trending_down' | 'range' | 'volatile' | 'random';

interface MockConfig {
  basePrice?: number;
  volatility?: number;    // 日內波動率，如 0.03 = 3%
  avgDailyVolume?: number;
  dayType?: DayType;
  seed?: number;          // 可重現的隨機種子
}

/** 簡易可種子的偽隨機數 */
class SeededRandom {
  private state: number;
  constructor(seed: number) { this.state = seed; }
  next(): number {
    this.state = (this.state * 1664525 + 1013904223) & 0x7fffffff;
    return this.state / 0x7fffffff;
  }
  /** Box-Muller 正態分佈 */
  normal(mean = 0, std = 1): number {
    const u1 = this.next() || 0.0001;
    const u2 = this.next();
    return mean + std * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
}

/** 台股交易時間：09:00 - 13:30（270 分鐘） */
const TW_MARKET_MINUTES = 270;

function generateMinuteCandles(
  symbol: string,
  date: string,
  config: MockConfig = {},
): IntradayCandle[] {
  const {
    basePrice = 100,
    volatility = 0.03,
    avgDailyVolume = 5000000,
    dayType = 'random',
    seed,
  } = config;

  const rng = new SeededRandom(seed ?? Date.parse(date + 'T00:00:00') + symbol.charCodeAt(0));
  const minuteVol = volatility / Math.sqrt(TW_MARKET_MINUTES);
  const candles: IntradayCandle[] = [];

  // 趨勢偏移
  let drift = 0;
  switch (dayType) {
    case 'trending_up':   drift = volatility * 0.8 / TW_MARKET_MINUTES; break;
    case 'trending_down': drift = -volatility * 0.8 / TW_MARKET_MINUTES; break;
    case 'volatile':      break; // 高波動無趨勢
    case 'range':         break;
    default: drift = (rng.next() - 0.5) * volatility * 0.6 / TW_MARKET_MINUTES;
  }

  const volMultiplier = dayType === 'volatile' ? 1.8 : dayType === 'range' ? 0.6 : 1.0;

  let price = basePrice * (1 + (rng.next() - 0.5) * 0.005); // 微小開盤偏移

  for (let m = 0; m < TW_MARKET_MINUTES; m++) {
    const hour = 9 + Math.floor(m / 60);
    const minute = m % 60;
    const timeStr = `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;

    const open = price;

    // 價格變動
    const noise = rng.normal(0, minuteVol * volMultiplier);
    const meanReversion = dayType === 'range' ? (basePrice - price) / basePrice * 0.01 : 0;
    price = price * (1 + drift + noise + meanReversion);

    // 確保正價格
    price = Math.max(price * 0.5, price);

    const close = price;
    const spread = Math.abs(close - open);
    const high = Math.max(open, close) + spread * rng.next() * 0.5;
    const low  = Math.min(open, close) - spread * rng.next() * 0.5;

    // 成交量 U 型分佈（開盤收盤大量）
    const tNorm = m / TW_MARKET_MINUTES; // 0 ~ 1
    const uCurve = 2.5 * (tNorm - 0.5) ** 2 + 0.5;
    // 爆量效果：如果價格變動大，量也放大
    const priceMoveFactor = 1 + Math.abs(noise) / minuteVol * 0.5;
    const baseVol = avgDailyVolume / TW_MARKET_MINUTES;
    const vol = Math.round(baseVol * uCurve * priceMoveFactor * (0.5 + rng.next()));

    candles.push({
      time: timeStr,
      open:  Math.round(open * 100) / 100,
      high:  Math.round(high * 100) / 100,
      low:   Math.round(low * 100) / 100,
      close: Math.round(close * 100) / 100,
      volume: vol,
      timeframe: '1m',
    });
  }

  return candles;
}

// ── MockIntradayProvider ──────────────────────────────────────────────────────

export class MockIntradayProvider implements IntradayDataProvider {
  private cache = new Map<string, IntradayCandle[]>();
  private defaultConfig: MockConfig;

  constructor(config?: MockConfig) {
    this.defaultConfig = config ?? {};
  }

  async getCandles(
    symbol: string,
    timeframe: IntradayTimeframe,
    date?: string,
  ): Promise<IntradayCandle[]> {
    const d = date ?? new Date().toISOString().split('T')[0];
    const cacheKey = `${symbol}:${d}`;

    // 取得或生成 1m 資料
    if (!this.cache.has(cacheKey)) {
      // 根據 symbol 決定 basePrice
      const basePrice = this.getBasePrice(symbol);
      const dayTypes: DayType[] = ['trending_up', 'trending_down', 'range', 'volatile', 'random'];
      const dayIdx = (Date.parse(d) / 86400000) % dayTypes.length;

      this.cache.set(cacheKey, generateMinuteCandles(symbol, d, {
        ...this.defaultConfig,
        basePrice,
        dayType: dayTypes[Math.floor(dayIdx)],
      }));
    }

    const minuteData = this.cache.get(cacheKey)!;
    return aggregateCandles(minuteData, timeframe);
  }

  private getBasePrice(symbol: string): number {
    // 模擬不同股票的基礎價格
    const prices: Record<string, number> = {
      '2330': 590, '2454': 1100, '2317': 105, '2412': 123,
      '2308': 240, '3008': 890, '2382': 340, '6505': 78,
      '6770': 28, '2303': 42, '2002': 28, '3443': 210,
      '2618': 38, '2609': 72, '2615': 65, '2603': 195,
      '00940': 10, '2886': 35, '2884': 32, '2891': 22,
      '3034': 580, '2345': 198, '6669': 320, '3037': 98,
    };
    const clean = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
    return prices[clean] ?? this.defaultConfig.basePrice ?? 100;
  }

  /** 清除快取 */
  clearCache(): void {
    this.cache.clear();
  }
}

// ── 導出預設實例 ──────────────────────────────────────────────────────────────

export const mockDataProvider = new MockIntradayProvider({
  volatility: 0.035,
  avgDailyVolume: 8000000,
});
