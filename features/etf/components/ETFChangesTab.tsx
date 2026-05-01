'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useETFStore } from '@/store/etfStore';
import { ACTIVE_ETF_LIST } from '@/lib/etf/etfList';
import type { ETFChange } from '@/lib/etf/types';
import { Skeleton } from '@/components/ui/skeleton';
import { formatPct, formatWeight } from '../utils/format';

export function ETFChangesTab() {
  const { selectedEtfCode, setSelectedEtfCode } = useETFStore();
  const [date, setDate] = useState<string | null>(null);
  const [changes, setChanges] = useState<ETFChange[] | null>(null);

  useEffect(() => {
    setChanges(null);
    const qs = new URLSearchParams();
    if (selectedEtfCode) qs.set('etfCode', selectedEtfCode);
    fetch(`/api/etf/changes?${qs.toString()}`)
      .then((r) => r.json())
      .then((d) => {
        setChanges(d.changes ?? []);
        setDate(d.date ?? null);
      })
      .catch(() => setChanges([]));
  }, [selectedEtfCode]);

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
        {date && <span className="text-xs text-muted-foreground ml-2">資料日：{date}</span>}
      </div>

      {changes === null ? (
        <Skeleton className="h-64 w-full" />
      ) : changes.length === 0 ? (
        <div className="border border-dashed border-border rounded-lg p-8 text-center">
          <p className="text-sm text-muted-foreground">尚無持股異動資料</p>
        </div>
      ) : (
        <div className="space-y-4">
          {changes.map((c) => (
            <ChangeCard key={c.etfCode} change={c} />
          ))}
        </div>
      )}
    </div>
  );
}

function ChangeCard({ change }: { change: ETFChange }) {
  return (
    <div className="border border-border rounded-lg p-4">
      <div className="flex items-baseline gap-2 mb-3">
        <span className="font-mono text-sm font-semibold">{change.etfCode}</span>
        <span className="text-sm">{change.etfName}</span>
        <span className="text-xs text-muted-foreground ml-auto">
          {change.fromDate} → {change.toDate}
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Section title="新增" color="text-emerald-500" rows={change.newEntries.map((h) => ({
          symbol: h.symbol, name: h.name, primary: formatWeight(h.weight), secondary: '新進',
        }))} />
        <Section title="加碼" color="text-sky-500" rows={change.increased.map((h) => ({
          symbol: h.symbol, name: h.name,
          primary: `${formatWeight(h.prevWeight)} → ${formatWeight(h.weight)}`,
          secondary: formatPct(h.delta),
        }))} />
        <Section title="減碼" color="text-amber-500" rows={change.decreased.map((h) => ({
          symbol: h.symbol, name: h.name,
          primary: `${formatWeight(h.prevWeight)} → ${formatWeight(h.weight)}`,
          secondary: formatPct(h.delta),
        }))} />
        <Section title="退出" color="text-rose-500" rows={change.exits.map((h) => ({
          symbol: h.symbol, name: h.name, primary: formatWeight(h.weight), secondary: '出清',
        }))} />
      </div>
    </div>
  );
}

interface SectionRow {
  symbol: string;
  name: string;
  primary: string;
  secondary: string;
}

function Section({ title, color, rows }: { title: string; color: string; rows: SectionRow[] }) {
  return (
    <div>
      <div className={`text-xs font-medium mb-1 ${color}`}>{title} ({rows.length})</div>
      {rows.length === 0 ? (
        <div className="text-xs text-muted-foreground/60">—</div>
      ) : (
        <ul className="space-y-1">
          {rows.map((r) => (
            <li key={r.symbol} className="flex items-center gap-2 text-xs">
              <Link
                href={`/?symbol=${r.symbol}.TW`}
                className="font-mono w-12 hover:text-sky-400"
              >
                {r.symbol}
              </Link>
              <span className="flex-1 truncate">{r.name}</span>
              <span className="text-muted-foreground tabular-nums">{r.primary}</span>
              <span className={`tabular-nums w-16 text-right ${color}`}>{r.secondary}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
