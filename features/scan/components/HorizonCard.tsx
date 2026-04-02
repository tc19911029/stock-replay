'use client';

import { BacktestHorizon } from '@/store/backtestStore';
import { StockForwardPerformance } from '@/lib/scanner/types';
import { calcBacktestSummary } from '@/lib/backtest/ForwardAnalyzer';
import { retColor, fmtRet } from '../utils';

/** 根據 horizon key 取得所需的最少交易日數 */
function requiredDays(horizon: BacktestHorizon): number {
  if (horizon === 'open') return 1;
  const m = horizon.match(/^d(\d+)$/);
  return m ? Number(m[1]) : 1;
}

/** 粗估掃描日到今天之間的交易日數（排除週末，不含假日） */
function estimateTradingDays(scanDate: string): number {
  const start = new Date(scanDate);
  const now = new Date();
  const utc8 = new Date(now.getTime() + 8 * 3600_000);
  let count = 0;
  const d = new Date(start);
  d.setDate(d.getDate() + 1); // start from day after scan
  while (d <= utc8) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) count++;
    d.setDate(d.getDate() + 1);
  }
  return count;
}

export function HorizonCard({ label, horizon, performance, scanDate }: {
  label: string; horizon: BacktestHorizon; performance: StockForwardPerformance[];
  scanDate?: string;
}) {
  const stats = calcBacktestSummary(performance, horizon);
  if (!stats) {
    const notYet = scanDate && estimateTradingDays(scanDate) < requiredDays(horizon);
    return (
      <div className="bg-secondary/50 rounded-lg p-2.5 flex flex-col items-center justify-center gap-1 opacity-40 min-h-[80px]">
        <div className="text-[10px] text-muted-foreground">{label}</div>
        <div className="text-muted-foreground text-xs">{notYet ? '尚未到期' : '–'}</div>
      </div>
    );
  }
  return (
    <div className="bg-secondary rounded-lg p-2.5 flex flex-col gap-1.5">
      <div className="text-[10px] text-muted-foreground font-medium">{label}</div>
      <div className={`text-lg font-bold leading-tight ${retColor(stats.avgReturn)}`}>
        {fmtRet(stats.avgReturn)}
      </div>
      <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px]">
        <span className="text-muted-foreground">勝率</span>
        <span className={stats.winRate >= 50 ? 'text-bull' : 'text-bear'}>{stats.winRate}%</span>
        <span className="text-muted-foreground">中位</span>
        <span className={retColor(stats.median)}>{fmtRet(stats.median)}</span>
        <span className="text-muted-foreground">最高</span>
        <span className="text-bull">+{stats.maxGain.toFixed(1)}%</span>
        <span className="text-muted-foreground">最低</span>
        <span className="text-bear">{stats.maxLoss.toFixed(1)}%</span>
      </div>
    </div>
  );
}
