'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { DabanScanResult, DabanScanSession, StockForwardPerformance } from '@/lib/scanner/types';
import type { SelectedStock } from './ScanChartPanel';

interface RealtimePrice {
  open: number;
  close: number;
  high: number;
  low: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatTurnover(value: number): string {
  if (value >= 1e8) return (value / 1e8).toFixed(1) + '億';
  if (value >= 1e4) return (value / 1e4).toFixed(0) + '萬';
  return value.toFixed(0);
}

function boardBadge(type: string): string {
  switch (type) {
    case '首板': return 'bg-amber-500/20 text-amber-400 border-amber-500/30';
    case '二板': return 'bg-orange-500/20 text-orange-400 border-orange-500/30';
    case '三板': return 'bg-red-500/20 text-red-400 border-red-500/30';
    default: return 'bg-red-700/20 text-red-300 border-red-700/30';
  }
}

/** Format a return % value for display */
function fmtRet(val: number | null | undefined): string {
  if (val == null) return '—';
  return `${val >= 0 ? '+' : ''}${val.toFixed(1)}%`;
}

/** Return color class for a return value */
function retColor(val: number | null | undefined): string {
  if (val == null) return 'text-muted-foreground/50';
  if (val > 0) return 'text-bull';
  if (val < 0) return 'text-bear';
  return 'text-muted-foreground';
}

// 打板專用前瞻欄位（短線策略，聚焦 1-3 日）
const FWD_COLS = [
  { key: 'openReturn' as const, label: '隔日開%' },
  { key: 'd1Return' as const, label: '1日' },
  { key: 'd2Return' as const, label: '2日' },
  { key: 'd3Return' as const, label: '3日' },
  { key: 'maxGain' as const, label: '最高' },
  { key: 'maxLoss' as const, label: '最低' },
] as const;

interface DabanResultsTableProps {
  date: string;
  onSelectStock?: (stock: SelectedStock) => void;
}

export function DabanResultsTable({ date, onSelectStock }: DabanResultsTableProps) {
  const [session, setSession] = useState<DabanScanSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Forward performance state
  const [forwardPerf, setForwardPerf] = useState<StockForwardPerformance[]>([]);
  const [isFetchingForward, setIsFetchingForward] = useState(false);

  // Chinese name mapping (fixes old sessions that saved English names)
  const [nameMap, setNameMap] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    import('@/lib/scanner/cnStocks').then(({ CN_STOCKS }) => {
      const map = new Map<string, string>();
      for (const s of CN_STOCKS) map.set(s.symbol, s.name);
      setNameMap(map);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!date) return;
    setLoading(true);
    setError(null);
    setSession(null);
    setForwardPerf([]);
    fetch(`/api/scanner/daban?date=${date}`)
      .then(r => r.json())
      .then(data => {
        setSession(data.session ?? null);
        if (!data.session) setError('該日期無打板掃描資料');
      })
      .catch(() => setError('載入失敗'))
      .finally(() => setLoading(false));
  }, [date]);

  // Fetch forward performance when session loads
  useEffect(() => {
    if (!session || session.results.length === 0) return;
    const buyable = session.results.filter(r => !r.isYiZiBan);
    if (buyable.length === 0) return;

    setIsFetchingForward(true);
    fetch('/api/backtest/forward', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scanDate: session.date,
        stocks: buyable.map(r => ({
          symbol: r.symbol,
          name: r.name,
          scanPrice: r.closePrice,
        })),
      }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.performance) setForwardPerf(data.performance);
      })
      .catch(() => { /* silently fail — forward data is supplementary */ })
      .finally(() => setIsFetchingForward(false));
  }, [session]);

  // Build performance lookup map
  const perfMap = useMemo(() => {
    const map = new Map<string, StockForwardPerformance>();
    for (const p of forwardPerf) {
      map.set(p.symbol, p);
    }
    return map;
  }, [forwardPerf]);

  // ── Real-time opening price (9:25 集合競價) ─────────────────────────────
  const [realtimePrices, setRealtimePrices] = useState<Map<string, RealtimePrice>>(new Map());
  const [isFetchingRealtime, setIsFetchingRealtime] = useState(false);
  const [realtimeFetchedAt, setRealtimeFetchedAt] = useState<string | null>(null);
  const [isAutoRefreshing, setIsAutoRefreshing] = useState(false);
  const autoRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchRealtimeOpenPrices = useCallback(async () => {
    if (!session || session.results.length === 0) return;
    const buyable = session.results.filter(r => !r.isYiZiBan);
    if (buyable.length === 0) return;

    setIsFetchingRealtime(true);
    try {
      const res = await fetch('/api/scanner/daban/openprices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbols: buyable.map(r => r.symbol) }),
      });
      const data = await res.json();
      if (data.prices) {
        const map = new Map<string, RealtimePrice>();
        for (const [sym, p] of Object.entries(data.prices)) {
          map.set(sym, p as RealtimePrice);
        }
        setRealtimePrices(map);
        setRealtimeFetchedAt(new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
      }
    } catch { /* silently fail */ }
    finally { setIsFetchingRealtime(false); }
  }, [session]);

  // Auto-refresh: every 30s
  const toggleAutoRefresh = useCallback(() => {
    if (autoRefreshRef.current) {
      clearInterval(autoRefreshRef.current);
      autoRefreshRef.current = null;
      setIsAutoRefreshing(false);
    } else {
      fetchRealtimeOpenPrices();
      autoRefreshRef.current = setInterval(fetchRealtimeOpenPrices, 30_000);
      setIsAutoRefreshing(true);
    }
  }, [fetchRealtimeOpenPrices]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (autoRefreshRef.current) clearInterval(autoRefreshRef.current);
    };
  }, []);

  // Reset real-time data when session changes
  useEffect(() => {
    setRealtimePrices(new Map());
    setRealtimeFetchedAt(null);
    if (autoRefreshRef.current) {
      clearInterval(autoRefreshRef.current);
      autoRefreshRef.current = null;
      setIsAutoRefreshing(false);
    }
  }, [session?.date]);

  const handleRealtimeScan = useCallback(async () => {
    setScanning(true);
    setError(null);
    try {
      // 不傳日期，讓 server 用 getLastTradingDay 自動判斷最後交易日
      const res = await fetch('/api/scanner/daban', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (data.session) {
        setSession(data.session);
      } else {
        setError(data.error || '掃描完成但無結果');
      }
    } catch {
      setError('即時掃描失敗');
    } finally {
      setScanning(false);
    }
  }, []);

  if (loading) {
    return <div className="text-center py-8 text-muted-foreground">載入打板掃描結果...</div>;
  }

  if (scanning) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <div className="animate-pulse">即時掃描中... 約需 10-30 秒</div>
      </div>
    );
  }

  if (error && !session) {
    return (
      <div className="text-center py-8 space-y-3">
        <div className="text-muted-foreground">{error}</div>
        <button
          onClick={handleRealtimeScan}
          className="px-4 py-2 rounded-lg bg-amber-500/20 text-amber-400 border border-amber-500/30 hover:bg-amber-500/30 text-sm"
        >
          即時掃描
        </button>
      </div>
    );
  }

  if (!session || session.results.length === 0) {
    return <div className="text-center py-8 text-muted-foreground">該日無漲停股</div>;
  }

  const buyable = session.results.filter(r => !r.isYiZiBan);
  const locked = session.results.filter(r => r.isYiZiBan);

  /** Resolve display name: prefer Chinese name from static list, fallback to session name */
  const displayName = (r: DabanScanResult) =>
    (nameMap.get(r.symbol) ?? r.name).slice(0, 8);

  return (
    <div className="space-y-4">
      {/* Sentiment indicator */}
      {session.sentiment && (
        <div className={`border rounded-lg p-3 ${
          session.sentiment.isCold
            ? 'bg-blue-500/10 border-blue-500/30'
            : 'bg-green-500/10 border-green-500/30'
        }`}>
          <div className="flex items-center gap-3 mb-1">
            <span className={`font-bold text-sm ${
              session.sentiment.isCold ? 'text-blue-400' : 'text-green-400'
            }`}>
              {session.sentiment.isCold ? '❄️ 情緒冰點 — 不建議進場' : '✅ 情緒正常 — 可進場'}
            </span>
          </div>
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <span>漲停 <span className={`font-mono font-bold ${
              session.sentiment.limitUpCount >= 15 ? 'text-green-400' : 'text-blue-400'
            }`}>{session.sentiment.limitUpCount}</span> 家</span>
            <span>昨漲停 {session.sentiment.yesterdayLimitUpCount} 支今均 <span className={`font-mono font-bold ${
              session.sentiment.yesterdayAvgReturn >= -3 ? 'text-green-400' : 'text-blue-400'
            }`}>{session.sentiment.yesterdayAvgReturn >= 0 ? '+' : ''}{session.sentiment.yesterdayAvgReturn}%</span></span>
            {session.sentiment.isCold && session.sentiment.reason && (
              <span className="text-blue-400">({session.sentiment.reason})</span>
            )}
          </div>
        </div>
      )}

      {/* Strategy rules banner */}
      <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-amber-400 font-bold text-sm">打板戰法（情緒增強版）</span>
          <span className="text-xs text-muted-foreground">
            漲停股 {session.results.length} 檔 | 可買入 {buyable.length} 檔
          </span>
          {isFetchingForward && (
            <span className="text-[10px] text-sky-400 animate-pulse">載入後續表現…</span>
          )}
        </div>
        <div className="text-xs text-muted-foreground">
          操作：情緒正常時，明天 09:25 找高開 ≥ 買入門檻的排名第一檔買入 →
          止盈 +5% / 止損 -3% / 收黑隔日走 / 最多持 2 天
        </div>
      </div>

      {/* Real-time opening price controls */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={fetchRealtimeOpenPrices}
          disabled={isFetchingRealtime}
          className="px-3 py-1.5 rounded-lg bg-sky-500/20 text-sky-400 border border-sky-500/30 hover:bg-sky-500/30 text-xs font-medium disabled:opacity-50"
        >
          {isFetchingRealtime ? '取得中…' : '即時開盤價'}
        </button>
        <button
          onClick={toggleAutoRefresh}
          className={`px-3 py-1.5 rounded-lg text-xs border ${
            isAutoRefreshing
              ? 'bg-green-500/20 text-green-400 border-green-500/30 hover:bg-green-500/30'
              : 'bg-muted/50 text-muted-foreground border-border hover:bg-muted'
          }`}
        >
          {isAutoRefreshing ? '自動刷新中 (30s)' : '自動刷新'}
        </button>
        {realtimeFetchedAt && (
          <span className="text-[10px] text-muted-foreground">
            更新於 {realtimeFetchedAt}
          </span>
        )}
        {realtimePrices.size > 0 && (
          <span className="text-[10px] text-sky-400">
            已取得 {realtimePrices.size} 檔即時報價
          </span>
        )}
      </div>

      {/* Results table — 單一 overflow-auto 容器，高度由父層控制 */}
      <div className="overflow-auto">
          <table className="w-full text-sm" style={{ tableLayout: 'fixed', minWidth: 1100 }}>
          <thead>
            {/* Group header row */}
            <tr className="text-[10px] text-muted-foreground/60 border-b border-border/30">
              <th colSpan={10} className="text-left py-1 px-2">掃描當日</th>
              <th colSpan={FWD_COLS.length + 2} className="text-center py-1 px-2 border-l border-border/30">掃描後表現</th>
            </tr>
            <tr className="text-xs text-muted-foreground border-b border-border">
              <th className="text-left py-2 px-2 w-8">#</th>
              <th className="text-left py-2 px-2">代碼</th>
              <th className="text-left py-2 px-2">名稱</th>
              <th className="text-right py-2 px-2">收盤</th>
              <th className="text-right py-2 px-2">漲幅</th>
              <th className="text-center py-2 px-2">類型</th>
              <th className="text-right py-2 px-2">成交額</th>
              <th className="text-right py-2 px-2">量比</th>
              <th className="text-right py-2 px-2">買入門檻</th>
              <th className="text-right py-2 px-2">分數</th>
              <th className="text-right py-2 px-1 whitespace-nowrap text-[10px] border-l border-border/20"
                title="隔日開盤價（可對照買入門檻判斷是否可進場）">
                隔日開價
              </th>
              {FWD_COLS.map(({ key, label }) => (
                <th key={key}
                  className="text-right py-2 px-1 whitespace-nowrap text-[10px] border-l border-border/20"
                  title={key === 'openReturn' ? '隔日開盤相對掃描日收盤的漲跌幅' :
                    key === 'maxGain' ? '觀察期間最大漲幅' :
                    key === 'maxLoss' ? '觀察期間最大跌幅' :
                    `第${label}收盤相對掃描日收盤的漲跌幅`}
                >
                  {label}
                </th>
              ))}
              <th className="text-center py-2 px-1 whitespace-nowrap text-[10px]"></th>
            </tr>
          </thead>
          <tbody>
            {buyable.map((r, i) => {
              const perf = perfMap.get(r.symbol);
              return (
                <tr key={r.symbol}
                  className={`border-b border-border/50 hover:bg-muted/50 ${i === 0 ? 'bg-amber-500/5' : ''}`}>
                  <td className="py-2 px-2 text-muted-foreground">{i + 1}</td>
                  <td className="py-2 px-2 font-mono text-xs">{r.symbol}</td>
                  <td className="py-2 px-2">{displayName(r)}</td>
                  <td className="py-2 px-2 text-right font-mono">{r.closePrice.toFixed(2)}</td>
                  <td className="py-2 px-2 text-right text-red-400">+{r.limitUpPct.toFixed(1)}%</td>
                  <td className="py-2 px-2 text-center">
                    <span className={`text-xs px-1.5 py-0.5 rounded border ${boardBadge(r.limitUpType)}`}>
                      {r.limitUpType}
                    </span>
                  </td>
                  <td className="py-2 px-2 text-right font-mono text-xs">{formatTurnover(r.turnover)}</td>
                  <td className="py-2 px-2 text-right font-mono text-xs">{r.volumeRatio.toFixed(1)}</td>
                  <td className="py-2 px-2 text-right font-mono text-amber-400 font-bold">
                    {r.buyThresholdPrice.toFixed(2)}
                  </td>
                  <td className="py-2 px-2 text-right font-mono">{r.rankScore.toFixed(1)}</td>
                  {/* 隔日開盤價（即時 > 前瞻） */}
                  <td className="py-2 px-1 text-right font-mono text-[10px] whitespace-nowrap border-l border-border/10">
                    {(() => {
                      const rt = realtimePrices.get(r.symbol);
                      const openPrice = rt?.open ?? perf?.nextOpenPrice;
                      const isRealtime = !!rt;
                      if (isFetchingRealtime && !rt && !perf?.nextOpenPrice) {
                        return <span className="text-muted-foreground/40">…</span>;
                      }
                      if (isFetchingForward && !perf && !rt) {
                        return <span className="text-muted-foreground/40">…</span>;
                      }
                      if (openPrice != null) {
                        const meetsThreshold = openPrice >= r.buyThresholdPrice;
                        return (
                          <span className={meetsThreshold ? 'text-amber-400 font-bold' : 'text-muted-foreground'}>
                            {openPrice.toFixed(2)}
                            {isRealtime && <span className="text-[8px] text-sky-400 ml-0.5">●</span>}
                          </span>
                        );
                      }
                      return <span className="text-muted-foreground/50">—</span>;
                    })()}
                  </td>
                  {/* Forward performance columns */}
                  {FWD_COLS.map(({ key }) => {
                    const val = perf ? perf[key] : undefined;
                    return (
                      <td key={key} className={`py-2 px-1 text-right font-mono text-[10px] whitespace-nowrap border-l border-border/10 ${retColor(val as number | null | undefined)}`}>
                        {isFetchingForward && !perf ? (
                          <span className="text-muted-foreground/40">…</span>
                        ) : (
                          fmtRet(val as number | null | undefined)
                        )}
                      </td>
                    );
                  })}
                  {/* 走圖按鈕 */}
                  <td className="py-2 px-2 text-center whitespace-nowrap">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectStock?.({ symbol: r.symbol, name: displayName(r), market: 'CN' });
                      }}
                      className="text-[10px] text-sky-400 hover:text-sky-300 px-1.5 py-0.5 rounded border border-sky-700/50 hover:bg-sky-900/30">
                      走圖
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Locked boards */}
      {locked.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer hover:text-foreground">
            一字板 {locked.length} 檔（買不到）
          </summary>
          <div className="mt-1 pl-4 space-y-0.5">
            {locked.map(r => (
              <div key={r.symbol}>
                {r.symbol} {displayName(r)} {r.closePrice.toFixed(2)} +{r.limitUpPct.toFixed(1)}%
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
