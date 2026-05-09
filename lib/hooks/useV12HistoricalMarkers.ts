/**
 * 走圖歷史 v12 markers hook
 *
 * 對 allCandles 後 90 根跑 M/N/O/P/Q/F 6 個 detector，產生 ChartSignalMarker[]
 * 用戶看到圖上 N 型態 / Q 三均線 / F V反轉 等 v12 訊號的歷史觸發日標記
 */
import { useEffect, useState } from 'react';
import type { CandleWithIndicators, ChartSignalMarker } from '@/types';
import type { MarketId } from '@/lib/scanner/types';

interface V12Marker extends ChartSignalMarker {
  letter: string;
}

const LOOKBACK = 90;

/**
 * 對最近 N 根 K 棒跑 v12 detector，找觸發日
 */
export function useV12HistoricalMarkers(
  candles: CandleWithIndicators[],
  ticker: string,
  enabled: boolean = true,
): V12Marker[] {
  const [markers, setMarkers] = useState<V12Marker[]>([]);

  useEffect(() => {
    if (!enabled || candles.length < 30 || !ticker) {
      setMarkers([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const market: MarketId = /\.(SS|SZ)$/i.test(ticker) ? 'CN' : 'TW';
      try {
        const [
          { detectLetterM },
          { detectLetterN },
          { detectLetterO },
          { detectLetterP },
          { detectLetterQ },
          { detectVReversal },
        ] = await Promise.all([
          import('@/lib/analysis/v12LetterM'),
          import('@/lib/analysis/v12LetterN'),
          import('@/lib/analysis/v12LetterO'),
          import('@/lib/analysis/v12LetterP'),
          import('@/lib/analysis/v12LetterQ'),
          import('@/lib/analysis/vReversalDetector'),
        ]);
        const result: V12Marker[] = [];
        const startIdx = Math.max(25, candles.length - LOOKBACK);
        for (let i = startIdx; i < candles.length; i++) {
          const date = candles[i]?.date;
          if (!date) continue;
          // 各 letter 觸發 → 加 marker（同日多訊號一起累進 strength）
          const m = detectLetterM(candles, i, market, ticker);
          if (m.triggered) result.push({ date, type: 'BUY', label: 'M', strength: 1, letter: 'M' });
          const n = detectLetterN(candles, i, market, ticker);
          if (n.triggered) result.push({ date, type: 'BUY', label: 'N', strength: 2, letter: 'N' });
          const o = detectLetterO(candles, i, market, ticker);
          if (o.triggered) result.push({ date, type: 'BUY', label: 'O', strength: 1, letter: 'O' });
          const p = detectLetterP(candles, i, market, ticker);
          if (p.triggered) result.push({ date, type: 'BUY', label: 'P', strength: 1, letter: 'P' });
          const q = detectLetterQ(candles, i, market, ticker);
          if (q.triggered) result.push({ date, type: 'BUY', label: 'Q', strength: 1, letter: 'Q' });
          const f = detectVReversal(candles, i);
          if (f?.isVReversal) result.push({ date, type: 'BUY', label: 'F', strength: 2, letter: 'F' });
        }
        if (!cancelled) setMarkers(result);
      } catch (err) {
        if (!cancelled) {
          console.error('[useV12HistoricalMarkers]', err);
          setMarkers([]);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [candles, ticker, enabled]);

  return markers;
}
