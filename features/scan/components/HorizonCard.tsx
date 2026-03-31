'use client';

import { BacktestHorizon } from '@/store/backtestStore';
import { StockForwardPerformance } from '@/lib/scanner/types';
import { calcBacktestSummary } from '@/lib/backtest/ForwardAnalyzer';
import { retColor, fmtRet } from '../utils';

export function HorizonCard({ label, horizon, performance }: {
  label: string; horizon: BacktestHorizon; performance: StockForwardPerformance[];
}) {
  const stats = calcBacktestSummary(performance, horizon);
  if (!stats) return (
    <div className="bg-slate-800/50 rounded-lg p-2.5 flex flex-col items-center justify-center gap-1 opacity-40 min-h-[80px]">
      <div className="text-[10px] text-slate-400">{label}</div>
      <div className="text-slate-500 text-xs">–</div>
    </div>
  );
  return (
    <div className="bg-slate-800 rounded-lg p-2.5 flex flex-col gap-1.5">
      <div className="text-[10px] text-slate-400 font-medium">{label}</div>
      <div className={`text-lg font-bold leading-tight ${retColor(stats.avgReturn)}`}>
        {fmtRet(stats.avgReturn)}
      </div>
      <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px]">
        <span className="text-slate-400">勝率</span>
        <span className={stats.winRate >= 50 ? 'text-red-400' : 'text-green-500'}>{stats.winRate}%</span>
        <span className="text-slate-400">中位</span>
        <span className={retColor(stats.median)}>{fmtRet(stats.median)}</span>
        <span className="text-slate-400">最高</span>
        <span className="text-red-400">+{stats.maxGain.toFixed(1)}%</span>
        <span className="text-slate-400">最低</span>
        <span className="text-green-500">{stats.maxLoss.toFixed(1)}%</span>
      </div>
    </div>
  );
}
