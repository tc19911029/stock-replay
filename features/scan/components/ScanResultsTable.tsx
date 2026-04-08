'use client';

import { useState, useEffect, useMemo, Fragment } from 'react';
import { useBacktestStore } from '@/store/backtestStore';
import type { SelectedStock } from './ScanChartPanel';
import { useWatchlistStore } from '@/store/watchlistStore';
import { POLLING } from '@/lib/config';
import { fetchInstitutionalBatch, type InstitutionalSummary } from '@/lib/datasource/useInstitutionalSummary';
import { Button } from '@/components/ui/button';
import type { StockForwardPerformance } from '@/lib/scanner/types';

// ── Helpers ──────────────────────────────────────────────────────────────────

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

// Forward performance column definitions
const FWD_COLS = [
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

const TOTAL_COLS = 22; // 代號+名稱+概念+價格+當日漲跌+趨勢+位置 + 14 fwd cols + 操作

interface ScanResultsTableProps {
  onSelectStock?: (stock: SelectedStock) => void;
}

export function ScanResultsTable({ onSelectStock }: ScanResultsTableProps = {}) {
  const {
    scanResults,
    scanDate,
    market,
    marketTrend,
    scanOnly,
    performance,
    isFetchingForward,
  } = useBacktestStore();

  const [expandedStock, setExpandedStock] = useState<string | null>(null);
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const [newsCache, setNewsCache] = useState<Record<string, { sentiment: number; summary: string; hasNews: boolean; loading: boolean }>>({});
  const [instData, setInstData] = useState<Map<string, InstitutionalSummary | null>>(new Map());
  const [realtimePrices, setRealtimePrices] = useState<Map<string, { price: number; changePct: number; time: string }>>(new Map());
  const [conceptFilter, setConceptFilter] = useState<string>('all');
  const [scanSort, setScanSort] = useState<'price' | 'change'>('change');
  const [scanSortDir, setScanSortDir] = useState<'asc' | 'desc'>('desc');

  // Build performance lookup map
  const perfMap = useMemo(() => {
    const map = new Map<string, StockForwardPerformance>();
    for (const p of performance) {
      map.set(p.symbol, p);
    }
    return map;
  }, [performance]);

  // ── Realtime prices (盤中即時價格更新) ──
  useEffect(() => {
    if (market !== 'TW' || scanResults.length === 0 || !scanOnly) return;
    const now = new Date();
    const h = now.getHours(), m = now.getMinutes();
    const isMarketHour = (h >= 9 && (h < 13 || (h === 13 && m <= 30)));
    if (!isMarketHour) return;

    const fetchRealtime = async () => {
      try {
        const symbols = scanResults.slice(0, 50).map(r => r.symbol).join(',');
        const res = await fetch(`/api/realtime?symbols=${symbols}`);
        const json = await res.json();
        if (json.quotes) {
          const map = new Map<string, { price: number; changePct: number; time: string }>();
          for (const q of json.quotes) {
            if (q.price > 0) map.set(q.symbol, { price: q.price, changePct: q.changePct, time: q.time });
          }
          setRealtimePrices(map);
        }
      } catch { /* silent */ }
    };

    fetchRealtime();
    const timer = setInterval(fetchRealtime, POLLING.QUOTE_INTERVAL);
    return () => clearInterval(timer);
  }, [market, scanResults.length, scanOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch FinMind institutional summaries
  useEffect(() => {
    if (market !== 'TW' || scanResults.length === 0) return;
    const tickers = scanResults.map(r => r.symbol.replace(/\.(TW|TWO)$/i, ''));
    fetchInstitutionalBatch(tickers).then(setInstData).catch(() => {});
  }, [market, scanResults]);

  // Fetch news on-demand
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!expandedStock) return;
    const ticker = expandedStock.replace(/\.(TW|TWO|SS|SZ)$/i, '');
    if (newsCache[ticker]) return;
    setNewsCache(c => ({ ...c, [ticker]: { sentiment: 0, summary: '', hasNews: false, loading: true } }));
    fetch(`/api/news/${ticker}`, { cache: 'no-store' })
      .then(r => r.json())
      .then((d: { aggregateSentiment?: number; summary?: string; hasNews?: boolean }) => {
        setNewsCache(c => ({
          ...c,
          [ticker]: {
            sentiment: d.aggregateSentiment ?? 0,
            summary: d.summary ?? '',
            hasNews: d.hasNews ?? false,
            loading: false,
          },
        }));
      })
      .catch(() => {
        setNewsCache(c => ({ ...c, [ticker]: { sentiment: 0, summary: '無法取得', hasNews: false, loading: false } }));
      });
  }, [expandedStock]); // eslint-disable-line react-hooks/exhaustive-deps
  /* eslint-enable react-hooks/set-state-in-effect */

  const availableConcepts = [...new Set(scanResults.map(r => r.industry).filter(Boolean))] as string[];

  const filteredScanResults = conceptFilter === 'all'
    ? scanResults
    : scanResults.filter(r => r.industry === conceptFilter);

  const sortedScanResults = [...filteredScanResults].sort((a, b) => {
    const dir = scanSortDir === 'desc' ? 1 : -1;
    switch (scanSort) {
      case 'price':      return dir * ((b.price ?? 0) - (a.price ?? 0));
      case 'change':     return dir * ((b.changePercent ?? 0) - (a.changePercent ?? 0));
      default:           return 0;
    }
  });

  if (!scanOnly) return null;

  if (scanResults.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <p className="text-3xl mb-3">🔍</p>
        <p className="text-sm font-medium text-muted-foreground">尚無掃描結果</p>
        <p className="text-xs text-muted-foreground/70 mt-1">可從歷史紀錄選擇日期查看，或手動掃描</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Header row */}
      <div className="flex items-center gap-2 text-sm flex-wrap">
        <span className="font-bold text-foreground">掃描結果</span>
        <span className="text-muted-foreground">{scanResults.length} 檔符合條件</span>
        <span className="text-[10px] text-muted-foreground/60" title="掃描的歷史資料日期">資料日期：{scanDate}</span>
        {marketTrend && (
          <span title={`大盤趨勢：${marketTrend}`}
            className={`px-1.5 py-0.5 rounded text-[10px] font-bold cursor-help ${
            marketTrend === '多頭' ? 'bg-red-900/50 text-red-300' :
            marketTrend === '空頭' ? 'bg-green-900/50 text-green-300' :
            'bg-yellow-900/50 text-yellow-300'
          }`}>{String(marketTrend)}</span>
        )}
        {isFetchingForward && (
          <span className="text-[10px] text-sky-400 animate-pulse">載入後續表現…</span>
        )}
        <Button
          onClick={() => {
            const headers = ['代號','名稱','概念','價格','漲跌%','趨勢','位置','隔日開','1日','2日','3日','4日','5日','10日','20日','最高','最低'];
            const rows = sortedScanResults.map(r => {
              const perf = perfMap.get(r.symbol);
              return [
                r.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, ''), r.name, r.industry ?? '',
                r.price.toFixed(2), `${r.changePercent >= 0 ? '+' : ''}${r.changePercent.toFixed(2)}%`,
                r.trendState, r.trendPosition,
                perf?.openReturn != null ? `${perf.openReturn.toFixed(2)}%` : '',
                perf?.d1Return != null ? `${perf.d1Return.toFixed(2)}%` : '',
                perf?.d2Return != null ? `${perf.d2Return.toFixed(2)}%` : '',
                perf?.d3Return != null ? `${perf.d3Return.toFixed(2)}%` : '',
                perf?.d4Return != null ? `${perf.d4Return.toFixed(2)}%` : '',
                perf?.d5Return != null ? `${perf.d5Return.toFixed(2)}%` : '',
                perf?.d10Return != null ? `${perf.d10Return.toFixed(2)}%` : '',
                perf?.d20Return != null ? `${perf.d20Return.toFixed(2)}%` : '',
                perf?.maxGain != null ? `${perf.maxGain.toFixed(2)}%` : '',
                perf?.maxLoss != null ? `${perf.maxLoss.toFixed(2)}%` : '',
              ];
            });
            const csv = '\uFEFF' + [headers, ...rows].map(r => r.map(v => `"${v}"`).join(',')).join('\n');
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url;
            a.download = `scan_${scanDate}_${market}.csv`; a.click();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
          }}
          variant="outline"
          size="sm"
          className="ml-auto text-[11px] text-sky-400 hover:text-sky-300 px-2.5 py-1 h-auto border-sky-700/50 hover:bg-sky-900/30 bg-transparent"
        >
          匯出 CSV
        </Button>
      </div>

      {/* Concept filter pills */}
      {availableConcepts.length > 1 && (
        <div className="flex flex-wrap gap-1 items-center">
          <span className="text-[10px] text-muted-foreground mr-1">篩選：</span>
          <Button onClick={() => setConceptFilter('all')}
            variant={conceptFilter === 'all' ? 'default' : 'secondary'}
            size="sm"
            className={`text-[10px] px-2 py-0.5 h-auto rounded-full ${conceptFilter === 'all' ? 'bg-sky-700 hover:bg-sky-600' : ''}`}>
            全部 ({scanResults.length})
          </Button>
          {availableConcepts.sort().slice(0, 20).map(c => {
            const count = scanResults.filter(r => r.industry === c).length;
            return (
              <Button key={c} onClick={() => setConceptFilter(c)}
                variant={conceptFilter === c ? 'default' : 'secondary'}
                size="sm"
                className={`text-[10px] px-2 py-0.5 h-auto rounded-full ${conceptFilter === c ? 'bg-sky-700 hover:bg-sky-600' : ''}`}>
                {c} ({count})
              </Button>
            );
          })}
        </div>
      )}

      {/* Main table with horizontal scroll */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs" style={{ minWidth: '1300px' }}>
          <thead>
            {/* Group header row */}
            <tr className="text-[10px] text-muted-foreground/60 border-b border-border/30">
              <th colSpan={8} className="text-left py-1 px-2 sticky left-0 bg-card z-10 font-normal tracking-wide">
                掃描當日資訊
              </th>
              <th colSpan={10} className="text-left py-1 px-2 font-normal tracking-wide border-l border-border/30">
                掃描後表現
              </th>
              <th className="py-1 px-2" />
            </tr>
            {/* Column header row */}
            <tr className="text-muted-foreground border-b border-border">
              <th className="text-left py-1.5 px-2 sticky left-0 bg-card z-10 whitespace-nowrap" style={{ width: '72px' }}>代號</th>
              <th className="text-left py-1.5 px-2 sticky left-[72px] bg-card z-10 whitespace-nowrap" style={{ width: '100px' }}>名稱</th>
              <th className="text-left py-1.5 px-2 whitespace-nowrap" style={{ width: '80px' }}>概念</th>
              {([
                { key: 'price' as const, label: '價格', w: '64px', tip: '掃描日收盤價' },
                { key: 'change' as const, label: '當日漲跌', w: '72px', tip: '掃描日收盤價相對前一交易日收盤價的漲跌百分比' },
              ]).map(({ key, label, w, tip }) => (
                <th key={key}
                  className="text-right py-1.5 px-1 cursor-pointer hover:text-foreground select-none whitespace-nowrap"
                  style={{ width: w }}
                  title={tip}
                  onClick={() => {
                    if (scanSort === key) setScanSortDir(d => d === 'desc' ? 'asc' : 'desc');
                    else { setScanSort(key); setScanSortDir('desc'); }
                  }}>
                  {label}
                  {scanSort === key && <span className="ml-0.5 text-sky-400">{scanSortDir === 'desc' ? '▼' : '▲'}</span>}
                </th>
              ))}
              <th className="text-left py-1.5 px-2 whitespace-nowrap" style={{ width: '48px' }}>趨勢</th>
              <th className="text-left py-1.5 px-2 whitespace-nowrap" style={{ width: '72px' }}>位置</th>
              {FWD_COLS.map(({ key, label }) => (
                <th key={key} className="text-right py-1.5 px-1 whitespace-nowrap text-[10px] border-l border-border/20 first:border-l-0" style={{ width: '54px' }}
                  title={key === 'maxGain' ? '觀察區間內相對掃描日收盤價的最大漲幅' :
                         key === 'maxLoss' ? '觀察區間內相對掃描日收盤價的最大跌幅' :
                         key === 'openReturn' ? '隔日開盤價相對掃描日收盤價的漲跌幅' :
                         `掃描後${label}收盤價相對掃描日收盤價的漲跌幅`}
                >{label}</th>
              ))}
              <th className="text-center py-1.5 px-2 whitespace-nowrap" style={{ width: '90px' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {sortedScanResults.slice(0, 50).map((r) => {
              const perf = perfMap.get(r.symbol);
              return (<Fragment key={r.symbol}>
              <tr className={`group border-b border-border/50 hover:bg-secondary/40 cursor-pointer ${expandedStock === r.symbol ? 'bg-secondary/60' : ''}`}
                onClick={() => setExpandedStock(expandedStock === r.symbol ? null : r.symbol)}>
                {/* 代號 — sticky */}
                <td className="py-1.5 px-2 font-mono text-foreground/90 sticky left-0 bg-card group-hover:bg-secondary/40 z-10 transition-colors">
                  {r.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '')}
                </td>
                {/* 名稱 + six-conditions badges — sticky */}
                <td className="py-1.5 px-2 sticky left-[72px] bg-card group-hover:bg-secondary/40 z-10 transition-colors">
                  <div className="text-foreground/90">{r.name}</div>
                  <div className="flex gap-0.5 mt-0.5">
                    {[
                      { pass: r.sixConditionsBreakdown.trend, label: '趨' },
                      { pass: r.sixConditionsBreakdown.position, label: '位' },
                      { pass: r.sixConditionsBreakdown.kbar, label: 'K' },
                      { pass: r.sixConditionsBreakdown.ma, label: '均' },
                      { pass: r.sixConditionsBreakdown.volume, label: '量' },
                      { pass: r.sixConditionsBreakdown.indicator, label: '指' },
                    ].map(({ pass, label }) => (
                      <span key={label} className={`text-[8px] w-3.5 h-3.5 flex items-center justify-center rounded-sm ${pass ? 'bg-sky-800/80 text-sky-300' : 'bg-secondary/50 text-muted-foreground/60'}`}>{label}</span>
                    ))}
                  </div>
                </td>
                {/* 概念 */}
                <td className="py-1.5 px-1 text-[10px] text-muted-foreground max-w-[80px] truncate" title={r.industry}>{r.industry ?? '—'}</td>
                {/* 價格 + 當日漲跌 */}
                {(() => {
                  const sym = r.symbol.replace(/\.(TW|TWO)$/i, '');
                  const rt = realtimePrices.get(sym);
                  const price = rt?.price ?? r.price;
                  const chgPct = rt?.changePct ?? r.changePercent;
                  return (<>
                    <td className="py-1.5 px-1 text-right font-mono text-foreground whitespace-nowrap" title={rt ? `即時 ${rt.time}` : '掃描時價格'}>
                      {price.toFixed(2)}
                      {rt && <span className="text-[8px] text-sky-500 ml-0.5">⚡</span>}
                    </td>
                    <td className={`py-1.5 px-1 text-right font-mono font-bold whitespace-nowrap ${chgPct >= 0 ? 'text-bull' : 'text-bear'}`}>
                      {chgPct >= 0 ? '+' : ''}{chgPct.toFixed(2)}%
                    </td>
                  </>);
                })()}
                {/* 趨勢 */}
                <td className="py-1.5 px-2 text-[10px] text-muted-foreground whitespace-nowrap">{r.trendState}</td>
                {/* 位置 */}
                <td className="py-1.5 px-2 text-[10px] text-muted-foreground whitespace-nowrap">{r.trendPosition}</td>
                {/* Forward performance columns */}
                {FWD_COLS.map(({ key }) => {
                  const val = perf ? perf[key] : undefined;
                  return (
                    <td key={key} className={`py-1.5 px-1 text-right font-mono text-[10px] whitespace-nowrap border-l border-border/10 ${retColor(val as number | null | undefined)}`}>
                      {isFetchingForward && !perf ? (
                        <span className="text-muted-foreground/40">…</span>
                      ) : (
                        fmtRet(val as number | null | undefined)
                      )}
                    </td>
                  );
                })}
                {/* 操作 */}
                <td className="py-1.5 px-2 text-center whitespace-nowrap">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectStock?.({ symbol: r.symbol, name: r.name, market: market as 'TW' | 'CN' });
                    }}
                    className="text-[10px] text-sky-400 hover:text-sky-300 px-1.5 py-0.5 rounded border border-sky-700/50 hover:bg-sky-900/30 mr-1">
                    走圖
                  </button>
                  <Button
                    onClick={(e) => {
                      e.stopPropagation();
                      useWatchlistStore.getState().add(r.symbol, r.name);
                      setJustAdded(r.symbol);
                      setTimeout(() => setJustAdded(prev => prev === r.symbol ? null : prev), 1200);
                    }}
                    variant="outline"
                    size="sm"
                    className="text-[10px] text-amber-400 hover:text-amber-300 px-1.5 py-0.5 h-auto border-amber-700/50 hover:bg-amber-900/30 bg-transparent">
                    {justAdded === r.symbol || useWatchlistStore.getState().has(r.symbol) ? '✓ 已加' : '+自選'}
                  </Button>
                </td>
              </tr>

              {/* Expanded row */}
              {expandedStock === r.symbol && (
                <tr className="bg-card/80">
                  <td colSpan={TOTAL_COLS} className="px-4 py-3">
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-[11px]">
                      {/* 飆股組件分數 */}
                      {r.surgeComponents && (
                        <div className="space-y-1.5">
                          <div className="text-muted-foreground font-medium">飆股潛力分解</div>
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
                                <span className="w-8 text-muted-foreground">{label}</span>
                                <div className="flex-1 h-1.5 bg-secondary rounded-full overflow-hidden">
                                  <div className={`h-full rounded-full ${comp.score >= 70 ? 'bg-red-500' : comp.score >= 40 ? 'bg-amber-500' : 'bg-muted'}`}
                                    style={{ width: `${comp.score}%` }} />
                                </div>
                                <span className="w-6 text-right text-muted-foreground">{comp.score}</span>
                                <span className="text-[9px] text-muted-foreground/60">({w})</span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {/* 技術特徵 */}
                      <div className="space-y-1.5">
                        <div className="text-muted-foreground font-medium">技術特徵</div>
                        <div className="flex flex-wrap gap-1">
                          {(r.surgeFlags ?? []).map(f => (
                            <span key={f} className="px-1.5 py-0.5 bg-sky-900/40 text-sky-300 rounded text-[10px]">{f}</span>
                          ))}
                          {(r.surgeFlags ?? []).length === 0 && <span className="text-muted-foreground/60">無明顯飆股特徵</span>}
                        </div>
                        <div className="text-muted-foreground font-medium mt-2">趨勢摘要</div>
                        <div className="text-foreground/80 text-[10px] space-y-0.5">
                          <div>趨勢：{r.trendState} · {r.trendPosition}</div>
                          <div>價格：{r.price.toFixed(2)} · 漲跌：{r.changePercent >= 0 ? '+' : ''}{r.changePercent.toFixed(2)}%</div>
                        </div>
                      </div>
                      {/* 觸發規則 */}
                      <div className="space-y-1.5">
                        <div className="text-muted-foreground font-medium">觸發的交易規則</div>
                        <div className="space-y-0.5 max-h-32 overflow-y-auto">
                          {r.triggeredRules.slice(0, 8).map((rule, i) => (
                            <div key={i} className="flex items-start gap-1.5 text-[10px]">
                              <span className={`mt-0.5 w-1.5 h-1.5 rounded-full shrink-0 ${rule.signalType === 'BUY' ? 'bg-bull' : 'bg-bear'}`} />
                              <span className="text-muted-foreground">{rule.reason}</span>
                            </div>
                          ))}
                          {r.triggeredRules.length === 0 && <span className="text-muted-foreground/60 text-[10px]">無觸發規則</span>}
                        </div>
                        {(r.highWinRateDetails ?? []).length > 0 && (
                          <div className="mt-2">
                            <div className="text-amber-400 font-medium text-[10px] mb-0.5">高勝率進場</div>
                            {r.highWinRateDetails!.map((d, i) => (
                              <div key={i} className="text-[10px] text-amber-300/80">{d}</div>
                            ))}
                          </div>
                        )}
                        {((r.winnerBullishPatterns ?? []).length > 0 || (r.winnerBearishPatterns ?? []).length > 0) && (
                          <div className="mt-2">
                            <div className="text-muted-foreground font-medium text-[10px] mb-0.5">贏家圖像</div>
                            {(r.winnerBullishPatterns ?? []).map((p, i) => (
                              <div key={`b${i}`} className="text-[10px] text-red-300">+ {p}</div>
                            ))}
                            {(r.winnerBearishPatterns ?? []).map((p, i) => (
                              <div key={`s${i}`} className="text-[10px] text-green-300">- {p}</div>
                            ))}
                          </div>
                        )}
                        {(r.eliminationReasons ?? []).length > 0 && (
                          <div className="mt-2">
                            <div className="text-orange-400 font-medium text-[10px] mb-0.5">風險提示 (-{r.eliminationPenalty ?? 0}分)</div>
                            {r.eliminationReasons!.map((reason, i) => (
                              <div key={i} className="text-[10px] text-orange-300/70">{reason}</div>
                            ))}
                          </div>
                        )}
                        {(r.trendlineBreakAbove || r.trendlineBreakBelow) && (
                          <div className="mt-2">
                            <div className="text-muted-foreground font-medium text-[10px] mb-0.5">切線分析</div>
                            {r.trendlineBreakAbove && <div className="text-[10px] text-red-300">突破下降切線（多方轉強）</div>}
                            {r.trendlineBreakBelow && <div className="text-[10px] text-green-300">跌破上升切線（多頭轉弱）</div>}
                          </div>
                        )}
                      </div>
                      {/* 新聞情緒 */}
                      {(() => {
                        const tk = r.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
                        const nd = newsCache[tk];
                        if (!nd) return null;
                        return (
                          <div className="space-y-1.5">
                            <div className="text-muted-foreground font-medium">新聞情緒</div>
                            {nd.loading ? (
                              <span className="text-[10px] text-muted-foreground animate-pulse">載入中…</span>
                            ) : nd.hasNews ? (
                              <>
                                <div className="flex items-center gap-2">
                                  <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${
                                    nd.sentiment > 0.1  ? 'bg-red-900/50 text-red-300' :
                                    nd.sentiment < -0.1 ? 'bg-green-900/50 text-green-300' :
                                                           'bg-muted/50 text-muted-foreground'
                                  }`}>
                                    {nd.sentiment > 0.1 ? '偏多' : nd.sentiment < -0.1 ? '偏空' : '中性'}
                                    <span className="ml-1 opacity-60 font-normal">({nd.sentiment.toFixed(2)})</span>
                                  </span>
                                </div>
                                <p className="text-[10px] text-muted-foreground leading-relaxed">{nd.summary}</p>
                              </>
                            ) : (
                              <span className="text-[10px] text-muted-foreground/60">近期無相關新聞</span>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
            );})}
          </tbody>
        </table>
      </div>
      {scanResults.length > 50 && (
        <div className="text-xs text-muted-foreground text-center space-y-0.5">
          <div>顯示前 50 檔（共 {filteredScanResults.length}{conceptFilter !== 'all' ? `/${scanResults.length}` : ''} 檔）</div>
          <div className="text-[10px] text-muted-foreground/60">數據來源：Yahoo Finance · TWSE/TPEx/東方財富 · 掃描日期 {scanDate}</div>
        </div>
      )}
    </div>
  );
}
