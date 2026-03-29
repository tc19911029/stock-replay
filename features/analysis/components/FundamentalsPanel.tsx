'use client';

import { useEffect, useState } from 'react';
import type { FundamentalsData } from '@/lib/datasource/FinMindClient';

interface FundamentalsPanelProps {
  ticker: string;  // clean stock ID e.g. "2330"
}

function fmt(v: number | null | undefined, decimals = 1, suffix = '') {
  if (v == null) return '—';
  return `${v.toFixed(decimals)}${suffix}`;
}

function KpiCell({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex flex-col gap-0.5 px-4 py-3">
      <div className="text-[10px] text-slate-500 uppercase tracking-wide">{label}</div>
      <div className={`text-base font-bold leading-tight tabular-nums ${color ?? 'text-slate-200'}`}>{value}</div>
    </div>
  );
}

export function FundamentalsPanel({ ticker }: FundamentalsPanelProps) {
  const [data, setData] = useState<FundamentalsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const key = ticker.replace(/\.(TW|TWO)$/i, '');
    setLoading(true);
    fetch(`/api/fundamentals/${key}`)
      .then(r => r.json())
      .then(json => { if (json.ok) setData(json.data as FundamentalsData); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [ticker]);

  if (loading) {
    return (
      <div className="bg-slate-900 border border-slate-800 rounded-xl px-4 py-3 animate-pulse">
        <div className="h-3 w-24 bg-slate-800 rounded mb-3" />
        <div className="grid grid-cols-4 sm:grid-cols-7 gap-2">
          {[...Array(7)].map((_, i) => <div key={i} className="h-10 bg-slate-800 rounded" />)}
        </div>
      </div>
    );
  }

  if (!data) return null;

  const epsColor = (data.epsYoY ?? 0) > 0 ? 'text-red-400' : (data.epsYoY ?? 0) < 0 ? 'text-green-400' : 'text-slate-200';
  const revMomColor = (data.revenueMoM ?? 0) > 0 ? 'text-red-400' : (data.revenueMoM ?? 0) < 0 ? 'text-green-400' : 'text-slate-200';
  const revYoyColor = (data.revenueYoY ?? 0) > 0 ? 'text-red-400' : (data.revenueYoY ?? 0) < 0 ? 'text-green-400' : 'text-slate-200';

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
      <div className="px-4 py-2.5 border-b border-slate-800 bg-slate-800/40">
        <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">基本面數據（FinMind）</span>
      </div>
      <div className="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-9 divide-x divide-y divide-slate-800/60">
        <KpiCell label="EPS" value={fmt(data.eps)} />
        <KpiCell label="EPS YoY" value={fmt(data.epsYoY, 1, '%')} color={epsColor} />
        <KpiCell label="毛利率" value={fmt(data.grossMargin, 1, '%')} />
        <KpiCell label="淨利率" value={fmt(data.netMargin, 1, '%')} />
        <KpiCell label="本益比" value={fmt(data.per, 1, 'x')} />
        <KpiCell label="淨值比" value={fmt(data.pbr, 2, 'x')} />
        <KpiCell label="殖利率" value={fmt(data.dividendYield, 2, '%')} />
        <KpiCell label="月營收 MoM" value={fmt(data.revenueMoM, 1, '%')} color={revMomColor} />
        <KpiCell label="月營收 YoY" value={fmt(data.revenueYoY, 1, '%')} color={revYoyColor} />
      </div>
    </div>
  );
}
