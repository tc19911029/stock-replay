/**
 * EastMoney CN 籌碼面 Provider
 *
 * 主力資金日線：https://push2.eastmoney.com/api/qt/stock/fflow/daykline/get
 *   secid: 1.600xxx (上海) / 0.000xxx (深圳)
 *   klt=101 = 日線
 *   回傳每日 5 種資金流向（單位：元）：
 *     f51: 主力淨流入
 *     f52: 超大單淨流入
 *     f53: 大單淨流入
 *     f54: 中單淨流入
 *     f55: 小單淨流入
 *     f56-f60: 各佔比 %
 *
 * 主力 = 超大單 + 大單（機構/大戶）
 * 散戶 = 中單 + 小單（一般散戶）
 */

import type { CnFlowDay } from '@/lib/chips/types';

const FFLOW_API = 'https://push2.eastmoney.com/api/qt/stock/fflow/daykline/get';

function getSecid(code: string, suffix?: 'SS' | 'SZ'): string {
  // suffix 權威：SS=上海(1.code)、SZ=深圳(0.code)
  // 否則 fallback：6/9 開頭 = 上海(1)、其他 = 深圳(0)
  if (suffix === 'SS') return `1.${code}`;
  if (suffix === 'SZ') return `0.${code}`;
  const first = code[0];
  return first === '6' || first === '9' ? `1.${code}` : `0.${code}`;
}

interface FFlowResponse {
  rc: number;
  data?: {
    code: string;
    klines: string[];
  };
}

/**
 * 抓 CN 個股最近 N 天主力資金流向。
 * @param code 6 位數代碼（無後綴）
 * @param days 天數
 * @param suffix 'SS'|'SZ'，避免 000001 在 SS（上證指數）vs SZ（平安銀行）誤判
 * @returns Map<date, CnFlowDay>，單位轉成「萬元」（原始為元，除 10000）
 */
export async function fetchCnMainFlow(code: string, days = 200, suffix?: 'SS' | 'SZ'): Promise<Map<string, CnFlowDay>> {
  const url = `${FFLOW_API}?secid=${getSecid(code, suffix)}&klt=101&lmt=${days}` +
    `&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Referer': 'https://quote.eastmoney.com/',
    },
  });
  if (!res.ok) throw new Error(`EastMoney FFlow HTTP ${res.status}`);
  const json = (await res.json()) as FFlowResponse;
  if (json.rc !== 0 || !json.data?.klines) {
    throw new Error(`EastMoney FFlow rc=${json.rc}`);
  }

  const out = new Map<string, CnFlowDay>();
  for (const line of json.data.klines) {
    // 格式: date,主力淨,超大單淨,大單淨,中單淨,小單淨,主力%,超大%,大%,中%,小%,close,changePct,turnover,...
    const parts = line.split(',');
    if (parts.length < 11) continue;
    const date = parts[0];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    // 元 → 萬元（÷10000，再四捨五入）
    const toWan = (s: string): number => Math.round(parseFloat(s) / 10000);
    const main = toWan(parts[1]);     // 主力淨流入
    const xl = toWan(parts[2]);        // 超大單
    const lg = toWan(parts[3]);        // 大單
    const md = toWan(parts[4]);        // 中單
    const sm = toWan(parts[5]);        // 小單
    out.set(date, {
      mainNet: main,
      superLargeNet: xl,
      largeNet: lg,
      mediumNet: md,
      smallNet: sm,
    });
  }
  return out;
}
