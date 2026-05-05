/**
 * GET /api/etf/changes?etfCode=00981A&toDate=YYYY-MM-DD
 *
 * 回傳 ETF 持股異動。單一 ETF 一律從快照即時計算（永遠用最新 holdingsDiff 邏輯，
 * 避免舊 stored ETFChange 檔帶過時 diff 邏輯）。
 *   - etfCode + toDate → 從 toDate 快照 + 前一筆快照即時 diff
 *   - 只給 etfCode → 找最近有差異的日期即時 diff
 *   - 都不給 → 讀全 ETF 預存（全部模式，多 ETF 同一天）
 *   - availableDates → 快照可用日期（供前端建日期選擇器）
 */
import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { ACTIVE_ETF_LIST } from '@/lib/etf/etfList';
import {
  loadAllChangesForDate,
  listChangeDates,
  loadETFSnapshot,
  listSnapshotDates,
} from '@/lib/etf/etfStorage';
import { computeETFChange } from '@/lib/etf/holdingsDiff';
import type { ETFChange } from '@/lib/etf/types';

export const runtime = 'nodejs';

/** 從 availableDates 找 toDate 的前一筆快照，即時計算 diff */
async function computeLiveDiff(
  etfCode: string,
  snapDates: string[],
  toDate: string,
): Promise<{ change: ETFChange; fromDate: string } | null> {
  const toIdx = snapDates.indexOf(toDate);
  if (toIdx < 0 || toIdx >= snapDates.length - 1) return null;
  const fromDate = snapDates[toIdx + 1];
  const [prior, current] = await Promise.all([
    loadETFSnapshot(etfCode, fromDate),
    loadETFSnapshot(etfCode, toDate),
  ]);
  if (!prior || !current) return null;
  return { change: computeETFChange(prior, current), fromDate };
}

export async function GET(req: NextRequest) {
  try {
    const p = req.nextUrl.searchParams;
    const etfCode = p.get('etfCode');
    const toDate  = p.get('toDate') ?? p.get('date');

    const allCodes = ACTIVE_ETF_LIST.map((e) => e.etfCode);

    // ── availableDates：快照日期，供前端建 picker ──────────────────────
    let availableDates: string[] = [];
    if (etfCode) {
      availableDates = await listSnapshotDates(etfCode);
    }

    // ── 單一 ETF：一律即時從快照 diff（不讀舊 stored ETFChange 檔） ─────
    if (etfCode) {
      let targetDate = toDate;

      if (!targetDate) {
        // 找最近一個有實際異動的日期（跳過非交易日空快照）
        for (const d of availableDates) {
          const result = await computeLiveDiff(etfCode, availableDates, d);
          if (result && (
            result.change.newEntries.length + result.change.exits.length +
            result.change.increased.length + result.change.decreased.length > 0
          )) {
            targetDate = d;
            break;
          }
        }
        targetDate = targetDate ?? availableDates[0] ?? null;
      }

      if (!targetDate) {
        return apiOk({ date: null, changes: [], availableDates, message: '尚無快照資料' });
      }

      const result = await computeLiveDiff(etfCode, availableDates, targetDate);
      if (!result) {
        return apiOk({ date: targetDate, changes: [], availableDates, message: '快照資料不足（需要前一筆快照）' });
      }
      return apiOk({ date: targetDate, fromDate: result.fromDate, toDate: targetDate, changes: [result.change], availableDates });
    }

    // ── 全部模式（無 etfCode）：讀預存 ETFChange ──────────────────────
    const allDates = new Set<string>();
    for (const code of allCodes) {
      for (const d of (await listChangeDates(code)).slice(0, 1)) allDates.add(d);
    }
    const date = Array.from(allDates).sort().reverse()[0] ?? null;

    if (!date) {
      return apiOk({ date: null, changes: [], availableDates, message: '尚無持股異動資料' });
    }

    const changes: ETFChange[] = await loadAllChangesForDate(date, allCodes);
    return apiOk({ date, changes, availableDates });
  } catch (err) {
    console.error('[etf/changes] error:', err);
    return apiError('ETF 持股異動查詢暫時無法使用');
  }
}
