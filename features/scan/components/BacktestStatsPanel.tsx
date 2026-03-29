'use client';

import type { BacktestStats, BacktestTrade } from '@/lib/backtest/BacktestEngine';
import { retColor, fmtRet } from '../utils';

// ── Kpi cell ─────────────────────────────────────────────────────────────────

function Kpi({ label, value, color, subtext }: {
  label: string; value: string; color: string; subtext?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 p-4">
      <div className="text-[10px] text-slate-500 uppercase tracking-wide">{label}</div>
      <div className={`text-lg font-bold leading-tight ${color}`}>{value}</div>
      {subtext && <div className="text-[10px] text-slate-600 mt-0.5">{subtext}</div>}
    </div>
  );
}

// ── Equity curve mini chart ───────────────────────────────────────────────────

export function EquityCurveMini({ trades }: { trades: BacktestTrade[] }) {
  if (trades.length < 2) return null;

  const sorted = [...trades].sort((a, b) => a.exitDate.localeCompare(b.exitDate));
  const points: number[] = [0];
  let eq = 0;
  for (const t of sorted) {
    eq += t.netReturn;
    points.push(eq);
  }

  const min   = Math.min(...points);
  const max   = Math.max(...points);
  const range = max - min || 1;
  const W = 400; const H = 52; const pad = 2;

  const toX = (i: number) => (i / (points.length - 1)) * W;
  const toY = (v: number) => H - pad - ((v - min) / range) * (H - pad * 2);

  const pathD = points.map((v, i) => `${i === 0 ? 'M' : 'L'} ${toX(i).toFixed(1)} ${toY(v).toFixed(1)}`).join(' ');
  const areaD = `${pathD} L ${W} ${H} L 0 ${H} Z`;
  const final = points[points.length - 1];
  const color = final >= 0 ? '#f87171' : '#4ade80';
  const zeroY = toY(0);

  return (
    <div className="px-5 py-3 border-t border-slate-800 bg-slate-900/40">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] text-slate-500 uppercase tracking-wide">累積淨報酬曲線</span>
        <span className={`text-xs font-bold tabular-nums ${final >= 0 ? 'text-red-400' : 'text-green-500'}`}>
          {final >= 0 ? '+' : ''}{final.toFixed(1)}% 累積
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-12" preserveAspectRatio="none">
        <defs>
          <linearGradient id="eq-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.25" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {min < 0 && max > 0 && (
          <line x1="0" y1={zeroY.toFixed(1)} x2={W} y2={zeroY.toFixed(1)}
            stroke="#334155" strokeWidth="1" strokeDasharray="4,3" />
        )}
        <path d={areaD} fill="url(#eq-grad)" />
        <path d={pathD} stroke={color} strokeWidth="1.5" fill="none" strokeLinejoin="round" />
        <circle cx={toX(0).toFixed(1)} cy={toY(0).toFixed(1)} r="2" fill="#64748b" />
        <circle cx={toX(points.length - 1).toFixed(1)} cy={toY(final).toFixed(1)} r="2.5" fill={color} />
      </svg>
    </div>
  );
}

// ── Strict stats panel ────────────────────────────────────────────────────────

interface BacktestStatsPanelProps {
  stats: BacktestStats;
  tradesCount: number;
  trades: BacktestTrade[];
}

export function BacktestStatsPanel({ stats, tradesCount, trades }: BacktestStatsPanelProps) {
  const winColor = stats.winRate >= 50 ? 'text-red-400' : 'text-green-500';
  return (
    <div className="bg-slate-900 border border-slate-700/60 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-slate-800 bg-slate-800/40">
        <div className="w-1.5 h-4 rounded-full bg-sky-500" />
        <h3 className="text-sm font-semibold text-slate-100">嚴謹回測統計（含成本）</h3>
        <div className="ml-auto flex items-center gap-3 text-xs text-slate-400">
          <span>{tradesCount} 筆</span>
          <span className={`font-bold text-sm ${winColor}`}>勝率 {stats.winRate}%</span>
          <span className={`font-bold text-sm ${retColor(stats.avgNetReturn)}`}>均值 {fmtRet(stats.avgNetReturn)}</span>
        </div>
      </div>

      {/* Reliability warnings */}
      {tradesCount < 30 && (
        <div className="px-5 py-2.5 bg-amber-950/40 border-b border-amber-800/40 flex items-center gap-2">
          <span className="text-amber-400 text-sm">!</span>
          <span className="text-[11px] text-amber-300/90">
            樣本數僅 {tradesCount} 筆（建議 ≥ 30 筆），統計結果參考價值有限
          </span>
        </div>
      )}
      {stats.sharpeRatio != null && stats.sharpeRatio < 0.5 && tradesCount >= 10 && (
        <div className="px-5 py-2 bg-red-950/30 border-b border-red-800/30 flex items-center gap-2">
          <span className="text-red-400 text-sm">!</span>
          <span className="text-[11px] text-red-300/80">
            Sharpe Ratio {stats.sharpeRatio.toFixed(2)} 偏低（&lt;0.5），風險調整後報酬不佳
          </span>
        </div>
      )}

      {/* KPI grid */}
      <div className="grid grid-cols-3 sm:grid-cols-5 divide-x divide-y divide-slate-800/60">
        <Kpi label="淨報酬均值"   value={fmtRet(stats.avgNetReturn)}   color={retColor(stats.avgNetReturn)} />
        <Kpi label="毛報酬均值"   value={fmtRet(stats.avgGrossReturn)} color={retColor(stats.avgGrossReturn)} />
        <Kpi label="中位數報酬"   value={fmtRet(stats.medianReturn)}   color={retColor(stats.medianReturn)} />
        <Kpi label="最大單筆獲利" value={fmtRet(stats.maxGain)}        color="text-red-400" />
        <Kpi label="最大單筆虧損" value={fmtRet(stats.maxLoss)}        color="text-green-500" />
        <Kpi label="期望值"       value={fmtRet(stats.expectancy)}     color={retColor(stats.expectancy)} subtext="每筆平均" />
        <Kpi label="最大回撤 MDD" value={fmtRet(stats.maxDrawdown)}    color="text-green-500" subtext="峰值到谷值" />
        <Kpi label="勝 / 負筆數"  value={`${stats.wins} / ${stats.losses}`} color="text-slate-200" />
        <Kpi label="淨報酬加總"   value={fmtRet(stats.totalNetReturn)} color={retColor(stats.totalNetReturn)} subtext="非複利" />
        <Kpi label="勝率"         value={`${stats.winRate}%`}           color={winColor} />
      </div>

      {/* Risk metrics footer */}
      <div className="border-t border-slate-800 px-5 py-3 flex flex-wrap gap-6 bg-slate-800/20">
        {[
          { label: 'Sharpe Ratio',  val: stats.sharpeRatio?.toFixed(2), color: retColor(stats.sharpeRatio) },
          { label: 'Profit Factor', val: stats.profitFactor?.toFixed(2), color: stats.profitFactor != null ? (stats.profitFactor >= 1 ? 'text-red-400' : 'text-green-500') : 'text-slate-500' },
          { label: 'Payoff Ratio',  val: stats.payoffRatio?.toFixed(2),  color: stats.payoffRatio != null ? (stats.payoffRatio >= 1 ? 'text-red-400' : 'text-slate-400') : 'text-slate-500' },
        ].map(({ label, val, color }) => (
          <div key={label} className="flex items-center gap-2">
            <span className="text-[10px] text-slate-500 uppercase tracking-wide">{label}</span>
            <span className={`text-sm font-bold ${val ? color : 'text-slate-500'}`}>{val ?? '–'}</span>
          </div>
        ))}
        <div className="flex items-center gap-2 ml-auto">
          <span className="text-[10px] text-slate-500 uppercase tracking-wide">覆蓋率</span>
          <span className={`text-sm font-semibold ${stats.coverageRate >= 90 ? 'text-slate-300' : 'text-amber-400'}`}>
            {stats.coverageRate}%
          </span>
          {stats.skippedCount > 0 && (
            <span className="text-[10px] text-slate-600">（跳過 {stats.skippedCount} 筆）</span>
          )}
        </div>
      </div>

      {/* Market comparison note */}
      {stats.avgNetReturn != null && (
        <div className="px-5 py-2 bg-slate-800/30 border-t border-slate-800/50 text-[11px] text-slate-500">
          提醒：回測績效需與同期大盤表現對比才有意義。
        </div>
      )}

      {/* Cost model */}
      <div className="px-5 py-2 border-t border-slate-800/50 text-[10px] text-slate-600 flex flex-wrap gap-x-4 gap-y-0.5">
        <span>台股：手續費 0.1425%×0.6 + 證交稅 0.3%</span>
        <span>陸股：佣金 0.025% + 印花稅 0.1%</span>
        <span>滑點 0.1%（買高賣低）</span>
      </div>

      <EquityCurveMini trades={trades} />
    </div>
  );
}
