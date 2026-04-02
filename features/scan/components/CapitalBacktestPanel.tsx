'use client';

/**
 * CapitalBacktestPanel.tsx — 回測模式 B：資金模擬回測面板
 *
 * 功能：
 * - 設定初始資金、部位模式、排序因子、方向
 * - 傳入掃描結果 + 前瞻資料後呼叫 /api/backtest/capital
 * - 顯示：最終資金、總報酬%、勝率、最大回撤、Sharpe
 * - 顯示：權益曲線圖（SVG mini chart）
 * - 顯示：每筆交易明細表
 */

import { useState, useCallback } from 'react';
import type { ScanSession } from '@/lib/scanner/types';
import type { CapitalSimResult, CapitalSimTrade } from '@/lib/backtest/CapitalSimulator';
import { retColor, fmtRet } from '../utils';

// ── Types ─────────────────────────────────────────────────────────────────────

type RankingFactor = 'composite' | 'surge' | 'smartMoney' | 'histWinRate' | 'sixConditions';
type PositionMode  = 'full' | 'fixed_pct' | 'risk_based';

const FACTOR_LABELS: Record<RankingFactor, string> = {
  composite:     '複合評分',
  surge:         '飆股潛力',
  smartMoney:    '智慧資金',
  histWinRate:   '歷史勝率',
  sixConditions: '六條件分',
};

const POS_MODE_LABELS: Record<PositionMode, string> = {
  full:       '全倉',
  fixed_pct:  '固定比例',
  risk_based: '風險比例',
};

const CAPITAL_PRESETS = [100_000, 500_000, 1_000_000, 3_000_000];

// ── Sub-components ─────────────────────────────────────────────────────────────

function Kpi({ label, value, sub, color = 'text-foreground' }: {
  label: string; value: string; sub?: string; color?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 p-4 bg-secondary/60 rounded-lg border border-border/40">
      <div className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</div>
      <div className={`text-lg font-bold leading-tight ${color}`}>{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground/60 mt-0.5">{sub}</div>}
    </div>
  );
}

function EquityCurve({ curve }: { curve: CapitalSimResult['equityCurve'] }) {
  if (curve.length < 2) return null;
  const equities = curve.map(d => d.equity);
  const min   = Math.min(...equities);
  const max   = Math.max(...equities);
  const range = max - min || 1;
  const W = 500; const H = 64; const pad = 3;

  const toX = (i: number) => (i / (equities.length - 1)) * W;
  const toY = (v: number) => H - pad - ((v - min) / range) * (H - pad * 2);

  const pathD  = equities.map((v, i) => `${i === 0 ? 'M' : 'L'} ${toX(i).toFixed(1)} ${toY(v).toFixed(1)}`).join(' ');
  const areaD  = `${pathD} L ${W} ${H} L 0 ${H} Z`;
  const final  = equities[equities.length - 1];
  const color  = final >= (curve[0]?.equity ?? 0) ? '#f87171' : '#4ade80';

  return (
    <div className="px-4 py-3 bg-card/40 rounded-lg border border-border/30">
      <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-2">權益曲線</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-16" preserveAspectRatio="none">
        <path d={areaD} fill={color} fillOpacity="0.08" />
        <path d={pathD} stroke={color} strokeWidth="1.5" fill="none" />
      </svg>
      <div className="flex justify-between text-[9px] text-muted-foreground/60 mt-1">
        <span>{curve[0]?.date}</span>
        <span>{curve[curve.length - 1]?.date}</span>
      </div>
    </div>
  );
}

function TradeTable({ trades }: { trades: CapitalSimTrade[] }) {
  const shown = trades.slice(0, 30);
  if (shown.length === 0) return <p className="text-muted-foreground/60 text-sm py-4">無交易紀錄</p>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs text-foreground/80">
        <thead>
          <tr className="border-b border-border text-muted-foreground">
            <th className="py-2 pr-3 text-left">進場日</th>
            <th className="py-2 pr-3 text-left">代號</th>
            <th className="py-2 pr-3 text-right">進場價</th>
            <th className="py-2 pr-3 text-right">出場價</th>
            <th className="py-2 pr-3 text-center">天數</th>
            <th className="py-2 pr-3 text-right">毛報酬</th>
            <th className="py-2 pr-3 text-right">淨損益(元)</th>
            <th className="py-2 text-left">出場原因</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((t, i) => (
            <tr key={i} className="border-b border-border/60 hover:bg-secondary/30">
              <td className="py-1.5 pr-3 font-mono text-muted-foreground">{t.entryDate}</td>
              <td className="py-1.5 pr-3 font-medium">{t.symbol} <span className="text-muted-foreground">{t.name}</span></td>
              <td className="py-1.5 pr-3 text-right">{t.entryPrice.toFixed(2)}</td>
              <td className="py-1.5 pr-3 text-right">{t.exitPrice.toFixed(2)}</td>
              <td className="py-1.5 pr-3 text-center">{t.holdDays}</td>
              <td className={`py-1.5 pr-3 text-right ${retColor(t.grossReturn)}`}>{fmtRet(t.grossReturn)}</td>
              <td className={`py-1.5 pr-3 text-right ${retColor(t.pnlAmount)}`}>
                {t.pnlAmount >= 0 ? '+' : ''}{t.pnlAmount.toLocaleString()}
              </td>
              <td className="py-1.5 text-muted-foreground text-[10px]">{t.exitReason}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {trades.length > 30 && (
        <p className="text-[10px] text-muted-foreground/60 py-2 text-center">顯示前30筆，共{trades.length}筆</p>
      )}
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────

interface CapitalBacktestPanelProps {
  sessions: ScanSession[];
}

export function CapitalBacktestPanel({ sessions }: CapitalBacktestPanelProps) {
  const [capital,      setCapital]      = useState(1_000_000);
  const [factor,       setFactor]       = useState<RankingFactor>('composite');
  const [posMode,      setPosMode]      = useState<PositionMode>('fixed_pct');
  const [positionPct,  setPositionPct]  = useState(0.5);
  const [maxPositions, setMaxPositions] = useState(1);
  const [direction,    setDirection]    = useState<'long' | 'short'>('long');

  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const [result,   setResult]   = useState<CapitalSimResult | null>(null);

  const validSessions = sessions.filter(s => s.results.length > 0);

  const run = useCallback(async () => {
    if (validSessions.length === 0) return;

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      // Step 1: 取得所有股票的前瞻資料
      const forwardBySymbolDate: Record<string, unknown[]> = {};

      await Promise.allSettled(
        validSessions.map(async (s) => {
          const stocks = s.results.map(r => ({
            symbol:    r.symbol,
            name:      r.name,
            scanPrice: r.price,
          }));
          try {
            const res  = await fetch('/api/backtest/forward', {
              method:  'POST',
              headers: { 'Content-Type': 'application/json' },
              body:    JSON.stringify({ scanDate: s.date, stocks }),
            });
            const data = await res.json();
            if (data.performance) {
              for (const p of data.performance) {
                if (p.forwardCandles?.length > 0) {
                  forwardBySymbolDate[`${p.symbol}_${s.date}`] = p.forwardCandles;
                }
              }
            }
          } catch { /* skip */ }
        })
      );

      // Step 2: 呼叫 /api/backtest/capital
      const config = {
        initialCapital:  capital,
        market:          validSessions[0].market,
        direction,
        positionMode:    posMode,
        positionPct:     posMode === 'fixed_pct' ? positionPct : undefined,
        maxPositions,
        rankingFactor:   factor,
      };

      const dailyScanResults = validSessions.map(s => ({
        date:    s.date,
        results: s.results,
      }));

      const res = await fetch('/api/backtest/capital', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ config, dailyScanResults, forwardBySymbolDate }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? '回測失敗');
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : '未知錯誤');
    } finally {
      setLoading(false);
    }
  }, [validSessions, capital, factor, posMode, positionPct, maxPositions, direction]);

  return (
    <div className="space-y-6">
      {/* Config */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-muted-foreground uppercase tracking-wide">初始資金</label>
          <select
            value={capital}
            onChange={e => setCapital(Number(e.target.value))}
            className="bg-secondary border border-border text-foreground text-sm rounded px-3 py-1.5"
          >
            {CAPITAL_PRESETS.map(c => (
              <option key={c} value={c}>
                {c >= 1_000_000 ? `${c / 1_000_000}百萬` : `${c / 1000}千`}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-muted-foreground uppercase tracking-wide">方向</label>
          <select
            value={direction}
            onChange={e => setDirection(e.target.value as 'long' | 'short')}
            className="bg-secondary border border-border text-foreground text-sm rounded px-3 py-1.5"
          >
            <option value="long">做多</option>
            <option value="short">做空</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-muted-foreground uppercase tracking-wide">部位模式</label>
          <select
            value={posMode}
            onChange={e => setPosMode(e.target.value as PositionMode)}
            className="bg-secondary border border-border text-foreground text-sm rounded px-3 py-1.5"
          >
            {(Object.entries(POS_MODE_LABELS) as [PositionMode, string][]).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </div>
        {posMode === 'fixed_pct' && (
          <div className="flex flex-col gap-1">
            <label className="text-[10px] text-muted-foreground uppercase tracking-wide">倉位比例</label>
            <select
              value={positionPct}
              onChange={e => setPositionPct(Number(e.target.value))}
              className="bg-secondary border border-border text-foreground text-sm rounded px-3 py-1.5"
            >
              {[0.25, 0.5, 0.75, 1.0].map(v => (
                <option key={v} value={v}>{(v * 100).toFixed(0)}%</option>
              ))}
            </select>
          </div>
        )}
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-muted-foreground uppercase tracking-wide">排序因子</label>
          <select
            value={factor}
            onChange={e => setFactor(e.target.value as RankingFactor)}
            className="bg-secondary border border-border text-foreground text-sm rounded px-3 py-1.5"
          >
            {(Object.entries(FACTOR_LABELS) as [RankingFactor, string][]).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-muted-foreground uppercase tracking-wide">最大持倉數</label>
          <select
            value={maxPositions}
            onChange={e => setMaxPositions(Number(e.target.value))}
            className="bg-secondary border border-border text-foreground text-sm rounded px-3 py-1.5"
          >
            {[1, 2, 3, 5].map(n => <option key={n} value={n}>{n} 檔</option>)}
          </select>
        </div>
      </div>

      <button
        onClick={run}
        disabled={loading || validSessions.length === 0}
        className="px-6 py-2 text-sm font-medium rounded bg-purple-600 hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed text-foreground transition-colors"
      >
        {loading ? '模擬中…' : '執行資金模擬回測'}
      </button>

      {error && (
        <div className="text-sm text-red-400 bg-red-900/20 border border-red-800/40 rounded px-4 py-2">
          {error}
        </div>
      )}

      {result && (
        <div className="space-y-5">
          {/* KPIs */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
            <Kpi
              label="最終資金"
              value={`${(result.finalCapital / 10000).toFixed(1)}萬`}
              sub={`初始 ${(capital / 10000).toFixed(0)}萬`}
              color={retColor(result.totalReturnPct)}
            />
            <Kpi
              label="總報酬"
              value={fmtRet(result.totalReturnPct)}
              color={retColor(result.totalReturnPct)}
            />
            <Kpi
              label="勝率"
              value={`${result.winRate}%`}
              sub={`${result.totalTrades} 筆交易`}
              color={retColor(result.winRate - 50)}
            />
            <Kpi
              label="最大回撤"
              value={fmtRet(result.maxDrawdown)}
              color={retColor(result.maxDrawdown)}
            />
            <Kpi
              label="Sharpe"
              value={result.sharpeRatio != null ? result.sharpeRatio.toFixed(2) : '—'}
              color={result.sharpeRatio != null ? retColor(result.sharpeRatio) : 'text-muted-foreground'}
            />
            <Kpi
              label="Profit Factor"
              value={result.profitFactor != null ? result.profitFactor.toFixed(2) : '—'}
              color={result.profitFactor != null ? retColor(result.profitFactor - 1) : 'text-muted-foreground'}
            />
          </div>

          {/* Equity Curve */}
          <EquityCurve curve={result.equityCurve} />

          {/* Trades */}
          <div className="space-y-2">
            <div className="text-xs text-muted-foreground font-semibold uppercase tracking-wide border-b border-border pb-2">
              交易明細
            </div>
            <TradeTable trades={result.trades} />
          </div>
        </div>
      )}

      {!loading && validSessions.length === 0 && (
        <p className="text-muted-foreground/60 text-sm">請先執行選股掃描以取得歷史會話</p>
      )}
    </div>
  );
}
