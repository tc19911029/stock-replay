'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { RefreshCw, ChevronDown, ExternalLink } from 'lucide-react';
import { useETFStore } from '@/store/etfStore';
import { ACTIVE_ETF_LIST, shortETFName, chartLoadSymbol, formatHoldingShares, formatHoldingShareDelta } from '@/lib/etf/etfList';
import type { ETFChange, ETFHolding } from '@/lib/etf/types';
import { Skeleton } from '@/components/ui/skeleton';
import { Calendar } from '@/components/ui/calendar';
import { formatWeight } from '../utils/format';
import { formatPercent } from '@/lib/format';
import type { StrategySignals, HoldingWithStrategies } from '@/lib/etf/strategySignals';

// ── 策略 A-F 標籤 ─────────────────────────────────────────────────────
const STRAT_KEYS: (keyof StrategySignals)[] = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];
const STRAT_TITLES: Record<string, string> = {
  A: '六大條件',
  B: '回後買上漲',
  C: '盤整突破',
  D: '一字底',
  E: '缺口進場',
  F: 'V形反轉',
  G: 'ABC 突破',
  H: '突破大量黑K',
  I: 'K線橫盤突破',
};

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
        <Link
          href={`/?load=${change.etfCode}.TW`}
          className="font-mono text-sm font-semibold hover:text-sky-400 transition-colors"
        >
          {change.etfCode}
        </Link>
        <Link
          href={`/?load=${change.etfCode}.TW`}
          className="text-xs text-muted-foreground hover:text-sky-400 transition-colors"
        >
          {change.etfName}
        </Link>
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
          const sharesDeltaStr = row.deltaShares !== undefined ? formatHoldingShareDelta(row.deltaShares, row.symbol) : '—';
          const posPctStr = row.type === 'new' ? '+100%'
            : row.type === 'exit' ? '-100%'
            : row.deltaShares !== undefined && row.priorShares
              ? fmtPosPct(row.deltaShares, row.priorShares)
              : `${deltaWeight >= 0 ? '+' : ''}${deltaWeight.toFixed(2)}%`;
          const weightStr = row.type === 'exit' ? '—' : `${row.currentWeight.toFixed(2)}%`;
          const weightDeltaStr = `${deltaWeight >= 0 ? '+' : ''}${deltaWeight.toFixed(2)}%`;

          const loadSym = chartLoadSymbol(row.symbol);
          const stockBlock = (
            <>
              <div className="text-xs text-foreground/90 truncate group-hover:underline">{row.name}</div>
              <div className={`text-[10px] font-mono ${meta.textColor}`}>{row.symbol}</div>
            </>
          );
          return (
            <li key={`${row.type}-${row.symbol}`} className={`grid ${COLS} gap-x-2 px-3 py-2 border-b border-border/30 hover:bg-muted/20 items-center`}>
              {loadSym ? (
                <Link href={`/?load=${loadSym}`} className="group min-w-0">{stockBlock}</Link>
              ) : (
                <div className="min-w-0">{stockBlock}</div>
              )}
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
  etfName,
  holdings,
  disclosureDate,
  strategyMap,
  loading,
}: {
  etfCode: string;
  etfName: string | null;
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
        {etfName && <span className="text-sm text-foreground/80">{etfName}</span>}
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
          const loadSym = chartLoadSymbol(h.symbol);
          const codeNode = loadSym
            ? <Link href={`/?load=${loadSym}`} className="font-mono text-sky-400 hover:underline shrink-0">{h.symbol}</Link>
            : <span className="font-mono text-muted-foreground shrink-0">{h.symbol}</span>;
          const nameNode = loadSym
            ? <Link href={`/?load=${loadSym}`} className="flex-1 truncate min-w-0 text-foreground/80 hover:text-sky-400 hover:underline transition-colors">{data?.name ?? h.name}</Link>
            : <span className="flex-1 truncate min-w-0 text-foreground/80">{data?.name ?? h.name}</span>;
          return (
            <li key={h.symbol} className="px-3 py-2 border-b border-border/30 hover:bg-muted/20">
              {/* line 1: rank · code · name · weight */}
              <div className="flex items-center gap-2 text-xs mb-0.5">
                <span className="text-muted-foreground/40 tabular-nums w-4 shrink-0 text-right">{i + 1}</span>
                {codeNode}
                {nameNode}
                <span className="tabular-nums text-muted-foreground shrink-0">
                  {h.shares !== undefined
                    ? `${formatHoldingShares(h.shares, h.symbol)} (${formatWeight(h.weight)})`
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
//
// 設計筆記：ETF 切換的所有 state 重置都靠「key={selectedEtfCode ?? 'ALL'}」
// 強制 ETFChangesContent 子元件 unmount/remount 處理，子元件 effect body 不
// 需要同步呼叫 setState reset（避免 React 19 set-state-in-effect 違規 +
// cascading renders）。
export function ETFChangesTab() {
  const { selectedEtfCode, setSelectedEtfCode } = useETFStore();

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
            title={etf.etfName}
            className={`px-2 py-0.5 rounded text-xs whitespace-nowrap transition-colors shrink-0 ${
              selectedEtfCode === etf.etfCode ? 'bg-sky-500 text-white' : 'bg-secondary text-muted-foreground hover:text-foreground'
            }`}
          >
            <span className="font-mono">{etf.etfCode}</span>
            <span className="ml-1 opacity-80">{shortETFName(etf.etfName)}</span>
          </button>
        ))}
      </div>

      {/* 子元件用 key reset：切 ETF → unmount → 所有 state 自動重置 */}
      <ETFChangesContent key={selectedEtfCode ?? 'ALL'} etfCode={selectedEtfCode} />
    </div>
  );
}

// ── 內容元件（per-ETF 生命週期） ──────────────────────────────────────
function ETFChangesContent({ etfCode }: { etfCode: string | null }) {
  // diff state
  const [changes, setChanges] = useState<ETFChange[] | null>(null);
  const [availableDates, setAvailableDates] = useState<string[]>([]);
  const [toDate, setToDate] = useState<string | null>(null);

  // snapshot state
  const [holdings, setHoldings] = useState<ETFHolding[] | null>(null);
  const [disclosureDate, setDisclosureDate] = useState<string | null>(null);

  // strategy signals
  const [strategyMap, setStrategyMap] = useState<Record<string, HoldingWithStrategies> | null>(null);

  // 防止 programmatic setToDate 觸發 re-fetch
  const autoSkipRef = useRef(false);

  // fromDate 自動為 toDate 的前一個快照日
  const fromDate = (() => {
    if (!toDate || availableDates.length < 2) return null;
    const idx = availableDates.indexOf(toDate);
    return idx >= 0 && idx < availableDates.length - 1 ? availableDates[idx + 1] : null;
  })();

  // 抓 changes：mount 時無 toDate（API 用 default），user 改 toDate 後 re-fetch
  useEffect(() => {
    if (autoSkipRef.current) {
      autoSkipRef.current = false;
      return;
    }

    let cancelled = false;
    const qs = new URLSearchParams();
    if (etfCode) qs.set('etfCode', etfCode);
    if (toDate) qs.set('toDate', toDate);

    fetch(`/api/etf/changes?${qs.toString()}`)
      .then(r => r.json())
      .then(d => {
        if (cancelled) return;
        setChanges(d.changes ?? []);
        if (d.availableDates?.length) {
          setAvailableDates(d.availableDates);
          if (!toDate) {
            const defaultDate = d.date ?? (d.availableDates as string[] | undefined)?.[0];
            if (defaultDate) {
              autoSkipRef.current = true; // 跳過 setToDate 觸發的 re-fetch
              setToDate(defaultDate);
            }
          }
        }
      })
      .catch(() => { if (!cancelled) setChanges([]); });

    return () => { cancelled = true; };
  }, [etfCode, toDate]);

  // 抓 snapshot：mount 時跑一次（etfCode 是 prop，子元件 lifetime 內不變）
  useEffect(() => {
    if (!etfCode) return;
    let cancelled = false;
    fetch(`/api/etf/snapshot/${etfCode}`)
      .then(r => r.json())
      .then(d => {
        if (cancelled) return;
        setHoldings(d.snapshot?.holdings ?? null);
        setDisclosureDate(d.snapshot?.disclosureDate ?? null);
      })
      .catch(() => { if (!cancelled) setHoldings(null); });
    return () => { cancelled = true; };
  }, [etfCode]);

  // 抓 strategy signals：holdings ready 後一次
  useEffect(() => {
    if (!etfCode || !holdings || holdings.length === 0) return;
    let cancelled = false;
    fetch(`/api/etf/holdings-conditions?etfCode=${etfCode}`)
      .then(r => r.json())
      .then(d => {
        if (cancelled) return;
        const map: Record<string, HoldingWithStrategies> = {};
        if (d.holdings) for (const h of d.holdings) map[h.symbol] = h;
        setStrategyMap(map);
      })
      .catch(() => { if (!cancelled) setStrategyMap({}); }); // 空 map = loaded but no data
    return () => { cancelled = true; };
  }, [etfCode, holdings]);

  // strategyLoading 從 holdings ready 但 strategyMap 未 set 推導（避免 effect 同步 setState）
  const strategyLoading = holdings != null && holdings.length > 0 && strategyMap === null;

  return (
    <>
      {/* 日期選擇器（只在單一 ETF 時顯示） */}
      {etfCode && (
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
        if (etfCode === null) {
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
      {etfCode && (
        holdings === null ? (
          <Skeleton className="h-64 w-full" />
        ) : holdings && holdings.length > 0 ? (
          <HoldingsTable
            etfCode={etfCode}
            etfName={ACTIVE_ETF_LIST.find(e => e.etfCode === etfCode)?.etfName ?? null}
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
    </>
  );
}
