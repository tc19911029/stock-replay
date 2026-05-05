/**
 * Cron：每日抓 11 檔主動式 ETF 持股、計算 diff、建立 tracking entries、產出共識榜
 *
 * 排程：週一至五 18:00 CST（10:00 UTC）
 * 手動觸發：?force=true&date=YYYY-MM-DD&allowStub=true
 */
import { NextRequest } from 'next/server';
import { apiOk } from '@/lib/api/response';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { loadLocalCandles } from '@/lib/datasource/LocalCandleStore';
import { ACTIVE_ETF_LIST } from '@/lib/etf/etfList';
import { fetchHoldings } from '@/lib/etf/holdingsSource';
import {
  saveETFSnapshot,
  loadETFSnapshot,
  loadLatestETFSnapshot,
  saveETFChange,
  loadAllChangesForDate,
  saveTrackingEntry,
  loadTrackingEntry,
  saveConsensus,
} from '@/lib/etf/etfStorage';
import { computeETFChange } from '@/lib/etf/holdingsDiff';
import { computeConsensus } from '@/lib/etf/consensusCalc';
import type { ETFSnapshot, ETFChange, ETFTrackingEntry, ETFListItem, ETFHoldingDelta, ETFHolding } from '@/lib/etf/types';
import { checkCronAuth } from '@/lib/api/cronAuth';

/**
 * 內容簽章：用於判定既存 snapshot 是否與本次抓到的內容一致。
 * 若一致就略過寫入（避免無謂 IO）；不同就覆寫（盤後完整版蓋過凌晨舊版）。
 */
function holdingsSignature(holdings: ETFHolding[]): string {
  return holdings
    .map((h) => `${h.symbol}:${h.shares ?? 0}:${h.weight.toFixed(4)}`)
    .sort()
    .join('|');
}

export const runtime = 'nodejs';
export const maxDuration = 120;

interface CronSummary {
  date: string;
  newSnapshots: number;
  updatedDiffs: number;
  newTrackingEntries: number;
  consensusCount: number;
  errors: string[];
}

export async function GET(req: NextRequest) {
  const authDenied = checkCronAuth(req);
  if (authDenied) return authDenied;

  const dateParam = req.nextUrl.searchParams.get('date');
  const force = req.nextUrl.searchParams.get('force') === 'true';
  const allowStub = req.nextUrl.searchParams.get('allowStub') === 'true';

  const date = dateParam ?? getLastTradingDay('TW');
  if (!isTradingDay(date, 'TW') && !force) {
    return apiOk({ skipped: true, reason: 'non-trading day', date });
  }

  const summary: CronSummary = {
    date,
    newSnapshots: 0,
    updatedDiffs: 0,
    newTrackingEntries: 0,
    consensusCount: 0,
    errors: [],
  };

  // 1) 對每檔 ETF 抓持股
  // 收集每檔實際使用的「資料日」(actualDate) → 後面共識榜以實際揭露日為準。
  const actualDates = new Set<string>();
  for (const etf of ACTIVE_ETF_LIST) {
    try {
      const result = await fetchHoldings(etf, date, { allowStub });
      if (!result) {
        summary.errors.push(`${etf.etfCode}: no source available`);
        continue;
      }

      // 用資料源實際揭露日（CMoney row[0]）為儲存 key；fallback：cron date。
      // 修正凌晨抓到舊資料卻 label 成今天的 mislabel bug。
      const actualDate = result.disclosureDate ?? date;
      actualDates.add(actualDate);

      const existing = await loadETFSnapshot(etf.etfCode, actualDate);
      // 既存 snapshot 內容簽章相同 → 略過寫入（盤後完整版 vs 凌晨舊版會內容不同 → 覆寫）。
      // force=true 仍強制覆寫（用於手動修復 / 重抓除錯）。
      if (
        existing &&
        !force &&
        holdingsSignature(existing.holdings) === holdingsSignature(result.holdings)
      ) {
        continue;
      }

      const snap: ETFSnapshot = {
        etfCode: etf.etfCode,
        etfName: etf.etfName,
        disclosureDate: actualDate,
        fetchedAt: new Date().toISOString(),
        holdings: result.holdings,
        source: result.source,
      };
      await saveETFSnapshot(snap);
      summary.newSnapshots++;

      // 2) 比對前一期 → 產生 ETFChange
      const prior = await loadPriorSnapshot(etf.etfCode, actualDate);
      if (!prior) continue;

      const change = computeETFChange(prior, snap);
      await saveETFChange(change);
      summary.updatedDiffs++;

      // 3) 對 newEntries + increased 建立 tracking entries
      const created = await createTrackingEntries(etf, change, actualDate);
      summary.newTrackingEntries += created;
    } catch (err) {
      summary.errors.push(
        `${etf.etfCode}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 4) 共識榜（取每個實際揭露日所有 ETFChange）
  // 通常一次 cron 只會有一個 actualDate；極少數情境（部分 ETF CMoney 有 0505、部分還只到 0504）
  // 會跨日，分開計算各自共識。
  try {
    for (const actualDate of actualDates) {
      const todaysChanges = await loadAllChangesForDate(
        actualDate,
        ACTIVE_ETF_LIST.map((e) => e.etfCode),
      );
      const consensus = computeConsensus(todaysChanges, 2);
      await saveConsensus(actualDate, consensus);
      summary.consensusCount += consensus.length;
    }
  } catch (err) {
    summary.errors.push(`consensus: ${err instanceof Error ? err.message : String(err)}`);
  }

  return apiOk(summary);
}

// ── helpers ──────────────────────────────────────────────────

async function loadPriorSnapshot(
  etfCode: string,
  beforeDate: string,
): Promise<ETFSnapshot | null> {
  const latest = await loadLatestETFSnapshot(etfCode);
  if (!latest || latest.disclosureDate >= beforeDate) {
    // 跳過自己 / 未來，回退到前一個
    const { listSnapshotDates, loadETFSnapshot } = await import('@/lib/etf/etfStorage');
    const dates = await listSnapshotDates(etfCode);
    const prior = dates.find((d) => d < beforeDate);
    return prior ? loadETFSnapshot(etfCode, prior) : null;
  }
  return latest;
}

async function createTrackingEntries(
  etf: ETFListItem,
  change: ETFChange,
  date: string,
): Promise<number> {
  let created = 0;

  type Action = { holding: ETFHolding | ETFHoldingDelta; type: 'new' | 'increased' };
  const actions: Action[] = [
    ...change.newEntries.map((h) => ({ holding: h, type: 'new' as const })),
    ...change.increased.map((h) => ({ holding: h, type: 'increased' as const })),
  ];

  for (const { holding, type } of actions) {
    const existing = await loadTrackingEntry(etf.etfCode, holding.symbol, date);
    if (existing) continue;

    // 美股持股（純字母 symbol）目前 L1 只存台股 / 陸股，跳過建立 tracking entry
    // 否則 priceAtAdd=0 會讓 forward perf 欄全部錯亂。未來若支援美股 L1 再開放。
    if (!/^\d{4,6}[A-Z]?$/.test(holding.symbol)) continue;

    const candles = await loadLocalCandles(`${holding.symbol}.TW`, 'TW');
    let priceAtAdd = 0;
    if (candles && candles.length > 0) {
      // 用 ≤ date 的最後一根 close
      const onOrBefore = [...candles].reverse().find((c) => c.date <= date);
      priceAtAdd = onOrBefore?.close ?? candles[candles.length - 1].close;
    }

    const entry: ETFTrackingEntry = {
      etfCode: etf.etfCode,
      etfName: etf.etfName,
      symbol: holding.symbol,
      stockName: holding.name,
      addedDate: date,
      changeType: type,
      addedWeight: holding.weight,
      priceAtAdd,
      d1Return: null,
      d3Return: null,
      d5Return: null,
      d10Return: null,
      d20Return: null,
      maxGain: null,
      maxDrawdown: null,
      lastUpdated: new Date().toISOString(),
      windowClosed: false,
    };
    await saveTrackingEntry(entry);
    created++;
  }
  return created;
}
