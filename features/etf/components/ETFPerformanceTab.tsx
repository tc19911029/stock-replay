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

interface PerformanceData {
  key: PeriodKey;
  entries: ETFPerformanceEntry[];
  latestDate: string;
  message: string | null;
}

export function ETFPerformanceTab() {
  const { performancePeriod, setPerformancePeriod, setActiveTab, setSelectedEtfCode } = useETFStore();
  const [data, setData] = useState<PerformanceData | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/etf/performance?period=${performancePeriod}&top=20`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setData({
          key: performancePeriod,
          entries: d.entries ?? [],
          latestDate: d.latestDate ?? '',
          message: d.message ?? null,
        });
      })
      .catch(() => {
        if (!cancelled) setData({ key: performancePeriod, entries: [], latestDate: '', message: null });
      });
    return () => { cancelled = true; };
  }, [performancePeriod]);

  // Derived: 切換 period 後 data.key 不匹配 → entries=null 顯示 loading
  const entries = data?.key === performancePeriod ? data.entries : null;
  const latestDate = data?.key === performancePeriod ? data.latestDate : '';
  const message = data?.key === performancePeriod ? data.message : null;

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
  // text-bull/text-bear 跟隨 data-color-theme（asia 紅漲綠跌、western 反過來）
  if (v == null) return 'text-muted-foreground';
  if (v > 0) return 'text-bull';
  if (v < 0) return 'text-bear';
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
