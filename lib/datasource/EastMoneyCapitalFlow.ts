/**
 * EastMoney 主力資金流（CN A 股）
 *
 * API: https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get
 * 每個 secid 一個 call，一次可抓歷史 N 天日線資金流
 *
 * secid format:
 *   1.SHxxxxxx → 上海（6 開頭）
 *   0.SZxxxxxx → 深圳（0/3 開頭）
 *
 * 回傳 f51-f57：
 *   f51: 日期 YYYY-MM-DD
 *   f52: 主力淨流入（大單 + 超大單）
 *   f53: 小單
 *   f54: 中單
 *   f55: 大單
 *   f56: 超大單
 *   f57: 漲跌幅 %
 *
 * 用於 CN 版本「淘汰 #8 主力連續淨流出」（等同 TW 三大法人連續賣超）
 */

export interface CapitalFlowDay {
  date:    string;   // YYYY-MM-DD
  mainNet: number;   // 主力淨流入（大+超大單）
}

interface EMResponse {
  data?: {
    code?: string;
    klines?: string[];
  } | null;
}

/**
 * 把 .SS/.SZ 轉成 EastMoney secid 格式
 */
function toSecid(symbol: string): string {
  const code = symbol.replace(/\.(SS|SZ)$/i, '');
  if (/\.SS$/i.test(symbol)) return `1.${code}`;  // 上海
  if (/\.SZ$/i.test(symbol)) return `0.${code}`;  // 深圳
  // fallback 猜：6 開頭 = 上海，其他 = 深圳
  return code.startsWith('6') ? `1.${code}` : `0.${code}`;
}

/**
 * 抓單股近 N 天資金流（日K）
 * @param symbol e.g. '600519.SS'
 * @param lmt 天數（預設 5）
 */
/** 轉 Sina daima 格式：'600519.SS' → 'sh600519'、'000001.SZ' → 'sz000001' */
function toSinaDaima(symbol: string): string {
  const code = symbol.replace(/\.(SS|SZ)$/i, '');
  if (/\.SS$/i.test(symbol)) return `sh${code}`;
  if (/\.SZ$/i.test(symbol)) return `sz${code}`;
  return code.startsWith('6') ? `sh${code}` : `sz${code}`;
}

interface SinaFlowRow {
  opendate?: string;
  r0_net?: string;    // 主力淨額（大+超大單）
  netamount?: string; // 綜合淨流入
}

/**
 * Sina fallback：`money.finance.sina.com.cn`
 * 回傳 JSON array，欄位 opendate / r0_net / netamount
 */
async function fetchCapitalFlowSina(
  symbol: string, lmt: number,
): Promise<CapitalFlowDay[]> {
  const daima = toSinaDaima(symbol);
  const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_qsfx_zjlrqs`
    + `?page=1&num=${lmt}&sort=opendate&asc=0&daima=${daima}`;

  const res = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Referer':    'https://vip.stock.finance.sina.com.cn/',
    },
  });
  if (!res.ok) return [];
  const text = await res.text();
  if (!text.trim().startsWith('[')) return [];
  const rows = JSON.parse(text) as SinaFlowRow[];
  return rows.map(r => ({
    date:    (r.opendate ?? '').slice(0, 10),
    mainNet: parseFloat(r.r0_net ?? '0') || 0,
  })).filter(r => r.date);
}

/**
 * EastMoney primary
 */
async function fetchCapitalFlowEM(
  symbol: string, lmt: number,
): Promise<CapitalFlowDay[]> {
  const secid = toSecid(symbol);
  const url = `https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get`
    + `?secid=${secid}&klt=101&lmt=${lmt}`
    + `&fields1=f1&fields2=f51,f52,f53,f54,f55,f56,f57`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Referer':    'https://quote.eastmoney.com/',
    },
  });
  if (!res.ok) return [];
  const json = await res.json() as EMResponse;
  const klines = json.data?.klines ?? [];
  return klines.map(line => {
    const parts = line.split(',');
    return { date: parts[0], mainNet: parseFloat(parts[1]) || 0 };
  });
}

/**
 * 抓單股近 N 天資金流（日K）
 * 優先 EastMoney，失敗或空時 fallback Sina
 */
export async function fetchCapitalFlow(
  symbol: string,
  lmt: number = 5,
): Promise<CapitalFlowDay[]> {
  try {
    const em = await fetchCapitalFlowEM(symbol, lmt);
    if (em.length > 0) return em;
  } catch { /* fallthrough */ }
  try {
    return await fetchCapitalFlowSina(symbol, lmt);
  } catch {
    return [];
  }
}
