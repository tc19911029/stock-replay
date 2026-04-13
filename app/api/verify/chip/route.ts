/**
 * P6: 籌碼面數據交叉驗證
 *
 * 從 FinMind 和 TWSE 各取同一天同一支股票的三大法人買賣超，
 * 差異超過閾值時標記告警。
 *
 * GET /api/verify/chip?symbol=2330&date=2025-04-10
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getInstitutional } from '@/lib/datasource/FinMindClient';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';

const querySchema = z.object({
  symbol: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

// 差異超過此閾值（張）才觸發告警
const ALERT_THRESHOLD_LOTS = 500;
// 差異超過此比例才觸發告警（相對於較大的那個值）
const ALERT_THRESHOLD_PCT = 0.05;

interface TWSEInstitutionalRow {
  foreignNet: number;  // 外資買賣超（張）
  trustNet: number;    // 投信買賣超（張）
  dealerNet: number;   // 自營商買賣超（張）
  totalNet: number;
}

/**
 * 從 TWSE T86 抓取指定日期全市場三大法人資料，並過濾出目標股票。
 * T86 URL: https://www.twse.com.tw/rwd/zh/fund/T86?date=YYYYMMDD&selectType=ALLBUT0999&response=json
 *
 * 回傳 null 表示該日期無資料（假日/停牌）。
 */
async function fetchTWSEInstitutional(
  symbol: string,
  date: string,
): Promise<TWSEInstitutionalRow | null> {
  const dateStr = date.replace(/-/g, '');  // YYYYMMDD
  const url = `https://www.twse.com.tw/rwd/zh/fund/T86?date=${dateStr}&selectType=ALLBUT0999&response=json`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`TWSE T86 HTTP ${res.status}`);

  const json = await res.json();
  // stat: "OK" or "No Data"
  if (json.stat !== 'OK' || !Array.isArray(json.data)) return null;

  // Fields: 證券代號, 證券名稱, 外資買進, 外資賣出, 外資買賣超, 投信買進, 投信賣出, 投信買賣超, 自營商買賣超, 三大法人買賣超
  const row = (json.data as string[][]).find(r => r[0]?.trim() === symbol);
  if (!row) return null;

  const parse = (s: string) => parseInt(s.replace(/,/g, ''), 10) || 0;
  // T86 columns (0-indexed):
  // 0: 代號, 1: 名稱, 2: 外資買進, 3: 外資賣出, 4: 外資買賣超, 5: 投信買進, 6: 投信賣出, 7: 投信買賣超, 8: 自營商買賣超, 9: 三大法人
  const foreignNet = parse(row[4]);
  const trustNet   = parse(row[7]);
  const dealerNet  = parse(row[8]);

  return {
    foreignNet,
    trustNet,
    dealerNet,
    totalNet: foreignNet + trustNet + dealerNet,
  };
}

function diffRow(key: string, finmind: number, twse: number) {
  const absDiff = Math.abs(finmind - twse);
  const base = Math.max(Math.abs(finmind), Math.abs(twse), 1);
  const pctDiff = absDiff / base;
  const alert = absDiff > ALERT_THRESHOLD_LOTS && pctDiff > ALERT_THRESHOLD_PCT;
  return { key, finmind, twse, absDiff, pctDiff: +(pctDiff * 100).toFixed(2), alert };
}

export async function GET(req: NextRequest) {
  const params = Object.fromEntries(new URL(req.url).searchParams);
  const parsed = querySchema.safeParse(params);
  if (!parsed.success) return apiValidationError(parsed.error);

  const { symbol, date } = parsed.data;

  // 決定目標日期（預設：最近交易日）
  const targetDate = date ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());

  try {
    const [finmindRows, twseRow] = await Promise.all([
      getInstitutional(symbol, 30),
      fetchTWSEInstitutional(symbol, targetDate),
    ]);

    // 找 FinMind 中對應日期的那筆
    const fmRow = finmindRows.find(r => r.date === targetDate);

    if (!fmRow && !twseRow) {
      return apiOk({
        symbol,
        date: targetDate,
        status: 'no_data',
        message: '兩個資料源均無此日期資料（可能為假日或停牌）',
      });
    }

    if (!fmRow) {
      return apiOk({
        symbol,
        date: targetDate,
        status: 'finmind_missing',
        message: 'FinMind 無此日期資料，TWSE 有',
        twse: twseRow,
      });
    }

    if (!twseRow) {
      return apiOk({
        symbol,
        date: targetDate,
        status: 'twse_missing',
        message: 'TWSE 無此日期資料，FinMind 有',
        finmind: { foreignNet: fmRow.foreignNet, trustNet: fmRow.trustNet, dealerNet: fmRow.dealerNet, totalNet: fmRow.totalNet },
      });
    }

    const diffs = [
      diffRow('foreignNet', fmRow.foreignNet, twseRow.foreignNet),
      diffRow('trustNet',   fmRow.trustNet,   twseRow.trustNet),
      diffRow('dealerNet',  fmRow.dealerNet,  twseRow.dealerNet),
      diffRow('totalNet',   fmRow.totalNet,   twseRow.totalNet),
    ];

    const hasAlert = diffs.some(d => d.alert);

    return apiOk({
      symbol,
      date: targetDate,
      status: hasAlert ? 'mismatch' : 'ok',
      message: hasAlert
        ? `⚠️ 數據不一致（差異超過閾值 ${ALERT_THRESHOLD_LOTS} 張 / ${ALERT_THRESHOLD_PCT * 100}%）`
        : '✓ 數據一致',
      diffs,
      thresholds: {
        lots: ALERT_THRESHOLD_LOTS,
        pct: ALERT_THRESHOLD_PCT * 100,
      },
    });
  } catch (err) {
    return apiError(`驗證失敗：${(err as Error).message}`);
  }
}
