'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useETFStore } from '@/store/etfStore';
import { ACTIVE_ETF_LIST } from '@/lib/etf/etfList';
import type { ETFChange, ETFHolding } from '@/lib/etf/types';
import { Skeleton } from '@/components/ui/skeleton';
import { formatPct, formatWeight } from '../utils/format';

export function ETFChangesTab() {
  const { selectedEtfCode, setSelectedEtfCode } = useETFStore();
  const [date, setDate] = useState<string | null>(null);
  const [changes, setChanges] = useState<ETFChange[] | null>(null);
  const [snapshot, setSnapshot] = useState<{ holdings: ETFHolding[]; disclosureDate: string } | null | 'loading'>('loading');

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

  useEffect(() => {
    if (!selectedEtfCode) {
      setSnapshot(null);
      return;
    }
    setSnapshot('loading');
    fetch(`/api/etf/snapshot/${selectedEtfCode}`)
      .then((r) => r.json())
      .then((d) => setSnapshot(d.snapshot ?? null))
      .catch(() => setSnapshot(null));
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
        <Skeleton className="h-32 w-full" />
      ) : changes.length > 0 ? (
        <div className="space-y-4 mb-6">
          {changes.map((c) => (
            <ChangeCard key={c.etfCode} change={c} />
          ))}
        </div>
      ) : selectedEtfCode === null ? (
        <div className="border border-dashed border-border rounded-lg p-8 text-center mb-6">
          <p className="text-sm text-muted-foreground">尚無持股異動資料——選擇上方 ETF 查看目前持股</p>
        </div>
      ) : null}

      {selectedEtfCode && (
        snapshot === 'loading' ? (
          <Skeleton className="h-64 w-full" />
        ) : snapshot && snapshot.holdings.length > 0 ? (
          <HoldingsTable etfCode={selectedEtfCode} holdings={snapshot.holdings} disclosureDate={snapshot.disclosureDate} />
        ) : (
          <div className="border border-dashed border-border rounded-lg p-8 text-center">
            <p className="text-sm text-muted-foreground">尚無持股快照——請等待今日 cron 執行後刷新</p>
          </div>
        )
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

function HoldingsTable({
  etfCode,
  holdings,
  disclosureDate,
}: {
  etfCode: string;
  holdings: ETFHolding[];
  disclosureDate: string;
}) {
  return (
    <div className="border border-border rounded-lg p-4">
      <div className="flex items-baseline gap-2 mb-3">
        <span className="font-mono text-sm font-semibold">{etfCode}</span>
        <span className="text-xs text-muted-foreground">目前持股</span>
        <span className="text-xs text-muted-foreground ml-auto">揭露日：{disclosureDate}</span>
      </div>
      <ul className="space-y-1">
        {holdings.map((h, i) => (
          <li key={h.symbol} className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground/50 w-6 text-right tabular-nums">{i + 1}</span>
            <Link
              href={`/?symbol=${h.symbol}.TW`}
              className="font-mono w-14 hover:text-sky-400 shrink-0"
            >
              {h.symbol}
            </Link>
            <span className="flex-1 truncate">{h.name}</span>
            <span className="text-muted-foreground tabular-nums">{formatWeight(h.weight)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
