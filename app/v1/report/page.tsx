'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { useBacktestStore } from '@/store/backtestStore';
import { BacktestTrade } from '@/lib/backtest/BacktestEngine';
import { BacktestSession } from '@/lib/scanner/types';

// ── Types ──────────────────────────────────────────────────────────────────────

type MarketFilter = 'ALL' | 'TW' | 'CN';
type GroupBy = 'none' | 'month' | 'score';
type SortKey = keyof BacktestTrade | 'none';
type SortDir = 'asc' | 'desc';

interface GroupStat {
  label: string;
  count: number;
  wins: number;
  winRate: number;
  avgNet: number;
  expectancy: number;
  maxLoss: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmt(n: number, digits = 2): string {
  return (n >= 0 ? '+' : '') + n.toFixed(digits);
}

function calcGroupStat(label: string, trades: BacktestTrade[]): GroupStat {
  if (trades.length === 0) {
    return { label, count: 0, wins: 0, winRate: 0, avgNet: 0, expectancy: 0, maxLoss: 0 };
  }
  const wins   = trades.filter(t => t.netReturn > 0);
  const losses = trades.filter(t => t.netReturn <= 0);
  const winRate = wins.length / trades.length;
  const avgNet  = trades.reduce((s, t) => s + t.netReturn, 0) / trades.length;
  const avgWin  = wins.length   > 0 ? wins.reduce((s, t) => s + t.netReturn, 0)   / wins.length   : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.netReturn, 0) / losses.length : 0;
  const expectancy = winRate * avgWin + (1 - winRate) * avgLoss;
  const maxLoss = trades.reduce((m, t) => Math.min(m, t.netReturn), 0);
  return { label, count: trades.length, wins: wins.length, winRate: winRate * 100, avgNet, expectancy, maxLoss };
}

// ── CSV Export ─────────────────────────────────────────────────────────────────

function exportCSV(trades: BacktestTrade[]) {
  const header = [
    'symbol','name','market','signalDate','signalScore','signalReasons',
    'trendState','entryDate','entryPrice','exitDate','exitPrice',
    'exitReason','holdDays','grossReturn','netReturn','totalCost',
  ].join(',');

  const rows = trades.map(t => [
    t.symbol,
    `"${t.name}"`,
    t.market,
    t.signalDate,
    t.signalScore,
    `"${t.signalReasons.join(';')}"`,
    `"${t.trendState}"`,
    t.entryDate,
    t.entryPrice,
    t.exitDate,
    t.exitPrice,
    t.exitReason,
    t.holdDays,
    t.grossReturn,
    t.netReturn,
    t.totalCost,
  ].join(','));

  const csv = [header, ...rows].join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `backtest_report_${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Histogram ─────────────────────────────────────────────────────────────────

function ReturnHistogram({ trades }: { trades: BacktestTrade[] }) {
  if (trades.length === 0) return null;

  // Buckets: < -10, -10~-7, -7~-4, -4~-2, -2~0, 0~2, 2~4, 4~7, 7~10, >10
  const buckets: Array<{ label: string; min: number; max: number; isWin: boolean }> = [
    { label: '<-10%',  min: -Infinity, max: -10,  isWin: false },
    { label: '-10~-7', min: -10,       max: -7,   isWin: false },
    { label: '-7~-4',  min: -7,        max: -4,   isWin: false },
    { label: '-4~-2',  min: -4,        max: -2,   isWin: false },
    { label: '-2~0',   min: -2,        max: 0,    isWin: false },
    { label: '0~2%',   min: 0,         max: 2,    isWin: true  },
    { label: '2~4%',   min: 2,         max: 4,    isWin: true  },
    { label: '4~7%',   min: 4,         max: 7,    isWin: true  },
    { label: '7~10%',  min: 7,         max: 10,   isWin: true  },
    { label: '>10%',   min: 10,        max: Infinity, isWin: true },
  ];

  const counts = buckets.map(b =>
    trades.filter(t => t.netReturn >= b.min && t.netReturn < b.max).length
  );
  const maxCount = Math.max(...counts, 1);

  return (
    <div className="bg-card rounded-xl border border-border p-4">
      <h3 className="text-sm font-semibold text-foreground/80 mb-3">報酬分布</h3>
      <div className="flex items-end gap-1 h-32">
        {buckets.map((b, i) => {
          const pct = (counts[i] / maxCount) * 100;
          return (
            <div key={b.label} className="flex-1 flex flex-col items-center gap-1">
              <span className="text-[9px] text-muted-foreground">{counts[i] > 0 ? counts[i] : ''}</span>
              <div className="w-full flex flex-col justify-end" style={{ height: '80px' }}>
                <div
                  className={`w-full rounded-t transition-all ${b.isWin ? 'bg-red-500/70' : 'bg-green-600/70'}`}
                  style={{ height: `${pct}%`, minHeight: counts[i] > 0 ? '2px' : '0' }}
                />
              </div>
              <span className="text-[9px] text-muted-foreground text-center leading-tight">{b.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Sort helpers ───────────────────────────────────────────────────────────────

function sortTrades(trades: BacktestTrade[], key: SortKey, dir: SortDir): BacktestTrade[] {
  if (key === 'none') return trades;
  return [...trades].sort((a, b) => {
    const av = a[key as keyof BacktestTrade];
    const bv = b[key as keyof BacktestTrade];
    if (typeof av === 'number' && typeof bv === 'number') {
      return dir === 'asc' ? av - bv : bv - av;
    }
    if (typeof av === 'string' && typeof bv === 'string') {
      return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    }
    return 0;
  });
}

// ── SortableHeader ─────────────────────────────────────────────────────────────

function SortableHeader({
  label, sortKey, currentKey, dir, onClick,
}: {
  label: string;
  sortKey: SortKey;
  currentKey: SortKey;
  dir: SortDir;
  onClick: (k: SortKey) => void;
}) {
  const active = currentKey === sortKey;
  return (
    <th
      className="px-2 py-1.5 text-left text-xs font-semibold text-muted-foreground cursor-pointer select-none hover:text-foreground whitespace-nowrap"
      onClick={() => onClick(sortKey)}
    >
      {label}
      {active && <span className="ml-1 text-blue-400">{dir === 'asc' ? '▲' : '▼'}</span>}
    </th>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function ReportPage() {
  const sessions = useBacktestStore(s => s.sessions);

  const [marketFilter, setMarketFilter] = useState<MarketFilter>('ALL');
  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  const [sortKey, setSortKey] = useState<SortKey>('signalDate');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // Gather all trades from all sessions
  const allTrades = useMemo<BacktestTrade[]>(() => {
    const trades: BacktestTrade[] = [];
    for (const s of sessions) {
      if (s.trades) trades.push(...s.trades);
    }
    return trades;
  }, [sessions]);

  // Filtered trades
  const filteredTrades = useMemo(() => {
    if (marketFilter === 'ALL') return allTrades;
    return allTrades.filter(t => t.market === marketFilter);
  }, [allTrades, marketFilter]);

  // Summary stats
  const summary = useMemo(() => {
    const trades = filteredTrades;
    if (trades.length === 0) return null;
    const wins   = trades.filter(t => t.netReturn > 0);
    const losses = trades.filter(t => t.netReturn <= 0);
    const winRate = wins.length / trades.length * 100;
    const avgNet  = trades.reduce((s, t) => s + t.netReturn, 0) / trades.length;
    const avgWin  = wins.length   > 0 ? wins.reduce((s, t) => s + t.netReturn, 0)   / wins.length   : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.netReturn, 0) / losses.length : 0;
    const expectancy = (winRate / 100) * avgWin + (1 - winRate / 100) * avgLoss;

    // Max consecutive loss
    let maxDrawdown = 0;
    let cur = 0;
    for (const t of trades) {
      if (t.netReturn < 0) { cur += t.netReturn; maxDrawdown = Math.min(maxDrawdown, cur); }
      else cur = 0;
    }

    return { count: trades.length, winRate, avgNet, expectancy, maxDrawdown };
  }, [filteredTrades]);

  // Group stats
  const groupStats = useMemo<GroupStat[]>(() => {
    const trades = filteredTrades;
    if (groupBy === 'none') return [];

    if (groupBy === 'month') {
      const map = new Map<string, BacktestTrade[]>();
      for (const t of trades) {
        const key = t.signalDate.slice(0, 7);
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(t);
      }
      return Array.from(map.entries())
        .sort((a, b) => b[0].localeCompare(a[0]))
        .map(([k, v]) => calcGroupStat(k, v));
    }

    if (groupBy === 'score') {
      const map = new Map<number, BacktestTrade[]>();
      for (const t of trades) {
        if (!map.has(t.signalScore)) map.set(t.signalScore, []);
        map.get(t.signalScore)!.push(t);
      }
      return Array.from(map.entries())
        .sort((a, b) => b[0] - a[0])
        .map(([k, v]) => calcGroupStat(`分數 ${k}`, v));
    }

    return [];
  }, [filteredTrades, groupBy]);

  // Sorted trades for table
  const sortedTrades = useMemo(
    () => sortTrades(filteredTrades, sortKey, sortDir),
    [filteredTrades, sortKey, sortDir],
  );

  function handleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('desc'); }
  }

  function exitReasonLabel(r: string) {
    switch (r) {
      case 'holdDays':   return '到期';
      case 'stopLoss':   return '停損';
      case 'takeProfit': return '停利';
      case 'dataEnd':    return '資料結束';
      default: return r;
    }
  }

  const sessionCount = sessions.length;
  const hasData = allTrades.length > 0;

  return (
    <div className="min-h-screen bg-background text-foreground">

      {/* ── Header ── */}
      <header className="border-b border-border px-4 py-3 flex items-center gap-3">
        <Link href="/" className="text-xs px-2.5 py-1 bg-muted hover:bg-muted rounded text-foreground/80 transition">
          ← 主頁
        </Link>
        <h1 className="text-sm font-bold text-foreground">研究報表</h1>
        <span className="text-xs text-muted-foreground ml-1">
          {sessionCount} 次回測 · {allTrades.length} 筆交易
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Link href="/backtest" className="text-xs px-2.5 py-1 bg-violet-700/80 hover:bg-violet-600 rounded text-foreground font-medium transition">
            📅 回測
          </Link>
          {hasData && (
            <button
              onClick={() => exportCSV(filteredTrades)}
              className="text-xs px-3 py-1 bg-emerald-700 hover:bg-emerald-600 rounded text-foreground font-medium transition"
            >
              ↓ 匯出 CSV
            </button>
          )}
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-5 space-y-5">

        {/* ── No data state ── */}
        {!hasData && (
          <div className="text-center py-20 text-muted-foreground">
            <p className="text-lg mb-2">尚無回測資料</p>
            <p className="text-sm mb-4">請先前往回測頁面執行至少一次回測</p>
            <Link href="/backtest" className="text-xs px-4 py-2 bg-violet-700 hover:bg-violet-600 rounded text-foreground transition">
              前往回測
            </Link>
          </div>
        )}

        {hasData && (
          <>
            {/* ── Filters ── */}
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-1.5 text-xs">
                <span className="text-muted-foreground">市場：</span>
                {(['ALL', 'TW', 'CN'] as MarketFilter[]).map(m => (
                  <button
                    key={m}
                    onClick={() => setMarketFilter(m)}
                    className={`px-2.5 py-1 rounded font-medium transition ${
                      marketFilter === m
                        ? 'bg-blue-600 text-foreground'
                        : 'bg-secondary text-muted-foreground hover:bg-muted'
                    }`}
                  >
                    {m === 'ALL' ? '全部' : m === 'TW' ? '台股' : '陸股'}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1.5 text-xs">
                <span className="text-muted-foreground">分組：</span>
                {(['none', 'month', 'score'] as GroupBy[]).map(g => (
                  <button
                    key={g}
                    onClick={() => setGroupBy(g)}
                    className={`px-2.5 py-1 rounded font-medium transition ${
                      groupBy === g
                        ? 'bg-blue-600 text-foreground'
                        : 'bg-secondary text-muted-foreground hover:bg-muted'
                    }`}
                  >
                    {g === 'none' ? '全部' : g === 'month' ? '月份' : '六大條件分數'}
                  </button>
                ))}
              </div>
            </div>

            {/* ── Summary ── */}
            {summary && (
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                {[
                  { label: '總樣本數',   value: String(summary.count),              color: 'text-foreground' },
                  { label: '整體勝率',   value: summary.winRate.toFixed(1) + '%',   color: summary.winRate >= 50 ? 'text-bull' : 'text-bear' },
                  { label: '平均淨報酬', value: fmt(summary.avgNet) + '%',          color: summary.avgNet >= 0 ? 'text-bull' : 'text-bear' },
                  { label: '期望值',     value: fmt(summary.expectancy) + '%',      color: summary.expectancy >= 0 ? 'text-bull' : 'text-bear' },
                  { label: '最大連虧',   value: fmt(summary.maxDrawdown) + '%',     color: 'text-orange-400' },
                ].map(item => (
                  <div key={item.label} className="bg-card rounded-xl border border-border px-4 py-3 text-center">
                    <p className="text-[11px] text-muted-foreground mb-1">{item.label}</p>
                    <p className={`text-xl font-bold font-mono ${item.color}`}>{item.value}</p>
                  </div>
                ))}
              </div>
            )}

            {/* ── Equity Curve & Drawdown ── */}
            {filteredTrades.length >= 3 && (() => {
              // 計算累積權益曲線
              const sorted = [...filteredTrades].sort((a, b) => a.exitDate.localeCompare(b.exitDate));
              let cum = 0;
              const equityData = sorted.map(t => { cum += t.netReturn; return { date: t.exitDate, equity: cum }; });

              // 計算回撤
              let peak = 0;
              const ddData = equityData.map(d => {
                peak = Math.max(peak, d.equity);
                return { date: d.date, dd: d.equity - peak };
              });

              const maxEq = Math.max(...equityData.map(d => d.equity), 0.01);
              const minEq = Math.min(...equityData.map(d => d.equity), -0.01);
              const maxDD = Math.min(...ddData.map(d => d.dd), -0.01);
              const eqRange = maxEq - minEq;
              const ddRange = Math.abs(maxDD);

              const eqY = (v: number) => Math.max(0, Math.min(100, ((maxEq - v) / eqRange) * 100));
              const ddY = (v: number) => Math.max(0, Math.min(100, (Math.abs(v) / ddRange) * 100));

              return (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {/* Equity Curve */}
                  <div className="bg-card rounded-xl border border-border p-4">
                    <h3 className="text-sm font-semibold text-foreground/80 mb-2">累積報酬曲線</h3>
                    <div className="relative h-32 flex items-end gap-[1px]">
                      {/* Zero line */}
                      <div className="absolute left-0 right-0 border-t border-dashed border-slate-600" style={{ top: `${eqY(0)}%` }} />
                      {equityData.map((d, i) => {
                        const h = Math.abs(d.equity) / eqRange * 100;
                        const isPos = d.equity >= 0;
                        return (
                          <div key={i} className="flex-1 flex flex-col justify-end items-center min-w-[2px]" title={`${d.date}: ${fmt(d.equity)}%`}>
                            {isPos ? (
                              <div className="w-full bg-red-500/80 rounded-t-sm" style={{ height: `${h}%` }} />
                            ) : (
                              <div className="w-full bg-green-500/80 rounded-b-sm" style={{ height: `${h}%` }} />
                            )}
                          </div>
                        );
                      })}
                    </div>
                    <div className="flex justify-between text-[9px] text-muted-foreground mt-1">
                      <span>{equityData[0]?.date}</span>
                      <span className={`font-bold ${cum >= 0 ? 'text-bull' : 'text-bear'}`}>{fmt(cum)}%</span>
                      <span>{equityData[equityData.length - 1]?.date}</span>
                    </div>
                  </div>

                  {/* Drawdown */}
                  <div className="bg-card rounded-xl border border-border p-4">
                    <h3 className="text-sm font-semibold text-foreground/80 mb-2">回撤分佈</h3>
                    <div className="relative h-32 flex items-start gap-[1px]">
                      {ddData.map((d, i) => {
                        const h = ddY(d.dd);
                        return (
                          <div key={i} className="flex-1 min-w-[2px]" title={`${d.date}: ${fmt(d.dd)}%`}>
                            <div className="w-full bg-orange-500/70 rounded-b-sm" style={{ height: `${h}%` }} />
                          </div>
                        );
                      })}
                    </div>
                    <div className="flex justify-between text-[9px] text-muted-foreground mt-1">
                      <span>{ddData[0]?.date}</span>
                      <span className="font-bold text-orange-400">最大回撤 {fmt(maxDD)}%</span>
                      <span>{ddData[ddData.length - 1]?.date}</span>
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* ── Group Stats ── */}
            {groupStats.length > 0 && (
              <div className="bg-card rounded-xl border border-border p-4 space-y-3">
                <h3 className="text-sm font-semibold text-foreground/80">
                  {groupBy === 'month' ? '月份分組統計' : '六大條件分數分組統計'}
                </h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs min-w-[540px]">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="px-2 py-1.5 text-left text-muted-foreground">分組</th>
                        <th className="px-2 py-1.5 text-right text-muted-foreground">樣本數</th>
                        <th className="px-2 py-1.5 text-right text-muted-foreground">勝率</th>
                        <th className="px-2 py-1.5 text-right text-muted-foreground">平均淨報酬</th>
                        <th className="px-2 py-1.5 text-right text-muted-foreground">期望值</th>
                        <th className="px-2 py-1.5 text-right text-muted-foreground">最大虧損</th>
                        <th className="px-2 py-1.5 text-left text-muted-foreground w-32">勝率視覺化</th>
                      </tr>
                    </thead>
                    <tbody>
                      {groupStats.map(g => (
                        <tr key={g.label} className="border-b border-border/50 hover:bg-secondary/40 transition">
                          <td className="px-2 py-2 text-foreground/90 font-medium">{g.label}</td>
                          <td className="px-2 py-2 text-right text-foreground/80">{g.count}</td>
                          <td className={`px-2 py-2 text-right font-mono font-semibold ${g.winRate >= 50 ? 'text-bull' : 'text-bear'}`}>
                            {g.winRate.toFixed(1)}%
                          </td>
                          <td className={`px-2 py-2 text-right font-mono ${g.avgNet >= 0 ? 'text-bull' : 'text-bear'}`}>
                            {fmt(g.avgNet)}%
                          </td>
                          <td className={`px-2 py-2 text-right font-mono ${g.expectancy >= 0 ? 'text-bull' : 'text-bear'}`}>
                            {fmt(g.expectancy)}%
                          </td>
                          <td className="px-2 py-2 text-right font-mono text-orange-400">
                            {fmt(g.maxLoss)}%
                          </td>
                          <td className="px-2 py-2">
                            <div className="flex h-4 rounded overflow-hidden bg-secondary">
                              <div
                                className="bg-red-500/70 transition-all"
                                style={{ width: `${Math.min(g.winRate, 100)}%` }}
                              />
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ── Histogram ── */}
            <ReturnHistogram trades={filteredTrades} />

            {/* ── Trade Table ── */}
            <div className="bg-card rounded-xl border border-border p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-foreground/80">
                  詳細交易紀錄
                  <span className="ml-2 text-xs text-muted-foreground font-normal">（點欄位標題排序）</span>
                </h3>
                <span className="text-xs text-muted-foreground">{filteredTrades.length} 筆</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs min-w-[900px]">
                  <thead className="border-b border-border">
                    <tr>
                      <SortableHeader label="股票"    sortKey="symbol"     currentKey={sortKey} dir={sortDir} onClick={handleSort} />
                      <SortableHeader label="名稱"    sortKey="name"       currentKey={sortKey} dir={sortDir} onClick={handleSort} />
                      <th className="px-2 py-1.5 text-left text-xs font-semibold text-muted-foreground">市場</th>
                      <SortableHeader label="訊號日"  sortKey="signalDate" currentKey={sortKey} dir={sortDir} onClick={handleSort} />
                      <SortableHeader label="進場日"  sortKey="entryDate"  currentKey={sortKey} dir={sortDir} onClick={handleSort} />
                      <SortableHeader label="進場價"  sortKey="entryPrice" currentKey={sortKey} dir={sortDir} onClick={handleSort} />
                      <SortableHeader label="出場日"  sortKey="exitDate"   currentKey={sortKey} dir={sortDir} onClick={handleSort} />
                      <SortableHeader label="出場價"  sortKey="exitPrice"  currentKey={sortKey} dir={sortDir} onClick={handleSort} />
                      <th className="px-2 py-1.5 text-left text-xs font-semibold text-muted-foreground">出場原因</th>
                      <SortableHeader label="持有天"  sortKey="holdDays"   currentKey={sortKey} dir={sortDir} onClick={handleSort} />
                      <SortableHeader label="毛報酬"  sortKey="grossReturn" currentKey={sortKey} dir={sortDir} onClick={handleSort} />
                      <SortableHeader label="淨報酬"  sortKey="netReturn"  currentKey={sortKey} dir={sortDir} onClick={handleSort} />
                      <SortableHeader label="分數"    sortKey="signalScore" currentKey={sortKey} dir={sortDir} onClick={handleSort} />
                      <th className="px-2 py-1.5 text-left text-xs font-semibold text-muted-foreground">命中原因</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedTrades.map((t, i) => {
                      const isWin = t.netReturn > 0;
                      return (
                        <tr
                          key={`${t.symbol}-${t.signalDate}-${i}`}
                          className="border-b border-border/50 hover:bg-secondary/40 transition"
                        >
                          <td className="px-2 py-1.5 font-mono text-blue-400">{t.symbol}</td>
                          <td className="px-2 py-1.5 text-foreground/80 max-w-[80px] truncate">{t.name}</td>
                          <td className="px-2 py-1.5">
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                              t.market === 'TW' ? 'bg-blue-900/60 text-blue-300' : 'bg-red-900/60 text-red-300'
                            }`}>
                              {t.market}
                            </span>
                          </td>
                          <td className="px-2 py-1.5 font-mono text-muted-foreground">{t.signalDate}</td>
                          <td className="px-2 py-1.5 font-mono text-muted-foreground">{t.entryDate}</td>
                          <td className="px-2 py-1.5 font-mono text-foreground/80">{t.entryPrice}</td>
                          <td className="px-2 py-1.5 font-mono text-muted-foreground">{t.exitDate}</td>
                          <td className="px-2 py-1.5 font-mono text-foreground/80">{t.exitPrice}</td>
                          <td className="px-2 py-1.5">
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                              t.exitReason === 'stopLoss'   ? 'bg-green-900/60 text-green-300' :
                              t.exitReason === 'takeProfit' ? 'bg-red-900/60 text-red-300'    :
                              t.exitReason === 'dataEnd'    ? 'bg-yellow-900/60 text-yellow-300' :
                              'bg-muted/60 text-foreground/80'
                            }`}>
                              {exitReasonLabel(t.exitReason)}
                            </span>
                          </td>
                          <td className="px-2 py-1.5 text-center text-muted-foreground">{t.holdDays}</td>
                          <td className={`px-2 py-1.5 font-mono font-semibold text-right ${t.grossReturn >= 0 ? 'text-bull' : 'text-bear'}`}>
                            {fmt(t.grossReturn)}%
                          </td>
                          <td className={`px-2 py-1.5 font-mono font-bold text-right ${isWin ? 'text-bull' : 'text-bear'}`}>
                            {fmt(t.netReturn)}%
                          </td>
                          <td className="px-2 py-1.5 text-center">
                            <span className={`px-1.5 py-0.5 rounded font-bold text-[11px] ${
                              t.signalScore >= 5 ? 'bg-yellow-600/40 text-yellow-300' :
                              t.signalScore >= 4 ? 'bg-blue-700/40 text-blue-300'    :
                              'bg-muted/40 text-muted-foreground'
                            }`}>
                              {t.signalScore}
                            </span>
                          </td>
                          <td className="px-2 py-1.5 text-muted-foreground max-w-[140px] truncate" title={t.signalReasons.join('、')}>
                            {t.signalReasons.join('、')}
                          </td>
                        </tr>
                      );
                    })}
                    {sortedTrades.length === 0 && (
                      <tr>
                        <td colSpan={14} className="text-center py-8 text-slate-600">
                          此條件下無交易紀錄
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* ── Session list (sidebar info) ── */}
            <div className="bg-card rounded-xl border border-border p-4 space-y-2">
              <h3 className="text-sm font-semibold text-foreground/80">回測 Session 清單 ({sessions.length})</h3>
              <div className="space-y-1.5 max-h-60 overflow-y-auto">
                {(sessions as BacktestSession[]).map(s => (
                  <div key={s.id} className="flex items-center justify-between text-xs px-3 py-2 bg-secondary/50 rounded-lg border border-border/50">
                    <div className="flex items-center gap-3">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                        s.market === 'TW' ? 'bg-blue-900/60 text-blue-300' : 'bg-red-900/60 text-red-300'
                      }`}>{s.market}</span>
                      <span className="text-foreground/80 font-mono">{s.scanDate}</span>
                      {s.strategyVersion && (
                        <span className="text-slate-600 hidden sm:inline">{s.strategyVersion}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-muted-foreground">
                      <span>{s.trades?.length ?? 0} 筆</span>
                      {s.stats && (
                        <span className={s.stats.winRate >= 50 ? 'text-bull' : 'text-bear'}>
                          勝率 {s.stats.winRate.toFixed(1)}%
                        </span>
                      )}
                      <span className="text-slate-700">{new Date(s.createdAt).toLocaleDateString('zh-TW')}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

          </>
        )}
      </main>
    </div>
  );
}
