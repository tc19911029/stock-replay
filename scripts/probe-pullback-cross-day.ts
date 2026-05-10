/**
 * 驗證 detectPullbackBuy 在「跨日站回 → 補量突破」情境下的行為。
 *
 * 用合成 candle，避免依賴真實資料。產出：對 5 種情境分別印出 hit / miss + barsSinceReclaim。
 */
import type { CandleWithIndicators } from '../types';
import { detectPullbackBuy } from '../lib/analysis/highWinPositions';

type RawBar = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

function withIndicators(bars: RawBar[]): CandleWithIndicators[] {
  return bars.map((b, i) => {
    const win5 = bars.slice(Math.max(0, i - 4), i + 1);
    const win10 = bars.slice(Math.max(0, i - 9), i + 1);
    const win20 = bars.slice(Math.max(0, i - 19), i + 1);
    const ma = (w: RawBar[]) => w.reduce((s, x) => s + x.close, 0) / w.length;
    return {
      ...b,
      ma5: win5.length >= 5 ? ma(win5) : null,
      ma10: win10.length >= 10 ? ma(win10) : null,
      ma20: win20.length >= 20 ? ma(win20) : null,
      ma60: null,
      ma120: null,
      kdK: null,
      kdD: null,
      kdJ: null,
      macd: null,
      macdSignal: null,
      macdHist: null,
      rsi: null,
    } as CandleWithIndicators;
  });
}

/**
 * 建立一個基本「多頭走勢 30 根」骨架，最後 5 根用參數覆蓋，
 * 來模擬不同的「站回 / 補量」時序組合。
 */
function buildScenario(opts: {
  // 倒數 5 根的 (close, volume, isRedBig)
  // T-4, T-3, T-2, T-1, T
  closes: [number, number, number, number, number];
  volumes: [number, number, number, number, number];
  highs?: [number, number, number, number, number];
  lows?: [number, number, number, number, number];
  opens?: [number, number, number, number, number];
}): CandleWithIndicators[] {
  // 前 25 根：穩定上漲（簡單線性 + 噪音）
  const base: RawBar[] = [];
  for (let i = 0; i < 25; i++) {
    const p = 100 + i * 0.5;
    base.push({
      date: `2026-04-${String(i + 1).padStart(2, '0')}`,
      open: p - 0.2,
      high: p + 0.3,
      low: p - 0.4,
      close: p,
      volume: 1000,
    });
  }
  // 倒數 5 根
  for (let k = 0; k < 5; k++) {
    const c = opts.closes[k];
    const o = opts.opens?.[k] ?? c - 0.3;
    const h = opts.highs?.[k] ?? Math.max(c, o) + 0.2;
    const l = opts.lows?.[k] ?? Math.min(c, o) - 0.2;
    base.push({
      date: `2026-05-${String(k + 1).padStart(2, '0')}`,
      open: o,
      high: h,
      low: l,
      close: c,
      volume: opts.volumes[k],
    });
  }
  return withIndicators(base);
}

function probe(name: string, c: CandleWithIndicators[]) {
  const idx = c.length - 1;
  const result = detectPullbackBuy(c, idx);
  const last3 = c.slice(-3).map(x =>
    `${x.date} c=${x.close.toFixed(2)} ma5=${x.ma5?.toFixed(2) ?? 'null'} v=${x.volume}`,
  ).join(' | ');
  if (result) {
    console.log(`✅ HIT  [${name}] barsSinceReclaim=${result.barsSinceReclaim} body=${result.bodyPct.toFixed(2)}% vol×${result.volumeRatio.toFixed(2)} brk=${result.breakoutPrice.toFixed(2)}`);
  } else {
    console.log(`⛔ MISS [${name}]`);
  }
  console.log(`     ${last3}`);
}

async function main() {
  // 注意：這些是合成資料，detectTrend 不一定通過——這個 probe 主要驗證 gate 2/3 的「站回/守MA5」邏輯。
  // 為了能進到 gate 2-3，我們關掉 gate 1（暫時 monkey-patch 其實太麻煩），改用 fixture 讓多頭成立。
  //
  // 實際上 detectTrend 需要 findPivots 找到 confirmed pivots — 用線性骨架很難穩定觸發。
  // 因此這個 probe 的意義是「能否產生候選資料 + 邏輯流程不爆 runtime」，
  // 真正的端到端驗證請看 npm run test:contracts + 手動跑掃描。

  console.log('=== Probe: detectPullbackBuy 跨日站回情境 ===\n');

  // Case 1: N=0 站回當日同時放量突破（向後相容）
  probe('N=0 站回當日同時放量突破', buildScenario({
    closes: [110, 109, 108, 109, 113],     // T-2 < ma5, T 站回 + 紅K
    volumes: [1000, 1000, 1000, 1000, 1500],
    opens: [110, 109.5, 108.5, 109, 110.5],
    highs: [111, 110, 109, 110, 113.5],
    lows: [109, 108.5, 107.5, 108.5, 110],
  }));

  // Case 2: N=1 站回隔日補量突破
  probe('N=1 T-1 站回小量, T 補量突破', buildScenario({
    closes: [110, 109, 108, 110.5, 113],
    volumes: [1000, 1000, 1000, 1100, 1500],
    opens: [110, 109.5, 108.5, 110, 110.5],
    highs: [111, 110, 109, 110.8, 113.5],
    lows: [109, 108.5, 107.5, 109.8, 110],
  }));

  // Case 3: N=1 但 T-1 站回後 T 跌破 → 應 MISS（gate 3 擋）
  probe('N=1 站回後跌破 MA5', buildScenario({
    closes: [110, 109, 108, 110.5, 107],   // T 跌回 MA5 之下
    volumes: [1000, 1000, 1000, 1100, 1500],
    opens: [110, 109.5, 108.5, 110, 109],
    highs: [111, 110, 109, 110.8, 109.2],
    lows: [109, 108.5, 107.5, 109.8, 106.5],
  }));

  // Case 4: N=3 站回後第 3 個交易日才放量 → 應 MISS（窗口外）
  probe('N=3 站回後第 3 日才補量', buildScenario({
    closes: [108, 110.2, 110.3, 110.4, 113],
    volumes: [1000, 1000, 1000, 1000, 1500],
    opens: [108.5, 109, 110, 110.2, 110.5],
    highs: [109, 110.5, 110.5, 110.6, 113.5],
    lows: [107.5, 108.5, 109.8, 110, 110],
  }));

  // Case 5: 量不足 → 應 MISS（gate 6）
  probe('量×1.0 不足 1.3', buildScenario({
    closes: [110, 109, 108, 110.5, 113],
    volumes: [1000, 1000, 1000, 1000, 1000],
    opens: [110, 109.5, 108.5, 110, 110.5],
    highs: [111, 110, 109, 110.8, 113.5],
    lows: [109, 108.5, 107.5, 109.8, 110],
  }));

  console.log('\n（以上 case 受 detectTrend gate 影響，合成資料未必觸發多頭，');
  console.log(' 主要看「barsSinceReclaim 欄位是否正確輸出 + 各 gate 邏輯不爆 runtime」。）');
}

main().catch(e => { console.error(e); process.exit(1); });
