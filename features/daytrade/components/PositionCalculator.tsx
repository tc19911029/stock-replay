'use client';

import { useState, useMemo } from 'react';

interface CalcResult {
  shares: number;        // 股數（整百張換算）
  lots: number;          // 張數
  totalCost: number;     // 總成本（元）
  maxLoss: number;       // 最大虧損（元）
  riskRatio: number;     // 帳戶風險比例 %
  rewardRisk: number;    // 報酬風險比
}

function fmtTWD(v: number) {
  return v.toLocaleString('zh-TW', { maximumFractionDigits: 0 });
}

export function PositionCalculator() {
  const [accountSize, setAccountSize] = useState(1_000_000);   // 帳戶資金（元）
  const [riskPct, setRiskPct] = useState(1);                   // 每筆風險 %
  const [entryPrice, setEntryPrice] = useState(0);             // 進場價
  const [stopLossPrice, setStopLossPrice] = useState(0);       // 停損價
  const [takeProfitPrice, setTakeProfitPrice] = useState(0);   // 停利價

  const result = useMemo<CalcResult | null>(() => {
    if (entryPrice <= 0 || stopLossPrice <= 0) return null;
    if (stopLossPrice >= entryPrice) return null;  // 做多：停損必須低於進場

    const riskPerShare = entryPrice - stopLossPrice;
    const maxLossPerTrade = accountSize * (riskPct / 100);
    const rawShares = maxLossPerTrade / riskPerShare;

    // 台股一張 = 1000 股，向下取整到整張
    const lots = Math.max(1, Math.floor(rawShares / 1000));
    const shares = lots * 1000;
    const totalCost = shares * entryPrice;
    const actualMaxLoss = shares * riskPerShare;
    const riskRatio = (actualMaxLoss / accountSize) * 100;

    let rewardRisk = 0;
    if (takeProfitPrice > entryPrice) {
      const profit = shares * (takeProfitPrice - entryPrice);
      rewardRisk = profit / actualMaxLoss;
    }

    return { shares, lots, totalCost, maxLoss: actualMaxLoss, riskRatio, rewardRisk };
  }, [accountSize, riskPct, entryPrice, stopLossPrice, takeProfitPrice]);

  const stopLossPct = entryPrice > 0 && stopLossPrice > 0
    ? ((stopLossPrice - entryPrice) / entryPrice * 100)
    : null;

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border bg-secondary/40">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">倉位計算器</span>
      </div>

      <div className="p-4 space-y-3">
        {/* Input grid */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-[10px] text-muted-foreground uppercase tracking-wide">帳戶資金（元）</label>
            <input
              type="number"
              value={accountSize}
              onChange={e => setAccountSize(Number(e.target.value))}
              className="w-full bg-secondary border border-border rounded-lg px-3 py-1.5 text-sm text-foreground focus:outline-none focus:border-sky-500 tabular-nums"
              min={0}
              step={100000}
            />
          </div>
          <div className="space-y-1">
            <label className="text-[10px] text-muted-foreground uppercase tracking-wide">每筆風險 (%)</label>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={0.5} max={3} step={0.5}
                value={riskPct}
                onChange={e => setRiskPct(Number(e.target.value))}
                className="flex-1 accent-sky-500"
              />
              <span className="text-sm font-bold text-sky-400 tabular-nums w-8 text-right">{riskPct}%</span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1">
            <label className="text-[10px] text-muted-foreground uppercase tracking-wide">進場價</label>
            <input
              type="number"
              value={entryPrice || ''}
              onChange={e => setEntryPrice(Number(e.target.value))}
              placeholder="0.00"
              className="w-full bg-secondary border border-border rounded-lg px-3 py-1.5 text-sm text-foreground focus:outline-none focus:border-sky-500 tabular-nums"
              min={0}
              step={0.01}
            />
          </div>
          <div className="space-y-1">
            <label className="text-[10px] text-muted-foreground uppercase tracking-wide flex items-center gap-1">
              停損價
              {stopLossPct != null && (
                <span className="text-bear font-mono">{stopLossPct.toFixed(1)}%</span>
              )}
            </label>
            <input
              type="number"
              value={stopLossPrice || ''}
              onChange={e => setStopLossPrice(Number(e.target.value))}
              placeholder="0.00"
              className="w-full bg-secondary border border-red-900/60 rounded-lg px-3 py-1.5 text-sm text-bear focus:outline-none focus:border-red-500 tabular-nums"
              min={0}
              step={0.01}
            />
          </div>
          <div className="space-y-1">
            <label className="text-[10px] text-muted-foreground uppercase tracking-wide">停利價（選填）</label>
            <input
              type="number"
              value={takeProfitPrice || ''}
              onChange={e => setTakeProfitPrice(Number(e.target.value))}
              placeholder="0.00"
              className="w-full bg-secondary border border-border rounded-lg px-3 py-1.5 text-sm text-bull focus:outline-none focus:border-sky-500 tabular-nums"
              min={0}
              step={0.01}
            />
          </div>
        </div>

        {/* Results */}
        {result ? (
          <div className="grid grid-cols-3 sm:grid-cols-6 border border-border/60 rounded-lg overflow-hidden">
            {[
              { label: '建議張數', value: `${result.lots} 張`, color: 'text-foreground font-bold' },
              { label: '建議股數', value: `${result.shares.toLocaleString()} 股`, color: 'text-foreground/80' },
              { label: '總成本', value: `$${fmtTWD(result.totalCost)}`, color: 'text-foreground/80' },
              { label: '最大虧損', value: `$${fmtTWD(result.maxLoss)}`, color: 'text-bear' },
              { label: '帳戶風險', value: `${result.riskRatio.toFixed(2)}%`, color: result.riskRatio > 2 ? 'text-amber-400' : 'text-sky-400' },
              { label: 'R:R', value: result.rewardRisk > 0 ? `1:${result.rewardRisk.toFixed(1)}` : '—', color: result.rewardRisk >= 2 ? 'text-bull' : 'text-muted-foreground' },
            ].map(({ label, value, color }) => (
              <div key={label} className="flex flex-col gap-0.5 px-3 py-2.5 border-r last:border-r-0 border-border/40">
                <div className="text-[9px] text-muted-foreground uppercase tracking-wide">{label}</div>
                <div className={`text-sm tabular-nums ${color}`}>{value}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-4 text-slate-600 text-xs">
            輸入進場價與停損價以計算建議張數
          </div>
        )}
      </div>
    </div>
  );
}
