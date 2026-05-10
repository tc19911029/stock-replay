'use client';

import { useState, useEffect, useMemo, Fragment } from 'react';
import { useBacktestStore } from '@/store/backtestStore';
import { useWatchlistStore } from '@/store/watchlistStore';
import type { SelectedStock } from './ScanChartPanel';
import type { StockForwardPerformance } from '@/lib/scanner/types';
import type { TrendState } from '@/lib/analysis/trendAnalysis';
import type { LockWatchRecord, LockWatchDailySnapshot } from '@/lib/scanner/lockWatchTypes';

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtRet(val: number | null | undefined): string {
  if (val == null) return '—';
  return `${val >= 0 ? '+' : ''}${val.toFixed(1)}%`;
}

// 軌道分類（書本五步法）— badge 顯示用
const TRACK_OF: Record<string, 'pool' | 'bullish' | 'reversal' | 'system'> = {
  A: 'pool',
  B: 'bullish', C: 'bullish', E: 'bullish',
  G: 'bullish', H: 'bullish', I: 'bullish',
  J: 'bullish', K: 'bullish', L: 'bullish',
  M: 'bullish', P: 'bullish',
  D: 'reversal', F: 'reversal', N: 'reversal', O: 'reversal',
  Q: 'system',
};

// v11 字母（G/H/I）跟 v12（J/K/L）是 alias，cross-strategy 顯示時去重
const V11_ALIAS_OF_V12: Record<string, string> = { G: 'J', H: 'L', I: 'K' };

/**
 * 過濾 cross-strategy badges 只顯示「有資訊量」的：
 *   - A 六條件：永遠保留（書本基本門檻）
 *   - 跨軌道命中：保留（多頭+反轉雙重訊號才有意義）
 *   - 同軌道兄弟訊號：隱藏（多頭軌主訊號旁邊掛多頭軌兄弟訊號太雜亂）
 *   - v11 alias：去重（G/H/I 跟 J/K/L 是同 detector，只顯示一次）
 */
function filterCrossBadges(matched: string[], main: string): string[] {
  const mainTrack = TRACK_OF[main] ?? 'bullish';
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matched) {
    if (m === main) continue;
    // v11 alias 統一映射到 v12 字母去重
    const canonical = V11_ALIAS_OF_V12[m] ?? m;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    // A 永遠保留
    if (canonical === 'A') {
      out.push(canonical);
      continue;
    }
    // 跨軌道才保留
    if ((TRACK_OF[canonical] ?? 'bullish') !== mainTrack) {
      out.push(canonical);
    }
  }
  return out;
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
    scanResults, scanDate, market, marketTrend: storeTrend, scanOnly,
    performance, isFetchingForward, isLoadingCronSession,
    activeBuyMethod,
  } = useBacktestStore();

  const [expandedStock, setExpandedStock] = useState<string | null>(null);
  const [conceptFilter, setConceptFilter] = useState<string>('all');
  const [scanSortDir] = useState<'desc'>('desc');

  // 即時 raw trend（跟 banner 同源）— saved session 的 marketTrend 是舊邏輯（含降級）
  // 不可用，會跟 banner 顯示不一致（「banner 多頭、結果欄盤整」這種）
  const [liveTrend, setLiveTrend] = useState<TrendState | null>(storeTrend ?? null);
  useEffect(() => {
    let cancelled = false;
    if (!market || !scanDate) return;
    fetch(`/api/scanner/market-trend?market=${market}&date=${scanDate}`)
      .then((r) => r.json())
      .then((j: { ok?: boolean; trend?: TrendState }) => {
        if (!cancelled && j.ok && j.trend) setLiveTrend(j.trend);
      })
      .catch(() => { /* keep storeTrend fallback */ });
    return () => { cancelled = true; };
  }, [market, scanDate]);
  const marketTrend = liveTrend ?? storeTrend;

  // ── LockWatch records cross-ref（已失效 N 形態訊號標 ✗）──────────────────
  // 同 LockWatchPanel 的資料來源；ScanResultsCompact 只需要 currentStage 來標失效 row
  const [lockWatchRecords, setLockWatchRecords] = useState<LockWatchRecord[]>([]);
  useEffect(() => {
    let cancelled = false;
    if (!market) return;
    fetch(`/api/lockwatch?market=${market}`)
      .then((r) => r.json())
      .then((j: { ok?: boolean; snapshot?: LockWatchDailySnapshot | null }) => {
        if (cancelled || !j.ok || !j.snapshot) return;
        setLockWatchRecords(j.snapshot.records ?? []);
      })
      .catch(() => { /* 拉不到就不顯示失效標記，不影響其他功能 */ });
    return () => { cancelled = true; };
  }, [market]);
  // symbol → 最新 N 訊號的 currentStage（一支股可能有多個 record，取最新觸發的 N）
  const lockWatchStageBySymbol = useMemo(() => {
    const map = new Map<string, LockWatchRecord['currentStage']>();
    for (const r of lockWatchRecords) {
      if (r.triggerSignal !== 'N') continue;
      // 後到的覆蓋，假設 records 大致依時序 — 同一支股取最新 record
      map.set(r.symbol, r.currentStage);
    }
    return map;
  }, [lockWatchRecords]);

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
                  // B/C/D/E/F/G/H/I：顯示策略觸發條件 + 跨策略命中徽章
                  (() => {
                    const rule = r.triggeredRules?.[0];
                    const methodColors: Record<string, string> = {
                      A: 'bg-amber-800/80 text-amber-200',
                      B: 'bg-sky-800/80 text-sky-300',
                      C: 'bg-emerald-800/80 text-emerald-300',
                      D: 'bg-purple-800/80 text-purple-300',
                      E: 'bg-orange-800/80 text-orange-300',
                      F: 'bg-rose-800/80 text-rose-300',
                      G: 'bg-cyan-800/80 text-cyan-300',
                      H: 'bg-fuchsia-800/80 text-fuchsia-300',
                      I: 'bg-lime-800/80 text-lime-300',
                      J: 'bg-cyan-800/80 text-cyan-300',
                      K: 'bg-lime-800/80 text-lime-300',
                      L: 'bg-fuchsia-800/80 text-fuchsia-300',
                      M: 'bg-teal-800/80 text-teal-300',
                      N: 'bg-indigo-800/80 text-indigo-300',
                      O: 'bg-blue-800/80 text-blue-300',
                      P: 'bg-pink-800/80 text-pink-300',
                      Q: 'bg-violet-800/80 text-violet-300',
                    };
                    const methodNames: Record<string, string> = {
                      A: '六條件', B: '回後買上漲', C: '盤整突破',
                      D: '一字底', E: '缺口', F: 'V反轉',
                      G: 'ABC突破', H: '突破黑K', I: 'K線橫盤',
                      J: 'ABC突破', K: 'K線橫盤', L: '突破黑K',
                      M: '軌道線突破', N: '型態確認', O: '打底完成',
                      P: '高檔拉回', Q: '三均戰法',
                    };
                    const color = methodColors[activeBuyMethod] ?? 'bg-sky-800/80 text-sky-300';
                    // 只顯示「有資訊量」的 cross-strategy（A + 跨軌道，去重 v11 alias）
                    const others = filterCrossBadges(r.matchedMethods ?? [], activeBuyMethod);
                    // 完整列表給 hover 看
                    const allOthers = (r.matchedMethods ?? []).filter(m => m !== activeBuyMethod);
                    return (
                      <>
                        <span className={`text-[8px] px-1.5 h-3.5 flex items-center rounded-sm max-w-[160px] truncate ${color}`}
                          title={rule?.ruleName ?? ''}>
                          {rule ? rule.ruleName.replace(/（.*）$/, '') : activeBuyMethod}
                        </span>
                        {others.map(m => (
                          <span key={m}
                            className={`text-[8px] px-1 h-3.5 flex items-center rounded-sm font-bold ${methodColors[m] ?? 'bg-secondary/60 text-foreground/70'}`}
                            title={`同時命中：${methodNames[m] ?? m}`}>
                            +{methodNames[m] ?? m}
                          </span>
                        ))}
                        {/* 同軌道兄弟訊號隱藏，只顯示總數可 hover 看完整 */}
                        {allOthers.length > others.length && (
                          <span className="text-[8px] text-muted-foreground/50 px-0.5"
                            title={`同軌道兄弟訊號（隱藏）：${allOthers.filter(m => !others.includes(m)).map(m => methodNames[m] ?? m).join('、')}`}>
                            +{allOthers.length - others.length}
                          </span>
                        )}
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
                      G: 'bg-cyan-800/80 text-cyan-300',
                      H: 'bg-fuchsia-800/80 text-fuchsia-300',
                      I: 'bg-lime-800/80 text-lime-300',
                      J: 'bg-cyan-800/80 text-cyan-300',
                      K: 'bg-lime-800/80 text-lime-300',
                      L: 'bg-fuchsia-800/80 text-fuchsia-300',
                      M: 'bg-teal-800/80 text-teal-300',
                      N: 'bg-indigo-800/80 text-indigo-300',
                      O: 'bg-blue-800/80 text-blue-300',
                      P: 'bg-pink-800/80 text-pink-300',
                      Q: 'bg-violet-800/80 text-violet-300',
                    };
                    const methodNames: Record<string, string> = {
                      B: '回後買上漲', C: '盤整突破', D: '一字底', E: '缺口', F: 'V反轉',
                      G: 'ABC突破', H: '突破黑K', I: 'K線橫盤',
                      J: 'ABC突破', K: 'K線橫盤', L: '突破黑K',
                      M: '軌道線突破', N: '型態確認', O: '打底完成',
                      P: '高檔拉回', Q: '三均戰法',
                    };
                    // A tab：所有命中策略都有資訊量（六條件 + 其他進場訊號），只去重 v11 alias
                    const seen = new Set<string>();
                    const others = (r.matchedMethods ?? [])
                      .filter(m => m !== 'A')
                      .filter(m => {
                        const canonical = V11_ALIAS_OF_V12[m] ?? m;
                        if (seen.has(canonical)) return false;
                        seen.add(canonical);
                        return true;
                      });
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
                            title={`同時命中：${methodNames[m] ?? m}`}>
                            +{methodNames[m] ?? m}
                          </span>
                        ))}
                      </>
                    );
                  })()
                )}

                {/* v12 警示徽章（議題 13/27/88）— 末升段/季線壓力/量分等級/KD 向下 */}
                {r.endPhaseFlag && (
                  <span
                    className="text-[8px] px-1 h-3.5 flex items-center rounded-sm bg-red-900/60 text-red-300 font-bold"
                    title="末升段警示：自最近翻多事件低點起漲漲幅 ≥ 100%（議題 13）">
                    末升段
                  </span>
                )}
                {r.seasonLineResistance != null && r.seasonLineResistance > 0 && (
                  <span
                    className="text-[8px] px-1 h-3.5 flex items-center rounded-sm bg-amber-900/50 text-amber-300"
                    title={`季線壓力 ${r.seasonLineResistance.toFixed(2)}：MA60 下彎且在股價上方（議題 27）`}>
                    季壓 {r.seasonLineResistance.toFixed(0)}
                  </span>
                )}
                {r.volumeLevel === 'climax' && (
                  <span
                    className="text-[8px] px-1 h-3.5 flex items-center rounded-sm bg-orange-900/60 text-orange-300 font-bold"
                    title="爆量警示：今日量 ≥ 5 日均量 × 2（議題 88）">
                    爆量
                  </span>
                )}
                {r.kdDecliningWarning && (
                  <span
                    className="text-[8px] px-1 h-3.5 flex items-center rounded-sm bg-rose-900/40 text-rose-300"
                    title="短線 20 守則 #9：KD 向下不買（議題 27）">
                    KD↓
                  </span>
                )}

                {/* v12 N 型態確認專用：型態名 + 達成率 + 目標價（議題 65）*/}
                {r.lockWatchPayload?.patternType && (() => {
                  const PATTERN_LABEL: Record<string, string> = {
                    'head-shoulder': '頭肩底', 'complex-head-shoulder': '複式頭肩底',
                    'triple-bottom': '三重底', 'falling-diamond': '跌菱形',
                    'rounding-bottom': '圓弧底', 'descending-wedge': '下降楔形',
                    'double-bottom': '雙重底', 'n-shape': 'N 字底',
                    'head-shoulder-top': '頭肩頂', 'triple-top': '三重頂', 'double-top': '雙重頂',
                  };
                  const name = PATTERN_LABEL[r.lockWatchPayload.patternType] ?? r.lockWatchPayload.patternType;
                  const rate = r.lockWatchPayload.patternAchievementRate;
                  const target = r.lockWatchPayload.patternTargetPrice;
                  // 目標相對現價的距離 — 正 = 仍有上漲空間；負 = 已達/超過目標
                  const upsideNum = target ? ((target - r.price) / r.price * 100) : null;
                  const reached = upsideNum != null && upsideNum <= 0;
                  // 結構失效 / 已撤銷 → 整個 N 徽章降灰 + 加 ✗ 後綴
                  const stage = lockWatchStageBySymbol.get(r.symbol);
                  const failed = stage === 'structure-broken' || stage === 'revoked';
                  const failReason = stage === 'structure-broken'
                    ? `已跌破頸線 ${r.lockWatchPayload.triggerPrice.toFixed(2)} ×0.97 = ${(r.lockWatchPayload.triggerPrice * 0.97).toFixed(2)}，型態結構失效`
                    : stage === 'revoked' ? '訊號已撤銷' : '';
                  const baseTitle = reached
                    ? `N 型態：${name} · 達成率 ${rate ? (rate * 100).toFixed(0) : '?'}% · 頸線 ${r.lockWatchPayload.triggerPrice.toFixed(2)} · 目標 ${target?.toFixed(2) ?? '?'}（已達標：現價超過目標 ${Math.abs(upsideNum!).toFixed(1)}%）`
                    : `N 型態：${name} · 達成率 ${rate ? (rate * 100).toFixed(0) : '?'}% · 頸線 ${r.lockWatchPayload.triggerPrice.toFixed(2)} · 目標 ${target?.toFixed(2) ?? '?'}（距目標還有 ${upsideNum?.toFixed(1) ?? '?'}% 空間）`;
                  return (
                    <span
                      className={`text-[8px] px-1 h-3.5 flex items-center gap-0.5 rounded-sm font-bold ${
                        failed
                          ? 'bg-zinc-800/60 text-zinc-500 line-through'
                          : 'bg-indigo-900/60 text-indigo-200'
                      }`}
                      title={failed ? `${baseTitle}\n— ${failReason}` : baseTitle}>
                      {name}{rate != null && <span className="opacity-75 ml-0.5">{(rate * 100).toFixed(0)}%</span>}
                      {target != null && upsideNum != null && !failed && (
                        reached ? (
                          // 已達 / 超過目標 → 提示停利
                          <span className="ml-0.5 text-amber-300" title="目標已達，可考慮停利">
                            目標達標
                          </span>
                        ) : (
                          // 仍有空間 → 顯示目標價 + 距現價百分比
                          <span className="ml-0.5 text-emerald-300">
                            目標 {target.toFixed(0)} (+{upsideNum.toFixed(1)}%)
                          </span>
                        )
                      )}
                      {failed && (
                        <span className="ml-0.5 text-rose-400/80 no-underline" title={failReason}>
                          ✗ {stage === 'structure-broken' ? '結構失效' : '已撤銷'}
                        </span>
                      )}
                    </span>
                  );
                })()}

                {/* v12 F V 反轉觸發鎖定價 */}
                {r.lockWatchPayload?.triggerPrice && !r.lockWatchPayload.patternType && (
                  <span
                    className="text-[8px] px-1 h-3.5 flex items-center rounded-sm bg-rose-900/60 text-rose-200 font-bold"
                    title={`F V 反轉鎖定價（觸發即進場參考）：${r.lockWatchPayload.triggerPrice.toFixed(2)}`}>
                    🔒{r.lockWatchPayload.triggerPrice.toFixed(2)}
                  </span>
                )}

                {/* v12 Provisional 三天驗證（K/D 型態訊號用，議題 75）*/}
                {r.provisional && (() => {
                  // 動態計算「實際剩餘交易日」（議題 86 真正用交易日）
                  // 用 history 長度 + scan date 比 today：history 含 entry 那天就已經有 1 筆，
                  // 之後每個交易日 cron 會 push 1 筆 → length 直接代表已過交易日數
                  const history = r.provisional.history ?? [];
                  let actualRemaining = r.provisional.daysRemaining;
                  if (history.length > 0 && r.provisional.status === 'provisional') {
                    // history[0] 是 entry 日，所以已過交易日 = length - 1
                    const tradingDaysPassed = Math.max(0, history.length - 1);
                    actualRemaining = Math.max(0, 3 - tradingDaysPassed) as 0 | 1 | 2 | 3;
                  }
                  const effectiveStatus = actualRemaining === 0 && r.provisional.status === 'provisional' ? 'confirmed' : r.provisional.status;
                  return (
                    <span
                      className={`text-[8px] px-1 h-3.5 flex items-center rounded-sm font-bold ${
                        effectiveStatus === 'confirmed' ? 'bg-emerald-900/60 text-emerald-200' :
                        effectiveStatus === 'revoked' ? 'bg-rose-900/60 text-rose-200 line-through' :
                        'bg-amber-900/60 text-amber-200'
                      }`}
                      title={
                        effectiveStatus === 'confirmed' ? `已確認（停留 ≥3 天）` :
                        effectiveStatus === 'revoked' ? `已撤銷（close 跌破 ${r.provisional.triggerPrice.toFixed(2)}）` :
                        `三天驗證中（剩 ${actualRemaining} 天，鎖定價 ${r.provisional.triggerPrice.toFixed(2)}）`
                      }>
                      {effectiveStatus === 'confirmed' ? '✓ 確認' :
                       effectiveStatus === 'revoked' ? '✗ 撤銷' :
                       `⏳ ${actualRemaining}天`}
                      {r.provisional.revocationCount >= 2 && (
                        <span className="ml-0.5 text-orange-400">!</span>
                      )}
                    </span>
                  );
                })()}

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
                {/* 33 種贏家圖像（寶典 Part 12） */}
                {((r.winnerBullishPatterns ?? []).length > 0 || (r.winnerBearishPatterns ?? []).length > 0) && (
                  <div>
                    {(r.winnerBullishPatterns ?? []).length > 0 && (
                      <div className="mb-0.5">
                        <span className="text-blue-400 font-medium">🎯 贏家圖像（空轉多）：</span>
                        <span className="text-blue-300/80 text-[9px]">{r.winnerBullishPatterns!.join('、')}</span>
                      </div>
                    )}
                    {(r.winnerBearishPatterns ?? []).length > 0 && (
                      <div>
                        <span className="text-purple-400 font-medium">⛔ 贏家圖像（多轉空）：</span>
                        <span className="text-purple-300/80 text-[9px]">{r.winnerBearishPatterns!.join('、')}</span>
                      </div>
                    )}
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
