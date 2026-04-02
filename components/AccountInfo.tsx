'use client';

import { useReplayStore } from '@/store/replayStore';
import { formatCurrency, formatReturn } from '@/lib/engines/statsEngine';

export default function AccountInfo() {
  const { metrics, account, stats } = useReplayStore();

  const pnlClass = (v: number) => v > 0 ? 'text-bull' : v < 0 ? 'text-bear' : 'text-foreground/80';
  const pnlSign  = (v: number) => v > 0 ? '+' : '';

  return (
    <div className="bg-secondary/80 border border-border rounded-xl overflow-hidden">

      {/* ── Big 3 ── */}
      <div className="grid grid-cols-3 divide-x divide-border border-b border-border">
        <div className="px-3 py-3 text-center">
          <p className="text-[10px] text-muted-foreground mb-1">總資產</p>
          <p className="text-base font-bold font-mono text-yellow-400">
            ${formatCurrency(metrics.totalAssets)}
          </p>
        </div>
        <div className="px-3 py-3 text-center">
          <p className="text-[10px] text-muted-foreground mb-1">未實現損益</p>
          <p className={`text-base font-bold font-mono ${pnlClass(metrics.unrealizedPnL)}`}>
            {pnlSign(metrics.unrealizedPnL)}${formatCurrency(metrics.unrealizedPnL)}
          </p>
          {metrics.shares > 0 && metrics.avgCost > 0 && (
            <p className={`text-[10px] font-mono mt-0.5 ${pnlClass(metrics.unrealizedPnL)}`}>
              {pnlSign(metrics.unrealizedPnL)}{((metrics.unrealizedPnL / (metrics.shares * metrics.avgCost)) * 100).toFixed(2)}%
            </p>
          )}
        </div>
        <div className="px-3 py-3 text-center">
          <p className="text-[10px] text-muted-foreground mb-1">總報酬率</p>
          <p className={`text-base font-bold font-mono ${pnlClass(metrics.returnRate)}`}>
            {formatReturn(metrics.returnRate)}
          </p>
        </div>
      </div>

      {/* ── Detail rows ── */}
      <div className="px-3 py-2 space-y-0">
        {[
          { label: '初始本金',  value: `$${formatCurrency(account.initialCapital)}` },
          { label: '現金餘額',  value: `$${formatCurrency(metrics.cash)}` },
          ...(metrics.shares > 0 ? [
            { label: '持倉股數', value: `${metrics.shares.toLocaleString()} 股` },
            { label: '持倉均價', value: `$${metrics.avgCost.toFixed(2)}`, cls: 'text-yellow-400' },
            { label: '持倉市值', value: `$${formatCurrency(metrics.holdingValue)}` },
          ] : []),
          { label: '已實現損益', value: `${pnlSign(metrics.realizedPnL)}$${formatCurrency(metrics.realizedPnL)}`, cls: pnlClass(metrics.realizedPnL) },
        ].map(({ label, value, cls = 'text-foreground' }) => (
          <div key={label} className="flex justify-between items-center py-1 border-b border-border/50 last:border-0">
            <span className="text-xs text-muted-foreground">{label}</span>
            <span className={`text-xs font-mono font-bold ${cls}`}>{value}</span>
          </div>
        ))}
      </div>

      {/* ── Stats ── */}
      <div className="border-t border-border px-3 py-2">
        {stats.totalTrades > 0 ? (
          <>
            <p className="text-[10px] text-muted-foreground mb-1.5 uppercase tracking-wide">績效統計</p>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div>
                <p className="text-xs font-bold text-foreground">{stats.totalTrades}</p>
                <p className="text-[10px] text-muted-foreground">交易筆數</p>
              </div>
              <div>
                <p className={`text-xs font-bold ${stats.winRate >= 0.5 ? 'text-bull' : 'text-bear'}`}>
                  {(stats.winRate * 100).toFixed(1)}%
                </p>
                <p className="text-[10px] text-muted-foreground">勝率</p>
              </div>
              <div>
                <p className="text-xs font-bold text-foreground">{stats.winCount}勝 {stats.lossCount}敗</p>
                <p className="text-[10px] text-muted-foreground">勝/負</p>
              </div>
            </div>
          </>
        ) : (
          <p className="text-[10px] text-muted-foreground text-center py-1">
            尚未交易 — 在下方交易面板買入開始練習
          </p>
        )}
      </div>
    </div>
  );
}
