'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useETFStore } from '@/store/etfStore';
import { ACTIVE_ETF_LIST } from '@/lib/etf/etfList';
import type { ETFTrackingEntry } from '@/lib/etf/types';
import { Skeleton } from '@/components/ui/skeleton';
import { formatPct } from '../utils/format';

export function ETFTrackingTab() {
  const { selectedEtfCode, setSelectedEtfCode, trackingShowOpen, setTrackingShowOpen } = useETFStore();
  const [entries, setEntries] = useState<ETFTrackingEntry[] | null>(null);

  useEffect(() => {
    setEntries(null);
    const qs = new URLSearchParams();
    if (selectedEtfCode) qs.set('etfCode', selectedEtfCode);
    if (trackingShowOpen) qs.set('open', 'true');
    fetch(`/api/etf/tracking?${qs.toString()}`)
      .then((r) => r.json())
      .then((d) => setEntries(d.entries ?? []))
      .catch(() => setEntries([]));
  }, [selectedEtfCode, trackingShowOpen]);

  return (
    <div className="mt-4">
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <button
          onClick={() => setSelectedEtfCode(null)}
          className={`px-3 py-1 text-xs rounded-md transition-colors ${
            selectedEtfCode === null
              ? 'bg-sky-500 text-white'
              : 'bg-secondary text-muted-foreground hover:text-foreground'
          }`}
        >
          全部
        </button>
        {ACTIVE_ETF_LIST.map((etf) => (
          <button
            key={etf.etfCode}
            onClick={() => setSelectedEtfCode(etf.etfCode)}
            className={`px-3 py-1 text-xs rounded-md font-mono transition-colors ${
              selectedEtfCode === etf.etfCode
                ? 'bg-sky-500 text-white'
                : 'bg-secondary text-muted-foreground hover:text-foreground'
            }`}
          >
            {etf.etfCode}
          </button>
        ))}
        <span className="w-px h-4 bg-border mx-2" />
        <button
          onClick={() => setTrackingShowOpen(!trackingShowOpen)}
          className={`px-3 py-1 text-xs rounded-md transition-colors ${
            trackingShowOpen
              ? 'bg-emerald-500 text-white'
              : 'bg-secondary text-muted-foreground hover:text-foreground'
          }`}
        >
          {trackingShowOpen ? '僅追蹤中' : '全部'}
        </button>
      </div>

      {entries === null ? (
        <Skeleton className="h-64 w-full" />
      ) : entries.length === 0 ? (
        <div className="border border-dashed border-border rounded-lg p-8 text-center">
          <p className="text-sm text-muted-foreground">尚無 tracking 紀錄</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-xs">
            <thead className="bg-muted/50">
              <tr className="text-left text-muted-foreground">
                <th className="px-2 py-2">ETF</th>
                <th className="px-2 py-2">股票</th>
                <th className="px-2 py-2">類型</th>
                <th className="px-2 py-2">納入日</th>
                <th className="px-2 py-2 text-right">納入價</th>
                <th className="px-2 py-2 text-right">1D</th>
                <th className="px-2 py-2 text-right">3D</th>
                <th className="px-2 py-2 text-right">5D</th>
                <th className="px-2 py-2 text-right">10D</th>
                <th className="px-2 py-2 text-right">20D</th>
                <th className="px-2 py-2 text-right">最大獲利</th>
                <th className="px-2 py-2 text-right">最大回撤</th>
                <th className="px-2 py-2 text-center">狀態</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr
                  key={`${e.etfCode}-${e.symbol}-${e.addedDate}`}
                  className="border-t border-border hover:bg-muted/30"
                >
                  <td className="px-2 py-2 font-mono">{e.etfCode}</td>
                  <td className="px-2 py-2">
                    <Link href={`/?symbol=${e.symbol}.TW`} className="font-mono hover:text-sky-400">
                      {e.symbol}
                    </Link>{' '}
                    <span className="text-muted-foreground">{e.stockName}</span>
                  </td>
                  <td className="px-2 py-2">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                      e.changeType === 'new'
                        ? 'bg-emerald-500/15 text-emerald-500'
                        : 'bg-sky-500/15 text-sky-400'
                    }`}>
                      {e.changeType === 'new' ? '新增' : '加碼'}
                    </span>
                  </td>
                  <td className="px-2 py-2 text-muted-foreground">{e.addedDate}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{e.priceAtAdd.toFixed(2)}</td>
                  <Cell v={e.d1Return} />
                  <Cell v={e.d3Return} />
                  <Cell v={e.d5Return} />
                  <Cell v={e.d10Return} />
                  <Cell v={e.d20Return} />
                  <Cell v={e.maxGain} />
                  <Cell v={e.maxDrawdown} />
                  <td className="px-2 py-2 text-center text-[10px]">
                    {e.windowClosed ? (
                      <span className="text-muted-foreground">已關窗</span>
                    ) : (
                      <span className="text-emerald-500">追蹤中</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Cell({ v }: { v: number | null | undefined }) {
  const color =
    v == null ? 'text-muted-foreground/50' : v > 0 ? 'text-emerald-500' : v < 0 ? 'text-rose-500' : '';
  return <td className={`px-2 py-2 text-right tabular-nums ${color}`}>{formatPct(v)}</td>;
}
