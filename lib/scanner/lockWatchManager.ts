/**
 * LockWatch 鎖股觀察名單管理（v12 Phase 1.6）
 *
 * 用於 F V 反轉 / N 型態確認的「**鎖股觀察 → 進場訊號**」兩段生命週期管理。
 *
 * 議題 23 / 65 / 93：
 * - F 觸發時還在空頭末段，趨勢確認需 5-10 天 → 走 LockWatch
 * - N 觸發時頸線 < 最近 pivot high，detectTrend 通常未翻多 → 走 LockWatch
 * - D / O / 多頭軌訊號 觸發即進場（不寫 LockWatch）
 *
 * 議題 49：每型態自實作結構失效判定
 * 議題 17：純書本不限期，由用戶手動移除（書本沒寫上限）
 * 議題 61：每日合併寫入 `data/lock-watch/{market}/{date}.json`
 * 議題 62：用戶買進 → currentStage='purchased' + 同步持倉
 *
 * 純書本邏輯：
 * - 結構失效（議題 49 各型態）→ 自動移除
 * - 趨勢翻空頭 → 撤銷
 * - close < triggerPrice → 撤銷
 * - 趨勢確認 + SOP 過 → 升級 entry-signal
 */

import type { CandleWithIndicators } from '../../types';

import { detectTrend } from '../analysis/trendAnalysis';
import { tradingDaysBetween } from '../utils/tradingDay';
import { evaluateMarketGate } from './marketTrendGate';
import type {
  LockWatchDailySnapshot,
  LockWatchEvent,
  LockWatchRecord,
} from './lockWatchTypes';
import type { MarketId } from './types';

/**
 * 觸發 N 訊號 → 寫入 LockWatch
 *
 * 2026-05-10 Phase C：依 close 跟頸線×1.03 比較決定初始 stage
 * - close < neckline×1.03 → 'pending-breakout'（結構成立等突破，即將突破清單）
 * - close ≥ neckline×1.03 → 'observation'（已突破，等趨勢確認）
 */
export function createLockWatchFromN(args: {
  symbol: string;
  market: MarketId;
  triggeredDate: string;
  patternType: NonNullable<LockWatchRecord['patternType']>;
  triggerPrice: number;  // 頸線價
  currentClose: number;  // 觸發當天 close（決定初始 stage）
  patternTargetPrice?: number;
  patternAchievementRate?: number;
}): LockWatchRecord {
  const breakoutThreshold = args.triggerPrice * 1.03;
  const initialStage: LockWatchRecord['currentStage'] =
    args.currentClose >= breakoutThreshold ? 'observation' : 'pending-breakout';
  const eventDetail = initialStage === 'pending-breakout'
    ? `N 結構成立（${args.patternType}）close=${args.currentClose.toFixed(2)} 等過 ${breakoutThreshold.toFixed(2)} 真突破`
    : `N 型態突破（${args.patternType}）close=${args.currentClose.toFixed(2)} ≥ ${breakoutThreshold.toFixed(2)}`;
  return {
    symbol: args.symbol,
    market: args.market,
    triggeredDate: args.triggeredDate,
    triggerSignal: 'N',
    patternType: args.patternType,
    triggerPrice: args.triggerPrice,
    patternTargetPrice: args.patternTargetPrice,
    patternAchievementRate: args.patternAchievementRate,
    currentStage: initialStage,
    daysObserved: 0,
    history: [
      {
        date: args.triggeredDate,
        event: 'triggered',
        detail: eventDetail,
      },
    ],
  };
}

/**
 * 觸發 F 訊號 → 寫入 LockWatch（observation 階段）
 */
export function createLockWatchFromF(args: {
  symbol: string;
  market: MarketId;
  triggeredDate: string;
  triggerPrice: number;  // V 底反彈起點 close（鎖定價）
  vBottom?: number;      // 變盤線 low（結構失效判定用，書本「V 底」）
}): LockWatchRecord {
  return {
    symbol: args.symbol,
    market: args.market,
    triggeredDate: args.triggeredDate,
    triggerSignal: 'F',
    triggerPrice: args.triggerPrice,
    vBottom: args.vBottom,
    currentStage: 'observation',
    daysObserved: 0,
    history: [
      {
        date: args.triggeredDate,
        event: 'triggered',
        detail: 'F V 反轉結構成立',
      },
    ],
  };
}

// ── 升級 / 撤銷邏輯 ───────────────────────────────────────────────────────

export interface LockWatchUpdateResult {
  /** 是否已狀態變化 */
  changed: boolean;
  /** 更新後的 record */
  record: LockWatchRecord;
}

/**
 * 每日 cron 維護觀察名單（議題 23）
 *
 * 對每個 record 檢查：
 * 1. 議題 94 撤銷三條件：
 *    - close < triggerPrice
 *    - detectTrend 翻空頭
 *    - 結構失效（議題 49）
 * 2. 議題 71 升級條件：
 *    - F：大盤多頭 + 個股趨勢確認 + SOP 過
 *    - N：個股趨勢確認 + SOP 過（大盤多頭 implicit 由 Step 0 處理）
 *
 * @param record 既有觀察名單
 * @param candles 該股票最新 K 線
 * @param indexCandles 大盤指數 K 線（用於 F 升級判定）
 * @param today ISO 日期
 */
export function updateLockWatch(
  record: LockWatchRecord,
  candles: ReadonlyArray<CandleWithIndicators>,
  indexCandles: ReadonlyArray<CandleWithIndicators>,
  today: string,
): LockWatchUpdateResult {
  // 跳過已結束的紀錄
  if (
    record.currentStage === 'revoked' ||
    record.currentStage === 'manually-removed' ||
    record.currentStage === 'structure-broken' ||
    record.currentStage === 'purchased'
  ) {
    return { changed: false, record };
  }

  if (candles.length === 0) {
    return { changed: false, record };
  }

  const lastIdx = candles.length - 1;
  const c = candles[lastIdx];
  // daysObserved 用交易日計（書本「停留 N 天」一律指交易日；calendar days 會被週末/假日污染）
  const newDaysObserved = tradingDaysBetween(record.triggeredDate, today, record.market);
  const updatedRecord: LockWatchRecord = {
    ...record,
    daysObserved: Math.max(0, newDaysObserved),
    history: [...record.history],
  };

  // ── 0. pending-breakout 升級條件（2026-05-10 Phase C 新增）──
  // close 過頸線×1.03 真突破 → 升級 observation；未過 → 維持 pending-breakout
  // 注意：pending-breakout 階段 close < triggerPrice 是正常的（結構成立等突破），
  // 跳過下方「close < triggerPrice 撤銷」邏輯避免誤撤銷
  if (record.currentStage === 'pending-breakout') {
    const breakoutThreshold = record.triggerPrice * 1.03;
    if (c.close >= breakoutThreshold) {
      updatedRecord.currentStage = 'observation';
      addEvent(updatedRecord, today, 'breakout-confirmed', `close=${c.close.toFixed(2)} ≥ ${breakoutThreshold.toFixed(2)} 真突破`);
      return { changed: true, record: updatedRecord };
    }
    // 還沒突破，繼續觀察
    return { changed: false, record: updatedRecord };
  }

  // ── 1. 撤銷條件：close < triggerPrice ──
  // F 訊號的 triggerPrice 是 rebound close（鎖定價），不是 V 底；不該因 close 跌破鎖定價就撤銷
  // F 的結構失效已由 checkStructureBroken（用 vBottom 判 low）處理
  if (record.triggerSignal !== 'F' && c.close < record.triggerPrice) {
    updatedRecord.currentStage = 'revoked';
    addEvent(updatedRecord, today, 'provisional-revoke', `close=${c.close.toFixed(2)} < triggerPrice=${record.triggerPrice.toFixed(2)}`);
    return { changed: true, record: updatedRecord };
  }

  // ── 2. 撤銷條件：detectTrend 翻空頭 ──
  const stockTrend = detectTrend(candles as CandleWithIndicators[], lastIdx);
  if (stockTrend === '空頭') {
    updatedRecord.currentStage = 'revoked';
    addEvent(updatedRecord, today, 'provisional-revoke', '個股 detectTrend 翻空頭');
    return { changed: true, record: updatedRecord };
  }

  // ── 3. 升級條件：個股趨勢確認 + 進場 SOP 過 ──
  // 個股趨勢確認 = detectTrend = 多頭
  if (stockTrend !== '多頭') {
    return { changed: false, record: updatedRecord };
  }

  // F 升級需要大盤多頭過 Step 0
  if (record.triggerSignal === 'F') {
    const marketGate = evaluateMarketGate(indexCandles);
    if (!marketGate.passed) {
      // 個股已多頭但大盤未過 Step 0 → 維持 observation
      return { changed: false, record: updatedRecord };
    }
  }

  // 升級為 entry-signal
  if (record.currentStage === 'observation') {
    updatedRecord.currentStage = 'entry-signal';
    addEvent(updatedRecord, today, 'trend-confirmed', '個股翻多 + 大盤多頭，可考慮進場');
    return { changed: true, record: updatedRecord };
  }

  return { changed: false, record: updatedRecord };
}

/**
 * 用戶手動移除（議題 17）
 */
export function removeLockWatchManually(
  record: LockWatchRecord,
  today: string,
  reason?: string,
): LockWatchRecord {
  const updated: LockWatchRecord = {
    ...record,
    currentStage: 'manually-removed',
    history: [...record.history],
  };
  addEvent(updated, today, 'manual-remove', reason);
  return updated;
}

/**
 * 用戶買進事件（議題 62）— 同步寫入持倉 watchlist
 */
export function markLockWatchPurchased(
  record: LockWatchRecord,
  today: string,
  entryPrice: number,
): LockWatchRecord {
  const updated: LockWatchRecord = {
    ...record,
    currentStage: 'purchased',
    history: [...record.history],
  };
  addEvent(updated, today, 'purchased', `entryPrice=${entryPrice.toFixed(2)}`);
  return updated;
}

// ── 結構失效判定（議題 49 各型態自實作）──────────────────────────────────

/**
 * 結構失效判定 — 各型態自實作（議題 49）
 *
 * @returns 是否結構失效
 */
export function checkStructureBroken(
  record: LockWatchRecord,
  candles: ReadonlyArray<CandleWithIndicators>,
): { broken: boolean; reason?: string } {
  if (candles.length === 0) return { broken: false };
  const c = candles[candles.length - 1];

  if (record.triggerSignal === 'F') {
    // F V 反轉：跌破真正 V 底（變盤線 low）→ 結構失效
    // vBottom 是實際 V 底（lockWatchProducer 從 vReversalDetector.stopBarLow 抽取）
    // triggerPrice 是 rebound close，比 vBottom 高得多，不可用來判結構失效
    const vBottom = record.vBottom ?? record.triggerPrice;  // 舊資料 fallback（可能 false positive）
    if (c.low < vBottom) {
      return { broken: true, reason: 'F 跌破 V 底' };
    }
  }

  if (record.triggerSignal === 'N') {
    // N 各型態：用 patternType 對應的「結構失效點」（記錄在 meta，但 LockWatchRecord 沒存）
    // 簡化版：跌破 triggerPrice（頸線價）即失效
    if (c.close < record.triggerPrice * 0.97) {
      return { broken: true, reason: 'N 跌破型態關鍵支撐（< 頸線 -3%）' };
    }
  }

  return { broken: false };
}

/**
 * 標記結構失效自動移除
 */
export function markStructureBroken(
  record: LockWatchRecord,
  today: string,
  reason: string,
): LockWatchRecord {
  const updated: LockWatchRecord = {
    ...record,
    currentStage: 'structure-broken',
    history: [...record.history],
  };
  addEvent(updated, today, 'structure-broken', reason);
  return updated;
}

// ── 內部 helper ──────────────────────────────────────────────────────────

function addEvent(
  record: LockWatchRecord,
  date: string,
  event: LockWatchEvent['event'],
  detail?: string,
): void {
  record.history.push({ date, event, detail });
}

// ── 持久化 helpers（議題 61：單檔合併寫入）─────────────────────────────────

/**
 * 建立每日快照（純函數，不 I/O）
 */
export function createDailySnapshot(
  market: MarketId,
  date: string,
  records: LockWatchRecord[],
): LockWatchDailySnapshot {
  return {
    market,
    date,
    records,
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * 篩選 active records（過濾掉已結束的）
 */
export function filterActiveRecords(records: LockWatchRecord[]): LockWatchRecord[] {
  return records.filter(r =>
    r.currentStage === 'observation' || r.currentStage === 'entry-signal',
  );
}
