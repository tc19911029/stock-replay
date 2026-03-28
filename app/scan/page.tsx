'use client';

import { useState, useEffect, useMemo, Fragment } from 'react';
import Link from 'next/link';
import { useBacktestStore, BacktestHorizon, CapitalConstraints, WalkForwardResult } from '@/store/backtestStore';
import { useWatchlistStore } from '@/store/watchlistStore';
import { StockForwardPerformance } from '@/lib/scanner/types';
import { calcBacktestSummary } from '@/lib/backtest/ForwardAnalyzer';
import { BacktestTrade, BacktestStats } from '@/lib/backtest/BacktestEngine';

// ── CSV Export ─────────────────────────────────────────────────────────────────

function exportToCsv(trades: BacktestTrade[], scanDate: string) {
  const headers = ['代號','名稱','市場','訊號日','評分','趨勢','進場日','進場價','出場日','出場價','出場原因','持有天數','毛報酬%','淨報酬%','交易成本','命中原因'];
  const rows = trades.map(t => [
    t.symbol, t.name, t.market, t.signalDate, t.signalScore, t.trendState,
    t.entryDate, t.entryPrice, t.exitDate, t.exitPrice, t.exitReason, t.holdDays,
    t.grossReturn, t.netReturn, t.totalCost, t.signalReasons.join('|'),
  ]);
  const csv = '\uFEFF' + [headers, ...rows].map(r => r.map(v => `"${v}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `backtest_${scanDate}.csv`;
  a.click();
  // 延遲釋放，避免慢速網路下載失敗
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ── Helpers ────────────────────────────────────────────────────────────────────

// 漲跌色彩：根據用戶設定（亞洲紅漲綠跌 / 歐美綠漲紅跌）
function retColor(v: number | null | undefined) {
  if (v == null) return 'text-slate-500';
  const theme = typeof window !== 'undefined'
    ? (JSON.parse(localStorage.getItem('settings-v4') || '{}')?.state?.colorTheme ?? 'asia')
    : 'asia';
  if (theme === 'western') {
    if (v > 0) return 'text-green-400';
    if (v < 0) return 'text-red-500';
  } else {
    if (v > 0) return 'text-red-400';
    if (v < 0) return 'text-green-500';
  }
  return 'text-slate-400';
}

function fmtRet(v: number | null | undefined) {
  if (v == null) return '–';
  return (v > 0 ? '+' : '') + v.toFixed(2) + '%';
}

function scoreColor(s: number) {
  if (s >= 5) return 'text-amber-400 font-bold';
  if (s >= 4) return 'text-sky-400 font-semibold';
  return 'text-sky-400';
}

// 亞洲慣例：多頭=紅，空頭=綠
function trendBadge(t: string) {
  const cls =
    t === '多頭' ? 'bg-red-900/60 text-red-300 border-red-800' :
    t === '空頭' ? 'bg-green-900/60 text-green-300 border-green-800' :
    'bg-slate-700/60 text-slate-300 border-slate-600';
  return (
    <span className={`inline-block whitespace-nowrap px-2 py-0.5 text-[11px] font-medium rounded-full border ${cls}`}>
      {t}
    </span>
  );
}

function exitBadge(reason: string) {
  const map: Record<string, string> = {
    holdDays:   'bg-sky-900/50 text-sky-300',
    stopLoss:   'bg-green-900/50 text-green-300',
    takeProfit: 'bg-red-900/50 text-red-300',
    dataEnd:    'bg-slate-700/50 text-slate-400',
  };
  const labels: Record<string, string> = {
    holdDays: '持滿', stopLoss: '停損', takeProfit: '停利', dataEnd: '缺資料',
  };
  const cls = map[reason] ?? map.holdDays;
  return (
    <span className={`inline-block whitespace-nowrap px-2 py-0.5 text-[10px] font-medium rounded-full ${cls}`}>
      {labels[reason] ?? reason}
    </span>
  );
}

// ── Summary Card (legacy horizon) ──────────────────────────────────────────────

function HorizonCard({ label, horizon, performance }: {
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

// ── Strict Stats Panel ──────────────────────────────────────────────────────────

function StrictStatsPanel({ stats, tradesCount, trades }: { stats: BacktestStats; tradesCount: number; trades: BacktestTrade[] }) {
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
      {/* 統計可靠性警告 */}
      {tradesCount < 30 && (
        <div className="px-5 py-2.5 bg-amber-950/40 border-b border-amber-800/40 flex items-center gap-2">
          <span className="text-amber-400 text-sm">!</span>
          <span className="text-[11px] text-amber-300/90">
            樣本數僅 {tradesCount} 筆（建議 &ge; 30 筆），統計結果參考價值有限，勝率和期望值可能有較大偏差
          </span>
        </div>
      )}
      {stats.sharpeRatio != null && stats.sharpeRatio < 0.5 && tradesCount >= 10 && (
        <div className="px-5 py-2 bg-red-950/30 border-b border-red-800/30 flex items-center gap-2">
          <span className="text-red-400 text-sm">!</span>
          <span className="text-[11px] text-red-300/80">
            Sharpe Ratio {stats.sharpeRatio.toFixed(2)} 偏低（&lt;0.5），表示風險調整後報酬不佳，策略在此條件下風險較高
          </span>
        </div>
      )}
      {/* KPI grid — 基本指標 */}
      <div className="grid grid-cols-3 sm:grid-cols-5 divide-x divide-y divide-slate-800/60">
        <Kpi label="淨報酬均值" value={fmtRet(stats.avgNetReturn)} color={retColor(stats.avgNetReturn)} />
        <Kpi label="毛報酬均值" value={fmtRet(stats.avgGrossReturn)} color={retColor(stats.avgGrossReturn)} />
        <Kpi label="中位數報酬" value={fmtRet(stats.medianReturn)} color={retColor(stats.medianReturn)} />
        <Kpi label="最大單筆獲利" value={fmtRet(stats.maxGain)} color="text-red-400" />
        <Kpi label="最大單筆虧損" value={fmtRet(stats.maxLoss)} color="text-green-500" />
        <Kpi label="期望值" value={fmtRet(stats.expectancy)} color={retColor(stats.expectancy)} subtext="每筆平均" />
        <Kpi label="最大回撤 MDD" value={fmtRet(stats.maxDrawdown)} color="text-green-500" subtext="峰值到谷值" />
        <Kpi label="勝 / 負筆數" value={`${stats.wins} / ${stats.losses}`} color="text-slate-200" />
        <Kpi label="淨報酬加總" value={fmtRet(stats.totalNetReturn)} color={retColor(stats.totalNetReturn)} subtext="非複利" />
        <Kpi label="勝率" value={`${stats.winRate}%`} color={winColor} />
      </div>
      {/* 風險調整指標 */}
      <div className="border-t border-slate-800 px-5 py-3 flex flex-wrap gap-6 bg-slate-800/20">
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-slate-500 uppercase tracking-wide">Sharpe Ratio</span>
          <span className={`text-sm font-bold ${stats.sharpeRatio != null ? retColor(stats.sharpeRatio) : 'text-slate-500'}`}>
            {stats.sharpeRatio != null ? stats.sharpeRatio.toFixed(2) : '–'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-slate-500 uppercase tracking-wide">Profit Factor</span>
          <span className={`text-sm font-bold ${stats.profitFactor != null ? (stats.profitFactor >= 1 ? 'text-red-400' : 'text-green-500') : 'text-slate-500'}`}>
            {stats.profitFactor != null ? stats.profitFactor.toFixed(2) : '–'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-slate-500 uppercase tracking-wide">Payoff Ratio</span>
          <span className={`text-sm font-bold ${stats.payoffRatio != null ? (stats.payoffRatio >= 1 ? 'text-red-400' : 'text-slate-400') : 'text-slate-500'}`}>
            {stats.payoffRatio != null ? stats.payoffRatio.toFixed(2) : '–'}
          </span>
        </div>
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
      {/* 大盤對比提示 */}
      {stats.avgNetReturn != null && (
        <div className="px-5 py-2 bg-slate-800/30 border-t border-slate-800/50 text-[11px] text-slate-500">
          提醒：回測績效需與同期大盤表現對比才有意義。若大盤同期漲 5%，策略均值 {fmtRet(stats.avgNetReturn)} 的實際超額報酬為 {stats.avgNetReturn >= 0 ? '需扣除大盤漲幅' : '且大盤可能也在跌'}。
          建議搭配 Walk-Forward 驗證策略是否真的優於買入持有。
        </div>
      )}
      {/* 成本與滑點說明 */}
      <div className="px-5 py-2 border-t border-slate-800/50 text-[10px] text-slate-600 flex flex-wrap gap-x-4 gap-y-0.5">
        <span>成本模型：台股手續費 0.1425%×0.6 + 證交稅 0.3%</span>
        <span>陸股佣金 0.025% + 印花稅 0.1%</span>
        <span>滑點 0.1%（買高賣低）</span>
        <span>實際成本因券商而異，可能高出 10-30%</span>
      </div>
      {/* Equity curve */}
      <EquityCurveMini trades={trades} />
    </div>
  );
}

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

// ── Equity Curve Mini-Chart ────────────────────────────────────────────────────

function EquityCurveMini({ trades }: { trades: BacktestTrade[] }) {
  if (trades.length < 2) return null;

  // Build cumulative equity by exit date order
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
  const W = 400; const H = 52;
  const pad = 2;

  const toX = (i: number) => (i / (points.length - 1)) * W;
  const toY = (v: number) => H - pad - ((v - min) / range) * (H - pad * 2);

  const pathD  = points.map((v, i) => `${i === 0 ? 'M' : 'L'} ${toX(i).toFixed(1)} ${toY(v).toFixed(1)}`).join(' ');
  const areaD  = `${pathD} L ${W} ${H} L 0 ${H} Z`;
  const final  = points[points.length - 1];
  const color  = final >= 0 ? '#f87171' : '#4ade80';  // 亞洲：紅漲綠跌
  const zeroY  = toY(0);

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
        {/* Zero baseline */}
        {min < 0 && max > 0 && (
          <line x1="0" y1={zeroY.toFixed(1)} x2={W} y2={zeroY.toFixed(1)}
            stroke="#334155" strokeWidth="1" strokeDasharray="4,3" />
        )}
        <path d={areaD} fill="url(#eq-grad)" />
        <path d={pathD} stroke={color} strokeWidth="1.5" fill="none" strokeLinejoin="round" />
        {/* Start & end dots */}
        <circle cx={toX(0).toFixed(1)} cy={toY(0).toFixed(1)} r="2" fill="#64748b" />
        <circle cx={toX(points.length - 1).toFixed(1)} cy={toY(final).toFixed(1)} r="2.5" fill={color} />
      </svg>
    </div>
  );
}

// ── Capital Panel ──────────────────────────────────────────────────────────────

function CapitalPanel({ trades, constraints, finalCapital, capitalReturn, skippedByCapital }: {
  trades: BacktestTrade[];
  constraints: CapitalConstraints;
  finalCapital: number | null;
  capitalReturn: number | null;
  skippedByCapital: number;
}) {
  if (trades.length === 0) return null;

  // Use engine-computed values (accurate), or fall back to estimate
  const capFinal  = finalCapital  ?? constraints.initialCapital;
  const capReturn = capitalReturn ?? 0;
  const positionNominal = constraints.initialCapital * constraints.positionSizePct;
  const totalPnL  = capFinal - constraints.initialCapital;
  const capColor  = capReturn >= 0 ? 'text-red-400' : 'text-green-500';

  return (
    <div className="bg-amber-950/20 border border-amber-800/40 rounded-xl overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-amber-900/30 bg-amber-950/30">
        <div className="w-1.5 h-4 rounded-full bg-amber-500" />
        <span className="text-sm font-semibold text-amber-200">資本限制模擬</span>
        <span className="text-xs text-slate-500 ml-1">
          {(constraints.initialCapital / 10000).toLocaleString('zh-TW')} 萬元 ×
          前 {constraints.maxPositions} 檔 ×
          每筆 {(constraints.positionSizePct * 100).toFixed(0)}%
        </span>
      </div>
      <div className="grid grid-cols-3 sm:grid-cols-5 divide-x divide-slate-800/60">
        <div className="flex flex-col gap-0.5 p-4">
          <div className="text-[10px] text-slate-500 uppercase tracking-wide">初始資金</div>
          <div className="text-base font-bold text-slate-300">
            {(constraints.initialCapital / 10000).toFixed(0)}萬
          </div>
        </div>
        <div className="flex flex-col gap-0.5 p-4">
          <div className="text-[10px] text-slate-500 uppercase tracking-wide">最終資金</div>
          <div className="text-base font-bold text-slate-100">
            {(capFinal / 10000).toFixed(1)}萬
          </div>
        </div>
        <div className="flex flex-col gap-0.5 p-4">
          <div className="text-[10px] text-slate-500 uppercase tracking-wide">資金報酬</div>
          <div className={`text-lg font-bold ${capColor}`}>
            {capReturn >= 0 ? '+' : ''}{capReturn.toFixed(2)}%
          </div>
        </div>
        <div className="flex flex-col gap-0.5 p-4">
          <div className="text-[10px] text-slate-500 uppercase tracking-wide">實際損益</div>
          <div className={`text-base font-bold ${capColor}`}>
            {totalPnL >= 0 ? '+' : ''}{Math.round(totalPnL).toLocaleString('zh-TW')} 元
          </div>
        </div>
        <div className="flex flex-col gap-0.5 p-4">
          <div className="text-[10px] text-slate-500 uppercase tracking-wide">資本排除</div>
          <div className="text-base font-bold text-slate-400">{skippedByCapital} 筆</div>
          <div className="text-[10px] text-slate-600">取前 {constraints.maxPositions} 高分</div>
        </div>
      </div>
      {trades.length > 0 && (
        <div className="px-4 py-2 border-t border-amber-900/30 text-xs text-slate-500">
          入選：{trades.map(t => `${t.name}（${(t.netReturn >= 0 ? '+' : '') + t.netReturn.toFixed(1)}%）`).join('　')}
        </div>
      )}
    </div>
  );
}

// ── Trade Row ──────────────────────────────────────────────────────────────────

// 回測交易的綜合分（與掃描結果用同一公式）
function calcTradeComposite(t: BacktestTrade): number {
  const sixCon = (t.signalScore / 6) * 100;
  const surge  = t.surgeScore ?? 0;
  const winR   = t.histWinRate ?? 50;
  const posBonus = t.trendPosition?.includes('起漲') ? 100
                 : t.trendPosition?.includes('主升') ? 70
                 : t.trendPosition?.includes('末升') ? 20 : 50;
  const volBonus = 50; // 回測交易沒有 surgeComponents，用預設值
  return Math.round((sixCon * 0.35 + surge * 0.25 + winR * 0.20 + posBonus * 0.10 + volBonus * 0.10) * 10) / 10;
}

function TradeRow({ t }: { t: BacktestTrade }) {
  const sym = t.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
  return (
    <tr className="border-b border-slate-800/50 hover:bg-slate-800/40">
      <td className="py-1.5 px-2 font-mono font-bold text-white">{sym}</td>
      <td className="py-1.5 px-2">
        <div className="text-slate-300">{t.name}</div>
        <div className="flex gap-0.5 mt-0.5">
          {t.signalReasons.slice(0, 6).map(r => (
            <span key={r} className="text-[8px] px-1 py-0.5 bg-sky-800/80 text-sky-300 rounded-sm">{r.replace(/條件|多頭|放大|長紅|多排|配合/g, '').slice(0, 2)}</span>
          ))}
        </div>
      </td>
      <td className="py-1.5 px-1 text-[10px] text-slate-500 max-w-[60px] truncate" title={t.industry}>{t.industry ?? '—'}</td>
      <td className="py-1.5 px-1 text-center">
        {(() => { const cs = calcTradeComposite(t); return <span className={`font-bold text-[11px] ${cs >= 70 ? 'text-sky-400' : cs >= 55 ? 'text-slate-200' : 'text-slate-500'}`}>{cs.toFixed(1)}</span>; })()}
      </td>
      <td className="py-1.5 px-1 text-center">
        <span className={`font-bold ${t.signalScore >= 5 ? 'text-red-400' : t.signalScore >= 4 ? 'text-orange-400' : 'text-yellow-400'}`}>
          {t.signalScore}/6
        </span>
      </td>
      <td className="py-1.5 px-1 text-center">
        {t.surgeGrade && (
          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
            t.surgeGrade === 'S' ? 'bg-red-600 text-white' :
            t.surgeGrade === 'A' ? 'bg-orange-500 text-white' :
            t.surgeGrade === 'B' ? 'bg-yellow-500 text-black' :
            'bg-slate-600 text-slate-300'
          }`}>{t.surgeGrade}</span>
        )}
      </td>
      <td className="py-1.5 px-1 text-center font-mono text-slate-300">{t.surgeScore ?? '—'}</td>
      <td className="py-1.5 px-1 text-center">
        {t.histWinRate != null && (
          <span className={`text-[10px] px-1 rounded ${t.histWinRate >= 60 ? 'bg-green-900/60 text-green-300' : t.histWinRate >= 50 ? 'bg-yellow-900/60 text-yellow-300' : 'bg-red-900/60 text-red-300'}`}>
            {t.histWinRate}%
          </span>
        )}
      </td>
      <td className="py-1.5 px-2 text-right font-mono text-white whitespace-nowrap">{t.entryPrice.toFixed(2)}</td>
      <td className="py-1.5 px-2 text-[10px] text-slate-400 whitespace-nowrap">{trendBadge(t.trendState)}</td>
      <td className="py-1.5 px-2 text-[10px] text-slate-400 whitespace-nowrap">{t.trendPosition}</td>
      <td className="py-1.5 px-2 text-right font-mono text-slate-400 whitespace-nowrap">{t.exitPrice.toFixed(2)}</td>
      <td className="py-1.5 px-1 text-center text-slate-500">{t.holdDays}日</td>
      <td className={`py-1.5 px-1 text-right font-mono font-bold ${retColor(t.netReturn)}`}>{fmtRet(t.netReturn)}</td>
      <td className="py-1.5 px-1 text-center">{exitBadge(t.exitReason)}</td>
      <td className="py-1.5 px-2 text-center whitespace-nowrap">
        <Link href={`/?load=${sym}`}
          className="text-[10px] text-sky-400 hover:text-sky-300 px-1.5 py-0.5 rounded border border-sky-700/50 hover:bg-sky-900/30 mr-1">走圖
        </Link>
      </td>
    </tr>
  );
}

// ── Research Assumptions Panel ─────────────────────────────────────────────────

function ResearchAssumptions({ market, strategy }: {
  market: string;
  strategy: { holdDays: number; stopLoss: number | null; takeProfit: number | null; entryType: string };
}) {
  const [open, setOpen] = useState(false);
  const poolDesc = market === 'TW'
    ? '台股全市場（上市+上櫃，約 1700+ 支，TWSE/TPEx API 動態取得）'
    : '陸股全市場（滬深主板+創業板+科創板，約 5000+ 支，東方財富 API 動態取得）';
  return (
    <div className="border border-amber-800/50 bg-amber-950/20 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-amber-900/10 transition-colors"
      >
        <span className="text-amber-400 text-sm">⚠</span>
        <span className="text-amber-300 text-sm font-medium">研究假設與偏誤說明</span>
        <span className="ml-auto text-slate-500 text-xs">{open ? '收起 ▲' : '展開 ▼'}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 grid sm:grid-cols-2 gap-4 text-xs text-slate-300">
          <div>
            <div className="text-slate-400 font-semibold mb-1.5 uppercase tracking-wide text-[10px]">進出場規則</div>
            <ul className="space-y-1 text-slate-400">
              <li>• 訊號時間：<span className="text-slate-200">收盤後評分，不含未來資訊</span></li>
              <li>• 進場方式：<span className="text-slate-200">訊號日隔日開盤價</span>（{strategy.entryType}）</li>
              <li>• 持有天數：<span className="text-slate-200">{strategy.holdDays} 個交易日後以收盤出場</span></li>
              <li>• 停損：<span className="text-slate-200">{strategy.stopLoss == null ? '未設定' : `${(strategy.stopLoss * 100).toFixed(0)}%（以停損價出場）`}</span></li>
              <li>• 停利：<span className="text-slate-200">{strategy.takeProfit == null ? '未設定' : `+${(strategy.takeProfit * 100).toFixed(0)}%（以停利價出場）`}</span></li>
            </ul>
          </div>
          <div>
            <div className="text-slate-400 font-semibold mb-1.5 uppercase tracking-wide text-[10px]">掃描池定義（關鍵偏誤）</div>
            <ul className="space-y-1 text-slate-400">
              <li>• 掃描池：<span className="text-amber-300">{poolDesc}</span></li>
              <li>• <span className="text-amber-300">非</span>動態每日成交量排名篩選</li>
              <li>• 影響：包含部分低流動性股票，回測滑價可能被低估</li>
              <li>• 數據源：Yahoo Finance（歷史K線）+ TWSE/東方財富（股票清單）</li>
            </ul>
          </div>
          <div className="sm:col-span-2 pt-1 border-t border-slate-800 text-slate-500">
            回測結果代表「全市場股票中，符合六大條件者的後續表現」。歷史回測績效僅供研究參考，過去績效不代表未來結果。實際交易需考慮流動性、滑價、市場情緒等因素。
          </div>
        </div>
      )}
    </div>
  );
}

// ── Session History Sidebar ────────────────────────────────────────────────────

function SessionHistory() {
  const { sessions, loadSession, market, scanDate } = useBacktestStore();
  const filtered = sessions.filter(s => s.market === market);
  if (filtered.length === 0) return null;

  // 統計所有歷史掃描的整體命中率
  const sessionsWithStats = filtered.filter(s => s.stats?.winRate != null);
  const avgWinRate = sessionsWithStats.length > 0
    ? Math.round(sessionsWithStats.reduce((sum, s) => sum + (s.stats?.winRate ?? 0), 0) / sessionsWithStats.length)
    : null;
  const totalTrades = sessionsWithStats.reduce((sum, s) => sum + (s.stats?.count ?? 0), 0);

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
      <div className="px-4 py-2.5 border-b border-slate-800 bg-slate-800/40">
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">回測歷史</h3>
        {avgWinRate != null && sessionsWithStats.length >= 2 && (
          <div className="flex items-center gap-2 mt-1 text-[10px]">
            <span className="text-slate-500">{sessionsWithStats.length} 次掃描</span>
            <span className="text-slate-500">·</span>
            <span className={avgWinRate >= 50 ? 'text-red-400' : 'text-green-500'}>
              平均勝率 {avgWinRate}%
            </span>
            <span className="text-slate-500">·</span>
            <span className="text-slate-500">{totalTrades} 筆交易</span>
          </div>
        )}
      </div>
      <div className="p-2 space-y-1">
        {filtered.map(s => {
          const isActive = s.scanDate === scanDate;
          const wr = s.stats?.winRate;
          return (
            <button
              key={s.id}
              onClick={() => loadSession(s.id)}
              className={`w-full text-left px-3 py-2.5 rounded-lg transition-colors ${
                isActive
                  ? 'bg-sky-900/40 border border-sky-800/60'
                  : 'hover:bg-slate-800 border border-transparent'
              }`}
            >
              <div className={`font-mono text-xs font-semibold ${isActive ? 'text-sky-300' : 'text-slate-300'}`}>
                {s.scanDate}
              </div>
              <div className="flex items-center gap-2 mt-0.5 text-[11px] text-slate-500">
                <span>{s.scanResults.length} 檔</span>
                {wr != null && (
                  <>
                    <span>｜</span>
                    <span className={wr >= 50 ? 'text-red-400' : 'text-green-500'}>勝率 {wr}%</span>
                  </>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Walk-Forward Panel ─────────────────────────────────────────────────────────

function WalkForwardPanel({
  result, sessionCount, minRequired, isRunning, onRun,
  trainSize, testSize, stepSize,
  onTrainSize, onTestSize, onStepSize,
}: {
  result: WalkForwardResult | null;
  sessionCount: number;
  minRequired: number;
  isRunning: boolean;
  onRun: () => void;
  trainSize: number; testSize: number; stepSize: number;
  onTrainSize: (n: number) => void;
  onTestSize:  (n: number) => void;
  onStepSize:  (n: number) => void;
}) {
  const enough = sessionCount >= minRequired;

  return (
    <div className="space-y-4">
      {/* Header explanation */}
      <div className="bg-slate-800/40 border border-slate-700/60 rounded-xl px-5 py-4 space-y-2">
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-4 rounded-full bg-violet-500" />
          <h3 className="text-sm font-semibold text-slate-100">步進式向前回測 (Walk-Forward)</h3>
          <span className="ml-auto text-xs text-slate-500">防止過度擬合的標準方法</span>
        </div>
        <p className="text-xs text-slate-400 leading-relaxed">
          將歷史 session 切分為滾動的訓練/測試窗口。在訓練集上評估策略，
          再驗證測試集（out-of-sample）是否一樣穩健。
          穩健性分數越高、效率比越接近 1，代表策略在未見過的資料上仍然有效。
        </p>
        <div className="text-xs text-slate-500">
          目前 <span className={enough ? 'text-slate-200 font-medium' : 'text-amber-400 font-medium'}>{sessionCount}</span> 個歷史 session
          {!enough && <span className="text-amber-400">（需至少 {minRequired} 個才能執行）</span>}
        </div>
      </div>

      {/* Config + Run */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-800 bg-slate-800/30">
          <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">窗口參數</h4>
        </div>
        <div className="p-5 flex flex-wrap items-end gap-4">
          {[
            { label: '訓練窗口', value: trainSize, min: 1, max: 10, onChange: onTrainSize,
              hint: '幾個 session 做訓練' },
            { label: '測試窗口', value: testSize, min: 1, max: 5, onChange: onTestSize,
              hint: '幾個 session 做驗證' },
            { label: '步進大小', value: stepSize, min: 1, max: 5, onChange: onStepSize,
              hint: '每次向前幾個 session' },
          ].map(({ label, value, min, max, onChange, hint }) => (
            <div key={label} className="space-y-1">
              <label className="text-xs text-slate-500 font-medium">{label}</label>
              <select
                value={value}
                onChange={e => onChange(+e.target.value)}
                className="bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-violet-500"
              >
                {Array.from({ length: max - min + 1 }, (_, i) => i + min).map(n => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
              <div className="text-[10px] text-slate-600">{hint}</div>
            </div>
          ))}
          <button
            onClick={onRun}
            disabled={!enough || isRunning}
            className="ml-auto px-5 py-2.5 bg-violet-600 hover:bg-violet-500 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-lg text-sm font-semibold transition-colors"
          >
            {isRunning ? '計算中…' : '執行 Walk-Forward'}
          </button>
        </div>
      </div>

      {/* Results */}
      {result && (
        <div className="space-y-4">
          {/* Summary KPIs */}
          <div className="bg-slate-900 border border-slate-700/60 rounded-xl overflow-hidden">
            <div className="flex items-center gap-3 px-5 py-3 border-b border-slate-800 bg-slate-800/40">
              <div className="w-1.5 h-4 rounded-full bg-violet-500" />
              <h3 className="text-sm font-semibold text-slate-100">跨窗口聚合（Out-of-Sample）</h3>
              <div className="ml-auto flex items-center gap-4 text-xs text-slate-400">
                <span>{result.windows.length} 個窗口</span>
                <span className={`font-bold text-sm ${result.robustnessScore >= 60 ? 'text-red-400' : 'text-amber-400'}`}>
                  穩健性 {result.robustnessScore}%
                </span>
                {result.efficiencyRatio !== null && (
                  <span className={`font-bold text-sm ${
                    result.efficiencyRatio >= 0.7 ? 'text-slate-200' : 'text-amber-400'
                  }`}>
                    效率比 {result.efficiencyRatio.toFixed(2)}
                  </span>
                )}
              </div>
            </div>
            {result.aggregateTestStats && (
              <div className="grid grid-cols-3 sm:grid-cols-6 divide-x divide-y divide-slate-800/60">
                <Kpi label="勝率" value={`${result.aggregateTestStats.winRate}%`}
                  color={result.aggregateTestStats.winRate >= 50 ? 'text-red-400' : 'text-green-500'} />
                <Kpi label="均值報酬" value={fmtRet(result.aggregateTestStats.avgNetReturn)}
                  color={retColor(result.aggregateTestStats.avgNetReturn)} />
                <Kpi label="中位報酬" value={fmtRet(result.aggregateTestStats.medianReturn)}
                  color={retColor(result.aggregateTestStats.medianReturn)} />
                <Kpi label="MDD" value={fmtRet(result.aggregateTestStats.maxDrawdown)}
                  color="text-green-500" subtext="峰谷最大回撤" />
                <Kpi label="Sharpe" value={result.aggregateTestStats.sharpeRatio?.toFixed(2) ?? '–'}
                  color={retColor(result.aggregateTestStats.sharpeRatio)} />
                <Kpi label="筆數" value={String(result.aggregateTestStats.count)}
                  color="text-slate-300" />
              </div>
            )}
            {/* Robustness gauge */}
            {result.robustnessScore < 70 && (
              <div className="px-5 py-2.5 bg-amber-950/40 border-t border-amber-800/40 flex items-center gap-2">
                <span className="text-amber-400 text-sm">!</span>
                <span className="text-[11px] text-amber-300/90">
                  穩健度 {result.robustnessScore}% 低於 70%，策略可能過度擬合歷史數據，實際交易表現可能大幅不如回測
                </span>
              </div>
            )}
            <div className="px-5 py-3 border-t border-slate-800 space-y-1.5">
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>穩健性分數（測試窗口勝率 &gt; 50% 的比例）</span>
                <span className="font-bold text-slate-200">{result.robustnessScore}%</span>
              </div>
              <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-700 ${
                    result.robustnessScore >= 70 ? 'bg-red-500' :
                    result.robustnessScore >= 50 ? 'bg-amber-500' : 'bg-green-600'
                  }`}
                  style={{ width: `${result.robustnessScore}%` }}
                />
              </div>
              {result.efficiencyRatio !== null && (
                <div className="text-[11px] text-slate-500 mt-1">
                  效率比 {result.efficiencyRatio.toFixed(2)}
                  <span className="ml-1.5 text-slate-600">
                    （= 測試集平均報酬 ÷ 訓練集平均報酬，越接近 1 代表策略可複製性越高）
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Per-window table */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-800 bg-slate-800/30">
              <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">各窗口詳情</h4>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[10px] text-slate-500 uppercase tracking-wide border-b border-slate-700/80 bg-slate-800/60">
                    <th className="py-2.5 px-4 text-left">窗口</th>
                    <th className="py-2.5 px-3 text-left">訓練期</th>
                    <th className="py-2.5 px-3 text-center">訓練勝率</th>
                    <th className="py-2.5 px-3 text-center">訓練均值</th>
                    <th className="py-2.5 px-3 text-left">測試期</th>
                    <th className="py-2.5 px-3 text-center">測試勝率</th>
                    <th className="py-2.5 px-3 text-center">測試均值</th>
                    <th className="py-2.5 px-3 text-center">測試 MDD</th>
                    <th className="py-2.5 px-3 text-center">穩健</th>
                  </tr>
                </thead>
                <tbody>
                  {result.windows.map(w => {
                    const trainWR  = w.trainStats?.winRate ?? null;
                    const testWR   = w.testStats?.winRate  ?? null;
                    const robust   = testWR !== null && testWR > 50;
                    return (
                      <tr key={w.windowIndex}
                        className={`border-t border-slate-700/40 hover:bg-slate-800/60 transition-colors ${
                          robust ? '' : 'opacity-60'
                        }`}>
                        <td className="py-2.5 px-4 text-slate-400 font-mono text-xs">#{w.windowIndex + 1}</td>
                        <td className="py-2.5 px-3 text-xs text-slate-400">
                          {w.trainSessions[0]} ~ {w.trainSessions[w.trainSessions.length - 1]}
                          <div className="text-slate-600">{w.trainSessions.length} 個 session</div>
                        </td>
                        <td className="py-2.5 px-3 text-center">
                          {trainWR !== null
                            ? <span className={trainWR >= 50 ? 'text-red-400 font-bold' : 'text-green-500'}>{trainWR}%</span>
                            : <span className="text-slate-600">–</span>}
                        </td>
                        <td className="py-2.5 px-3 text-center">
                          <span className={retColor(w.trainStats?.avgNetReturn)}>
                            {fmtRet(w.trainStats?.avgNetReturn)}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-xs text-slate-300">
                          {w.testSessions[0]} ~ {w.testSessions[w.testSessions.length - 1]}
                          <div className="text-slate-600">{w.testSessions.length} 個 session</div>
                        </td>
                        <td className="py-2.5 px-3 text-center">
                          {testWR !== null
                            ? <span className={`font-bold ${testWR >= 50 ? 'text-red-400' : 'text-green-500'}`}>{testWR}%</span>
                            : <span className="text-slate-600">–</span>}
                        </td>
                        <td className="py-2.5 px-3 text-center">
                          <span className={retColor(w.testStats?.avgNetReturn)}>
                            {fmtRet(w.testStats?.avgNetReturn)}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-center text-green-500 text-xs">
                          {w.testStats?.maxDrawdown != null ? fmtRet(w.testStats.maxDrawdown) : '–'}
                        </td>
                        <td className="py-2.5 px-3 text-center text-lg">
                          {w.testStats == null ? '–' : robust ? '✓' : '✗'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Empty state when no sessions */}
      {!result && !isRunning && (
        <div className="text-center py-16 text-slate-500 space-y-2">
          <div className="text-4xl">📈</div>
          <div className="text-sm font-medium text-slate-400">
            {enough
              ? '設定窗口參數後，點擊「執行 Walk-Forward」'
              : `需要至少 ${minRequired} 個歷史回測 session（目前 ${sessionCount} 個）`}
          </div>
          {!enough && (
            <div className="text-xs">先回到「回測參數設定」執行不同日期的回測，累積歷史 session</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function UnifiedScanPage() {
  const {
    market, scanDate, strategy,
    useCapitalMode, capitalConstraints,
    walkForwardConfig, walkForwardResult, isRunningWF,
    sessions,
    setMarket, setScanDate, setStrategy,
    setCapitalConstraints, toggleCapitalMode,
    setWalkForwardConfig, computeWalkForward,
    isScanning, scanProgress, scanError,
    scanResults, isFetchingForward, forwardError, performance,
    trades, stats,
    skippedByCapital, finalCapital, capitalReturn,
    runScan, clearCurrent,
    scanOnly, setScanOnly,
    marketTrend,
  } = useBacktestStore();

  const [tab, setTab]               = useState<'strict' | 'horizon' | 'walkforward'>('strict');
  const [activeHorizon, setHorizon] = useState<BacktestHorizon>('d5');
  const [sortBy, setSortBy]         = useState<'composite' | 'netReturn' | 'signalScore' | 'surgeScore' | 'histWinRate' | 'holdDays'>('composite');
  const [sortDir, setSortDir]       = useState<'asc' | 'desc'>('desc');
  const [scanSort, setScanSort]     = useState<'composite' | 'score' | 'grade' | 'potential' | 'winRate' | 'price' | 'change'>('composite');
  const [scanSortDir, setScanSortDir] = useState<'asc' | 'desc'>('desc');
  const [expandedStock, setExpandedStock] = useState<string | null>(null);
  const [gradeFilter, setGradeFilter] = useState<string>('all');
  const [conceptFilter, setConceptFilter] = useState<string>('all');

  // 用 state 避免 SSR hydration mismatch
  const [maxDate, setMaxDate] = useState('2099-12-31');
  useEffect(() => { setMaxDate(new Date().toISOString().split('T')[0]); }, []);

  const horizonLabels: { key: BacktestHorizon; label: string }[] = [
    { key: 'open', label: '隔日開' }, { key: 'd1', label: '1日' },
    { key: 'd2', label: '2日' },     { key: 'd3', label: '3日' },
    { key: 'd4', label: '4日' },     { key: 'd5', label: '5日' },
    { key: 'd10', label: '10日' },   { key: 'd20', label: '20日' },
  ];

  const perfMap = useMemo(() => new Map(performance.map(p => [p.symbol, p])), [performance]);

  const sortedTrades = [...trades].sort((a, b) => {
    const dir = sortDir === 'desc' ? 1 : -1;
    if (sortBy === 'composite')    return dir * (calcTradeComposite(b) - calcTradeComposite(a));
    if (sortBy === 'netReturn')    return dir * (b.netReturn - a.netReturn);
    if (sortBy === 'signalScore')  return dir * (b.signalScore - a.signalScore);
    if (sortBy === 'surgeScore')   return dir * ((b.surgeScore ?? 0) - (a.surgeScore ?? 0));
    if (sortBy === 'histWinRate')  return dir * ((b.histWinRate ?? 0) - (a.histWinRate ?? 0));
    if (sortBy === 'holdDays')     return dir * (a.holdDays - b.holdDays);
    return 0;
  });

  // 掃描結果中出現的概念列表（用於篩選器）
  const availableConcepts = [...new Set(scanResults.map(r => r.industry).filter(Boolean))] as string[];

  // 綜合分計算：六條件35% + 潛力25% + 勝率20% + 位置10% + 量能10%
  function calcComposite(r: typeof scanResults[0]): number {
    const sixCon = (r.sixConditionsScore / 6) * 100;
    const surge  = (r.surgeScore ?? 0);
    const winR   = r.histWinRate ?? 50;
    const posBonus = r.trendPosition?.includes('起漲') ? 100
                   : r.trendPosition?.includes('主升') ? 70
                   : r.trendPosition?.includes('末升') ? 20 : 50;
    const volBonus = (r.surgeComponents?.volume?.score ?? 50);
    return Math.round((sixCon * 0.35 + surge * 0.25 + winR * 0.20 + posBonus * 0.10 + volBonus * 0.10) * 10) / 10;
  }

  // 掃描結果篩選 + 排序
  const filteredScanResults = conceptFilter === 'all'
    ? scanResults
    : scanResults.filter(r => r.industry === conceptFilter);
  const sortedScanResults = [...filteredScanResults].sort((a, b) => {
    const dir = scanSortDir === 'desc' ? 1 : -1;
    switch (scanSort) {
      case 'composite':  return dir * (calcComposite(b) - calcComposite(a));
      case 'score':     return dir * ((b.sixConditionsScore ?? 0) - (a.sixConditionsScore ?? 0));
      case 'grade': {
        const gradeOrder: Record<string, number> = { S: 5, A: 4, B: 3, C: 2, D: 1 };
        return dir * ((gradeOrder[b.surgeGrade ?? ''] ?? 0) - (gradeOrder[a.surgeGrade ?? ''] ?? 0));
      }
      case 'potential':  return dir * ((b.surgeScore ?? 0) - (a.surgeScore ?? 0));
      case 'winRate':    return dir * ((b.histWinRate ?? 0) - (a.histWinRate ?? 0));
      case 'price':      return dir * ((b.price ?? 0) - (a.price ?? 0));
      case 'change':     return dir * ((b.changePercent ?? 0) - (a.changePercent ?? 0));
      default:           return 0;
    }
  });

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-3 sm:px-4 h-12 sm:h-14 flex items-center gap-2 sm:gap-4">
          <Link href="/" className="text-slate-400 hover:text-slate-200 text-xs sm:text-sm">← 主頁</Link>
          <div className="h-4 w-px bg-slate-700" />
          <h1 className="font-bold text-white text-sm sm:text-base truncate">掃描選股 & 回測</h1>
          <span className="relative group cursor-help">
            <span className="text-[10px] w-4 h-4 flex items-center justify-center rounded-full bg-slate-700 text-slate-400">?</span>
            <div className="absolute z-50 left-0 top-full mt-1 hidden group-hover:block w-64 p-3 rounded-lg bg-slate-800 border border-slate-600 text-[11px] text-slate-300 shadow-lg leading-relaxed">
              <p className="font-medium text-white mb-1">掃描選股 & 回測</p>
              <p>選擇市場和日期，一鍵掃描符合六大條件的個股。可選「掃描選股」快速篩選，或「掃描+回測」驗證策略在歷史數據上的表現。</p>
            </div>
          </span>
          <div className="ml-auto flex items-center gap-2 shrink-0">
            <Link href="/live-daytrade" className="text-[10px] sm:text-xs text-violet-400 hover:text-violet-300 px-2 sm:px-3 py-1 sm:py-1.5 rounded-lg border border-violet-700/60 transition-colors">
              當沖助手
            </Link>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-3 sm:px-4 py-4 sm:py-6 space-y-4 sm:space-y-6">

        {/* Controls */}
        <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-800 bg-slate-800/30 flex items-center justify-between">
            <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">回測參數設定</h2>
            <span className="text-[10px] text-slate-600 hidden sm:block group relative cursor-help">
              ❓ 這是什麼
              <div className="absolute z-50 right-0 top-full mt-1 hidden group-hover:block w-72 p-3 rounded-lg bg-slate-800 border border-slate-600 text-[11px] text-slate-300 shadow-xl space-y-1.5">
                <div className="font-medium text-white text-xs">📊 掃描選股 & 回測</div>
                <p>系統會掃描所有股票，找出在<span className="text-sky-400">指定日期</span>符合六大技術條件的個股。</p>
                <p><span className="text-violet-400">掃描選股</span>：僅列出符合條件的股票清單與評分。</p>
                <p><span className="text-sky-400">掃描+回測</span>：模擬在訊號日買入、按停損/持有天數出場，計算每筆交易的真實績效（含手續費）。</p>
                <p className="text-slate-500 text-[10px]">提示：選越近的日期，後續績效天數越少（因為還沒到）。</p>
              </div>
            </span>
          </div>
          <div className="p-5 flex flex-wrap items-end gap-4">
            {/* Market */}
            <div className="space-y-1.5">
              <label className="text-xs text-slate-500 font-medium">市場</label>
              <div className="flex rounded-lg overflow-hidden border border-slate-700">
                {(['TW', 'CN'] as const).map(m => (
                  <button key={m} onClick={() => { setMarket(m); clearCurrent(); }}
                    className={`px-5 py-2 text-sm font-medium transition-colors ${
                      market === m
                        ? 'bg-sky-600 text-white'
                        : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                    }`}>
                    {m === 'TW' ? '台股' : '陸股'}
                  </button>
                ))}
              </div>
            </div>

            {/* Date */}
            <div className="space-y-1.5">
              <label className="text-xs text-slate-500 font-medium">訊號日期</label>
              <input type="date" value={scanDate} max={maxDate} min="2020-01-01"
                onChange={e => { setScanDate(e.target.value); clearCurrent(); }}
                className="bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-sky-500"
              />
            </div>

            {/* Strategy params — only shown in backtest mode */}
            {!scanOnly && <><div className="space-y-1.5">
              <label className="text-xs text-slate-500 font-medium">持有天數</label>
              <select value={strategy.holdDays}
                onChange={e => setStrategy({ holdDays: +e.target.value })}
                className="bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-sky-500">
                {[1, 3, 5, 10, 20].map(d => <option key={d} value={d}>{d} 日</option>)}
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs text-slate-500 font-medium">停損</label>
              <select
                value={strategy.stopLoss == null ? 'off' : String(strategy.stopLoss)}
                onChange={e => setStrategy({ stopLoss: e.target.value === 'off' ? null : +e.target.value })}
                className="bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-sky-500">
                <option value="off">不設停損</option>
                <option value="-0.05">-5%</option>
                <option value="-0.07">-7%（朱老師）</option>
                <option value="-0.10">-10%</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs text-slate-400 font-medium">停利</label>
              <select
                value={strategy.takeProfit == null ? 'off' : String(strategy.takeProfit)}
                onChange={e => setStrategy({ takeProfit: e.target.value === 'off' ? null : +e.target.value })}
                className="bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-sky-500">
                <option value="off">不設停利</option>
                <option value="0.10">+10%</option>
                <option value="0.15">+15%</option>
                <option value="0.20">+20%</option>
              </select>
            </div>

            {/* Capital Mode Toggle */}
            <div className="space-y-1.5">
              <label className="text-xs text-slate-500 font-medium">資本模式</label>
              <button
                onClick={toggleCapitalMode}
                className={`px-4 py-2 text-sm rounded-lg border transition-colors ${
                  useCapitalMode
                    ? 'bg-amber-700/60 border-amber-600 text-amber-200'
                    : 'bg-slate-800 border-slate-700 text-slate-400 hover:bg-slate-700'
                }`}
              >
                {useCapitalMode ? '💰 資本限制' : '∞ 無限資本'}
              </button>
            </div>

            {/* Capital params (shown when capital mode is on) */}
            {useCapitalMode && (
              <>
                <div className="space-y-1.5">
                  <label className="text-xs text-amber-500/80 font-medium">初始資金（萬）</label>
                  <input
                    type="number" min="10" max="10000" step="10"
                    value={capitalConstraints.initialCapital / 10000}
                    onChange={e => setCapitalConstraints({ initialCapital: +e.target.value * 10000 })}
                    className="bg-slate-800 border border-amber-700/60 text-white rounded-lg px-3 py-2 text-sm w-24 focus:outline-none focus:border-amber-500"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs text-amber-500/80 font-medium">最多持倉</label>
                  <select
                    value={capitalConstraints.maxPositions}
                    onChange={e => setCapitalConstraints({ maxPositions: +e.target.value })}
                    className="bg-slate-800 border border-amber-700/60 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-amber-500"
                  >
                    {[1, 2, 3, 5, 8, 10].map(n => <option key={n} value={n}>{n} 檔</option>)}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs text-amber-500/80 font-medium">每筆倉位</label>
                  <select
                    value={capitalConstraints.positionSizePct}
                    onChange={e => setCapitalConstraints({ positionSizePct: +e.target.value })}
                    className="bg-slate-800 border border-amber-700/60 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-amber-500"
                  >
                    <option value={0.05}>5%</option>
                    <option value={0.1}>10%</option>
                    <option value={0.15}>15%</option>
                    <option value={0.2}>20%</option>
                    <option value={0.25}>25%</option>
                    <option value={0.3}>30%</option>
                    <option value={0.5}>50%</option>
                    <option value={1.0}>100%（全倉）</option>
                  </select>
                </div>
              </>
            )}
            </>}

            {/* 模式切換 + 執行 */}
            <div className="flex items-center gap-3 ml-auto">
              {/* 模式切換 */}
              <div className="flex items-center bg-slate-800 border border-slate-700 rounded-lg overflow-hidden">
                <button onClick={() => setScanOnly(true)}
                  title="僅篩選符合條件的股票清單，速度快"
                  className={`text-xs px-3 py-2 font-medium transition-colors ${
                    scanOnly ? 'bg-violet-600 text-white' : 'text-slate-400 hover:text-white'
                  }`}>
                  掃描選股
                </button>
                <button onClick={() => setScanOnly(false)}
                  title="篩選後模擬買入出場，計算每筆交易的報酬率（含手續費）"
                  className={`text-xs px-3 py-2 font-medium transition-colors ${
                    !scanOnly ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-white'
                  }`}>
                  掃描+回測
                </button>
              </div>

              {scanResults.length > 0 && !isScanning && (
                <div className="text-sm text-slate-400">
                  <span className="text-slate-300 font-medium">{scanDate}</span>
                  {' 選出 '}
                  <span className="text-amber-400 font-bold">{scanResults.length}</span>
                  {' 檔'}
                  {marketTrend && (
                    <span title={`大盤趨勢：${marketTrend}\n多頭＝大盤上漲趨勢，選股勝率較高\n盤整＝大盤方向不明，需謹慎\n空頭＝大盤下跌，選股風險較大`}
                      className={`ml-2 px-1.5 py-0.5 rounded text-[10px] font-bold cursor-help ${
                      marketTrend === '多頭' ? 'bg-red-900/50 text-red-300' :
                      marketTrend === '空頭' ? 'bg-green-900/50 text-green-300' :
                      'bg-yellow-900/50 text-yellow-300'
                    }`}>{marketTrend}</span>
                  )}
                </div>
              )}

              <button onClick={runScan}
                disabled={isScanning || isFetchingForward || !scanDate}
                className={`px-6 py-2.5 ${scanOnly ? 'bg-violet-600 hover:bg-violet-500' : 'bg-sky-600 hover:bg-sky-500'} disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-lg text-sm font-semibold transition-colors whitespace-nowrap`}>
                {isScanning ? '掃描中…' : isFetchingForward ? '計算績效…' : scanOnly ? '開始掃描' : '掃描+回測'}
              </button>
            </div>
          </div>

          {/* Progress */}
          {(isScanning || isFetchingForward) && (
            <div className="px-5 pb-4 space-y-2 border-t border-slate-800 pt-3 mt-0">
              <div className="text-xs text-slate-400 flex items-center justify-between">
                <span>{isScanning ? `掃描歷史數據（${scanDate}）…` : '計算後續績效與回測引擎…'}</span>
                {isScanning && <span className="text-sky-400 font-mono">{Math.round(scanProgress)}%</span>}
              </div>
              <div className="h-1 bg-slate-800 rounded-full overflow-hidden">
                <div className="h-full bg-sky-500 rounded-full transition-all duration-500"
                  style={{ width: isScanning ? `${scanProgress}%` : '100%',
                           animation: isFetchingForward ? 'pulse 1s infinite' : 'none' }} />
              </div>
            </div>
          )}

          {(scanError || forwardError) && (
            <div className="mx-5 mb-4 px-4 py-2.5 bg-red-950/60 border border-red-900 rounded-lg text-sm text-red-300">
              {scanError || forwardError}
            </div>
          )}
        </div>

        {/* Results */}
        {(scanResults.length > 0 || trades.length > 0 || performance.length > 0 || sessions.filter(s => s.market === market).length > 0) && (
          <div className="flex gap-6">
            <div className="flex-1 min-w-0 space-y-4">

              {/* Research Assumptions Notice */}
              <ResearchAssumptions market={market} strategy={strategy} />

              {/* 🎯 當日 Top 3 推薦績效追蹤 */}
              {scanResults.length > 0 && (() => {
                // ── 校準版排名邏輯（基於15天歷史回測優化）──
                // 綜合評分 = 六大條件(35%) + 飆股潛力(25%) + 歷史勝率(20%) + 趨勢位置(10%) + 覆蓋率(10%)
                const scored = [...scanResults]
                  .filter(r => r.surgeScore != null && r.surgeScore >= 30)
                  .map(r => {
                    const sixCon = (r.sixConditionsScore / 6) * 100;                // 0-100 (權重35%)
                    const surge  = (r.surgeScore ?? 0);                             // 0-100 (權重25%)
                    const winR   = r.histWinRate ?? 50;                             // 0-100 (權重20%)
                    const posBonus = r.trendPosition?.includes('起漲') ? 100
                                   : r.trendPosition?.includes('主升') ? 70
                                   : r.trendPosition?.includes('末升') ? 20 : 50;  // (權重10%)
                    const volBonus = (r.surgeComponents?.volume?.score ?? 50);       // (權重10%)
                    const composite = sixCon * 0.35 + surge * 0.25 + winR * 0.20 + posBonus * 0.10 + volBonus * 0.10;
                    return { ...r, _composite: Math.round(composite * 10) / 10 };
                  })
                  .sort((a, b) => b._composite - a._composite)
                  .slice(0, 3);

                if (scored.length === 0) return null;
                const perfMap = new Map(performance.map(p => [p.symbol, p]));

                // 生成選股原因
                const getReasons = (r: typeof scored[0]) => {
                  const reasons: string[] = [];
                  // 六大條件
                  const bd = r.sixConditionsBreakdown;
                  const passed = [
                    bd.trend && '趨勢', bd.position && '位置', bd.kbar && 'K棒',
                    bd.ma && '均線', bd.volume && '量能', bd.indicator && '指標'
                  ].filter(Boolean);
                  if (passed.length > 0) reasons.push(`六大條件 ${r.sixConditionsScore}/6（${passed.join('+')}）`);
                  // 趨勢
                  if (r.trendState && r.trendPosition) reasons.push(`${r.trendState}・${r.trendPosition}`);
                  // 飆股特徵
                  if (r.surgeFlags && r.surgeFlags.length > 0) {
                    const flagMap: Record<string, string> = {
                      'BB_SQUEEZE_BREAKOUT': '布林收縮突破', 'VOLUME_CLIMAX': '量能高潮',
                      'MA_CONVERGENCE_BREAKOUT': '均線收斂突破', 'CONSOLIDATION_BREAKOUT': '盤整突破',
                      'NEW_60D_HIGH': '60日新高', 'MOMENTUM_ACCELERATION': '動能加速',
                      'PROGRESSIVE_VOLUME': '遞增量', 'NEW_20D_HIGH': '20日新高',
                    };
                    const translated = r.surgeFlags.map(f => flagMap[f] || f).slice(0, 3);
                    reasons.push(translated.join('、'));
                  }
                  // 觸發規則
                  if (r.triggeredRules.length > 0) {
                    const buyRules = r.triggeredRules.filter(t => t.signalType === 'BUY').slice(0, 2);
                    if (buyRules.length > 0) reasons.push(buyRules.map(t => t.ruleName).join('、'));
                  }
                  // 歷史勝率
                  if (r.histWinRate != null && r.histWinRate >= 60)
                    reasons.push(`歷史勝率 ${r.histWinRate}%（${r.histSignalCount ?? '?'}次）`);
                  return reasons;
                };

                return (
                  <div className="bg-gradient-to-r from-violet-900/20 to-blue-900/20 border border-violet-700/50 rounded-xl p-4">
                    <div className="flex items-center gap-2 mb-3">
                      <span className="text-lg">🎯</span>
                      <span className="text-sm font-bold text-white">當日 Top 3 推薦績效追蹤</span>
                      <span className="text-[10px] text-slate-500">{scanDate}</span>
                    </div>

                    <div className="space-y-3">
                      {scored.map((r, idx) => {
                        const p = perfMap.get(r.symbol);
                        const reasons = getReasons(r);
                        const retClass = (v: number | null | undefined) =>
                          v == null ? 'text-slate-600' : v > 0 ? 'text-red-400' : v < 0 ? 'text-green-400' : 'text-slate-400';
                        const fmt = (v: number | null | undefined) =>
                          v != null ? `${v > 0 ? '+' : ''}${v.toFixed(2)}%` : '—';
                        const rankColors = ['border-red-500/60 bg-red-950/30', 'border-orange-500/60 bg-orange-950/30', 'border-yellow-500/60 bg-yellow-950/30'];
                        const rankBg = ['bg-red-600', 'bg-orange-500', 'bg-yellow-500'];
                        const rankText = ['text-white', 'text-white', 'text-black'];

                        return (
                          <div key={r.symbol} className={`border rounded-lg p-3 ${rankColors[idx]}`}>
                            {/* 上半：股票基本資訊 + 績效 */}
                            <div className="flex items-start gap-3">
                              <span className={`text-xs font-black w-6 h-6 flex items-center justify-center rounded-full shrink-0 mt-0.5 ${rankBg[idx]} ${rankText[idx]}`}>
                                {idx + 1}
                              </span>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="font-bold text-white text-sm">{r.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '')}</span>
                                  <span className="text-slate-400 text-xs">{r.name}</span>
                                  <span className={`font-bold px-1.5 py-0.5 rounded text-[10px] ${
                                    r.surgeGrade === 'S' ? 'bg-red-600 text-white' :
                                    r.surgeGrade === 'A' ? 'bg-orange-500 text-white' : 'bg-yellow-600 text-white'
                                  }`}>{r.surgeGrade}級</span>
                                  <span className="text-[10px] text-slate-500">潛力{r.surgeScore}</span>
                                  <span className="text-[10px] text-sky-400">綜合{r._composite}</span>
                                  {r.histWinRate != null && (
                                    <span className={`text-[10px] px-1 rounded ${r.histWinRate >= 60 ? 'bg-green-900/60 text-green-300' : r.histWinRate >= 50 ? 'bg-yellow-900/60 text-yellow-300' : 'bg-red-900/60 text-red-300'}`}>
                                      勝率{r.histWinRate}%
                                    </span>
                                  )}
                                  <span className="text-[10px] text-slate-500">買入 {r.price.toFixed(2)}</span>
                                  <Link href={`/?load=${r.symbol}`}
                                    className="text-[10px] text-sky-400 hover:text-sky-300 px-1.5 py-0.5 rounded border border-sky-700/50 hover:bg-sky-900/30 ml-1">
                                    走圖
                                  </Link>
                                  <button
                                    onClick={(e) => {
                                      useWatchlistStore.getState().add(r.symbol, r.name);
                                      const btn = e.currentTarget;
                                      btn.textContent = '✓ 已加';
                                      setTimeout(() => { btn.textContent = '+自選'; }, 1200);
                                    }}
                                    className="text-[10px] text-amber-400 hover:text-amber-300 px-1.5 py-0.5 rounded border border-amber-700/50 hover:bg-amber-900/30">
                                    {useWatchlistStore.getState().has(r.symbol) ? '✓ 已加' : '+自選'}
                                  </button>
                                </div>

                                {/* 選股原因 */}
                                <div className="mt-1.5 flex flex-wrap gap-1">
                                  {reasons.map((reason, i) => (
                                    <span key={i} className="text-[10px] bg-slate-800/80 text-slate-300 px-1.5 py-0.5 rounded">
                                      {reason}
                                    </span>
                                  ))}
                                </div>

                                {/* 績效表格（回測模式才顯示） */}
                                {performance.length > 0 && <div className="mt-2 grid grid-cols-10 gap-1 text-[10px]">
                                  {[
                                    { label: '隔日開', val: p?.openReturn },
                                    { label: '1日', val: p?.d1Return },
                                    { label: '2日', val: p?.d2Return },
                                    { label: '3日', val: p?.d3Return },
                                    { label: '4日', val: p?.d4Return },
                                    { label: '5日', val: p?.d5Return },
                                    { label: '10日', val: p?.d10Return },
                                    { label: '20日', val: p?.d20Return },
                                  ].map(({ label, val }) => (
                                    <div key={label} className="text-center">
                                      <div className="text-slate-500">{label}</div>
                                      <div className={`font-mono font-bold ${retClass(val)}`}>{fmt(val)}</div>
                                    </div>
                                  ))}
                                  <div className="text-center">
                                    <div className="text-slate-500">最高</div>
                                    <div className="font-mono font-bold text-red-400">{p ? `+${p.maxGain.toFixed(1)}%` : '—'}</div>
                                  </div>
                                  <div className="text-center">
                                    <div className="text-slate-500">最低</div>
                                    <div className="font-mono font-bold text-green-400">{p ? `${p.maxLoss.toFixed(1)}%` : '—'}</div>
                                  </div>
                                </div>}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}

              {/* 掃描結果列表（scanOnly 模式） */}
              {scanOnly && scanResults.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-bold text-white">掃描結果</span>
                    <span className="text-slate-400">{scanResults.length} 檔符合條件</span>
                    {marketTrend && (
                      <span title={`大盤趨勢：${marketTrend}\n多頭＝大盤上漲趨勢，選股勝率較高\n盤整＝大盤方向不明，需謹慎\n空頭＝大盤下跌，選股風險較大`}
                        className={`px-1.5 py-0.5 rounded text-[10px] font-bold cursor-help ${
                        marketTrend === '多頭' ? 'bg-red-900/50 text-red-300' :
                        marketTrend === '空頭' ? 'bg-green-900/50 text-green-300' :
                        'bg-yellow-900/50 text-yellow-300'
                      }`}>{String(marketTrend)}</span>
                    )}
                    <button
                      onClick={() => {
                        const headers = ['代號','名稱','概念','評分','等級','潛力','勝率','信號次數','價格','漲跌%','趨勢','位置'];
                        const rows = sortedScanResults.map(r => [
                          r.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, ''), r.name, r.industry ?? '',
                          r.sixConditionsScore, r.surgeGrade ?? '', r.surgeScore ?? '',
                          r.histWinRate != null ? `${r.histWinRate}%` : '', r.histSignalCount ?? '',
                          r.price.toFixed(2), `${r.changePercent >= 0 ? '+' : ''}${r.changePercent.toFixed(2)}%`,
                          r.trendState, r.trendPosition,
                        ]);
                        const csv = '\uFEFF' + [headers, ...rows].map(r => r.map(v => `"${v}"`).join(',')).join('\n');
                        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a'); a.href = url;
                        a.download = `scan_${scanDate}_${market}.csv`; a.click();
                        setTimeout(() => URL.revokeObjectURL(url), 5000);
                      }}
                      className="ml-auto text-[11px] text-sky-400 hover:text-sky-300 px-2.5 py-1 rounded border border-sky-700/50 hover:bg-sky-900/30 transition-colors"
                    >
                      匯出 CSV
                    </button>
                  </div>
                  {/* 概念篩選器 */}
                  {availableConcepts.length > 1 && (
                    <div className="flex flex-wrap gap-1 items-center">
                      <span className="text-[10px] text-slate-500 mr-1">篩選：</span>
                      <button onClick={() => setConceptFilter('all')}
                        className={`text-[10px] px-2 py-0.5 rounded-full transition ${conceptFilter === 'all' ? 'bg-sky-700 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}>
                        全部 ({scanResults.length})
                      </button>
                      {availableConcepts.sort().slice(0, 20).map(c => {
                        const count = scanResults.filter(r => r.industry === c).length;
                        return (
                          <button key={c} onClick={() => setConceptFilter(c)}
                            className={`text-[10px] px-2 py-0.5 rounded-full transition ${conceptFilter === c ? 'bg-sky-700 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}>
                            {c} ({count})
                          </button>
                        );
                      })}
                    </div>
                  )}
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-slate-400 border-b border-slate-700">
                          <th className="text-left py-1.5 px-2">代號</th>
                          <th className="text-left py-1.5 px-2">名稱</th>
                          <th className="text-left py-1.5 px-1 text-[10px]">概念</th>
                          {([
                            { key: 'composite' as const, label: '綜合', align: 'text-center', tooltip: '綜合評分 (0-100)\n六條件35% + 潛力25% + 勝率20%\n+ 位置10% + 量能10%\n越高代表多維度共振越強' },
                            { key: 'score' as const, label: '評分', align: 'text-center', tooltip: '六大條件評分 (0-6)\n1.趨勢：頭頭高底底高+MA排列\n2.位置：MA20乖離0-12%或回踩MA10\n3.K棒：紅棒≥2%收上半部\n4.均線：MA5>MA10>MA20多頭排列\n5.量能：成交量≥5日均量×1.5倍\n6.指標：MACD紅柱或KD黃金交叉' },
                            { key: 'grade' as const, label: '等級', align: 'text-center', tooltip: '飆股潛力等級\nS級(80+)：極強飆股特徵\nA級(65-79)：強勢股\nB級(50-64)：中等潛力\nC級(35-49)：偏弱\nD級(<35)：不具飆股特徵' },
                            { key: 'potential' as const, label: '潛力', align: 'text-center', tooltip: '飆股潛力分數 (0-100)\n動能(18%)+波動率(12%)+量能(15%)\n+突破(15%)+趨勢品質(15%)\n+價格位置(5%)+K棒強度(5%)\n+指標共振(5%)+長期品質(10%)' },
                            { key: 'winRate' as const, label: '勝率', align: 'text-center', tooltip: '歷史勝率：過去同類信號\n在相同策略參數下的獲利比率\n基於回測歷史交易計算' },
                            { key: 'price' as const, label: '價格', align: 'text-right', tooltip: '' },
                            { key: 'change' as const, label: '漲跌%', align: 'text-right', tooltip: '' },
                          ]).map(({ key, label, align, tooltip }) => (
                            <th key={key}
                              title={tooltip || undefined}
                              className={`${align} py-1.5 px-1 cursor-pointer hover:text-white select-none`}
                              onClick={() => {
                                if (scanSort === key) setScanSortDir(d => d === 'desc' ? 'asc' : 'desc');
                                else { setScanSort(key); setScanSortDir('desc'); }
                              }}>
                              {label}{tooltip && <span className="text-[8px] text-slate-600 ml-0.5">ⓘ</span>}
                              {scanSort === key && <span className="ml-0.5 text-sky-400">{scanSortDir === 'desc' ? '▼' : '▲'}</span>}
                            </th>
                          ))}
                          <th className="text-left py-1.5 px-2 whitespace-nowrap">趨勢</th>
                          <th className="text-left py-1.5 px-2 whitespace-nowrap">位置</th>
                          <th className="text-center py-1.5 px-2">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortedScanResults.slice(0, 50).map((r, idx) => (<Fragment key={r.symbol}>
                          <tr className={`border-b border-slate-800/50 hover:bg-slate-800/40 cursor-pointer ${expandedStock === r.symbol ? 'bg-slate-800/60' : ''}`}
                            onClick={() => setExpandedStock(expandedStock === r.symbol ? null : r.symbol)}>
                            <td className="py-1.5 px-2 font-mono font-bold text-white">{r.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '')}</td>
                            <td className="py-1.5 px-2">
                              <div className="text-slate-300">{r.name}</div>
                              <div className="flex gap-0.5 mt-0.5">
                                {[
                                  { pass: r.sixConditionsBreakdown.trend, label: '趨' },
                                  { pass: r.sixConditionsBreakdown.position, label: '位' },
                                  { pass: r.sixConditionsBreakdown.kbar, label: 'K' },
                                  { pass: r.sixConditionsBreakdown.ma, label: '均' },
                                  { pass: r.sixConditionsBreakdown.volume, label: '量' },
                                  { pass: r.sixConditionsBreakdown.indicator, label: '指' },
                                ].map(({ pass, label }) => (
                                  <span key={label} className={`text-[8px] w-3.5 h-3.5 flex items-center justify-center rounded-sm ${pass ? 'bg-sky-800/80 text-sky-300' : 'bg-slate-800/50 text-slate-600'}`}>{label}</span>
                                ))}
                              </div>
                            </td>
                            <td className="py-1.5 px-1 text-[10px] text-slate-500 max-w-[60px] truncate" title={r.industry}>{r.industry ?? '—'}</td>
                            <td className="py-1.5 px-1 text-center">
                              {(() => {
                                const cs = calcComposite(r);
                                return <span className={`font-bold text-[11px] ${cs >= 70 ? 'text-sky-400' : cs >= 55 ? 'text-slate-200' : 'text-slate-500'}`}>{cs.toFixed(1)}</span>;
                              })()}
                            </td>
                            <td className="py-1.5 px-1 text-center">
                              <span className={`font-bold ${r.sixConditionsScore >= 5 ? 'text-red-400' : r.sixConditionsScore >= 4 ? 'text-orange-400' : 'text-yellow-400'}`}>
                                {r.sixConditionsScore}/6
                              </span>
                            </td>
                            <td className="py-1.5 px-1 text-center">
                              {r.surgeGrade && (
                                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                                  r.surgeGrade === 'S' ? 'bg-red-600 text-white' :
                                  r.surgeGrade === 'A' ? 'bg-orange-500 text-white' :
                                  r.surgeGrade === 'B' ? 'bg-yellow-500 text-black' :
                                  'bg-slate-600 text-slate-300'
                                }`}>{r.surgeGrade}</span>
                              )}
                            </td>
                            <td className="py-1.5 px-1 text-center font-mono text-slate-300">{r.surgeScore ?? '—'}</td>
                            <td className="py-1.5 px-1 text-center">
                              {r.histWinRate != null && (
                                <span className={`text-[10px] px-1 rounded ${r.histWinRate >= 60 ? 'bg-green-900/60 text-green-300' : r.histWinRate >= 50 ? 'bg-yellow-900/60 text-yellow-300' : 'bg-red-900/60 text-red-300'}`}
                                  title={`基於過去 ${r.histSignalCount ?? '?'} 次同類信號的歷史勝率`}>
                                  {r.histWinRate}%<span className="text-[8px] opacity-60">({r.histSignalCount ?? '?'})</span>
                                </span>
                              )}
                            </td>
                            <td className="py-1.5 px-2 text-right font-mono text-white">{r.price.toFixed(2)}</td>
                            <td className={`py-1.5 px-2 text-right font-mono font-bold ${r.changePercent >= 0 ? 'text-red-400' : 'text-green-400'}`}>
                              {r.changePercent >= 0 ? '+' : ''}{r.changePercent.toFixed(2)}%
                            </td>
                            <td className="py-1.5 px-2 text-[10px] text-slate-400 whitespace-nowrap">{r.trendState}</td>
                            <td className="py-1.5 px-2 text-[10px] text-slate-400 whitespace-nowrap">{r.trendPosition}</td>
                            <td className="py-1.5 px-2 text-center whitespace-nowrap">
                              <Link href={`/?load=${r.symbol}`}
                                className="text-[10px] text-sky-400 hover:text-sky-300 px-1.5 py-0.5 rounded border border-sky-700/50 hover:bg-sky-900/30 mr-1">
                                走圖
                              </Link>
                              <button
                                onClick={(e) => {
                                  useWatchlistStore.getState().add(r.symbol, r.name);
                                  const btn = e.currentTarget;
                                  btn.textContent = '✓ 已加';
                                  setTimeout(() => { btn.textContent = '+自選'; }, 1200);
                                }}
                                className="text-[10px] text-amber-400 hover:text-amber-300 px-1.5 py-0.5 rounded border border-amber-700/50 hover:bg-amber-900/30">
                                {useWatchlistStore.getState().has(r.symbol) ? '✓ 已加' : '+自選'}
                              </button>
                            </td>
                          </tr>
                          {expandedStock === r.symbol && (
                            <tr className="bg-slate-900/80">
                              <td colSpan={13} className="px-4 py-3">
                                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-[11px]">
                                  {/* 飆股組件分數 */}
                                  {r.surgeComponents && (
                                    <div className="space-y-1.5">
                                      <div className="text-slate-400 font-medium">飆股潛力分解</div>
                                      {([
                                        { key: 'momentum', label: '動能', w: '18%' },
                                        { key: 'volatility', label: '波動', w: '12%' },
                                        { key: 'volume', label: '量能', w: '15%' },
                                        { key: 'breakout', label: '突破', w: '15%' },
                                        { key: 'trendQuality', label: '趨勢', w: '15%' },
                                        { key: 'pricePosition', label: '位置', w: '5%' },
                                        { key: 'kbarStrength', label: 'K棒', w: '5%' },
                                        { key: 'indicatorConfluence', label: '指標', w: '5%' },
                                        { key: 'longTermQuality', label: '長期', w: '10%' },
                                      ] as const).map(({ key, label, w }) => {
                                        const comp = r.surgeComponents![key];
                                        return (
                                          <div key={key} className="flex items-center gap-2">
                                            <span className="w-8 text-slate-500">{label}</span>
                                            <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                                              <div className={`h-full rounded-full ${comp.score >= 70 ? 'bg-red-500' : comp.score >= 40 ? 'bg-amber-500' : 'bg-slate-600'}`}
                                                style={{ width: `${comp.score}%` }} />
                                            </div>
                                            <span className="w-6 text-right text-slate-400">{comp.score}</span>
                                            <span className="text-[9px] text-slate-600">({w})</span>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  )}
                                  {/* 飆股特徵標籤 */}
                                  <div className="space-y-1.5">
                                    <div className="text-slate-400 font-medium">技術特徵</div>
                                    <div className="flex flex-wrap gap-1">
                                      {(r.surgeFlags ?? []).map(f => (
                                        <span key={f} className="px-1.5 py-0.5 bg-sky-900/40 text-sky-300 rounded text-[10px]">{f}</span>
                                      ))}
                                      {(r.surgeFlags ?? []).length === 0 && <span className="text-slate-600">無明顯飆股特徵</span>}
                                    </div>
                                    <div className="text-slate-400 font-medium mt-2">趨勢摘要</div>
                                    <div className="text-slate-300 text-[10px] space-y-0.5">
                                      <div>趨勢：{r.trendState} · {r.trendPosition}</div>
                                      <div>價格：{r.price.toFixed(2)} · 漲跌：{r.changePercent >= 0 ? '+' : ''}{r.changePercent.toFixed(2)}%</div>
                                      <div>成交量：{(r.volume / 1000).toFixed(0)}K</div>
                                    </div>
                                  </div>
                                  {/* 觸發規則 */}
                                  <div className="space-y-1.5">
                                    <div className="text-slate-400 font-medium">觸發的交易規則</div>
                                    <div className="space-y-0.5 max-h-32 overflow-y-auto">
                                      {r.triggeredRules.slice(0, 8).map((rule, i) => (
                                        <div key={i} className="flex items-start gap-1.5 text-[10px]">
                                          <span className={`mt-0.5 w-1.5 h-1.5 rounded-full shrink-0 ${rule.signalType === 'BUY' ? 'bg-red-400' : 'bg-green-400'}`} />
                                          <span className="text-slate-400">{rule.reason}</span>
                                        </div>
                                      ))}
                                      {r.triggeredRules.length === 0 && <span className="text-slate-600 text-[10px]">無觸發規則</span>}
                                    </div>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {scanResults.length > 50 && (
                    <div className="text-xs text-slate-500 text-center space-y-0.5">
                      <div>顯示前 50 檔（共 {filteredScanResults.length}{conceptFilter !== 'all' ? `/${scanResults.length}` : ''} 檔）</div>
                      <div className="text-[10px] text-slate-600">數據來源：Yahoo Finance · TWSE/TPEx/東方財富 · 掃描日期 {scanDate}</div>
                    </div>
                  )}
                </div>
              )}

              {/* Tab switcher — 回測模式才顯示 */}
              {!scanOnly && <><div className="flex items-center gap-1 border-b border-slate-800">
                {([
                  { key: 'strict',      label: '嚴謹回測',    icon: '🔬' },
                  { key: 'horizon',     label: '時間視角',    icon: '📊' },
                  { key: 'walkforward', label: 'Walk-Forward', icon: '🔁' },
                ] as const).map(({ key, label, icon }) => (
                  <button key={key} onClick={() => setTab(key)}
                    className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                      tab === key
                        ? 'border-sky-500 text-sky-300'
                        : 'border-transparent text-slate-500 hover:text-slate-300'
                    }`}>
                    <span>{icon}</span>
                    <span>{label}</span>
                  </button>
                ))}
              </div>

              {/* Tab descriptions */}
              <div className="bg-slate-900/40 border border-slate-800 rounded-lg px-4 py-2.5 text-xs text-slate-500">
                {tab === 'strict' && '🔬 嚴謹回測：模擬真實交易（含手續費0.1425%、證交稅0.3%、滑點），計算每筆交易的淨報酬。可設定止損/止盈/持有天數。'}
                {tab === 'horizon' && '📊 時間視角：檢視信號發出後 1/5/10/20 天的報酬率分佈，了解不同持有期間的表現差異。'}
                {tab === 'walkforward' && '🔁 Walk-Forward：將數據分成多個訓練/測試窗口，在訓練期優化策略後在測試期驗證，確保策略不是過度擬合。這是最嚴格的驗證方法。'}
              </div>

              {/* ── Tab: Strict ── */}
              {tab === 'strict' && (
                <div className="space-y-4">
                  {stats && <StrictStatsPanel stats={stats} tradesCount={trades.length} trades={trades} />}
                  {useCapitalMode && trades.length > 0 && (
                    <CapitalPanel
                      trades={trades}
                      constraints={capitalConstraints}
                      finalCapital={finalCapital}
                      capitalReturn={capitalReturn}
                      skippedByCapital={skippedByCapital}
                    />
                  )}

                  <div className="flex items-center justify-end mb-2">
                    <button
                      onClick={() => exportToCsv(sortedTrades, scanDate)}
                      disabled={sortedTrades.length === 0}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-40 rounded-lg text-[11px] text-slate-300 hover:text-white transition-colors"
                    >
                      匯出 CSV
                    </button>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-slate-400 border-b border-slate-700">
                          <th className="text-left py-1.5 px-2">代號</th>
                          <th className="text-left py-1.5 px-2">名稱</th>
                          <th className="text-left py-1.5 px-1 text-[10px]">概念</th>
                          {([
                            { key: 'composite' as const, label: '綜合', tooltip: '綜合評分 (0-100)\n六條件35% + 潛力25% + 勝率20%\n+ 位置10% + 量能10%\n越高代表多維度共振越強' },
                            { key: 'signalScore' as const, label: '評分', tooltip: '六大條件評分 (0-6)\n1.趨勢 2.位置 3.K棒\n4.均線 5.量能 6.指標\n≥4分才列入選股' },
                            { key: 'surgeScore' as const, label: '等級', tooltip: '飆股潛力等級\nS(80+) A(65-79) B(50-64)\nC(35-49) D(<35)' },
                            { key: 'surgeScore' as const, label: '潛力', tooltip: '飆股潛力分 (0-100)\n9大維度加權：動能18% 量能15%\n突破15% 趨勢15% 波動12%\n長線10% 位置5% K棒5% 共振5%' },
                            { key: 'histWinRate' as const, label: '勝率', tooltip: '歷史勝率\n過去120天同類信號\n隔日開盤買→持有5日賣\n有多少次是賺錢的' },
                          ]).map(({ key, label, tooltip }) => (
                            <th key={label}
                              title={tooltip || undefined}
                              className="text-center py-1.5 px-1 cursor-pointer hover:text-white select-none"
                              onClick={() => {
                                if (sortBy === key) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
                                else { setSortBy(key); setSortDir('desc'); }
                              }}>
                              {label}{tooltip && <span className="text-[8px] text-slate-600 ml-0.5">ⓘ</span>}
                              {sortBy === key && <span className="ml-0.5 text-sky-400">{sortDir === 'desc' ? '▼' : '▲'}</span>}
                            </th>
                          ))}
                          <th className="text-right py-1.5 px-2 whitespace-nowrap">進場價</th>
                          <th className="text-center py-1.5 px-2 whitespace-nowrap">趨勢</th>
                          <th className="text-left py-1.5 px-2 whitespace-nowrap">位置</th>
                          <th className="text-right py-1.5 px-2 whitespace-nowrap">出場價</th>
                          <th className="text-center py-1.5 px-2 whitespace-nowrap cursor-pointer hover:text-white select-none"
                            onClick={() => {
                              if (sortBy === 'holdDays') setSortDir(d => d === 'desc' ? 'asc' : 'desc');
                              else { setSortBy('holdDays'); setSortDir('desc'); }
                            }}>
                            持有{sortBy === 'holdDays' && <span className="ml-0.5 text-sky-400">{sortDir === 'desc' ? '▼' : '▲'}</span>}
                          </th>
                          <th className="text-right py-1.5 px-2 whitespace-nowrap cursor-pointer hover:text-white select-none"
                            onClick={() => {
                              if (sortBy === 'netReturn') setSortDir(d => d === 'desc' ? 'asc' : 'desc');
                              else { setSortBy('netReturn'); setSortDir('desc'); }
                            }}>
                            淨報酬{sortBy === 'netReturn' && <span className="ml-0.5 text-sky-400">{sortDir === 'desc' ? '▼' : '▲'}</span>}
                          </th>
                          <th className="text-center py-1.5 px-1">出場</th>
                          <th className="text-center py-1.5 px-2">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortedTrades.map(t => <TradeRow key={t.symbol + t.entryDate} t={t} />)}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* ── Tab: Horizon ── */}
              {tab === 'horizon' && performance.length > 0 && (
                <div className="space-y-4">
                  <div className="grid grid-cols-4 md:grid-cols-8 gap-2">
                    {horizonLabels.map(({ key, label }) => (
                      <HorizonCard key={key} label={label} horizon={key} performance={performance} />
                    ))}
                  </div>

                  <div className="overflow-x-auto">
                    <div className="flex gap-1 mb-2">
                      {horizonLabels.map(({ key, label }) => (
                        <button key={key} onClick={() => setHorizon(key)}
                          className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                            activeHorizon === key ? 'bg-sky-700 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                          }`}>
                          {label}
                        </button>
                      ))}
                    </div>
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-slate-700 text-slate-400">
                          <th className="text-left py-1.5 px-2">代號</th>
                          <th className="text-left py-1.5 px-2">名稱</th>
                          <th className="text-left py-1.5 px-1 text-[10px]">概念</th>
                          {([
                            { key: 'composite' as const, label: '綜合', tooltip: '綜合評分 (0-100)\n六條件35% + 潛力25% + 勝率20%\n+ 位置10% + 量能10%' },
                            { key: 'score' as const, label: '評分', tooltip: '六大條件評分 (0-6)\n1.趨勢 2.位置 3.K棒\n4.均線 5.量能 6.指標' },
                            { key: 'grade' as const, label: '等級', tooltip: '飆股潛力等級\nS(80+) A(65-79) B(50-64)\nC(35-49) D(<35)' },
                            { key: 'potential' as const, label: '潛力', tooltip: '飆股潛力分 (0-100)\n9大維度加權計算' },
                            { key: 'winRate' as const, label: '勝率', tooltip: '過去120天同類信號的歷史勝率' },
                            { key: 'price' as const, label: '價格', tooltip: '' },
                            { key: 'change' as const, label: '漲跌%', tooltip: '' },
                          ]).map(({ key, label, tooltip }) => (
                            <th key={key}
                              title={tooltip || undefined}
                              className={`${key === 'price' || key === 'change' ? 'text-right' : 'text-center'} py-1.5 px-1 cursor-pointer hover:text-white select-none`}
                              onClick={() => {
                                if (scanSort === key) setScanSortDir(d => d === 'desc' ? 'asc' : 'desc');
                                else { setScanSort(key); setScanSortDir('desc'); }
                              }}>
                              {label}{tooltip && <span className="text-[8px] text-slate-600 ml-0.5">ⓘ</span>}
                              {scanSort === key && <span className="ml-0.5 text-sky-400">{scanSortDir === 'desc' ? '▼' : '▲'}</span>}
                            </th>
                          ))}
                          <th className="text-left py-1.5 px-2 whitespace-nowrap">趨勢</th>
                          <th className="text-left py-1.5 px-2 whitespace-nowrap">位置</th>
                          <th className="text-right py-1.5 px-1.5 whitespace-nowrap">隔日開</th>
                          <th className="text-right py-1.5 px-1.5 whitespace-nowrap">1日</th>
                          <th className="text-right py-1.5 px-1.5 whitespace-nowrap">2日</th>
                          <th className="text-right py-1.5 px-1.5 whitespace-nowrap">3日</th>
                          <th className="text-right py-1.5 px-1.5 whitespace-nowrap">4日</th>
                          <th className="text-right py-1.5 px-1.5 whitespace-nowrap">5日</th>
                          <th className="text-right py-1.5 px-1.5 whitespace-nowrap">10日</th>
                          <th className="text-right py-1.5 px-1.5 whitespace-nowrap">20日</th>
                          <th className="text-right py-1.5 px-1.5 whitespace-nowrap">最高/最低</th>
                          <th className="text-center py-1.5 px-2">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortedScanResults.map(r => {
                          const p = perfMap.get(r.symbol);
                          const sym = r.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
                          return (
                            <tr key={r.symbol} className="border-b border-slate-800/50 hover:bg-slate-800/40">
                              <td className="py-1.5 px-2 font-mono font-bold text-white">{sym}</td>
                              <td className="py-1.5 px-2">
                                <div className="text-slate-300">{r.name}</div>
                                <div className="flex gap-0.5 mt-0.5">
                                  {[
                                    { pass: r.sixConditionsBreakdown.trend, label: '趨' },
                                    { pass: r.sixConditionsBreakdown.position, label: '位' },
                                    { pass: r.sixConditionsBreakdown.kbar, label: 'K' },
                                    { pass: r.sixConditionsBreakdown.ma, label: '均' },
                                    { pass: r.sixConditionsBreakdown.volume, label: '量' },
                                    { pass: r.sixConditionsBreakdown.indicator, label: '指' },
                                  ].map(({ pass, label }) => (
                                    <span key={label} className={`text-[8px] w-3.5 h-3.5 flex items-center justify-center rounded-sm ${pass ? 'bg-sky-800/80 text-sky-300' : 'bg-slate-800/50 text-slate-600'}`}>{label}</span>
                                  ))}
                                </div>
                              </td>
                              <td className="py-1.5 px-1 text-[10px] text-slate-500 max-w-[60px] truncate" title={r.industry}>{r.industry ?? '—'}</td>
                              <td className="py-1.5 px-1 text-center">
                                {(() => { const cs = calcComposite(r); return <span className={`font-bold text-[11px] ${cs >= 70 ? 'text-sky-400' : cs >= 55 ? 'text-slate-200' : 'text-slate-500'}`}>{cs.toFixed(1)}</span>; })()}
                              </td>
                              <td className="py-1.5 px-1 text-center">
                                <span className={`font-bold ${r.sixConditionsScore >= 5 ? 'text-red-400' : r.sixConditionsScore >= 4 ? 'text-orange-400' : 'text-yellow-400'}`}>
                                  {r.sixConditionsScore}/6
                                </span>
                              </td>
                              <td className="py-1.5 px-1 text-center">
                                {r.surgeGrade && (
                                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                                    r.surgeGrade === 'S' ? 'bg-red-600 text-white' :
                                    r.surgeGrade === 'A' ? 'bg-orange-500 text-white' :
                                    r.surgeGrade === 'B' ? 'bg-yellow-500 text-black' :
                                    'bg-slate-600 text-slate-300'
                                  }`}>{r.surgeGrade}</span>
                                )}
                              </td>
                              <td className="py-1.5 px-1 text-center font-mono text-slate-300">{r.surgeScore ?? '—'}</td>
                              <td className="py-1.5 px-1 text-center">
                                {r.histWinRate != null && (
                                  <span className={`text-[10px] px-1 rounded ${r.histWinRate >= 60 ? 'bg-green-900/60 text-green-300' : r.histWinRate >= 50 ? 'bg-yellow-900/60 text-yellow-300' : 'bg-red-900/60 text-red-300'}`}>
                                    {r.histWinRate}%<span className="text-[8px] opacity-60">({r.histSignalCount ?? '?'})</span>
                                  </span>
                                )}
                              </td>
                              <td className="py-1.5 px-2 text-right font-mono text-white">{r.price.toFixed(2)}</td>
                              <td className={`py-1.5 px-2 text-right font-mono font-bold ${r.changePercent >= 0 ? 'text-red-400' : 'text-green-400'}`}>
                                {r.changePercent >= 0 ? '+' : ''}{r.changePercent.toFixed(2)}%
                              </td>
                              <td className="py-1.5 px-2 text-[10px] text-slate-400 whitespace-nowrap">{r.trendState}</td>
                              <td className="py-1.5 px-2 text-[10px] text-slate-400 whitespace-nowrap">{r.trendPosition}</td>
                              {p ? (
                                <>
                                  {[p.openReturn, p.d1Return, p.d2Return, p.d3Return, p.d4Return, p.d5Return, p.d10Return, p.d20Return].map((v, i) => (
                                    <td key={i} className={`py-1.5 px-1 text-right font-mono ${retColor(v)}`}>{fmtRet(v)}</td>
                                  ))}
                                  <td className="py-1.5 px-1 text-right whitespace-nowrap">
                                    <span className="text-red-400">+{p.maxGain.toFixed(1)}%</span>
                                    <span className="text-slate-600">/</span>
                                    <span className="text-green-500">{p.maxLoss.toFixed(1)}%</span>
                                  </td>
                                </>
                              ) : (
                                <td colSpan={9} className="py-1.5 text-center text-slate-600">—</td>
                              )}
                              <td className="py-1.5 px-2 text-center whitespace-nowrap">
                                <Link href={`/?load=${sym}`}
                                  className="text-[10px] text-sky-400 hover:text-sky-300 px-1.5 py-0.5 rounded border border-sky-700/50 hover:bg-sky-900/30 mr-1">走圖</Link>
                                <button onClick={() => { useWatchlistStore.getState().add(r.symbol, r.name); }}
                                  className="text-[10px] text-amber-400 hover:text-amber-300 px-1.5 py-0.5 rounded border border-amber-700/50 hover:bg-amber-900/30">
                                  {useWatchlistStore.getState().has(r.symbol) ? '✓ 已加' : '+自選'}
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* ── Tab: Walk-Forward ── */}
              {tab === 'walkforward' && (
                <WalkForwardPanel
                  result={walkForwardResult}
                  sessionCount={sessions.filter(s => s.market === market).length}
                  minRequired={walkForwardConfig.trainSize + walkForwardConfig.testSize}
                  isRunning={isRunningWF}
                  onRun={computeWalkForward}
                  trainSize={walkForwardConfig.trainSize}
                  testSize={walkForwardConfig.testSize}
                  stepSize={walkForwardConfig.stepSize}
                  onTrainSize={n => setWalkForwardConfig({ trainSize: n })}
                  onTestSize={n  => setWalkForwardConfig({ testSize: n })}
                  onStepSize={n  => setWalkForwardConfig({ stepSize: n })}
                />
              )}
              </>}
            </div>

            {/* Sidebar */}
            <div className="w-52 shrink-0 hidden lg:block">
              <SessionHistory />
            </div>
          </div>
        )}

        {/* Empty state */}
        {!isScanning && !isFetchingForward && scanResults.length === 0 && !scanError && (
          scanProgress ? (
            /* 掃描完成但無結果 */
            <div className="text-center py-16 text-slate-500 space-y-3">
              <div className="text-5xl">📭</div>
              <div className="text-lg font-medium text-slate-400">本日無符合條件的個股</div>
              <div className="text-sm space-y-1">
                <p>可能的原因：</p>
                <ul className="text-xs text-slate-500 space-y-0.5">
                  <li>大盤處於空頭或盤整，門檻自動提高</li>
                  <li>該日期市場整體量能不足</li>
                  <li>策略條件較嚴格（可在「策略」頁面調整門檻）</li>
                </ul>
                <p className="text-xs text-sky-400 mt-3">建議：嘗試其他日期，或降低最低評分門檻</p>
              </div>
            </div>
          ) : (
            /* 初始歡迎狀態 */
            <div className="text-center py-20 text-slate-500 space-y-2">
              <div className="text-5xl">🔬</div>
              <div className="text-lg font-medium text-slate-400">選擇市場、日期、策略，開始回測</div>
              <div className="text-sm">嚴謹模式：進場用隔日開盤價，成本模型台股/陸股分開計算</div>
              <div className="text-sm">每筆交易保留完整進出場紀錄與命中原因</div>
            </div>
          )
        )}

      </div>
    </div>
  );
}
