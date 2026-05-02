'use client';

import { useState, useMemo, Fragment } from 'react';
import { useBacktestStore } from '@/store/backtestStore';
import { useWatchlistStore } from '@/store/watchlistStore';
import type { SelectedStock } from './ScanChartPanel';
import type { StockForwardPerformance } from '@/lib/scanner/types';

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtRet(val: number | null | undefined): string {
  if (val == null) return '—';
  return `${val >= 0 ? '+' : ''}${val.toFixed(1)}%`;
}

function retColor(val: number | null | undefined): string {
  if (val == null) return 'text-muted-foreground/50';
  if (val > 0) return 'text-bull';
  if (val < 0) return 'text-bear';
  return 'text-muted-foreground';
}

const COMPACT_FWD = [
  { key: 'openReturn' as const, label: '隔日開' },
  { key: 'd1Return' as const, label: '1日' },
  { key: 'd2Return' as const, label: '2日' },
  { key: 'd3Return' as const, label: '3日' },
  { key: 'd4Return' as const, label: '4日' },
  { key: 'd5Return' as const, label: '5日' },
  { key: 'd6Return' as const, label: '6日' },
  { key: 'd7Return' as const, label: '7日' },
  { key: 'd8Return' as const, label: '8日' },
  { key: 'd9Return' as const, label: '9日' },
  { key: 'd10Return' as const, label: '10日' },
  { key: 'd20Return' as const, label: '20日' },
  { key: 'maxGain' as const, label: '最高' },
  { key: 'maxLoss' as const, label: '最低' },
] as const;

interface ScanResultsCompactProps {
  onSelectStock?: (stock: SelectedStock) => void;
}

export function ScanResultsCompact({ onSelectStock }: ScanResultsCompactProps) {
  const {
    scanResults, scanDate, market, marketTrend, scanOnly,
    performance, isFetchingForward, isLoadingCronSession,
    activeBuyMethod,
  } = useBacktestStore();

  const [expandedStock, setExpandedStock] = useState<string | null>(null);
  const [conceptFilter, setConceptFilter] = useState<string>('all');
  const [scanSortDir] = useState<'desc'>('desc');

  const perfMap = useMemo(() => {
    const map = new Map<string, StockForwardPerformance>();
    for (const p of performance) map.set(p.symbol, p);
    return map;
  }, [performance]);

  const availableConcepts = [...new Set(scanResults.map(r => r.industry).filter(Boolean))] as string[];

  const filtered = conceptFilter === 'all'
    ? scanResults
    : scanResults.filter(r => r.industry === conceptFilter);

  const sorted = [...filtered].sort((a, b) => {
    const dir = scanSortDir === 'desc' ? 1 : -1;
    return dir * ((b.changePercent ?? 0) - (a.changePercent ?? 0));
  });

  if (!scanOnly) return null;
  if (scanResults.length === 0 && isLoadingCronSession) return null;

  if (scanResults.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <p className="text-2xl mb-2">🔍</p>
        <p className="text-xs text-muted-foreground">尚無掃描結果</p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5 px-2">
      {/* Header */}
      <div className="flex items-center gap-1.5 text-xs flex-wrap">
        <span className="font-bold text-foreground">{scanResults.length} 檔</span>
        <span className="text-[10px] text-muted-foreground/60">{scanDate}</span>
        {marketTrend && (
          <span className={`px-1 py-0.5 rounded text-[9px] font-bold ${
            marketTrend === '多頭' ? 'bg-red-900/50 text-red-300' :
            marketTrend === '空頭' ? 'bg-green-900/50 text-green-300' :
            'bg-yellow-900/50 text-yellow-300'
          }`}>{String(marketTrend)}</span>
        )}
        {isFetchingForward && (
          <span className="text-[9px] text-sky-400 animate-pulse">載入中…</span>
        )}
      </div>


      {/* Concept filter pills */}
      {availableConcepts.length > 1 && (
        <div className="flex flex-wrap gap-1">
          <button onClick={() => setConceptFilter('all')}
            className={`text-[9px] px-1.5 py-0.5 rounded-full ${conceptFilter === 'all' ? 'bg-sky-700 text-foreground' : 'bg-secondary text-muted-foreground'}`}>
            全部
          </button>
          {availableConcepts.sort().slice(0, 10).map(c => (
            <button key={c} onClick={() => setConceptFilter(c)}
              className={`text-[9px] px-1.5 py-0.5 rounded-full ${conceptFilter === c ? 'bg-sky-700 text-foreground' : 'bg-secondary text-muted-foreground'}`}>
              {c}
            </button>
          ))}
        </div>
      )}

      {/* Card list */}
      {sorted.slice(0, 50).map(r => {
        const perf = perfMap.get(r.symbol);
        const isExpanded = expandedStock === r.symbol;
        const ticker = r.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');

        return (
          <Fragment key={r.symbol}>
            <div
              className={`rounded-lg border border-border/60 px-2.5 py-2 cursor-pointer hover:bg-secondary/40 transition-colors ${isExpanded ? 'bg-secondary/60 border-sky-700/50' : 'bg-card'}`}
              onClick={() => setExpandedStock(isExpanded ? null : r.symbol)}
            >
              {/* Row 1: Symbol + Name + Change% + Actions */}
              <div className="flex items-center gap-1.5 mb-1">
                <span className="font-mono text-[11px] text-foreground/90 shrink-0">{ticker}</span>
                <span className="text-[11px] text-foreground/80 truncate flex-1">{r.name}</span>
                <span className={`font-mono text-[11px] font-bold shrink-0 ${r.changePercent >= 0 ? 'text-bull' : 'text-bear'}`}>
                  {r.changePercent >= 0 ? '+' : ''}{r.changePercent.toFixed(1)}%
                </span>
              </div>

              {/* Row 2: Price + Industry + Trend + Position + Turnover Rank */}
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground mb-1">
                <span className="font-mono">{r.price.toFixed(2)}</span>
                {r.industry && <span className="truncate max-w-[60px]">{r.industry}</span>}
                <span>{r.trendState}</span>
                <span className="truncate">{r.trendPosition}</span>
                {r.turnoverRank !== undefined && (
                  <span
                    className="ml-auto text-[9px] font-mono text-amber-400/80 bg-amber-900/20 px-1 py-px rounded shrink-0"
                    title="20日均成交額排名（全市場前500內）"
                  >
                    成交量第{r.turnoverRank}名
                  </span>
                )}
              </div>

              {/* Row 3: 條件 badges */}
              <div className="flex items-center gap-1 mb-1">
                {activeBuyMethod && activeBuyMethod !== 'A' ? (
                  // B/C/D/E/F：顯示策略觸發條件 + 跨策略命中徽章
                  (() => {
                    const rule = r.triggeredRules?.[0];
                    const methodColors: Record<string, string> = {
                      A: 'bg-amber-800/80 text-amber-200',
                      B: 'bg-sky-800/80 text-sky-300',
                      C: 'bg-emerald-800/80 text-emerald-300',
                      D: 'bg-purple-800/80 text-purple-300',
                      E: 'bg-orange-800/80 text-orange-300',
                      F: 'bg-rose-800/80 text-rose-300',
                    };
                    const methodNames: Record<string, string> = {
                      A: '六條件', B: '回後買上漲', C: '盤整突破',
                      D: '一字底', E: '缺口', F: 'V反轉',
                    };
                    const color = methodColors[activeBuyMethod] ?? 'bg-sky-800/80 text-sky-300';
                    const others = (r.matchedMethods ?? []).filter(m => m !== activeBuyMethod);
                    return (
                      <>
                        <span className={`text-[8px] px-1.5 h-3.5 flex items-center rounded-sm max-w-[160px] truncate ${color}`}
                          title={rule?.ruleName ?? ''}>
                          {rule ? rule.ruleName.replace(/（.*）$/, '') : activeBuyMethod}
                        </span>
                        {others.map(m => (
                          <span key={m}
                            className={`text-[8px] px-1 h-3.5 flex items-center rounded-sm font-bold ${methodColors[m] ?? 'bg-secondary/60 text-foreground/70'}`}
                            title={`同時命中：${m}（${methodNames[m] ?? ''}）`}>
                            +{methodNames[m] ?? m}
                          </span>
                        ))}
                      </>
                    );
                  })()
                ) : (
                  // A（六條件）：六個條件格子 + 分數 + 跨策略命中徽章
                  (() => {
                    const methodColors: Record<string, string> = {
                      B: 'bg-sky-800/80 text-sky-300',
                      C: 'bg-emerald-800/80 text-emerald-300',
                      D: 'bg-purple-800/80 text-purple-300',
                      E: 'bg-orange-800/80 text-orange-300',
                      F: 'bg-rose-800/80 text-rose-300',
                    };
                    const methodNames: Record<string, string> = {
                      B: '回後買上漲', C: '盤整突破', D: '一字底', E: '缺口', F: 'V反轉',
                    };
                    const others = (r.matchedMethods ?? []).filter(m => m !== 'A');
                    return (
                      <>
                        {[
                          { pass: r.sixConditionsBreakdown?.trend, label: '趨' },
                          { pass: r.sixConditionsBreakdown?.position, label: '位' },
                          { pass: r.sixConditionsBreakdown?.kbar, label: 'K' },
                          { pass: r.sixConditionsBreakdown?.ma, label: '均' },
                          { pass: r.sixConditionsBreakdown?.volume, label: '量' },
                          { pass: r.sixConditionsBreakdown?.indicator, label: '指' },
                        ].map(({ pass, label }) => (
                          <span key={label} className={`text-[8px] w-3.5 h-3.5 flex items-center justify-center rounded-sm ${pass ? 'bg-sky-800/80 text-sky-300' : 'bg-secondary/50 text-muted-foreground/60'}`}>{label}</span>
                        ))}
                        <span className="text-[9px] text-sky-400 ml-0.5">{r.sixConditionsScore}/6</span>
                        {others.map(m => (
                          <span key={m}
                            className={`text-[8px] px-1 h-3.5 flex items-center rounded-sm font-bold ${methodColors[m] ?? 'bg-secondary/60 text-foreground/70'}`}
                            title={`同時命中：${m}（${methodNames[m] ?? ''}）`}>
                            +{methodNames[m] ?? m}
                          </span>
                        ))}
                      </>
                    );
                  })()
                )}

                {/* Action buttons */}
                <div className="ml-auto flex items-center gap-1">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectStock?.({ symbol: r.symbol, name: r.name, market: market as 'TW' | 'CN' });
                    }}
                    className="text-[9px] text-sky-400 hover:text-sky-300 px-1 py-0.5 rounded border border-sky-700/50 hover:bg-sky-900/30">
                    走圖
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      useWatchlistStore.getState().add(r.symbol, r.name, r.price);
                    }}
                    className="text-[9px] text-amber-400 hover:text-amber-300 px-1 py-0.5 rounded border border-amber-700/50 hover:bg-amber-900/30">
                    {useWatchlistStore.getState().has(r.symbol) ? '✓' : '+'}
                  </button>
                </div>
              </div>

              {/* Row 4: Compact forward performance */}
              <div className="flex items-center gap-0.5">
                {COMPACT_FWD.map(({ key, label }) => {
                  const val = perf ? perf[key] : undefined;
                  return (
                    <div key={key} className="flex-1 text-center">
                      <div className="text-[8px] text-muted-foreground/60">{label}</div>
                      <div className={`text-[9px] font-mono ${retColor(val as number | null | undefined)}`}>
                        {isFetchingForward && !perf ? '…' : fmtRet(val as number | null | undefined)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Expanded details */}
            {isExpanded && (
              <div className="rounded-lg border border-sky-700/30 bg-card/80 px-2.5 py-2 space-y-2 text-[10px]">
                {/* MTF info — 週線六條件 checklist（= 日線六條件套週線）+ 月線趨勢 */}
                {r.mtfScore != null && (
                  <div>
                    <div className="text-muted-foreground font-medium mb-0.5">長線保護短線 {r.mtfScore}/7</div>
                    <div className="space-y-0.5 text-[9px]">
                      {([
                        { label: '週①趨勢',   pass: r.mtfWeeklyChecks?.trend     ?? (r.mtfWeeklyTrend !== '空頭'), desc: '週線頭頭高底底高' },
                        { label: '週②均線',   pass: r.mtfWeeklyChecks?.ma        ?? false,                          desc: 'MA5/10/20 三線多排 + MA10/20 向上' },
                        { label: '週③位置',   pass: r.mtfWeeklyChecks?.position  ?? false,                          desc: '收盤 > MA10 AND MA20' },
                        { label: '週④量',     pass: r.mtfWeeklyChecks?.volume    ?? false,                          desc: '週量 ≥ 前週 × 1.3' },
                        { label: '週⑤紅K',    pass: r.mtfWeeklyChecks?.kbar      ?? false,                          desc: '紅K實體≥2% + 高收盤 + 上影≤實體' },
                        { label: '週⑥指標',   pass: r.mtfWeeklyChecks?.indicator ?? false,                          desc: 'MACD 綠縮/紅延 + KD 金叉向上' },
                        { label: '月線趨勢',   pass: r.mtfMonthlyPass ?? false,                                     desc: '月線不是空頭' },
                      ]).map(({ label, pass, desc }) => (
                        <div key={label} className="flex items-center gap-1.5">
                          <span className={pass ? 'text-green-400' : 'text-red-400'}>{pass ? '✅' : '❌'}</span>
                          <span className="text-muted-foreground font-medium">{label}</span>
                          <span className="text-muted-foreground/50">{desc}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {/* Elimination reasons */}
                {r.eliminationReasons && r.eliminationReasons.length > 0 && (
                  <div>
                    <div className="text-amber-400 font-medium mb-0.5">淘汰法警告</div>
                    {r.eliminationReasons.map((reason, i) => (
                      <div key={i} className="text-[9px] text-amber-300/80">⚠ {reason}</div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
