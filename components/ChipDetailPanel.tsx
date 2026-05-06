'use client';

import { useState, useEffect } from 'react';
import { fetchWithRetry } from '@/lib/fetchWithRetry';
import { toast } from 'sonner';

interface ChipInfo {
  symbol: string;
  name?: string;
  foreignBuy: number;
  trustBuy: number;
  dealerBuy: number;
  totalInstitutional: number;
  marginBalance: number;
  marginNet: number;
  shortBalance: number;
  shortNet: number;
  marginUtilRate: number;
  dayTradeVolume: number;
  dayTradeRatio: number;
  largeTraderBuy: number;
  largeTraderSell: number;
  largeTraderNet: number;
  lendingBalance: number;
  lendingNet: number;
  largeHolderPct: number;
  largeHolderChange: number;
  chipScore: number;
  chipGrade: string;
  chipSignal: string;
  chipDetail: string;
}

// ── Signal label + color ────────────────────────────────────────────────────
function getSignal(v: number, big: number, small: number) {
  if (v >=  big)   return { label: '大增', cls: 'text-bull' };
  if (v >=  small) return { label: '增',   cls: 'text-bull-light' };
  if (v <= -big)   return { label: '大減', cls: 'text-bear' };
  if (v <= -small) return { label: '小賣', cls: 'text-bear-light' };
  return             { label: '中立', cls: 'text-yellow-400' };
}

function getPctSignal(v: number) {
  if (v >=  1)  return { label: '大增', cls: 'text-bull' };
  if (v >=  0.2) return { label: '增',  cls: 'text-bull-light' };
  if (v <= -1)  return { label: '大減', cls: 'text-bear' };
  if (v <= -0.2) return { label: '小賣', cls: 'text-bear-light' };
  return { label: '中立', cls: 'text-yellow-400' };
}

// ── Gauge bar ───────────────────────────────────────────────────────────────
// Shows current value position in a fixed symmetric range
function GaugeBar({ value, range }: { value: number; range: number }) {
  const clamped = Math.max(-range, Math.min(range, value));
  const pct = ((clamped / range) + 1) / 2; // 0..1, 0.5 = center
  const positive = clamped >= 0;

  return (
    <div className="relative w-full h-[3px] bg-muted rounded-full mt-2">
      <div className="absolute left-1/2 top-0 h-full w-px bg-muted-foreground" />
      {positive ? (
        <div
          className="absolute top-0 h-full bg-red-500 rounded-full"
          style={{ left: '50%', width: `${(pct - 0.5) * 100}%` }}
        />
      ) : (
        <div
          className="absolute top-0 h-full bg-green-500 rounded-full"
          style={{ right: '50%', width: `${(0.5 - pct) * 100}%` }}
        />
      )}
      <div
        className="absolute top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-white shadow"
        style={{ left: `calc(${pct * 100}% - 3px)` }}
      />
    </div>
  );
}

// ── Single chip tile ────────────────────────────────────────────────────────
function ChipTile({
  label,
  value,
  signal,
  unit = '張',
  range,
  isPct = false,
}: {
  label: string;
  value: number | null;
  signal: { label: string; cls: string };
  unit?: string;
  range: number;
  isPct?: boolean;
}) {
  const noData = value == null;
  const valColor = noData
    ? 'text-muted-foreground/60'
    : value > 0
    ? 'text-bull'
    : value < 0
    ? 'text-bear'
    : 'text-muted-foreground';

  let displayVal = '—';
  if (!noData) {
    if (isPct) {
      displayVal = (value > 0 ? '+' : '') + value.toFixed(2) + '%';
    } else {
      const abs = Math.abs(value);
      const formatted =
        abs >= 100_000
          ? (value / 1000).toFixed(0) + 'K'
          : value.toLocaleString();
      displayVal = (value > 0 ? '+' : '') + formatted;
    }
  }

  return (
    <div className="bg-secondary/70 rounded-lg p-2 border border-border/40 flex flex-col gap-0.5">
      {/* Header: label + signal */}
      <div className="flex justify-between items-center">
        <span className="text-[9px] text-muted-foreground font-medium">{label}</span>
        {!noData && (
          <span className={`text-[9px] font-bold ${signal.cls}`}>{signal.label}</span>
        )}
      </div>
      {/* Value */}
      <div className={`text-sm font-mono font-bold leading-snug ${valColor}`}>
        {displayVal}
        {!noData && !isPct && (
          <span className="text-[8px] text-muted-foreground/60 ml-0.5">{unit}</span>
        )}
      </div>
      {/* Gauge */}
      {!noData && <GaugeBar value={value} range={range} />}
    </div>
  );
}

// ── Grade badge ─────────────────────────────────────────────────────────────
const GRADE_CLS: Record<string, string> = {
  S: 'text-bull border-red-600',
  A: 'text-orange-400 border-orange-600',
  B: 'text-yellow-400 border-yellow-600',
  C: 'text-muted-foreground border-border',
  D: 'text-muted-foreground border-border',
};

// ── Main component ──────────────────────────────────────────────────────────
export default function ChipDetailPanel({ symbol, date }: { symbol: string; date?: string }) {
  const [data, setData] = useState<ChipInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  const cleanSym = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!cleanSym) return;
    setLoading(true);
    setError(null);

    // 用 Asia/Taipei TZ 而非 UTC：CST 凌晨時 UTC 還在前一天，會造成籌碼日期偏差
    const chipDate = date || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());

    fetchWithRetry(`/api/chip?date=${chipDate}&symbol=${cleanSym}`, { maxRetries: 2 })
      .then(r => r.json())
      .then(j => {
        if (j.error) { setError('查無籌碼資料'); setData(null); }
        else setData(j);
      })
      .catch(() => { setError('載入失敗'); toast.error('籌碼資料載入失敗', { id: 'chip-error', duration: 3000 }); })
      .finally(() => setLoading(false));
  }, [cleanSym, date, retryCount]);
  /* eslint-enable react-hooks/set-state-in-effect */

  if (loading) return (
    <div className="space-y-3 p-3">
      <div className="flex items-center gap-2">
        <div className="animate-pulse bg-muted/50 rounded h-8 w-20" />
        <div className="animate-pulse bg-muted/50 rounded h-4 flex-1" />
      </div>
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <div className="animate-pulse bg-muted/50 rounded h-4 w-16" />
          <div className="animate-pulse bg-muted/50 rounded h-4 flex-1" />
        </div>
      ))}
      <p className="text-[10px] text-muted-foreground/60 text-center">載入籌碼資料中...</p>
    </div>
  );
  if (error) return (
    <div className="text-xs text-red-400/80 py-6 text-center">
      <p>{error}</p>
      <button onClick={() => setRetryCount(c => c + 1)} className="mt-2 text-sky-400 hover:text-sky-300 transition-colors">重試</button>
    </div>
  );
  if (!data) return (
    <div className="text-xs text-muted-foreground/60 py-6 text-center">無資料</div>
  );

  // ── Tile definitions ──────────────────────────────────────────────────────
  const tiles = [
    {
      label: '外資',
      value: data.foreignBuy,
      signal: getSignal(data.foreignBuy, 5000, 500),
      range: 20000,
    },
    {
      label: '投信',
      value: data.trustBuy,
      signal: getSignal(data.trustBuy, 500, 50),
      range: 2000,
    },
    {
      label: '自營',
      value: data.dealerBuy,
      signal: getSignal(data.dealerBuy, 1000, 100),
      range: 3000,
    },
    {
      label: '法人',
      value: data.totalInstitutional,
      signal: getSignal(data.totalInstitutional, 8000, 800),
      range: 25000,
    },
    {
      label: '融資',
      value: data.marginNet,
      signal: getSignal(data.marginNet, 2000, 200),
      range: 8000,
    },
    {
      label: '融券',
      value: data.shortNet,
      signal: getSignal(data.shortNet, 500, 50),
      range: 2000,
    },
    {
      // 主力 = 三大法人合計（外資 + 投信 + 自營）
      label: '主力',
      value: data.totalInstitutional,
      signal: getSignal(data.totalInstitutional, 8000, 800),
      range: 25000,
    },
    {
      label: '券賣',
      value: data.lendingNet !== 0 ? data.lendingNet : null,
      signal: getSignal(data.lendingNet, 5000, 500),
      range: 20000,
    },
    {
      label: '借券',
      value: data.lendingBalance !== 0 ? -data.lendingBalance : null,
      signal: getSignal(-data.lendingBalance, 10000, 1000),
      range: 50000,
    },
    {
      label: '董監',
      value: null as number | null,
      signal: { label: '—', cls: 'text-muted-foreground/60' },
      range: 1,
      isPct: true,
    },
    {
      label: '大戶',
      value: data.largeHolderChange !== 0 ? data.largeHolderChange : null,
      signal: getPctSignal(data.largeHolderChange),
      range: 5,
      isPct: true,
    },
    {
      label: '散戶',
      value: data.largeHolderChange !== 0 ? -data.largeHolderChange : null,
      signal: getPctSignal(-data.largeHolderChange),
      range: 5,
      isPct: true,
    },
  ];

  const gradeCls = GRADE_CLS[data.chipGrade] ?? GRADE_CLS['D'];
  const signalBg =
    data.chipSignal === '主力進場' ? 'bg-red-900/50 text-red-300' :
    data.chipSignal === '法人偏多' ? 'bg-orange-900/50 text-orange-300' :
    data.chipSignal === '大戶加碼' ? 'bg-yellow-900/50 text-yellow-300' :
    data.chipSignal === '主力出貨' ? 'bg-green-900/50 text-green-300' :
    data.chipSignal === '散戶追高' ? 'bg-amber-900/50 text-amber-300' :
    data.chipSignal === '法人偏空' ? 'bg-blue-900/50 text-blue-300' :
    'bg-secondary text-muted-foreground';

  return (
    <div className="space-y-2.5">
      {/* ── Score header ── */}
      <div className="flex items-center justify-between px-0.5">
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground">籌碼面評分</span>
          <span className={`text-base font-bold border-2 rounded px-1.5 py-0.5 leading-none ${gradeCls}`}>
            {data.chipGrade}
          </span>
          <span className="text-sm font-mono text-foreground/80">{data.chipScore}</span>
        </div>
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${signalBg}`}>
          {data.chipSignal}
        </span>
      </div>

      {/* ── 3-column grid ── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
        {tiles.map(t => (
          <ChipTile
            key={t.label}
            label={t.label}
            value={t.value}
            signal={t.signal}
            range={t.range}
            isPct={t.isPct}
          />
        ))}
      </div>

      {/* ── Summary ── */}
      {data.chipDetail && data.chipDetail !== '中性' && (
        <div className="text-[9px] text-muted-foreground bg-secondary/40 rounded px-2 py-1.5 border border-border/30 leading-relaxed">
          {data.chipDetail}
        </div>
      )}

      {/* ── Margin detail ── */}
      <div className="grid grid-cols-2 gap-1.5 text-[9px] text-muted-foreground">
        <div className="bg-secondary/40 rounded px-2 py-1 border border-border/30">
          <span>融資餘額</span>
          <span className="float-right text-muted-foreground font-mono">{data.marginBalance.toLocaleString()}張</span>
          <div className="clear-both" />
          <span>使用率</span>
          <span className="float-right text-muted-foreground font-mono">{data.marginUtilRate}%</span>
        </div>
        <div className="bg-secondary/40 rounded px-2 py-1 border border-border/30">
          <span>融券餘額</span>
          <span className="float-right text-muted-foreground font-mono">{data.shortBalance.toLocaleString()}張</span>
          <div className="clear-both" />
          <span>當沖比例</span>
          <span className={`float-right font-mono ${data.dayTradeRatio > 40 ? 'text-bull' : data.dayTradeRatio > 25 ? 'text-yellow-400' : 'text-muted-foreground'}`}>
            {data.dayTradeRatio}%
          </span>
        </div>
      </div>
    </div>
  );
}
