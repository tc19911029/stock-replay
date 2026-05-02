'use client';

import { useEffect, useState } from 'react';
import { useETFStore } from '@/store/etfStore';
import type { PeriodKey } from '@/lib/etf/performanceCalc';
import type { ETFPerformanceEntry } from '@/lib/etf/types';
import { Skeleton } from '@/components/ui/skeleton';
import { formatPct } from '../utils/format';

const PERIOD_LABELS: Record<PeriodKey, string> = {
  d1: '近一日',
  w1: '近一週',
  m1: '近一月',
  ytd: '今年以來',
  inception: '成立以來',
};

export function ETFPerformanceTab() {
  const { performancePeriod, setPerformancePeriod, setActiveTab, setSelectedEtfCode } = useETFStore();
  const [entries, setEntries] = useState<ETFPerformanceEntry[] | null>(null);
  const [latestDate, setLatestDate] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setEntries(null);
    fetch(`/api/etf/performance?period=${performancePeriod}&top=20`)
      .then((r) => r.json())
      .then((d) => {
        setEntries(d.entries ?? []);
        setLatestDate(d.latestDate ?? '');
        setMessage(d.message ?? null);
      })
      .catch(() => setEntries([]));
  }, [performancePeriod]);

  return (
    <div className="mt-4">
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        {(Object.keys(PERIOD_LABELS) as PeriodKey[]).map((p) => (
          <button
            key={p}
            onClick={() => setPerformancePeriod(p)}
            className={`px-3 py-1 text-xs rounded-md transition-colors ${
              performancePeriod === p
                ? 'bg-sky-500 text-white'
                : 'bg-secondary text-muted-foreground hover:text-foreground'
            }`}
          >
            {PERIOD_LABELS[p]}
          </button>
        ))}
        {latestDate && <span className="text-xs text-muted-foreground ml-2">資料日：{latestDate}</span>}
      </div>

      {entries === null ? (
        <Skeleton className="h-64 w-full" />
      ) : entries.length === 0 ? (
        <EmptyHint message={message ?? '尚無資料'} />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 w-12">#</th>
                <th className="px-3 py-2">代號</th>
                <th className="px-3 py-2">名稱</th>
                <th className="px-3 py-2 text-right">最新收盤</th>
                <th className="px-3 py-2 text-right">{PERIOD_LABELS[performancePeriod]}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => {
                const ret = e.returns[performancePeriod];
                return (
                  <tr
                    key={e.etfCode}
                    className="border-t border-border hover:bg-muted/30 cursor-pointer"
                    onClick={() => { setSelectedEtfCode(e.etfCode); setActiveTab('changes'); }}
                  >
                    <td className="px-3 py-2 text-muted-foreground">{i + 1}</td>
                    <td className="px-3 py-2 font-mono text-sky-400">{e.etfCode}</td>
                    <td className="px-3 py-2">{e.etfName}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{e.latestPrice.toFixed(2)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${returnColor(ret)}`}>
                      {formatPct(ret)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function returnColor(v: number | null | undefined): string {
  if (v == null) return 'text-muted-foreground';
  if (v > 0) return 'text-emerald-500';
  if (v < 0) return 'text-rose-500';
  return 'text-muted-foreground';
}

function EmptyHint({ message }: { message: string }) {
  return (
    <div className="border border-dashed border-border rounded-lg p-8 text-center">
      <p className="text-sm text-muted-foreground">{message}</p>
      <p className="text-xs text-muted-foreground/70 mt-2">
        提示：先呼叫 <code>/api/cron/fetch-etf-holdings?force=true&amp;allowStub=true</code> 產 demo 資料，再呼叫 <code>/api/cron/update-etf-tracking</code>。
      </p>
    </div>
  );
}
