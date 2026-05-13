'use client';

import { useCallback, useEffect, useState } from 'react';
import type { LockWatchDailySnapshot } from '@/lib/scanner/lockWatchTypes';

interface ApiResponse {
  ok: boolean;
  snapshot: LockWatchDailySnapshot | null;
  dates?: string[];
  error?: string;
}

/**
 * 共用 lockwatch snapshot fetch（LockWatchPanel + ScanResultsCompact）。
 * 回傳 reload 讓呼叫端在 user 操作（如手動移除一檔）後重新拉取。
 */
export function useLockwatchSnapshot(market: 'TW' | 'CN' | null | undefined): {
  snapshot: LockWatchDailySnapshot | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
} {
  const [snapshot, setSnapshot] = useState<LockWatchDailySnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!market) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/lockwatch?market=${market}`);
      const json = (await res.json()) as ApiResponse;
      if (!json.ok) {
        setError(json.error ?? 'load failed');
        return;
      }
      setSnapshot(json.snapshot);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [market]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  return { snapshot, loading, error, reload: fetchData };
}
