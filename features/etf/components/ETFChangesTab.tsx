'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { RefreshCw } from 'lucide-react';
import { useETFStore } from '@/store/etfStore';
import { ACTIVE_ETF_LIST } from '@/lib/etf/etfList';
import type { ETFChange, ETFHolding } from '@/lib/etf/types';
import { Skeleton } from '@/components/ui/skeleton';
import { formatWeight } from '../utils/format';

// ── 六條件顏色點 ──────────────────────────────────────────────────────
const COND_KEYS = ['trend', 'position', 'kbar', 'ma', 'volume', 'indicator'] as const;
const COND_LABELS: Record<string, string> = {
  trend: '①', position: '②', kbar: '③', ma: '④', volume: '⑤', indicator: '⑥',
};

interface SixCond {
  totalScore: number;
  trend: { pass: boolean };
  position: { pass: boolean };
  kbar: { pass: boolean };
  ma: { pass: boolean };
  volume: { pass: boolean };
  indicator: { pass: boolean };
}

interface HoldingWithCond extends ETFHolding {
  price?: number;
  changePct?: number;
  trend?: string;
  sixConditions?: SixCond;
}

// ── ETF chip 選擇器 ───────────────────────────────────────────────────
function EtfChips({
  selected,
  onSelect,
}: {
  selected: string | null;
  onSelect: (code: string | null) => void;
}) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <button
        onClick={() => onSelect(null)}
        className={`px-3 py-1 text-xs rounded-md transition-colors ${
          selected === null ? 'bg-sky-500 text-white' : 'bg-secondary text-muted-foreground hover:text-foreground'
        }`}
      >
        全部
      </button>
      {ACTIVE_ETF_LIST.map((etf) => (
        <button
          key={etf.etfCode}
          onClick={() => onSelect(etf.etfCode)}
          className={`px-3 py-1 text-xs rounded-md font-mono transition-colors ${
            selected === etf.etfCode ? 'bg-sky-500 text-white' : 'bg-secondary text-muted-foreground hover:text-foreground'
          }`}
        >
          {etf.etfCode}
        </button>
      ))}
    </div>
  );
}

// ── 持股異動 diff 卡片 ────────────────────────────────────────────────
function ChangeCard({ change }: { change: ETFChange }) {
  const hasAny = change.newEntries.length + change.exits.length +
    change.increased.length + change.decreased.length > 0;

  if (!hasAny) return null;

  return (
    <div className="border border-border rounded-lg p-4 mb-4">
      <div className="flex items-baseline gap-2 mb-3">
        <span className="font-mono text-sm font-semibold">{change.etfCode}</span>
        <span className="text-sm text-muted-foreground">{change.etfName}</span>
        <span className="text-xs text-muted-foreground ml-auto">{change.fromDate} → {change.toDate}</span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        <DiffSection label="新增" color="text-emerald-500" items={change.newEntries.map(h => ({ symbol: h.symbol, name: h.name, note: formatWeight(h.weight) }))} />
        <DiffSection label="加碼" color="text-sky-500" items={change.increased.map(h => ({ symbol: h.symbol, name: h.name, note: `+${h.delta.toFixed(2)}%` }))} />
        <DiffSection label="減碼" color="text-amber-500" items={change.decreased.map(h => ({ symbol: h.symbol, name: h.name, note: `${h.delta.toFixed(2)}%` }))} />
        <DiffSection label="退出" color="text-rose-500" items={change.exits.map(h => ({ symbol: h.symbol, name: h.name, note: '—' }))} />
      </div>
    </div>
  );
}

function DiffSection({ label, color, items }: { label: string; color: string; items: { symbol: string; name: string; note: string }[] }) {
  return (
    <div>
      <div className={`font-medium mb-1 ${color}`}>{label} ({items.length})</div>
      {items.length === 0 ? (
        <span className="text-muted-foreground/50">—</span>
      ) : (
        <ul className="space-y-0.5">
          {items.map(it => (
            <li key={it.symbol} className="flex gap-1">
              <Link href={`/?load=${it.symbol}.TW`} className={`font-mono hover:underline ${color}`}>{it.symbol}</Link>
              <span className="text-muted-foreground truncate">{it.note}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── 目前持股表格（類自選股排版）────────────────────────────────────────
function HoldingsTable({
  etfCode,
  holdings,
  disclosureDate,
  conditionsData,
  conditionsLoading,
  onLoadConditions,
}: {
  etfCode: string;
  holdings: ETFHolding[];
  disclosureDate: string;
  conditionsData: Record<string, HoldingWithCond> | null;
  conditionsLoading: boolean;
  onLoadConditions: () => void;
}) {
  return (
    <div className="border border-border rounded-lg overflow-hidden">
      {/* header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-muted/20">
        <span className="font-mono text-sm font-semibold">{etfCode}</span>
        <span className="text-xs text-muted-foreground">目前持股 {holdings.length} 支</span>
        <span className="text-xs text-muted-foreground">揭露日：{disclosureDate}</span>
        <div className="ml-auto">
          {conditionsData === null && !conditionsLoading && (
            <button
              onClick={onLoadConditions}
              className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-secondary hover:bg-secondary/80 text-muted-foreground hover:text-foreground transition-colors"
            >
              載入六條件
            </button>
          )}
          {conditionsLoading && (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <RefreshCw className="w-3 h-3 animate-spin" /> 分析中…
            </span>
          )}
        </div>
      </div>

      {/* rows */}
      <ul>
        {holdings.map((h, i) => {
          const cond = conditionsData?.[h.symbol];
          return (
            <li key={h.symbol} className="px-3 py-2 border-b border-border/30 hover:bg-muted/20">
              {/* line 1: code · name · weight */}
              <div className="flex items-center gap-2 text-xs mb-0.5">
                <span className="text-muted-foreground/40 tabular-nums w-4 shrink-0 text-right">{i + 1}</span>
                <Link href={`/?load=${h.symbol}.TW`} className="font-mono text-sky-400 hover:underline shrink-0">
                  {h.symbol}
                </Link>
                <span className="flex-1 truncate min-w-0 text-foreground/80">{cond?.name ?? h.name}</span>
                <span className="tabular-nums text-muted-foreground shrink-0">{formatWeight(h.weight)}</span>
              </div>
              {/* line 2: price · change · six conditions */}
              <div className="flex items-center gap-2 text-xs pl-6">
                {cond ? (
                  <>
                    <span className="tabular-nums text-muted-foreground shrink-0">{cond.price?.toFixed(0)}</span>
                    <span className={`tabular-nums shrink-0 ${(cond.changePct ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {(cond.changePct ?? 0) >= 0 ? '+' : ''}{cond.changePct?.toFixed(2)}%
                    </span>
                    <span className="text-muted-foreground/30 mx-1">·</span>
                  </>
                ) : null}
                <span className="flex gap-0.5">
                  {cond?.sixConditions ? (
                    COND_KEYS.map(k => (
                      <span
                        key={k}
                        title={COND_LABELS[k]}
                        className={`w-4 h-4 rounded-full text-[9px] font-bold flex items-center justify-center ${
                          cond.sixConditions![k].pass
                            ? 'bg-emerald-500/20 text-emerald-400'
                            : 'bg-muted text-muted-foreground/30'
                        }`}
                      >
                        {COND_LABELS[k]}
                      </span>
                    ))
                  ) : (
                    <span className="text-muted-foreground/30">載入六條件查看策略</span>
                  )}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ── 日期比較選擇器 ────────────────────────────────────────────────────
function DateRangePicker({
  availableDates,
  fromDate,
  toDate,
  onFrom,
  onTo,
}: {
  availableDates: string[];
  fromDate: string | null;
  toDate: string | null;
  onFrom: (d: string) => void;
  onTo: (d: string) => void;
}) {
  if (availableDates.length < 2) return null;
  return (
    <div className="flex items-center gap-2 text-xs mb-3">
      <span className="text-muted-foreground">比較</span>
      <select
        value={fromDate ?? ''}
        onChange={e => onFrom(e.target.value)}
        className="bg-secondary border border-border rounded px-2 py-1 text-xs"
      >
        {availableDates.map(d => <option key={d} value={d}>{d}</option>)}
      </select>
      <span className="text-muted-foreground">→</span>
      <select
        value={toDate ?? ''}
        onChange={e => onTo(e.target.value)}
        className="bg-secondary border border-border rounded px-2 py-1 text-xs"
      >
        {availableDates.map(d => <option key={d} value={d}>{d}</option>)}
      </select>
    </div>
  );
}

// ── 主元件 ────────────────────────────────────────────────────────────
export function ETFChangesTab() {
  const { selectedEtfCode, setSelectedEtfCode } = useETFStore();

  // diff state
  const [changes, setChanges] = useState<ETFChange[] | null>(null);
  const [availableDates, setAvailableDates] = useState<string[]>([]);
  const [fromDate, setFromDate] = useState<string | null>(null);
  const [toDate, setToDate] = useState<string | null>(null);

  // snapshot state
  const [holdings, setHoldings] = useState<ETFHolding[] | null>(null);
  const [disclosureDate, setDisclosureDate] = useState<string | null>(null);

  // conditions state
  const [conditionsData, setConditionsData] = useState<Record<string, HoldingWithCond> | null>(null);
  const [conditionsLoading, setConditionsLoading] = useState(false);

  // fetch diff
  useEffect(() => {
    setChanges(null);
    setAvailableDates([]);
    const qs = new URLSearchParams();
    if (selectedEtfCode) qs.set('etfCode', selectedEtfCode);
    if (fromDate) qs.set('fromDate', fromDate);
    if (toDate) qs.set('toDate', toDate);

    fetch(`/api/etf/changes?${qs.toString()}`)
      .then(r => r.json())
      .then(d => {
        setChanges(d.changes ?? []);
        if (d.availableDates?.length) {
          setAvailableDates(d.availableDates);
          if (!fromDate && d.availableDates.length >= 2) setFromDate(d.availableDates[d.availableDates.length - 1]);
          if (!toDate && d.availableDates.length >= 1) setToDate(d.availableDates[0]);
        }
      })
      .catch(() => setChanges([]));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEtfCode, fromDate, toDate]);

  // fetch snapshot
  useEffect(() => {
    setHoldings(null);
    setDisclosureDate(null);
    setConditionsData(null);
    if (!selectedEtfCode) return;

    fetch(`/api/etf/snapshot/${selectedEtfCode}`)
      .then(r => r.json())
      .then(d => {
        setHoldings(d.snapshot?.holdings ?? null);
        setDisclosureDate(d.snapshot?.disclosureDate ?? null);
      })
      .catch(() => setHoldings(null));
  }, [selectedEtfCode]);

  const loadConditions = useCallback(async () => {
    if (!selectedEtfCode) return;
    setConditionsLoading(true);
    try {
      const res = await fetch(`/api/etf/holdings-conditions?etfCode=${selectedEtfCode}`);
      const d = await res.json();
      if (d.holdings) {
        const map: Record<string, HoldingWithCond> = {};
        for (const h of d.holdings) map[h.symbol] = h;
        setConditionsData(map);
      }
    } catch {
      // ignore
    } finally {
      setConditionsLoading(false);
    }
  }, [selectedEtfCode]);

  return (
    <div className="mt-4 space-y-4">
      {/* ETF 選擇 chips */}
      <EtfChips selected={selectedEtfCode} onSelect={code => {
        setSelectedEtfCode(code);
        setFromDate(null);
        setToDate(null);
        setConditionsData(null);
      }} />

      {/* 日期比較選擇器（只在單一 ETF 時顯示） */}
      {selectedEtfCode && (
        <DateRangePicker
          availableDates={availableDates}
          fromDate={fromDate}
          toDate={toDate}
          onFrom={setFromDate}
          onTo={setToDate}
        />
      )}

      {/* diff 卡片 */}
      {changes === null ? (
        <Skeleton className="h-20 w-full" />
      ) : (() => {
        const nonEmpty = changes.filter(c =>
          c.newEntries.length + c.exits.length + c.increased.length + c.decreased.length > 0
        );
        if (nonEmpty.length > 0) {
          return nonEmpty.map(c => <ChangeCard key={c.etfCode} change={c} />);
        }
        if (selectedEtfCode === null) {
          return (
            <div className="border border-dashed border-border rounded-lg p-5 text-center">
              <p className="text-sm text-muted-foreground">選擇上方 ETF 查看持股與異動</p>
            </div>
          );
        }
        if (fromDate && toDate && fromDate !== toDate) {
          return (
            <div className="border border-dashed border-border rounded-lg p-5 text-center">
              <p className="text-sm text-muted-foreground">
                {fromDate} → {toDate} 持股無變化
              </p>
            </div>
          );
        }
        return null;
      })()}

      {/* 目前持股表格 */}
      {selectedEtfCode && (
        holdings === null ? (
          <Skeleton className="h-64 w-full" />
        ) : holdings && holdings.length > 0 ? (
          <HoldingsTable
            etfCode={selectedEtfCode}
            holdings={holdings}
            disclosureDate={disclosureDate ?? '—'}
            conditionsData={conditionsData}
            conditionsLoading={conditionsLoading}
            onLoadConditions={loadConditions}
          />
        ) : (
          <div className="border border-dashed border-border rounded-lg p-8 text-center">
            <p className="text-sm text-muted-foreground">尚無持股快照</p>
          </div>
        )
      )}
    </div>
  );
}
