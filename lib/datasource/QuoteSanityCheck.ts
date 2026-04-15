/**
 * QuoteSanityCheck — L3 報價健全檢查
 *
 * 比對即時報價 vs L1 上一交易日收盤價，偵測千倍誤差、volume 單位異常等。
 * 用於 /api/stock merge 即時報價前，防止錯誤數據傳到前端。
 */

export type SanityLevel = 'ok' | 'warning' | 'critical';

export interface SanityResult {
  level: SanityLevel;
  priceDeviation: number;    // 百分比偏差 (absolute)
  volumeFlag: boolean;       // volume 數量級異常
  message?: string;
}

/**
 * 檢查即時報價的合理性
 *
 * @param realtimeClose 即時報價的 close
 * @param realtimeVolume 即時報價的成交量
 * @param lastL1Close L1 上一交易日收盤價
 * @param lastL1Volume L1 上一交易日成交量（可選）
 * @param market 市場
 */
export function checkQuoteSanity(
  realtimeClose: number,
  realtimeVolume: number,
  lastL1Close: number,
  lastL1Volume: number | undefined,
  market: 'TW' | 'CN',
): SanityResult {
  // 基本防護：無效數據
  if (lastL1Close <= 0 || realtimeClose <= 0) {
    return { level: 'ok', priceDeviation: 0, volumeFlag: false };
  }

  // 價格偏差（百分比）
  const priceDeviation = Math.abs((realtimeClose - lastL1Close) / lastL1Close) * 100;

  // Volume 數量級檢查
  let volumeFlag = false;
  if (lastL1Volume && lastL1Volume > 0 && realtimeVolume > 0) {
    // 若 L1 volume 極小（< 100 張）代表 L1 本身是壞資料（如 vol=1 的錯誤 K 棒），
    // 跳過倍率檢查避免誤拒 L3 注入。volume=1 是已知的 EODHD 資料異常。
    if (lastL1Volume >= 100) {
      const volumeRatio = realtimeVolume / lastL1Volume;
      // 盤中成交量可能很低（正常），但如果大 1000 倍以上就很可疑
      if (volumeRatio > 1000) {
        volumeFlag = true;
      }
    }
  }

  // 判斷等級
  if (priceDeviation > 50 || volumeFlag) {
    // >50% 偏差 或 volume 千倍異常 → critical（可能是單位錯誤）
    return {
      level: 'critical',
      priceDeviation: Math.round(priceDeviation * 100) / 100,
      volumeFlag,
      message: priceDeviation > 50
        ? `價格偏差 ${priceDeviation.toFixed(1)}%，可能是數據單位錯誤`
        : `成交量異常（比 L1 大 ${Math.round(realtimeVolume / (lastL1Volume ?? 1))} 倍）`,
    };
  }

  if (priceDeviation > 20) {
    // >20% → warning（可能是漲停/跌停，需確認）
    // 台股漲跌停 10%，陸股漲跌停 10%（ST 股 5%），但新股/恢復交易可能更大
    const limit = market === 'TW' ? 10 : 10;
    return {
      level: 'warning',
      priceDeviation: Math.round(priceDeviation * 100) / 100,
      volumeFlag,
      message: `價格偏差 ${priceDeviation.toFixed(1)}%（超過 ${limit}% 漲跌停限制）`,
    };
  }

  return {
    level: 'ok',
    priceDeviation: Math.round(priceDeviation * 100) / 100,
    volumeFlag,
  };
}
