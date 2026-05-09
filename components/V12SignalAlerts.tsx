'use client';

/**
 * v12 訊號 alerts — 走圖頁顯示當前股票的 v12 detector 命中
 *
 * 顯示：
 * - 進場類：N 型態 / Q 三均線 / M 軌道線 / P 高檔拉回 / O 打底完成
 * - 已建立 lockWatchPayload 的 N/F 顯示頸線/目標
 *
 * 不重新跑全部 detector — 透過 /api/scanner/buy-method 或直接呼叫不適合（要重 fetch L1）
 * 改用 useReplayStore 既有的 currentCandles + 動態 import detector。
 */

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useReplayStore } from '@/store/replayStore';

interface V12Hit {
  letter: 'M' | 'N' | 'O' | 'P' | 'Q';
  trackName: string;
  detail: string;
  // For N
  patternType?: string;
  patternTargetPrice?: number;
  achievementRate?: number;
  necklinePrice?: number;
}

const TRACK_COLOR: Record<string, string> = {
  M: 'bg-red-700/70 text-red-100',  // 多頭軌
  N: 'bg-blue-700/70 text-blue-100',  // 轉折軌
  O: 'bg-blue-700/70 text-blue-100',
  P: 'bg-red-700/70 text-red-100',
  Q: 'bg-purple-700/70 text-purple-100',  // 戰法軌
};

const TRACK_NAMES: Record<string, string> = {
  M: '多頭軌·軌道線突破',
  N: '轉折軌·型態確認',
  O: '轉折軌·打底完成',
  P: '多頭軌·高檔拉回',
  Q: '戰法軌·三均線',
};

const PATTERN_LABEL: Record<string, string> = {
  'head-shoulder': '頭肩底', 'complex-head-shoulder': '複式頭肩底',
  'triple-bottom': '三重底', 'falling-diamond': '跌菱形',
  'rounding-bottom': '圓弧底', 'descending-wedge': '下降楔形',
  'double-bottom': '雙重底',
};

export default function V12SignalAlerts() {
  const { allCandles, currentIndex, currentStock } = useReplayStore();
  const [hits, setHits] = useState<V12Hit[]>([]);
  const [loading, setLoading] = useState(false);

  const candleCount = allCandles.length;
  const ticker = currentStock?.ticker ?? '';
  const market: 'TW' | 'CN' = useMemo(() => /\.(SS|SZ)$/i.test(ticker) ? 'CN' : 'TW', [ticker]);

  const detect = useCallback(async () => {
    if (!ticker || candleCount < 30 || currentIndex < 25) {
      setHits([]);
      return;
    }
    setLoading(true);
    const results: V12Hit[] = [];
    try {
      // 載入所有 v12 detectors 並執行
      const [{ detectLetterM }, { detectLetterN }, { detectLetterO }, { detectLetterP }, { detectLetterQ }] = await Promise.all([
        import('@/lib/analysis/v12LetterM'),
        import('@/lib/analysis/v12LetterN'),
        import('@/lib/analysis/v12LetterO'),
        import('@/lib/analysis/v12LetterP'),
        import('@/lib/analysis/v12LetterQ'),
      ]);
      const m = detectLetterM(allCandles, currentIndex, market, ticker);
      const n = detectLetterN(allCandles, currentIndex, market, ticker);
      const o = detectLetterO(allCandles, currentIndex, market, ticker);
      const p = detectLetterP(allCandles, currentIndex, market, ticker);
      const q = detectLetterQ(allCandles, currentIndex, market, ticker);
      if (m.triggered) results.push({ letter: 'M', trackName: TRACK_NAMES.M, detail: m.detail });
      if (n.triggered && n.patternType) {
        results.push({
          letter: 'N',
          trackName: TRACK_NAMES.N,
          detail: n.detail,
          patternType: n.patternType,
          patternTargetPrice: n.patternTargetPrice,
          achievementRate: n.achievementRate ? n.achievementRate / 100 : undefined,
          necklinePrice: n.necklinePrice,
        });
      }
      if (o.triggered) results.push({ letter: 'O', trackName: TRACK_NAMES.O, detail: o.detail });
      if (p.triggered) results.push({ letter: 'P', trackName: TRACK_NAMES.P, detail: p.detail });
      if (q.triggered) results.push({ letter: 'Q', trackName: TRACK_NAMES.Q, detail: q.detail });
    } catch (err) {
      console.error('[V12SignalAlerts]', err);
    } finally {
      setHits(results);
      setLoading(false);
    }
  }, [ticker, market, allCandles, currentIndex, candleCount]);

  useEffect(() => {
    detect();
  }, [detect]);

  if (!ticker || candleCount < 30) return null;

  const todayPrice = allCandles[currentIndex]?.close ?? 0;

  return (
    <div className="bg-card border border-border rounded-lg p-2">
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className="text-[9px] font-bold uppercase tracking-wider opacity-70">v12</span>
        <h3 className="text-xs font-bold text-foreground">14 軌訊號</h3>
        {loading && <span className="text-[9px] text-muted-foreground">計算中…</span>}
      </div>
      {hits.length === 0 ? (
        <p className="text-[10px] text-muted-foreground/70">今日無 v12 進場訊號（M/N/O/P/Q）</p>
      ) : (
        <div className="space-y-1">
          {hits.map((h) => (
            <div key={h.letter} className="flex items-start gap-1.5 text-[10px]">
              <span className={`font-bold px-1.5 py-px rounded shrink-0 ${TRACK_COLOR[h.letter]}`}>
                {h.letter}
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-foreground/90">{h.trackName}</div>
                <div className="text-[9px] text-muted-foreground leading-tight mt-0.5">{h.detail}</div>
                {h.patternType && h.patternTargetPrice && h.necklinePrice && (
                  <div className="mt-0.5 flex items-center gap-1.5 text-[9px]">
                    <span className="text-indigo-300 font-bold">{PATTERN_LABEL[h.patternType] ?? h.patternType}</span>
                    {h.achievementRate != null && (
                      <span className="text-amber-300">{(h.achievementRate * 100).toFixed(0)}%</span>
                    )}
                    <span className="text-muted-foreground">頸線 {h.necklinePrice.toFixed(2)}</span>
                    <span className="text-emerald-400">→{h.patternTargetPrice.toFixed(2)} ({((h.patternTargetPrice - todayPrice) / todayPrice * 100).toFixed(1)}% 空間)</span>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
