'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useETFStore } from '@/store/etfStore';
import type { ETFConsensusEntry } from '@/lib/etf/types';
import { Skeleton } from '@/components/ui/skeleton';
import { formatWeight } from '../utils/format';

interface ConsensusData {
  key: number;
  entries: ETFConsensusEntry[];
  date: string | null;
  windowDays: number;
}

export function ETFConsensusTab() {
  const { consensusMinEtfs, setConsensusMinEtfs } = useETFStore();
  const [data, setData] = useState<ConsensusData | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/etf/consensus?minEtfs=${consensusMinEtfs}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setData({
          key: consensusMinEtfs,
          entries: d.entries ?? [],
          date: d.date ?? null,
          windowDays: d.windowDays ?? 0,
        });
      })
      .catch(() => {
        if (!cancelled) setData({ key: consensusMinEtfs, entries: [], date: null, windowDays: 0 });
      });
    return () => { cancelled = true; };
  }, [consensusMinEtfs]);

  // Derived state: 切換 minEtfs 後 fetch 完成前，data.key 不匹配 → entries=null 顯示 loading
  const entries = data?.key === consensusMinEtfs ? data.entries : null;
  const date = data?.key === consensusMinEtfs ? data.date : null;
  const windowDays = data?.key === consensusMinEtfs ? data.windowDays : 0;

  return (
    <div className="mt-4">
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <span className="text-xs text-muted-foreground">最少 ETF 數：</span>
        {[2, 3, 4].map((n) => (
          <button
            key={n}
            onClick={() => setConsensusMinEtfs(n)}
            className={`px-3 py-1 text-xs rounded-md transition-colors ${
              consensusMinEtfs === n
                ? 'bg-sky-500 text-white'
                : 'bg-secondary text-muted-foreground hover:text-foreground'
            }`}
          >
            {n}+
          </button>
        ))}
        {date && (
          <span className="text-xs text-muted-foreground ml-2">
            資料日：{date} · 窗口 {windowDays} 個交易日
          </span>
        )}
      </div>

      {entries === null ? (
        <Skeleton className="h-64 w-full" />
      ) : entries.length === 0 ? (
        <div className="border border-dashed border-border rounded-lg p-8 text-center">
          <p className="text-sm text-muted-foreground">無符合條件的共識買進個股</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-left text-xs text-muted-foreground">
                <th className="px-3 py-2">股票</th>
                <th className="px-3 py-2">名稱</th>
                <th className="px-3 py-2 text-center">買入 ETF 數</th>
                <th className="px-3 py-2">ETF 列表</th>
                <th className="px-3 py-2 text-right">平均納入權重</th>
                <th className="px-3 py-2">最早動作日</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.symbol} className="border-t border-border hover:bg-muted/30">
                  <td className="px-3 py-2">
                    <Link href={`/?load=${e.symbol}.TW`} className="font-mono hover:text-sky-400">
                      {e.symbol}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{e.stockName}</td>
                  <td className="px-3 py-2 text-center">
                    <span className="inline-flex items-center justify-center min-w-6 h-6 px-2 rounded-md bg-sky-500/15 text-sky-400 text-xs font-medium">
                      {e.etfCodes.length}
                    </span>
                    {e.newCount > 0 && (
                      <span className="ml-1 text-[10px] text-emerald-500">新{e.newCount}</span>
                    )}
                    {e.increasedCount > 0 && (
                      <span className="ml-1 text-[10px] text-sky-400">加{e.increasedCount}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {e.etfCodes.join('、')}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatWeight(e.avgWeight)}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{e.firstAddedDate}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
