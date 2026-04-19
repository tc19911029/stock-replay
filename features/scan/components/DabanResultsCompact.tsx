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

function boardBadge(type: string): string {
  switch (type) {
    case '首板': return 'bg-amber-500/20 text-amber-400 border-amber-500/30';
    case '二板': return 'bg-orange-500/20 text-orange-400 border-orange-500/30';
    case '三板': return 'bg-red-500/20 text-red-400 border-red-500/30';
    default: return 'bg-red-700/20 text-red-300 border-red-700/30';
  }
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

interface DabanResultsCompactProps {
  date: string;
  onSelectStock?: (stock: SelectedStock) => void;
}

export function DabanResultsCompact({ date, onSelectStock }: DabanResultsCompactProps) {
  const [session, setSession] = useState<DabanScanSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forwardPerf, setForwardPerf] = useState<StockForwardPerformance[]>([]);
  const [isFetchingForward, setIsFetchingForward] = useState(false);
  const [realtimePrices, setRealtimePrices] = useState<Map<string, RealtimePrice>>(new Map());
  const [isAutoRefreshing, setIsAutoRefreshing] = useState(false);
  const autoRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [nameMap, setNameMap] = useState<Map<string, string>>(new Map());
  const [turnoverRankMap, setTurnoverRankMap] = useState<Map<string, number>>(new Map());

  // 載入全市場 20 日均成交額排名（top 500）
  useEffect(() => {
    let cancelled = false;
    fetch('/api/scanner/turnover-rank?market=CN')
      .then(r => r.ok ? r.json() : null)
      .then(json => {
        if (cancelled || !json?.symbols) return;
        const m = new Map<string, number>();
        (json.symbols as string[]).forEach((s, i) => m.set(s, i + 1));
        setTurnoverRankMap(m);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    import('@/lib/scanner/cnStocks').then(({ CN_STOCKS }) => {
      const map = new Map<string, string>();
      for (const s of CN_STOCKS) map.set(s.symbol, s.name);
      setNameMap(map);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!date) return;
    setLoading(true); setError(null); setSession(null); setForwardPerf([]);
    fetch(`/api/scanner/daban?date=${date}`)
      .then(r => r.json())
      .then(data => { setSession(data.session ?? null); if (!data.session) setError('該日無打板掃描資料'); })
      .catch(() => setError('載入失敗'))
      .finally(() => setLoading(false));
  }, [date]);

  // CN 開盤確認視窗（CST 9:20–9:40）內每 30 秒靜默重載 session，
  // 讓後端 confirmDabanAtOpen 寫入的 openConfirmed / gapUpPct 自動刷出來。
  useEffect(() => {
    if (!date) return;
    const tick = () => {
      const nowCN = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
      const hhmm = nowCN.getHours() * 100 + nowCN.getMinutes();
      if (hhmm < 920 || hhmm > 940) return; // 視窗外不動作
      fetch(`/api/scanner/daban?date=${date}`)
        .then(r => r.json())
        .then(data => { if (data.session) setSession(data.session); })
        .catch(() => {});
    };
    const id = setInterval(tick, 30_000);
    tick(); // 進入頁面或換日期時先試一次（視窗外自動略過）
    return () => clearInterval(id);
  }, [date]);

  useEffect(() => {
    if (!session || session.results.length === 0) return;
    const buyable = session.results.filter(r => !r.isYiZiBan);
    if (buyable.length === 0) return;
    setIsFetchingForward(true);
    fetch('/api/backtest/forward', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scanDate: session.date, stocks: buyable.map(r => ({ symbol: r.symbol, name: r.name, scanPrice: r.closePrice })) }),
    })
      .then(r => r.json())
      .then(data => { if (data.performance) setForwardPerf(data.performance); })
      .catch(() => {})
      .finally(() => setIsFetchingForward(false));
  }, [session]);

  const perfMap = useMemo(() => {
    const map = new Map<string, StockForwardPerformance>();
    for (const p of forwardPerf) map.set(p.symbol, p);
    return map;
  }, [forwardPerf]);

  const fetchRealtimeOpenPrices = useCallback(async () => {
    if (!session || session.results.length === 0) return;
    const buyable = session.results.filter(r => !r.isYiZiBan);
    if (buyable.length === 0) return;
    try {
      const res = await fetch('/api/scanner/daban/openprices', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbols: buyable.map(r => r.symbol) }),
      });
      const data = await res.json();
      if (data.prices) {
        const map = new Map<string, RealtimePrice>();
        for (const [sym, p] of Object.entries(data.prices)) map.set(sym, p as RealtimePrice);
        setRealtimePrices(map);
      }
    } catch {}
  }, [session]);

  const toggleAutoRefresh = useCallback(() => {
    if (autoRefreshRef.current) {
      clearInterval(autoRefreshRef.current); autoRefreshRef.current = null; setIsAutoRefreshing(false);
    } else {
      fetchRealtimeOpenPrices();
      autoRefreshRef.current = setInterval(fetchRealtimeOpenPrices, 30_000);
      setIsAutoRefreshing(true);
    }
  }, [fetchRealtimeOpenPrices]);

  useEffect(() => { return () => { if (autoRefreshRef.current) clearInterval(autoRefreshRef.current); }; }, []);
  useEffect(() => {
    setRealtimePrices(new Map());
    if (autoRefreshRef.current) { clearInterval(autoRefreshRef.current); autoRefreshRef.current = null; setIsAutoRefreshing(false); }
  }, [session?.date]);

  const handleRealtimeScan = useCallback(async () => {
    setScanning(true); setError(null);
    try {
      const res = await fetch('/api/scanner/daban', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      const data = await res.json();
      if (data.session) setSession(data.session); else setError(data.error || '掃描完成但無結果');
    } catch { setError('即時掃描失敗'); }
    finally { setScanning(false); }
  }, []);

  const displayName = (r: DabanScanResult) => (nameMap.get(r.symbol) ?? r.name).slice(0, 8);

  if (loading) return <div className="text-center py-6 text-muted-foreground text-xs">載入打板結果...</div>;

  if (error && !session) {
    return (
      <div className="text-center py-6 space-y-2">
        <div className="text-xs text-muted-foreground">{error}</div>
        <button onClick={handleRealtimeScan} disabled={scanning}
          className="px-3 py-1.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30 text-[11px]">
          {scanning ? '掃描中...' : '即時掃描'}
        </button>
      </div>
    );
  }

  if (!session || session.results.length === 0) {
    return <div className="text-center py-6 text-muted-foreground text-xs">該日無漲停股</div>;
  }

  const buyable = session.results.filter(r => !r.isYiZiBan);
  const locked = session.results.filter(r => r.isYiZiBan);

  return (
    <div className="space-y-1.5 px-2">
      {/* Sentiment + Live Monitor */}
      {session.sentiment && (() => {
        const s = session.sentiment;
        const live = s.liveStatus;
        const headerColor =
          live === 'declining' ? { bg: 'bg-red-500/10 border-red-500/30', txt: 'text-red-400', label: '⚠️ 策略走弱' }
          : live === 'recovering' ? { bg: 'bg-emerald-500/10 border-emerald-500/30', txt: 'text-emerald-400', label: '📈 策略回升' }
          : s.isCold ? { bg: 'bg-blue-500/10 border-blue-500/30', txt: 'text-blue-400', label: '❄️ 情緒冰點' }
          : { bg: 'bg-green-500/10 border-green-500/30', txt: 'text-green-400', label: '✅ 正常' };

        return (
          <div className={`rounded-lg p-2 text-[10px] border ${headerColor.bg}`}>
            <div className={`font-bold text-[11px] mb-0.5 ${headerColor.txt}`}>
              {headerColor.label}
            </div>
            <div className="flex gap-2 text-muted-foreground flex-wrap">
              <span>漲停 <span className="font-bold text-foreground">{s.limitUpCount}</span></span>
              {s.recentTradeCount != null && s.recentTradeCount > 0 && (
                <>
                  <span>近{s.recentSessions}日勝率
                    <span className={`font-bold ${(s.recentWinRate ?? 0) >= (s.baselineMedianWinRate ?? 50) ? 'text-bull' : 'text-bear'}`}>
                      {' '}{s.recentWinRate}%
                    </span>
                  </span>
                  {s.baselineMedianWinRate != null && (
                    <span className="text-muted-foreground/70">vs baseline {s.baselineMedianWinRate}%
                      {s.winRateDeltaPct != null && (
                        <span className={s.winRateDeltaPct >= 0 ? 'text-bull' : 'text-bear'}>
                          {' '}({s.winRateDeltaPct >= 0 ? '+' : ''}{s.winRateDeltaPct}%)
                        </span>
                      )}
                    </span>
                  )}
                  <span className="text-muted-foreground/60">({s.recentTradeCount}筆)</span>
                </>
              )}
            </div>
            {s.reason && (
              <div className={`mt-1 text-[10px] ${headerColor.txt}`}>
                {s.reason}
              </div>
            )}
          </div>
        );
      })()}

      {/* Sort indicator（鐵律 6：靜默排序要 UI 提示） */}
      {(() => {
        // 舊檔案沒 sortedBy 欄位：有 openConfirmDate 就推斷為 gapUpPct，否則 turnover
        const sortedBy = session.sortedBy ?? (session.openConfirmDate ? 'gapUpPct' : 'turnover');
        return (
          <div className="text-[10px] text-muted-foreground px-0.5">
            {sortedBy === 'gapUpPct' ? (
              <span>🔀 按 <span className="text-amber-400">高開幅度</span> 排序（開盤確認後重排）</span>
            ) : (
              <span>🔀 按 <span className="text-sky-400">成交額</span> 排序（收盤時）</span>
            )}
          </div>
        );
      })()}

      {/* Realtime controls */}
      <div className="flex items-center gap-1.5 text-[10px]">
        <button onClick={fetchRealtimeOpenPrices} className="px-1.5 py-0.5 rounded bg-sky-700/40 text-sky-300 hover:bg-sky-700/60">
          刷新開盤價
        </button>
        <button onClick={toggleAutoRefresh}
          className={`px-1.5 py-0.5 rounded ${isAutoRefreshing ? 'bg-green-700/40 text-green-300' : 'bg-secondary text-muted-foreground'}`}>
          {isAutoRefreshing ? '⏸ 停止' : '▶ 自動刷新'}
        </button>
        <button onClick={handleRealtimeScan} disabled={scanning}
          className="px-1.5 py-0.5 rounded bg-amber-700/40 text-amber-300 hover:bg-amber-700/60 ml-auto">
          {scanning ? '掃描中...' : '重新掃描'}
        </button>
      </div>

      {/* Header */}
      <div className="text-xs text-muted-foreground">
        可買 <span className="text-amber-400 font-bold">{buyable.length}</span>
        {locked.length > 0 && <span className="ml-1">一字板 {locked.length}</span>}
        {isFetchingForward && <span className="text-sky-400 animate-pulse ml-1">載入表現…</span>}
      </div>

      {/* Buyable cards */}
      {buyable.map(r => {
        const perf = perfMap.get(r.symbol);
        const rt = realtimePrices.get(r.symbol);
        const ticker = r.symbol.replace(/\.(SS|SZ)$/i, '');
        const turnoverRank = turnoverRankMap.get(r.symbol);

        return (
          <div key={r.symbol} className="rounded-lg border border-border/60 px-2.5 py-2 bg-card hover:bg-secondary/40 transition-colors">
            {/* Row 1: Symbol + Name + Board type + 進場確認燈 + 全市場成交額排名 */}
            <div className="flex items-center gap-1.5 mb-1 flex-wrap">
              <span className="font-mono text-[11px] text-foreground/90">{ticker}</span>
              <span className="text-[11px] text-foreground/80 truncate flex-1">{displayName(r)}</span>
              {turnoverRank != null && (
                <span
                  className={`text-[9px] px-1 py-0.5 rounded border ${
                    turnoverRank <= 50 ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                    : turnoverRank <= 200 ? 'bg-sky-500/20 text-sky-300 border-sky-500/40'
                    : 'bg-zinc-500/20 text-zinc-400 border-zinc-500/40'
                  }`}
                  title={`全市場 20 日均成交額排名第 ${turnoverRank} 名（top 500）`}
                >
                  💰 #{turnoverRank}
                </span>
              )}
              {r.openConfirmed === true && (
                <span className="text-[9px] px-1 py-0.5 rounded border bg-green-500/20 text-green-400 border-green-500/30" title="9:25集合競價開盤價 ≥ 買入門檻，確認進場">
                  ✅ 進場
                </span>
              )}
              {r.openConfirmed === false && (
                <span className="text-[9px] px-1 py-0.5 rounded border bg-zinc-500/20 text-zinc-400 border-zinc-500/40" title="9:25集合競價未達買入門檻（收盤 × 1.02），不進場">
                  ⏸ 不進
                </span>
              )}
              <span className={`text-[9px] px-1 py-0.5 rounded border ${boardBadge(r.limitUpType)}`}>{r.limitUpType}</span>
            </div>

            {/* Row 2: Price + Change + 門檻 + 高開幅 */}
            <div className="flex items-center gap-1.5 text-[10px] mb-1 flex-wrap">
              <span className="font-mono text-foreground">{r.closePrice.toFixed(2)}</span>
              <span className="text-bull font-bold">+{r.limitUpPct.toFixed(1)}%</span>
              <span className="text-muted-foreground/70">門檻 {r.buyThresholdPrice.toFixed(2)}</span>
              {r.openPrice != null && (
                <span className="text-muted-foreground/70">
                  開 <span className="font-mono text-foreground/90">{r.openPrice.toFixed(2)}</span>
                </span>
              )}
              {r.gapUpPct != null && (
                <span className={r.gapUpPct >= 0 ? 'text-bull' : 'text-bear'}>
                  高開 {r.gapUpPct >= 0 ? '+' : ''}{r.gapUpPct.toFixed(1)}%
                </span>
              )}
            </div>

            {/* Row 3: Realtime open price（手動刷新用） */}
            {rt && (
              <div className="flex items-center gap-1.5 text-[10px] mb-1 bg-sky-900/20 rounded px-1.5 py-0.5">
                <span className="text-muted-foreground">即時</span>
                <span className="font-mono text-foreground">{rt.open.toFixed(2)}</span>
                {(() => {
                  const openChg = ((rt.open - r.closePrice) / r.closePrice * 100);
                  return <span className={openChg >= 0 ? 'text-bull' : 'text-bear'}>{openChg >= 0 ? '+' : ''}{openChg.toFixed(1)}%</span>;
                })()}
              </div>
            )}

            {/* Row 4: Forward perf + Actions */}
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
              <button
                onClick={() => onSelectStock?.({ symbol: r.symbol, name: displayName(r), market: 'CN' })}
                className="text-[9px] text-sky-400 hover:text-sky-300 px-1 py-0.5 rounded border border-sky-700/50 hover:bg-sky-900/30 ml-1 shrink-0">
                走圖
              </button>
            </div>
          </div>
        );
      })}

      {/* Locked (一字板) */}
      {locked.length > 0 && (
        <div className="text-[10px] text-muted-foreground/60 pt-1 border-t border-border/30">
          <span className="font-medium">一字板（不可買入）：</span>
          {locked.map(r => (
            <span key={r.symbol} className="ml-1">{displayName(r)}</span>
          ))}
        </div>
      )}
    </div>
  );
}
