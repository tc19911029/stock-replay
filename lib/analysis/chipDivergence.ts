/**
 * 籌碼背離訊號偵測
 *
 * 偵測股價與籌碼的背離：
 *   - 多頭背離：價跌 + 法人累積買超 → 隱性吸籌
 *   - 空頭背離：價漲 + 法人累積賣超 → 隱性出貨
 *
 * 用 N 日（預設 5 日）區間判斷：
 *   1. 區間收盤價變化 = (today.close − N天前.close) / N天前.close
 *   2. 區間法人累積淨買 = 過去 N 天 sum(foreign + trust)
 *   3. 兩者方向相反 + 絕對值都夠大 → 出訊號
 */

export interface ChipDivergenceResult {
  /** 訊號類型：bullish=多頭背離（價跌法人買），bearish=空頭背離（價漲法人賣） */
  type: 'bullish' | 'bearish' | null;
  /** N 日收盤價變化 % */
  priceChangePct: number;
  /** N 日法人累積買賣超（張） */
  instAccumNet: number;
  /** 訊號強度 0-3 */
  strength: 0 | 1 | 2 | 3;
  /** 人類可讀說明 */
  detail: string;
}

interface PriceCandle {
  date: string;
  close: number;
}

interface InstFlow {
  date: string;
  foreign: number;
  trust: number;
}

/**
 * 偵測單支股票的籌碼背離。
 *
 * @param candles 升冪 by date 的 K 線
 * @param insts   升冪 by date 的法人資料
 * @param windowDays 觀察區間（預設 5 日）
 * @param minPriceMove 最小價格變化門檻 %（預設 3%）
 * @param minInstAccum 最小法人累積門檻（張，預設 500）
 */
export function detectChipDivergence(
  candles: PriceCandle[],
  insts: InstFlow[],
  windowDays = 5,
  minPriceMove = 3,
  minInstAccum = 500,
): ChipDivergenceResult {
  const empty: ChipDivergenceResult = {
    type: null, priceChangePct: 0, instAccumNet: 0, strength: 0, detail: '',
  };
  if (candles.length < windowDays + 1) return empty;

  const last = candles[candles.length - 1];
  const ref = candles[candles.length - 1 - windowDays];
  if (!last || !ref || ref.close <= 0) return empty;

  const priceChangePct = +(((last.close - ref.close) / ref.close) * 100).toFixed(2);

  // 取窗口內的法人資料 sum
  const startDate = ref.date;
  const endDate = last.date;
  let instAccumNet = 0;
  for (const i of insts) {
    if (i.date >= startDate && i.date <= endDate) {
      instAccumNet += (i.foreign ?? 0) + (i.trust ?? 0);
    }
  }

  const priceUp = priceChangePct >= minPriceMove;
  const priceDown = priceChangePct <= -minPriceMove;
  const instBuy = instAccumNet >= minInstAccum;
  const instSell = instAccumNet <= -minInstAccum;

  // 多頭背離：價跌 + 法人買超
  if (priceDown && instBuy) {
    const strength = Math.min(3,
      Math.floor(Math.abs(priceChangePct) / 5) + Math.floor(instAccumNet / 2000),
    ) as 0 | 1 | 2 | 3;
    return {
      type: 'bullish',
      priceChangePct,
      instAccumNet,
      strength,
      detail: `${windowDays}日內價跌 ${Math.abs(priceChangePct).toFixed(1)}% 但法人累積買超 ${instAccumNet.toLocaleString('zh-TW')} 張（隱性吸籌）`,
    };
  }

  // 空頭背離：價漲 + 法人賣超
  if (priceUp && instSell) {
    const strength = Math.min(3,
      Math.floor(priceChangePct / 5) + Math.floor(Math.abs(instAccumNet) / 2000),
    ) as 0 | 1 | 2 | 3;
    return {
      type: 'bearish',
      priceChangePct,
      instAccumNet,
      strength,
      detail: `${windowDays}日內價漲 ${priceChangePct.toFixed(1)}% 但法人累積賣超 ${Math.abs(instAccumNet).toLocaleString('zh-TW')} 張（隱性出貨）`,
    };
  }

  return { ...empty, priceChangePct, instAccumNet };
}
