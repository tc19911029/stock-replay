'use client';

import type { BacktestTrade } from '@/lib/backtest/BacktestEngine';
import type { CapitalConstraints } from '@/store/backtestStore';

interface CapitalPanelProps {
  trades: BacktestTrade[];
  constraints: CapitalConstraints;
  finalCapital: number | null;
  capitalReturn: number | null;
  skippedByCapital: number;
}

export function CapitalPanel({ trades, constraints, finalCapital, capitalReturn, skippedByCapital }: CapitalPanelProps) {
  if (trades.length === 0) return null;

  const capFinal  = finalCapital ?? constraints.initialCapital;
  const capReturn = capitalReturn ?? 0;
  const totalPnL  = capFinal - constraints.initialCapital;
  const capColor  = capReturn >= 0 ? 'text-bull' : 'text-bear';

  return (
    <div className="bg-amber-950/20 border border-amber-800/40 rounded-xl overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-amber-900/30 bg-amber-950/30">
        <div className="w-1.5 h-4 rounded-full bg-amber-500" />
        <span className="text-sm font-semibold text-amber-200">資本限制模擬</span>
        <span className="text-xs text-muted-foreground ml-1">
          {(constraints.initialCapital / 10000).toLocaleString('zh-TW')} 萬元 ×
          前 {constraints.maxPositions} 檔 ×
          每筆 {(constraints.positionSizePct * 100).toFixed(0)}%
        </span>
      </div>

      <div className="grid grid-cols-3 sm:grid-cols-5 divide-x divide-border/60">
        {[
          { label: '初始資金', value: `${(constraints.initialCapital / 10000).toFixed(0)}萬`, color: 'text-foreground/80' },
          { label: '最終資金', value: `${(capFinal / 10000).toFixed(1)}萬`, color: 'text-foreground' },
          { label: '資金報酬', value: `${capReturn >= 0 ? '+' : ''}${capReturn.toFixed(2)}%`, color: capColor },
          { label: '實際損益', value: `${totalPnL >= 0 ? '+' : ''}${Math.round(totalPnL).toLocaleString('zh-TW')} 元`, color: capColor },
          { label: '資本排除', value: `${skippedByCapital} 筆`, color: 'text-muted-foreground' },
        ].map(({ label, value, color }) => (
          <div key={label} className="flex flex-col gap-0.5 p-4">
            <div className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</div>
            <div className={`text-base font-bold ${color}`}>{value}</div>
          </div>
        ))}
      </div>

      {trades.length > 0 && (
        <div className="px-4 py-2 border-t border-amber-900/30 text-xs text-muted-foreground">
          入選：{trades.map(t => `${t.name}（${(t.netReturn >= 0 ? '+' : '') + t.netReturn.toFixed(1)}%）`).join('　')}
        </div>
      )}
    </div>
  );
}
