'use client';

import { useABTestStore } from '@/store/abTestStore';
import { BacktestStats } from '@/lib/backtest/BacktestEngine';
import { retColor, fmtRet } from '../utils';

// ── Kpi Cell ────────────────────────────────────────────────────────────────────

function Kpi({ label, value, color, winner }: {
  label: string; value: string; color: string; winner?: boolean;
}) {
  return (
    <div className={`flex flex-col gap-0.5 p-3 rounded-lg ${winner ? 'bg-amber-500/10 ring-1 ring-amber-500/30' : ''}`}>
      <div className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</div>
      <div className={`text-lg font-bold leading-tight ${color}`}>
        {value}
        {winner && <span className="ml-1 text-[10px] text-amber-400">★</span>}
      </div>
    </div>
  );
}

// ── Stats Card ──────────────────────────────────────────────────────────────────

function StatsCard({ title, accent, stats, winnerMetrics }: {
  title: string;
  accent: string;
  stats: BacktestStats | null;
  winnerMetrics: Set<string>;
}) {
  if (!stats) {
    return (
      <div className="flex-1 bg-card border border-border rounded-xl p-5">
        <div className="flex items-center gap-2 mb-3">
          <div className={`w-1.5 h-4 rounded-full ${accent}`} />
          <h4 className="text-sm font-semibold text-foreground">{title}</h4>
        </div>
        <div className="text-sm text-muted-foreground">無交易數據</div>
      </div>
    );
  }

  return (
    <div className="flex-1 bg-card border border-border rounded-xl overflow-hidden">
      <div className="px-5 py-3 border-b border-border bg-secondary/30 flex items-center gap-2">
        <div className={`w-1.5 h-4 rounded-full ${accent}`} />
        <h4 className="text-sm font-semibold text-foreground">{title}</h4>
        <span className="ml-auto text-xs text-muted-foreground">{stats.count} 筆交易</span>
      </div>
      <div className="grid grid-cols-3 gap-1 p-2">
        <Kpi label="勝率" value={`${stats.winRate}%`}
          color={stats.winRate >= 50 ? 'text-bull' : 'text-bear'}
          winner={winnerMetrics.has('winRate')} />
        <Kpi label="平均報酬" value={fmtRet(stats.avgNetReturn)}
          color={retColor(stats.avgNetReturn)}
          winner={winnerMetrics.has('avgNetReturn')} />
        <Kpi label="最大回撤" value={`${stats.maxDrawdown.toFixed(1)}%`}
          color={stats.maxDrawdown >= -5 ? 'text-foreground/80' : 'text-bear'}
          winner={winnerMetrics.has('maxDrawdown')} />
        <Kpi label="Sharpe" value={stats.sharpeRatio?.toFixed(2) ?? '–'}
          color={stats.sharpeRatio != null && stats.sharpeRatio > 0.5 ? 'text-bull' : 'text-foreground/80'}
          winner={winnerMetrics.has('sharpeRatio')} />
        <Kpi label="獲利因子" value={stats.profitFactor?.toFixed(2) ?? '–'}
          color={stats.profitFactor != null && stats.profitFactor > 1.5 ? 'text-bull' : 'text-foreground/80'}
          winner={winnerMetrics.has('profitFactor')} />
        <Kpi label="期望值" value={stats.expectancy.toFixed(2)}
          color={retColor(stats.expectancy)}
          winner={winnerMetrics.has('expectancy')} />
      </div>
    </div>
  );
}

// ── Dual Equity Curve ───────────────────────────────────────────────────────────

function DualEquityCurve({ perDateStats }: {
  perDateStats: Array<{ date: string; groupATop1Return: number | null; groupBTop1Return: number | null }>;
}) {
  // Build cumulative equity for both groups
  let eqA = 0;
  let eqB = 0;
  const pointsA: number[] = [0];
  const pointsB: number[] = [0];
  const dates: string[] = [''];

  for (const d of perDateStats) {
    eqA += d.groupATop1Return ?? 0;
    eqB += d.groupBTop1Return ?? 0;
    pointsA.push(eqA);
    pointsB.push(eqB);
    dates.push(d.date);
  }

  if (pointsA.length < 3) return null;

  const allPoints = [...pointsA, ...pointsB];
  const min = Math.min(...allPoints);
  const max = Math.max(...allPoints);
  const range = max - min || 1;
  const W = 500;
  const H = 80;
  const pad = 4;

  const toX = (i: number) => (i / (pointsA.length - 1)) * W;
  const toY = (v: number) => H - pad - ((v - min) / range) * (H - pad * 2);

  const buildPath = (points: number[]) =>
    points.map((v, i) => `${i === 0 ? 'M' : 'L'} ${toX(i).toFixed(1)} ${toY(v).toFixed(1)}`).join(' ');

  const pathA = buildPath(pointsA);
  const pathB = buildPath(pointsB);
  const finalA = pointsA[pointsA.length - 1];
  const finalB = pointsB[pointsB.length - 1];
  const zeroY = toY(0);

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="px-5 py-3 border-b border-border bg-secondary/30 flex items-center justify-between">
        <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">累積報酬曲線</h4>
        <div className="flex items-center gap-4 text-xs">
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-0.5 rounded bg-orange-400" />
            <span className="text-muted-foreground">A: 最大量</span>
            <span className={finalA >= 0 ? 'text-bull' : 'text-bear'}>
              {finalA >= 0 ? '+' : ''}{finalA.toFixed(1)}%
            </span>
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-0.5 rounded bg-sky-400" />
            <span className="text-muted-foreground">B: 系統#1</span>
            <span className={finalB >= 0 ? 'text-bull' : 'text-bear'}>
              {finalB >= 0 ? '+' : ''}{finalB.toFixed(1)}%
            </span>
          </span>
        </div>
      </div>
      <div className="p-5">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-20" preserveAspectRatio="none">
          {min < 0 && max > 0 && (
            <line x1="0" y1={zeroY.toFixed(1)} x2={W} y2={zeroY.toFixed(1)}
              stroke="#334155" strokeWidth="1" strokeDasharray="4,3" />
          )}
          <path d={pathA} stroke="#fb923c" strokeWidth="1.5" fill="none" strokeLinejoin="round" />
          <path d={pathB} stroke="#38bdf8" strokeWidth="1.5" fill="none" strokeLinejoin="round" />
        </svg>
      </div>
    </div>
  );
}

// ── Per-Date Table ──────────────────────────────────────────────────────────────

function PerDateTable({ perDateStats }: {
  perDateStats: Array<{
    date: string;
    groupATop1Return: number | null;
    groupBTop1Return: number | null;
    groupASignals: number;
    groupBSignals: number;
  }>;
}) {
  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="px-5 py-3 border-b border-border bg-secondary/30">
        <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">逐日明細</h4>
      </div>
      <div className="max-h-[400px] overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-secondary/90 backdrop-blur">
            <tr className="text-muted-foreground uppercase tracking-wide">
              <th className="text-left px-4 py-2">日期</th>
              <th className="text-right px-3 py-2">A 訊號數</th>
              <th className="text-right px-3 py-2">A 報酬</th>
              <th className="text-right px-3 py-2">B 訊號數</th>
              <th className="text-right px-3 py-2">B 報酬</th>
              <th className="text-center px-3 py-2">勝者</th>
            </tr>
          </thead>
          <tbody>
            {perDateStats.map(d => {
              const aRet = d.groupATop1Return;
              const bRet = d.groupBTop1Return;
              let winner = '–';
              if (aRet != null && bRet != null) {
                winner = aRet > bRet ? 'A' : bRet > aRet ? 'B' : '平';
              } else if (aRet != null) {
                winner = 'A';
              } else if (bRet != null) {
                winner = 'B';
              }

              return (
                <tr key={d.date} className="border-t border-border/50 hover:bg-secondary/30">
                  <td className="px-4 py-2 text-foreground/80 font-mono">{d.date}</td>
                  <td className="text-right px-3 py-2 text-muted-foreground">{d.groupASignals}</td>
                  <td className={`text-right px-3 py-2 font-mono ${retColor(aRet)}`}>
                    {aRet != null ? fmtRet(aRet) : '無訊號'}
                  </td>
                  <td className="text-right px-3 py-2 text-muted-foreground">{d.groupBSignals}</td>
                  <td className={`text-right px-3 py-2 font-mono ${retColor(bRet)}`}>
                    {bRet != null ? fmtRet(bRet) : '無訊號'}
                  </td>
                  <td className="text-center px-3 py-2">
                    <span className={`text-xs font-bold ${
                      winner === 'A' ? 'text-orange-400'
                        : winner === 'B' ? 'text-sky-400'
                          : 'text-muted-foreground/60'
                    }`}>{winner}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Main Panel ──────────────────────────────────────────────────────────────────

export function ABTestPanel() {
  const {
    market, fromDate, toDate, sampleInterval,
    isRunning, progress, statusMessage, error, result,
    setMarket, setFromDate, setToDate, setSampleInterval,
    runTest, clearResult,
  } = useABTestStore();

  // Determine winner metrics for each strategy
  const winnerMetricsA = new Set<string>();
  const winnerMetricsB = new Set<string>();
  if (result) {
    const topN1 = result.topNResults.find(r => r.topN === 1);
    if (topN1?.groupA && topN1?.groupB) {
      const a = topN1.groupA;
      const b = topN1.groupB;
      const check = (key: string, aVal: number | null, bVal: number | null, higherWins = true) => {
        if (aVal == null || bVal == null) return;
        if (Math.abs(aVal - bVal) < 0.001) return;
        const aWins = higherWins ? aVal > bVal : aVal < bVal;
        if (aWins) winnerMetricsA.add(key);
        else winnerMetricsB.add(key);
      };
      check('winRate', a.winRate, b.winRate);
      check('avgNetReturn', a.avgNetReturn, b.avgNetReturn);
      check('maxDrawdown', a.maxDrawdown, b.maxDrawdown, false); // 回撤小的贏
      check('sharpeRatio', a.sharpeRatio, b.sharpeRatio);
      check('profitFactor', a.profitFactor, b.profitFactor);
      check('expectancy', a.expectancy, b.expectancy);
    }
  }

  const topN1 = result?.topNResults.find(r => r.topN === 1);
  const aWinCount = winnerMetricsA.size;
  const bWinCount = winnerMetricsB.size;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="bg-secondary/40 border border-border/60 rounded-xl px-5 py-4 space-y-2">
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-4 rounded-full bg-amber-500" />
          <h3 className="text-sm font-semibold text-foreground">A/B 策略比較回測</h3>
          <span className="ml-auto text-xs text-muted-foreground">朱SOP+最大量 vs 系統第一名</span>
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          策略A：朱老師六條件篩選 → 選成交量最大的1檔。
          策略B：完整多因子系統 → 選 compositeScore 最高的1檔。
          兩者都用朱老師獲利方程式出場，差異只在選股邏輯。
        </p>
      </div>

      {/* Config */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-border bg-secondary/30">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">回測參數</h4>
        </div>
        <div className="p-5 flex flex-wrap items-end gap-4">
          {/* Market */}
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground font-medium">市場</label>
            <select value={market} onChange={e => setMarket(e.target.value as 'TW' | 'CN')}
              className="bg-secondary border border-border text-foreground rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-amber-500"
              disabled={isRunning}>
              <option value="TW">台股</option>
              <option value="CN">陸股</option>
            </select>
          </div>

          {/* Date range */}
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground font-medium">開始日期</label>
            <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
              className="bg-secondary border border-border text-foreground rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-amber-500"
              disabled={isRunning} />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground font-medium">結束日期</label>
            <input type="date" value={toDate} onChange={e => setToDate(e.target.value)}
              className="bg-secondary border border-border text-foreground rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-amber-500"
              disabled={isRunning} />
          </div>

          {/* Sample interval */}
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground font-medium">取樣間隔</label>
            <select value={sampleInterval} onChange={e => setSampleInterval(+e.target.value)}
              className="bg-secondary border border-border text-foreground rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-amber-500"
              disabled={isRunning}>
              <option value={1}>每日</option>
              <option value={5}>每週</option>
              <option value={10}>每兩週</option>
            </select>
            <div className="text-[10px] text-muted-foreground/60">每 N 個交易日取樣</div>
          </div>

          {/* Run button */}
          <div className="ml-auto flex items-center gap-2">
            {result && (
              <button onClick={clearResult}
                className="px-3 py-2 text-xs text-muted-foreground hover:text-foreground rounded-lg border border-border hover:border-border transition"
                disabled={isRunning}>
                清除
              </button>
            )}
            <button onClick={runTest} disabled={isRunning}
              className="px-5 py-2 text-sm font-medium bg-amber-600 hover:bg-amber-500 disabled:bg-muted disabled:text-muted-foreground text-white rounded-lg transition">
              {isRunning ? '執行中...' : '開始比較'}
            </button>
          </div>
        </div>

        {/* Progress */}
        {isRunning && (
          <div className="px-5 pb-4 space-y-1">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{statusMessage}</span>
              <span>{progress}%</span>
            </div>
            <div className="w-full h-1.5 bg-secondary rounded-full overflow-hidden">
              <div className="h-full bg-amber-500 rounded-full transition-all duration-300"
                style={{ width: `${progress}%` }} />
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="mx-5 mb-4 px-4 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-xs text-red-400">
            {error}
          </div>
        )}
      </div>

      {/* Results */}
      {result && topN1 && (
        <>
          {/* Winner summary */}
          <div className="text-center py-2">
            <span className="text-sm text-muted-foreground">
              {aWinCount > bWinCount ? (
                <><span className="text-orange-400 font-bold">策略A（最大量）</span>在 {aWinCount}/6 項指標勝出</>
              ) : bWinCount > aWinCount ? (
                <><span className="text-sky-400 font-bold">策略B（系統#1）</span>在 {bWinCount}/6 項指標勝出</>
              ) : (
                <>兩策略平手（各 {aWinCount}/6 項）</>
              )}
            </span>
            <span className="text-xs text-muted-foreground/60 ml-2">
              共分析 {result.datesAnalyzed} 個交易日
            </span>
          </div>

          {/* Side-by-side stats cards */}
          <div className="flex gap-4">
            <StatsCard title="A: 朱SOP + 最大量" accent="bg-orange-400"
              stats={topN1.groupA} winnerMetrics={winnerMetricsA} />
            <StatsCard title="B: 系統第一名" accent="bg-sky-400"
              stats={topN1.groupB} winnerMetrics={winnerMetricsB} />
          </div>

          {/* Equity curves */}
          <DualEquityCurve perDateStats={result.perDateStats} />

          {/* Per-date table */}
          <PerDateTable perDateStats={result.perDateStats} />
        </>
      )}
    </div>
  );
}
