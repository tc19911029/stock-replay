/**
 * Cron: 每日抓 CN 主力資金（EastMoney）
 *
 * 排程：每日 16:00 CST（CN 收盤 15:00 + 1 小時 buffer）
 *   `0 8 * * 1-5` (UTC)
 *
 * 抓取範圍：
 *   - 持倉 CN 股票
 *   - 自選股 CN 股票
 *   - 已經有 L1 chips 紀錄的 CN 股票（持續累積）
 */

import { NextRequest } from 'next/server';
import { apiOk } from '@/lib/api/response';
import { fetchCnMainFlow } from '@/lib/datasource/EastMoneyChips';
import { writeCnFlowStock, readCnFlowStock } from '@/lib/chips/ChipStorage';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { promises as fs } from 'fs';
import path from 'path';
import { checkCronAuth } from '@/lib/api/cronAuth';

export const runtime = 'nodejs';
export const maxDuration = 120;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function listExistingCnFlowCodes(): Promise<string[]> {
  try {
    const dir = path.join(process.cwd(), 'data', 'chips', 'CN', 'flow');
    const files = await fs.readdir(dir);
    return files.filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
  } catch {
    return [];
  }
}

export async function GET(req: NextRequest) {
  const authDenied = checkCronAuth(req);
  if (authDenied) return authDenied;

  const dateParam = req.nextUrl.searchParams.get('date');
  const date = dateParam ?? getLastTradingDay('CN');
  if (!isTradingDay(date, 'CN')) {
    return apiOk({ skipped: true, reason: 'non-trading day', date });
  }

  // 從 query param 或 L1 既存清單抓
  const symbolsParam = req.nextUrl.searchParams.get('symbols');
  let codes: string[] = [];
  if (symbolsParam) {
    codes = symbolsParam.split(',').map(s => s.trim().replace(/\.(SS|SZ)$/i, ''));
  } else {
    codes = await listExistingCnFlowCodes();
  }

  if (codes.length === 0) {
    return apiOk({ date, action: 'no_codes', message: '尚無已追蹤的 CN 股票，請先在自選股或走圖開過一次' });
  }

  let ok = 0, skip = 0, fail = 0;
  for (const code of codes) {
    const existing = await readCnFlowStock(code);
    if (existing?.lastDate === date) { skip++; continue; }
    try {
      const fetched = await fetchCnMainFlow(code, 5); // 只要最新 1 天，給 5 防失漏
      const todayRow = fetched.get(date);
      if (todayRow) {
        await writeCnFlowStock(code, [{ date, ...todayRow }]);
        ok++;
      } else {
        fail++;
      }
      await sleep(300); // EastMoney rate-limit polite
    } catch (err) {
      fail++;
      if (err instanceof Error && /Empty reply|HTTP 5/i.test(err.message)) {
        // 連續 server error 就停
        await sleep(2000);
      }
    }
  }

  return apiOk({ date, totalCodes: codes.length, ok, skip, fail });
}
