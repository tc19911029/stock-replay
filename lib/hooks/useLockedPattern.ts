'use client';

import { useEffect, useState } from 'react';

export interface LockedPattern {
  patternType: string;
  necklinePrice: number;
  targetPrice: number;
  stopPrice?: number;
  achievementRate?: number;
  kind: 'bottom' | 'top';
}

interface LockwatchRecordShape {
  symbol: string;
  patternType?: string;
  /** N 訊號：頸線價（即 LockWatchRecord.triggerPrice） */
  triggerPrice?: number;
  patternTargetPrice?: number;
  /** F 訊號：V 底，可作為結構失效價 */
  vBottom?: number;
  patternAchievementRate?: number;
  triggerSignal?: string;
  /** 紀錄階段 — 結構失效/已撤銷的紀錄不可作為走圖鎖定來源 */
  currentStage?: string;
}

/** 仍有效的 stage（observation / entry-signal alias / purchased 持倉中仍可看到鎖定型態） */
const ACTIVE_STAGES = new Set(['observation', 'entry-signal', 'purchased']);

interface LockwatchApiResponse {
  ok?: boolean;
  snapshot?: { records?: LockwatchRecordShape[] } | null;
}

const TOP_PATTERNS = new Set(['head-shoulder-top', 'triple-top', 'double-top']);

/**
 * 鎖股觀察紀錄 → 走圖型態 chip 的穩定資料源。
 * 只要 symbol 變動就重抓；走圖前後切時間軸不會重算。
 *
 * 為什麼存在：app/page.tsx 跟 ScanChartPanel 都要把 lockedPattern 傳進 CandleChart，
 * 兩處原本各自實作會漂移；統一抽 hook 並補掃描側 wiring，型態/頸線就不會跟著時間軸跳動。
 */
export function useLockedPattern(symbol: string | null | undefined): {
  lockedPattern: LockedPattern | null;
  loading: boolean;
} {
  const [lockedPattern, setLockedPattern] = useState<LockedPattern | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!symbol) {
      setLockedPattern(null);
      return;
    }
    // L3 fix：裸數字 symbol (如 '2330') 推斷為 TW；含 .SS/.SZ 為 CN；其他為 TW
    const market: 'TW' | 'CN' = /\.(SS|SZ)$/i.test(symbol) ? 'CN' : 'TW';
    let cancelled = false;
    setLoading(true);
    fetch(`/api/lockwatch?market=${market}`)
      .then((r) => r.json() as Promise<LockwatchApiResponse>)
      .then((j) => {
        if (cancelled) return;
        if (!j.ok || !j.snapshot) {
          setLockedPattern(null);
          return;
        }
        const bare = symbol.replace(/\.(TW|TWO)$/i, '');
        // 0513 audit H3：只取仍有效 stage 的紀錄（revoked/structure-broken/manually-removed 排除）
        const rec = (j.snapshot.records ?? []).find(
          (r) =>
            (r.symbol === symbol || r.symbol === bare) &&
            (r.currentStage == null || ACTIVE_STAGES.has(r.currentStage)),
        );
        // N 訊號才有 patternType + neckline（= triggerPrice）+ 目標價；F 不走型態鎖定
        if (!rec || !rec.patternType || rec.triggerPrice == null || rec.patternTargetPrice == null) {
          setLockedPattern(null);
          return;
        }
        setLockedPattern({
          patternType: rec.patternType,
          necklinePrice: rec.triggerPrice,
          targetPrice: rec.patternTargetPrice,
          stopPrice: rec.vBottom,  // F 才有；N 由 CandleChart fallback necklinePrice * 0.93
          achievementRate:
            rec.patternAchievementRate != null ? rec.patternAchievementRate * 100 : undefined,
          kind: TOP_PATTERNS.has(rec.patternType) ? 'top' : 'bottom',
        });
      })
      .catch(() => {
        if (!cancelled) setLockedPattern(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  return { lockedPattern, loading };
}
