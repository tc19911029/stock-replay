'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { RefreshCw, ChevronDown, ExternalLink } from 'lucide-react';
import { useETFStore } from '@/store/etfStore';
import { ACTIVE_ETF_LIST } from '@/lib/etf/etfList';
import type { ETFChange, ETFHolding } from '@/lib/etf/types';
import { Skeleton } from '@/components/ui/skeleton';
import { Calendar } from '@/components/ui/calendar';
import { formatWeight } from '../utils/format';
import { formatPercent, formatShares as fmtShares } from '@/lib/format';
import type { StrategySignals, HoldingWithStrategies } from '@/lib/etf/strategySignals';

const formatShares = fmtShares;

// ── 策略 A-F 標籤 ─────────────────────────────────────────────────────
const STRAT_KEYS: (keyof StrategySignals)[] = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const STRAT_TITLES: Record<string, string> = {
  A: '六大條件',
  B: '回後買上漲',
  C: '盤整突破',
  D: '一字底',
  E: '缺口進場',
  F: 'V形反轉',
  G: 'ABC 突破',
  H: '突破大量黑K',
};

// ── 格式化股數變動（依大小選張/股） ──────────────────────────────────
function fmtShareDelta(delta: number): string {
  const abs = Math.abs(delta);
  const sign = delta >= 0 ? '+' : '-';
  if (abs >= 1000) return `${sign}${Math.round(abs / 1000).toLocaleString('zh-TW')}張`;
  return `${sign}${abs.toLocaleString('zh-TW')}股`;
}

function fmtPosPct(deltaShares: number, priorShares: number): string {
  const pct = (deltaShares / priorShares) * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

// ── 持股異動 diff 卡片（扁平清單 + summary 方格） ─────────────────────
type RowType = 'new' | 'exit' | 'increased' | 'decreased';

interface ChangeRow {
  symbol: string;
  name: string;
  type: RowType;
  currentWeight: number;
  prevWeight: number;
  deltaShares?: number;
  priorShares?: number;
}

const ROW_TYPE_META: Record<RowType, { label: string; badge: string; textColor: string }> = {
  new:       { label: '新增', badge: 'bg-amber-500/15 text-amber-400 border-amber-500/30',   textColor: 'text-amber-400' },
  exit:      { label: '刪除', badge: 'bg-muted text-muted-foreground border-border',           textColor: 'text-muted-foreground' },
  increased: { label: '加碼', badge: 'bg-rose-500/15 text-rose-400 border-rose-500/30',        textColor: 'text-rose-400' },
  decreased: { label: '減碼', badge: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30', textColor: 'text-emerald-400' },
};

const SUMMARY_META: Record<RowType, { label: string; bg: string; text: string }> = {
  new:       { label: '新增', bg: 'bg-amber-500/10 border-amber-500/30',   text: 'text-amber-400' },
  exit:      { label: '刪除', bg: 'bg-muted/40 border-border',              text: 'text-muted-foreground' },
  increased: { label: '加碼', bg: 'bg-rose-500/10 border-rose-500/30',      text: 'text-rose-400' },
  decreased: { label: '減碼', bg: 'bg-emerald-500/10 border-emerald-500/30', text: 'text-emerald-400' },
};

type SortKey = 'type' | 'shares' | 'posPct' | 'weight';
type SortDir = 'asc' | 'desc';

const TYPE_ORDER: Record<RowType, number> = { new: 0, exit: 1, increased: 2, decreased: 3 };

const COLS = 'grid-cols-[1fr_3rem_4.5rem_4rem_5rem]';

function SortBtn({ label, sortKey, active, dir, onToggle }: {
  label: string; sortKey: SortKey; active: SortKey; dir: SortDir;
  onToggle: (k: SortKey) => void;
}) {
  const isActive = active === sortKey;
  return (
    <button
      onClick={() => onToggle(sortKey)}
      className="flex items-center justify-end gap-0.5 group w-full"
    >
      <span className={isActive ? 'text-foreground/80' : ''}>{label}</span>
      <span className="flex flex-col leading-none ml-0.5">
        <span className={`text-[7px] leading-none ${isActive && dir === 'asc' ? 'text-sky-400' : 'text-muted-foreground/30 group-hover:text-muted-foreground/60'}`}>▲</span>
        <span className={`text-[7px] leading-none ${isActive && dir === 'desc' ? 'text-sky-400' : 'text-muted-foreground/30 group-hover:text-muted-foreground/60'}`}>▼</span>
      </span>
    </button>
  );
}

function ChangeCard({ change }: { change: ETFChange }) {
  const [sortKey, setSortKey] = useState<SortKey>('shares');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortKey(k); setSortDir('desc'); }
  };

  const baseRows: ChangeRow[] = [
    ...change.newEntries.map(h => ({
      symbol: h.symbol, name: h.name, type: 'new' as RowType,
      currentWeight: h.weight, prevWeight: 0,
      deltaShares: h.shares, priorShares: undefined,
    })),
    ...change.exits.map(h => ({
      symbol: h.symbol, name: h.name, type: 'exit' as RowType,
      currentWeight: 0, prevWeight: h.weight,
      deltaShares: h.shares !== undefined ? -h.shares : undefined, priorShares: h.shares,
    })),
    ...change.increased.map(h => ({
      symbol: h.symbol, name: h.name, type: 'increased' as RowType,
      currentWeight: h.weight, prevWeight: h.prevWeight,
      deltaShares: h.deltaShares, priorShares: h.priorShares,
    })),
    ...change.decreased.map(h => ({
      symbol: h.symbol, name: h.name, type: 'decreased' as RowType,
      currentWeight: h.weight, prevWeight: h.prevWeight,
      deltaShares: h.deltaShares, priorShares: h.priorShares,
    })),
  ];

  if (baseRows.length === 0) return null;

  const rows = [...baseRows].sort((a, b) => {
    if (sortKey === 'type') {
      const diff = TYPE_ORDER[a.type] - TYPE_ORDER[b.type];
      return sortDir === 'asc' ? diff : -diff;
    }
    let av = 0, bv = 0;
    if (sortKey === 'shares') {
      av = Math.abs(a.deltaShares ?? 0);
      bv = Math.abs(b.deltaShares ?? 0);
    } else if (sortKey === 'posPct') {
      av = a.type === 'new' || a.type === 'exit' ? 1
        : a.deltaShares && a.priorShares ? Math.abs(a.deltaShares / a.priorShares) : 0;
      bv = b.type === 'new' || b.type === 'exit' ? 1
        : b.deltaShares && b.priorShares ? Math.abs(b.deltaShares / b.priorShares) : 0;
    } else {
      av = Math.abs(a.currentWeight - a.prevWeight);
      bv = Math.abs(b.currentWeight - b.prevWeight);
    }
    return sortDir === 'desc' ? bv - av : av - bv;
  });

  const counts: Record<RowType, number> = {
    new: change.newEntries.length,
    exit: change.exits.length,
    increased: change.increased.length,
    decreased: change.decreased.length,
  };

  return (
    <div className="border border-border rounded-lg overflow-hidden mb-4">
      {/* header */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border bg-muted/20">
        <span className="font-mono text-sm font-semibold">{change.etfCode}</span>
        <span className="text-xs text-muted-foreground">{change.etfName}</span>
      </div>

      {/* summary 方格 */}
      <div className="grid grid-cols-4 gap-0 border-b border-border">
        {(['new', 'exit', 'increased', 'decreased'] as RowType[]).map(t => {
          const m = SUMMARY_META[t];
          return (
            <div key={t} className={`flex flex-col items-center py-2 border-r last:border-r-0 border-border ${m.bg}`}>
              <span className={`text-xs ${m.text}`}>{m.label}</span>
              <span className={`text-xl font-bold ${m.text}`}>{counts[t]}</span>
              <span className={`text-[10px] ${m.text}`}>檔</span>
            </div>
          );
        })}
      </div>

      {/* 欄標題 */}
      <div className={`grid ${COLS} gap-x-2 px-3 py-1.5 border-b border-border/50 bg-muted/10 text-[10px] text-muted-foreground/60`}>
        <span>標的</span>
        <div className="flex justify-center">
          <SortBtn label="狀態" sortKey="type" active={sortKey} dir={sortDir} onToggle={toggleSort} />
        </div>
        <SortBtn label="持股變動" sortKey="shares" active={sortKey} dir={sortDir} onToggle={toggleSort} />
        <SortBtn label="變動幅度" sortKey="posPct" active={sortKey} dir={sortDir} onToggle={toggleSort} />
        <div className="flex flex-col items-end leading-none">
          <SortBtn label="目前權重" sortKey="weight" active={sortKey} dir={sortDir} onToggle={toggleSort} />
          <span className="text-[9px] text-muted-foreground/40 mt-0.5">變動%</span>
        </div>
      </div>

      {/* 異動列表 */}
      <ul>
        {rows.map(row => {
          const meta = ROW_TYPE_META[row.type];
          const deltaWeight = row.currentWeight - row.prevWeight;
          const sharesDeltaStr = row.deltaShares !== undefined ? fmtShareDelta(row.deltaShares) : '—';
          const posPctStr = row.type === 'new' ? '+100%'
            : row.type === 'exit' ? '-100%'
            : row.deltaShares !== undefined && row.priorShares
              ? fmtPosPct(row.deltaShares, row.priorShares)
              : `${deltaWeight >= 0 ? '+' : ''}${deltaWeight.toFixed(2)}%`;
          const weightStr = row.type === 'exit' ? '—' : `${row.currentWeight.toFixed(2)}%`;
          const weightDeltaStr = `${deltaWeight >= 0 ? '+' : ''}${deltaWeight.toFixed(2)}%`;

          return (
            <li key={`${row.type}-${row.symbol}`} className={`grid ${COLS} gap-x-2 px-3 py-2 border-b border-border/30 hover:bg-muted/20 items-center`}>
              <Link href={`/?load=${row.symbol}.TW`} className="group min-w-0">
                <div className="text-xs text-foreground/90 truncate group-hover:underline">{row.name}</div>
                <div className={`text-[10px] font-mono ${meta.textColor}`}>{row.symbol}</div>
              </Link>
              <div className="flex justify-center">
                <span className={`text-[9px] font-medium px-1 py-0.5 rounded border ${meta.badge}`}>{meta.label}</span>
              </div>
              <div className={`text-[11px] tabular-nums text-right ${meta.textColor}`}>{sharesDeltaStr}</div>
              <div className={`text-[11px] tabular-nums text-right ${meta.textColor}`}>{posPctStr}</div>
              <div className="text-right">
                <div className="text-[11px] tabular-nums text-foreground/80">{weightStr}</div>
                <div className={`text-[10px] tabular-nums ${deltaWeight >= 0 ? 'text-rose-400' : 'text-emerald-400'}`}>{weightDeltaStr}</div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ── 策略 A-F 標籤列 ──────────────────────────────────────────────────
function StrategyBadges({ strategies }: { strategies: StrategySignals }) {
  const matched = STRAT_KEYS.filter(k => strategies[k]);
  if (matched.length === 0) {
    return <span className="text-muted-foreground/30 text-[10px]">無策略訊號</span>;
  }
  return (
    <span className="flex gap-1 flex-wrap">
      {matched.map(k => (
        <span
          key={k}
          title={`${k} ${STRAT_TITLES[k]}`}
          className="px-1.5 h-4 rounded text-[10px] font-medium flex items-center bg-emerald-500/20 text-emerald-400"
        >
          {STRAT_TITLES[k]}
        </span>
      ))}
    </span>
  );
}

// ── 目前持股表格 ──────────────────────────────────────────────────────
function HoldingsTable({
  etfCode,
  holdings,
  disclosureDate,
  strategyMap,
  loading,
}: {
  etfCode: string;
  holdings: ETFHolding[];
  disclosureDate: string;
  strategyMap: Record<string, HoldingWithStrategies> | null;
  loading: boolean;
}) {
  return (
    <div className="border border-border rounded-lg overflow-hidden">
      {/* header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-muted/20">
        <Link
          href={`/?load=${etfCode}.TW`}
          className="font-mono text-sm font-semibold text-sky-400 hover:underline flex items-center gap-1"
        >
          {etfCode}
          <ExternalLink className="w-3 h-3 opacity-60" />
        </Link>
        <span className="text-xs text-muted-foreground">目前持股 {holdings.length} 支</span>
        <span className="text-xs text-muted-foreground">揭露日：{disclosureDate}</span>
        {loading && (
          <span className="ml-auto text-xs text-muted-foreground flex items-center gap-1">
            <RefreshCw className="w-3 h-3 animate-spin" /> 載入策略訊號…
          </span>
        )}
      </div>

      {/* rows */}
      <ul>
        {holdings.map((h, i) => {
          const data = strategyMap?.[h.symbol];
          return (
            <li key={h.symbol} className="px-3 py-2 border-b border-border/30 hover:bg-muted/20">
              {/* line 1: rank · code · name · weight */}
              <div className="flex items-center gap-2 text-xs mb-0.5">
                <span className="text-muted-foreground/40 tabular-nums w-4 shrink-0 text-right">{i + 1}</span>
                <Link href={`/?load=${h.symbol}.TW`} className="font-mono text-sky-400 hover:underline shrink-0">
                  {h.symbol}
                </Link>
                <span className="flex-1 truncate min-w-0 text-foreground/80">{data?.name ?? h.name}</span>
                <span className="tabular-nums text-muted-foreground shrink-0">
                  {h.shares !== undefined
                    ? `${formatShares(h.shares)} (${formatWeight(h.weight)})`
                    : formatWeight(h.weight)}
                </span>
              </div>
              {/* line 2: price · change% · strategy A-F */}
              <div className="flex items-center gap-2 text-xs pl-6">
                {data ? (
                  <>
                    <span className="tabular-nums text-muted-foreground shrink-0">{data.price.toFixed(0)}</span>
                    <span className={`tabular-nums shrink-0 ${data.changePct >= 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                      {formatPercent(data.changePct)}
                    </span>
                    <span className="text-muted-foreground/30 mx-0.5">·</span>
                    <StrategyBadges strategies={data.strategies} />
                  </>
                ) : loading ? (
                  <span className="text-muted-foreground/30 text-[10px]">載入中…</span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ── 日曆選擇器（彈出式，只有快照日期可點） ──────────────────────────
function DatePicker({
  availableDates,
  toDate,
  onTo,
}: {
  availableDates: string[];
  toDate: string | null;
  onTo: (d: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // 點外部關閉（hooks 必須在所有 return 之前）
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // 只有 ≥2 個快照才有「前一天」可以比
  const pickable = new Set(availableDates.slice(0, -1));
  if (pickable.size === 0) return null;

  const toLocalIso = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

  const selectedDate = toDate ? new Date(toDate + 'T12:00:00') : undefined;

  const isDisabled = (date: Date) => !pickable.has(toLocalIso(date));

  const handleSelect = (date: Date | undefined) => {
    if (!date) return;
    const iso = toLocalIso(date);
    if (pickable.has(iso)) {
      onTo(iso);
      setOpen(false);
    }
  };

  return (
    <div className="flex items-center gap-2 text-xs" ref={ref}>
      <span className="text-muted-foreground shrink-0">查看</span>
      <div className="relative">
        <button
          onClick={() => setOpen(v => !v)}
          className="flex items-center gap-1 bg-secondary border border-border rounded px-2 py-1 text-xs hover:bg-muted/60 transition-colors"
        >
          {toDate ?? '選擇日期'}
          <ChevronDown className="w-3 h-3 text-muted-foreground" />
        </button>
        {open && (
          <div className="absolute left-0 top-full mt-1 z-50 bg-popover border border-border rounded-lg shadow-lg">
            <Calendar
              mode="single"
              selected={selectedDate}
              onSelect={handleSelect}
              disabled={isDisabled}
              defaultMonth={selectedDate}
            />
          </div>
        )}
      </div>
      <span className="text-muted-foreground shrink-0">的異動</span>
    </div>
  );
}

// ── 主元件 ────────────────────────────────────────────────────────────
export function ETFChangesTab() {
  const { selectedEtfCode, setSelectedEtfCode } = useETFStore();

  // diff state
  const [changes, setChanges] = useState<ETFChange[] | null>(null);
  const [availableDates, setAvailableDates] = useState<string[]>([]);
  const [toDate, setToDate] = useState<string | null>(null);

  // fromDate 自動為 toDate 的前一個快照日
  const fromDate = (() => {
    if (!toDate || availableDates.length < 2) return null;
    const idx = availableDates.indexOf(toDate);
    return idx >= 0 && idx < availableDates.length - 1 ? availableDates[idx + 1] : null;
  })();

  // snapshot state
  const [holdings, setHoldings] = useState<ETFHolding[] | null>(null);
  const [disclosureDate, setDisclosureDate] = useState<string | null>(null);

  // strategy signals state
  const [strategyMap, setStrategyMap] = useState<Record<string, HoldingWithStrategies> | null>(null);
  const [strategyLoading, setStrategyLoading] = useState(false);

  // refs to prevent redundant fetches when we programmatically set toDate
  const prevEtfCodeRef = useRef<string | null | undefined>(undefined);
  const autoSkipRef = useRef(false); // true when toDate was set by us (not the user)

  // Unified fetch effect: handles both ETF switch and user date selection in one pass.
  // On ETF switch: fetch without toDate (let API pick default), mark the subsequent
  // programmatic setToDate calls to skip re-fetch via autoSkipRef.
  useEffect(() => {
    const etfJustChanged = prevEtfCodeRef.current !== selectedEtfCode;
    prevEtfCodeRef.current = selectedEtfCode;

    // Skip re-renders caused by our own setToDate calls (programmatic, not user-driven)
    if (autoSkipRef.current && !etfJustChanged) {
      autoSkipRef.current = false;
      return;
    }

    setChanges(null);

    let effectiveDate: string | null;
    if (etfJustChanged) {
      setAvailableDates([]);
      setStrategyMap(null);
      // Reset date picker immediately; mark as auto so the null→null re-render is skipped
      autoSkipRef.current = true;
      setToDate(null);
      effectiveDate = null; // always fetch the API default on ETF switch
    } else {
      autoSkipRef.current = false;
      effectiveDate = toDate;
    }

    const qs = new URLSearchParams();
    if (selectedEtfCode) qs.set('etfCode', selectedEtfCode);
    if (effectiveDate) qs.set('toDate', effectiveDate);

    fetch(`/api/etf/changes?${qs.toString()}`)
      .then(r => r.json())
      .then(d => {
        setChanges(d.changes ?? []);
        if (d.availableDates?.length) {
          setAvailableDates(d.availableDates);
          if (!effectiveDate) {
            const defaultDate = d.date ?? (d.availableDates as string[] | undefined)?.[0];
            if (defaultDate) {
              autoSkipRef.current = true; // skip the re-fetch triggered by setToDate
              setToDate(defaultDate);
            }
          }
        }
      })
      .catch(() => setChanges([]));
  }, [selectedEtfCode, toDate]);

  // fetch snapshot
  useEffect(() => {
    setHoldings(null);
    setDisclosureDate(null);
    setStrategyMap(null);
    if (!selectedEtfCode) return;

    fetch(`/api/etf/snapshot/${selectedEtfCode}`)
      .then(r => r.json())
      .then(d => {
        setHoldings(d.snapshot?.holdings ?? null);
        setDisclosureDate(d.snapshot?.disclosureDate ?? null);
      })
      .catch(() => setHoldings(null));
  }, [selectedEtfCode]);

  // auto-load strategy signals once holdings are ready
  useEffect(() => {
    if (!selectedEtfCode || !holdings || holdings.length === 0) return;
    setStrategyLoading(true);
    fetch(`/api/etf/holdings-conditions?etfCode=${selectedEtfCode}`)
      .then(r => r.json())
      .then(d => {
        if (d.holdings) {
          const map: Record<string, HoldingWithStrategies> = {};
          for (const h of d.holdings) map[h.symbol] = h;
          setStrategyMap(map);
        }
      })
      .catch(() => { /* ignore */ })
      .finally(() => setStrategyLoading(false));
  }, [selectedEtfCode, holdings]);

  return (
    <div className="mt-4 space-y-4">
      {/* ETF 選擇 chips */}
      <div className="flex items-center gap-1 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
        <button
          onClick={() => setSelectedEtfCode(null)}
          className={`px-2 py-0.5 rounded text-xs whitespace-nowrap transition-colors shrink-0 ${
            selectedEtfCode === null ? 'bg-sky-500 text-white' : 'bg-secondary text-muted-foreground hover:text-foreground'
          }`}
        >
          全部
        </button>
        {ACTIVE_ETF_LIST.map((etf) => (
          <button
            key={etf.etfCode}
            onClick={() => setSelectedEtfCode(etf.etfCode)}
            className={`px-2 py-0.5 rounded text-xs font-mono whitespace-nowrap transition-colors shrink-0 ${
              selectedEtfCode === etf.etfCode ? 'bg-sky-500 text-white' : 'bg-secondary text-muted-foreground hover:text-foreground'
            }`}
          >
            {etf.etfCode}
          </button>
        ))}
      </div>

      {/* 日期選擇器（只在單一 ETF 時顯示） */}
      {selectedEtfCode && (
        <DatePicker
          availableDates={availableDates}
          toDate={toDate}
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
        if (fromDate && toDate) {
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
            strategyMap={strategyMap}
            loading={strategyLoading}
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
