import { useMemo } from 'react';
import type { CandleWithIndicators } from '@/types';
import { aggregateCandles } from '@/lib/datasource/aggregateCandles';
import { computeIndicators } from '@/lib/indicators';
import { findAnchorIndex, MINUTE_INTERVALS, type ScanInterval, type AnchorResult } from '@/lib/datasource/findAnchorIndex';

interface ScanTimeframeResult {
  /** 聚合後含指標的 K 棒（日K 時 = 原始 allCandles） */
  displayCandles: CandleWithIndicators[];
  /** 訊號日對應 K 棒的 index（null = 找不到） */
  anchorIndex: number | null;
  /** 訊號日對應 K 棒的 date 字串 */
  anchorDate: string | null;
  /** 顯示用的對應關係標籤 */
  signalDateLabel: string | null;
}

const INTERVAL_LABEL: Record<string, string> = {
  '1d': '日K',
  '1wk': '週K',
  '1mo': '月K',
};

/**
 * 根據選擇的週期聚合日K、計算指標、定位訊號日
 */
export function useScanTimeframe(
  dailyCandles: CandleWithIndicators[],
  signalDate: string | undefined,
  interval: ScanInterval,
): ScanTimeframeResult {
  return useMemo(() => {
    if (dailyCandles.length === 0) {
      return { displayCandles: [], anchorIndex: null, anchorDate: null, signalDateLabel: null };
    }

    // 分鐘K：API 已回傳對應週期的數據，直接透傳不聚合
    if ((MINUTE_INTERVALS as readonly string[]).includes(interval)) {
      return { displayCandles: dailyCandles, anchorIndex: null, anchorDate: null, signalDateLabel: null };
    }

    // 看歷史 scan 時切片：只顯示到 signalDate 為止的 K，避免「scan panel 是 04/27 但圖跑到今天」的時間錯亂
    // 切片在「聚合前」做：只切 dailyCandles，再聚合，才不會讓最後一根週/月K 被未來日污染
    const slicedDaily = signalDate
      ? dailyCandles.filter(c => c.date.slice(0, 10) <= signalDate)
      : dailyCandles;

    let displayCandles: CandleWithIndicators[];
    if (interval === '1d') {
      displayCandles = slicedDaily;
    } else {
      const rawAggregated = aggregateCandles(slicedDaily, interval);
      displayCandles = computeIndicators(rawAggregated);
    }

    if (!signalDate) {
      return { displayCandles, anchorIndex: null, anchorDate: null, signalDateLabel: null };
    }

    const anchor: AnchorResult | null = findAnchorIndex(
      displayCandles, dailyCandles, signalDate, interval,
    );

    if (!anchor) {
      return { displayCandles, anchorIndex: null, anchorDate: null, signalDateLabel: null };
    }

    const fmtSignal = signalDate.replace(/-/g, '/');
    const label = interval === '1d'
      ? `訊號日：${fmtSignal}`
      : `訊號日：${fmtSignal} → 對應${INTERVAL_LABEL[interval]}：${anchor.rangeLabel}`;

    return {
      displayCandles,
      anchorIndex: anchor.index,
      anchorDate: anchor.anchorDate,
      signalDateLabel: label,
    };
  }, [dailyCandles, signalDate, interval]);
}
