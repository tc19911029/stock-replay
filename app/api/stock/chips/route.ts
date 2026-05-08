/**
 * GET /api/stock/chips?symbol=2330.TW&days=120
 *
 * 走圖籌碼面 API（lazy fetch + L1 cache）
 *
 * TW 流程：FinMind 三大法人 + TDCC 大戶持股
 * CN 流程：EastMoney 主力資金（超大單/大單/中單/小單）
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import {
  loadChipSeries, readInstStock, writeInstStock,
  readCnFlowStock, writeCnFlowStock,
} from '@/lib/chips/ChipStorage';
import { fetchT86ForStock } from '@/lib/datasource/TwseT86Provider';
import { fetchCnMainFlow } from '@/lib/datasource/EastMoneyChips';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { detectChipDivergence } from '@/lib/analysis/chipDivergence';
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';

export const runtime = 'nodejs';

const schema = z.object({
  symbol: z.string().min(1),
  days: z.coerce.number().int().min(10).max(500).optional().default(120),
});

function dateMinusDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function classifyMarket(symbol: string): 'TW' | 'CN' | null {
  if (/\.(SS|SZ)$/i.test(symbol)) return 'CN';
  if (/\.(TW|TWO)$/i.test(symbol)) return 'TW';
  if (/^\d{6}$/.test(symbol)) {
    // 6 位純數字：6/9 開頭 = 上海，0/3 開頭 = 深圳
    return /^[069]/.test(symbol) ? 'CN' : 'TW';
  }
  if (/^\d{4,5}$/.test(symbol)) return 'TW';
  return null;
}

export async function GET(req: NextRequest) {
  const parsed = schema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return apiValidationError(parsed.error);
  const { symbol, days } = parsed.data;

  const market = classifyMarket(symbol);
  if (!market) return apiOk({ symbol, inst: [], tdcc: [], note: '無法判斷市場' });

  const code = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
  // 2026-05-07：cnSecid bug 第 7 處 — suffix 必須傳給 fetchCnMainFlow
  // 否則 000001.SS 走 EastMoney 預設 0.000001 → 拿到平安銀行籌碼，不是上證指數
  const cnSuffix = /\.SS$/i.test(symbol) ? 'SS' : /\.SZ$/i.test(symbol) ? 'SZ' : undefined;
  const targetDate = getLastTradingDay(market);

  try {
    if (market === 'CN') {
      // ── CN 主力資金（lazy fetch + L1） ──
      const existing = await readCnFlowStock(code);
      const needsRefresh = !existing || existing.lastDate < targetDate;
      if (needsRefresh) {
        try {
          // EastMoney 直接抓最近 200 天，不分增量（API 一次回完）
          const fetched = await fetchCnMainFlow(code, 200, cnSuffix);
          if (fetched.size > 0) {
            const rows = Array.from(fetched.entries()).map(([date, v]) => ({ date, ...v }));
            await writeCnFlowStock(code, rows);
          }
        } catch (err) {
          console.warn(`[chips] EastMoney CN flow ${code} 失敗:`, err instanceof Error ? err.message : err);
          // 2026-05-08：原本第一次 fetch fail 就回 500 → 前端顯示「載入失敗」
          // 改 graceful：回空 series + note 標記，前端可以顯示「暫無資料」而不是 error
          if (!existing) return apiOk({ inst: [], tdcc: [], cnFlow: [], note: 'CN 籌碼來源暫時無回應，稍後重試' });
        }
      }
      const series = await loadChipSeries(code, days, 'CN');
      return apiOk(series);
    }

    // ── TW 三大法人（FinMind） ──
    const existing = await readInstStock(code);
    const needsRefresh = !existing || existing.lastDate < targetDate;
    if (needsRefresh) {
      const fetchStart = existing?.lastDate
        ? dateMinusDays(existing.lastDate, -1)
        : dateMinusDays(targetDate, 200);
      try {
        const fetched = await fetchT86ForStock(code, fetchStart, targetDate);
        if (fetched.size > 0) {
          const newRows = Array.from(fetched.entries()).map(([date, v]) => ({ date, ...v }));
          await writeInstStock(code, newRows);
        }
      } catch (err) {
        console.warn(`[chips] FinMind ${code} 失敗:`, err instanceof Error ? err.message : err);
        // 2026-05-08：FinMind rate limit / timeout 時 graceful 回空 series 而不是 500
        if (!existing) return apiOk({ inst: [], tdcc: [], note: 'TW 籌碼來源暫時無回應，稍後重試' });
      }
    }
    const series = await loadChipSeries(code, days, 'TW');

    // 籌碼背離偵測（TW 才有）
    let divergence = null;
    try {
      const candleFile = await readCandleFile(`${code}.TW`, 'TW') ?? await readCandleFile(`${code}.TWO`, 'TW');
      if (candleFile?.candles) {
        const recentCandles = candleFile.candles.slice(-30).map(c => ({ date: c.date, close: c.close }));
        const recentInst = series.inst.slice(-30);
        const div = detectChipDivergence(recentCandles, recentInst, 5, 3, 500);
        if (div.type) divergence = div;
      }
    } catch { /* divergence 失敗不影響主流程 */ }

    return apiOk({ ...series, divergence });
  } catch (err) {
    console.error('[chips] error:', err);
    return apiError('籌碼資料讀取失敗');
  }
}
