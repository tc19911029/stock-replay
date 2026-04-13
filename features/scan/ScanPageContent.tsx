'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useBacktestStore } from '@/store/backtestStore';
import {
  SessionHistory,
  ScanResultsTable,
  ScanChartPanel,
  DateNavigator,
  DabanResultsTable,
} from '@/features/scan';
import type { SelectedStock } from '@/features/scan';
import { PageShell } from '@/components/shared';
import { SectionBoundary } from '@/components/ErrorBoundary';
import { Button } from '@/components/ui/button';

// ── Compact Scan Panel (embeddable in other pages) ───────────────────────────

interface ScanPanelProps {
  onSelectStock?: (stock: SelectedStock) => void;
}

export function ScanPanel({ onSelectStock }: ScanPanelProps) {
  const {
    market, scanDate,
    useMultiTimeframe, toggleMultiTimeframe,
    setMarket, setScanDate,
    isScanning, scanProgress, scanningStock, scanningCount, scanError,
    scanResults, isFetchingForward, forwardError,
    clearCurrent,
    setScanOnly,
    scanDirection, setScanDirection,
    marketTrend,
    cancelScan,
    cronDates, fetchCronDates,
    isLoadingCronSession,
    autoLoadLatest,
    sessionDataFreshness: _sessionDataFreshness,
  } = useBacktestStore();

  const [maxDate] = useState(() => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date()));

  // 載入歷史日期
  useEffect(() => {
     
    if (scanDirection === 'daban') {
      // 打板有獨立的日期列表 API
      fetch('/api/scanner/daban').then(r => r.json()).then(data => {
        if (data.dates) {
          useBacktestStore.setState({
            cronDates: data.dates.map((d: { date: string; resultCount: number }) => ({
              market: 'CN' as const, date: d.date, resultCount: d.resultCount, scanTime: '',
            })),
          });
        }
      }).catch(() => {});
    } else {
      fetchCronDates(market, scanDirection);
    }
  }, [market, scanDirection, fetchCronDates]);

  // 自動載入最新掃描結果
  const autoLoadedRef = useRef(false);
  useEffect(() => {
    if (!autoLoadedRef.current) {
      autoLoadedRef.current = true;
      autoLoadLatest();
    }
  }, [autoLoadLatest]);

  const isBusy = isScanning || isFetchingForward;

  const handleScan = useCallback(() => {
    if (isBusy) return;
    setScanOnly(true);
    setTimeout(() => useBacktestStore.getState().runScan(), 0);
  }, [isBusy, setScanOnly]);

  return (
    <div className="text-foreground text-xs">
      {/* Compact action bar — single row */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-border">
        {/* Market */}
        <div className="flex rounded overflow-hidden border border-border">
          {(['TW', 'CN'] as const).map(m => (
            <button key={m} onClick={() => { setMarket(m); clearCurrent(); }}
              className={`px-2.5 py-1 text-[11px] font-medium ${market === m ? 'bg-blue-600 text-foreground' : 'bg-secondary text-muted-foreground hover:bg-muted'}`}>
              {m === 'TW' ? '台股' : '陸股'}
            </button>
          ))}
        </div>

        {/* Direction */}
        <div className="flex rounded overflow-hidden border border-border">
          <button onClick={() => { setScanDirection('long'); clearCurrent(); }}
            className={`px-2 py-1 text-[11px] font-medium ${scanDirection === 'long' ? 'bg-red-600 text-foreground' : 'bg-secondary text-muted-foreground hover:bg-muted'}`}>多</button>
          <button onClick={() => { setScanDirection('short'); clearCurrent(); }}
            className={`px-2 py-1 text-[11px] font-medium ${scanDirection === 'short' ? 'bg-green-600 text-foreground' : 'bg-secondary text-muted-foreground hover:bg-muted'}`}>空</button>
          {market === 'CN' && (
            <button onClick={() => { setScanDirection('daban'); }}
              className={`px-2 py-1 text-[11px] font-medium ${scanDirection === 'daban' ? 'bg-amber-600 text-foreground' : 'bg-secondary text-muted-foreground hover:bg-muted'}`}>打板</button>
          )}
        </div>

        {/* Date */}
        <input type="date" value={scanDate} max={maxDate} min="2020-01-01"
          onChange={e => { setScanDate(e.target.value); clearCurrent(); }}
          className="bg-secondary border border-border text-foreground rounded px-2 py-1 text-[11px] focus:outline-none focus:border-sky-500"
        />

        {/* 長線保護 */}
        <button onClick={toggleMultiTimeframe}
          className={`px-2 py-1 rounded text-[11px] font-medium border ${useMultiTimeframe ? 'bg-blue-700/60 border-blue-600 text-blue-200' : 'bg-secondary border-border text-muted-foreground hover:bg-muted'}`}>
          {useMultiTimeframe ? '週月線' : '僅日線'}
        </button>

        {/* Result badge */}
        {scanResults.length > 0 && !isScanning && (
          <span className="text-muted-foreground">
            選出 <span className="text-amber-400 font-bold">{scanResults.length}</span> 檔
            {marketTrend && (
              <span className={`ml-1 px-1 py-0.5 rounded text-[10px] font-bold ${
                marketTrend === '多頭' ? 'bg-red-900/50 text-red-300' :
                marketTrend === '空頭' ? 'bg-green-900/50 text-green-300' :
                'bg-yellow-900/50 text-yellow-300'
              }`}>{marketTrend}</span>
            )}
          </span>
        )}

        {/* Scan button */}
        <div className="flex items-center gap-1.5 ml-auto">
          <button onClick={handleScan} disabled={isBusy || !scanDate}
            className="px-3 py-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-foreground text-[11px] font-semibold rounded whitespace-nowrap">
            {isScanning ? `掃描中 ${Math.round(scanProgress)}%` : '掃描'}
          </button>
          {isBusy && (
            <button onClick={cancelScan}
              className="px-2 py-1 bg-red-700 hover:bg-red-600 text-foreground text-[11px] rounded">
              取消
            </button>
          )}
        </div>
      </div>

      {/* Date Navigator — 歷史日期列表 */}
      {cronDates.length > 0 && (
        <div className="px-3 py-1.5 border-b border-border flex flex-wrap gap-1 items-center">
          <span className="text-[10px] text-muted-foreground mr-1">紀錄：</span>
          {cronDates.filter(c => c.market === market).filter((c, i, arr) => arr.findIndex(x => x.date === c.date) === i).slice(0, 30).map(c => {
            const isActive = c.date === scanDate;
            return (
              <button
                key={c.date}
                onClick={() => {
                  if (isBusy || isLoadingCronSession) return;
                  if (scanDirection === 'daban') {
                    useBacktestStore.setState({ scanDate: c.date });
                  } else {
                    useBacktestStore.getState().loadCronSession(c.market, c.date, { scanOnly: true, direction: scanDirection });
                  }
                }}
                disabled={isBusy || isLoadingCronSession}
                className={`px-1.5 py-0.5 rounded text-[10px] font-mono transition-colors ${
                  isActive
                    ? 'bg-sky-700 text-sky-100 font-semibold'
                    : 'bg-secondary/60 text-muted-foreground hover:bg-secondary hover:text-foreground'
                } ${isBusy || isLoadingCronSession ? 'opacity-50 cursor-wait' : 'cursor-pointer'}`}
                title={`${c.date}｜${c.resultCount >= 0 ? c.resultCount + ' 檔' : '點擊載入'}`}
              >
                {c.date.slice(5)}
                {c.resultCount >= 0 && <span className="ml-0.5 opacity-60">({c.resultCount})</span>}
              </button>
            );
          })}
        </div>
      )}

      {/* Progress bar */}
      {(isScanning || isFetchingForward) && (
        <div className="px-3 py-1.5 border-b border-border">
          <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1">
            <span>{isScanning ? (scanningStock || '掃描中…') : '計算績效…'}</span>
            {isScanning && scanningCount && <span className="font-mono">{scanningCount}</span>}
          </div>
          <div className="h-1 bg-secondary rounded-full overflow-hidden">
            <div className="h-full bg-sky-500 rounded-full transition-all duration-500"
              style={{ width: isScanning ? `${scanProgress}%` : '100%' }} />
          </div>
        </div>
      )}

      {/* Loading */}
      {isLoadingCronSession && scanResults.length === 0 && (
        <div className="px-3 py-3 text-center text-muted-foreground">
          <span className="inline-block w-3 h-3 border border-sky-500/30 border-t-sky-500 rounded-full animate-spin mr-1.5" />
          <span className="text-[11px]">載入中…</span>
        </div>
      )}

      {/* Error / Warning */}
      {(scanError || forwardError) && (() => {
        const msg = scanError || forwardError || '';
        const isWarning = msg.includes('\u90e8\u5206\u8986\u84cb') || msg.includes('\u8986\u84cb\u7387') || msg.includes('無符合');
        const isInfo = msg.includes('正常現象');
        const colorClass = isInfo
          ? 'bg-blue-950/60 border border-blue-900 text-blue-300'
          : isWarning
            ? 'bg-amber-950/60 border border-amber-900 text-amber-300'
            : 'bg-red-950/60 border border-red-900 text-red-300';
        return (
          <div className={`mx-3 my-1.5 px-3 py-2 rounded text-[11px] leading-relaxed ${colorClass}`}>
            {msg.split('\n').map((line, i) => (
              <div key={i} className={line.startsWith('建議') || line.startsWith('可能原因') ? 'mt-0.5 opacity-80' : ''}>
                {line.startsWith('建議') ? '💡 ' : line.startsWith('可能原因') ? '❓ ' : ''}{line}
              </div>
            ))}
          </div>
        );
      })()}

      {/* Results table */}
      <div className="overflow-y-auto" style={{ maxHeight: 'calc(55vh - 60px)' }}>
        <div className="px-3 py-2">
          {scanDirection === 'daban' ? (
            <SectionBoundary section="打板掃描結果">
              <DabanResultsTable date={scanDate} onSelectStock={onSelectStock} />
            </SectionBoundary>
          ) : (
            <SectionBoundary section="掃描結果">
              <ScanResultsTable onSelectStock={onSelectStock} />
            </SectionBoundary>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Shared Scan Page Content ──────────────────────────────────────────────────

interface ScanPageContentProps {
  /** 'sop' = V2簡化版(六條件+戒律+淘汰法), 'full' = 舊版完整管線 */
  defaultMode?: 'full' | 'sop';
}

export default function ScanPageContent({ defaultMode: _defaultMode = 'full' }: ScanPageContentProps) {
  const {
    market, scanDate,
    useMultiTimeframe, toggleMultiTimeframe,
    setMarket, setScanDate,
    isScanning, scanProgress, scanningStock, scanningCount, scanError,
    scanResults, isFetchingForward, forwardError,
    setScanOnly,
    scanMode,
    scanDirection, setScanDirection,
    marketTrend,
    cancelScan,
    cronDates, fetchCronDates,
    isLoadingCronSession,
    sessionDataFreshness: _sessionDataFreshness2,
  } = useBacktestStore();

  const autoLoadLatest = useBacktestStore(s => s.autoLoadLatest);
  const scanTiming = useBacktestStore(s => s.scanTiming);

   
  // 載入 cron 歷史日期（market/direction/MTF 切換時重新取得）
  useEffect(() => {
    if (scanDirection === 'daban') {
      fetch('/api/scanner/daban').then(r => r.json()).then(data => {
        if (data.dates) {
          useBacktestStore.setState({
            cronDates: data.dates.map((d: { date: string; resultCount: number }) => ({
              market: 'CN' as const, date: d.date, resultCount: d.resultCount, scanTime: '',
            })),
          });
        }
      }).catch(() => {});
    } else {
      fetchCronDates(market, scanDirection);
    }
  }, [market, scanDirection, useMultiTimeframe, fetchCronDates]);

  // 用 state 避免 SSR hydration mismatch
  const [maxDate] = useState(() => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date()));

  // 自動載入最新掃描結果（進頁時）
  const autoLoadedRef = useRef(false);
  useEffect(() => {
    if (!autoLoadedRef.current) {
      autoLoadedRef.current = true;
      autoLoadLatest();
    }
  }, [autoLoadLatest]);

  // Auto-load when condition changes (market / direction / date / MTF) — skip initial render
  const conditionInitRef = useRef(false);
  useEffect(() => {
    if (!conditionInitRef.current) { conditionInitRef.current = true; return; }
    if (!scanDate) return;
    if (scanDirection !== 'daban') {
      useBacktestStore.getState().loadCronSession(market, scanDate, { scanOnly: true, direction: scanDirection });
    }
    // daban 模式由 DabanResultsTable 自行載入
  }, [market, scanDirection, scanDate, useMultiTimeframe]);

  // ── Chart selection state ──
  const [selectedStock, setSelectedStock] = useState<SelectedStock | null>(null);

  // ── One-click scan actions ──
  const isBusy = isScanning || isFetchingForward;

  const handleScan = useCallback(() => {
    if (isBusy) return;
    setScanOnly(true);
    setTimeout(() => useBacktestStore.getState().runScan(), 0);
  }, [isBusy, setScanOnly]);

  return (
    <PageShell>
    <div className="text-foreground">
      <div className="px-3 sm:px-4 lg:px-6 py-4 sm:py-6 space-y-4 sm:space-y-6">

        {/* ── Action Bar ── */}
        <div className="bg-card rounded-xl border border-border overflow-hidden">
          <div className="p-4 sm:p-5 flex flex-wrap items-end gap-3 sm:gap-4">
            {/* Market */}
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground font-medium">市場</label>
              <div className="flex rounded-lg overflow-hidden border border-border">
                {(['TW', 'CN'] as const).map(m => (
                  <Button key={m} onClick={() => setMarket(m)}
                    variant={market === m ? 'default' : 'secondary'}
                    className="px-4 py-2 rounded-none text-sm font-medium">
                    {m === 'TW' ? '台股' : '陸股'}
                  </Button>
                ))}
              </div>
            </div>

            {/* Direction — 做多/做空切換 */}
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground font-medium">方向</label>
              <div className="flex rounded-lg overflow-hidden border border-border">
                <Button onClick={() => setScanDirection('long')}
                  variant={scanDirection === 'long' ? 'default' : 'secondary'}
                  className={`px-3 py-2 rounded-none text-sm font-medium ${scanDirection === 'long' ? 'bg-red-600 hover:bg-red-500' : ''}`}>做多</Button>
                <Button onClick={() => setScanDirection('short')}
                  variant={scanDirection === 'short' ? 'default' : 'secondary'}
                  className={`px-3 py-2 rounded-none text-sm font-medium ${scanDirection === 'short' ? 'bg-green-600 hover:bg-green-500' : ''}`}>做空</Button>
                {market === 'CN' && (
                  <Button onClick={() => setScanDirection('daban')}
                    variant={scanDirection === 'daban' ? 'default' : 'secondary'}
                    className={`px-3 py-2 rounded-none text-sm font-medium ${scanDirection === 'daban' ? 'bg-amber-600 hover:bg-amber-500' : ''}`}>打板</Button>
                )}
              </div>
            </div>

            {/* Date */}
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground font-medium">訊號日期</label>
              <input type="date" value={scanDate} max={maxDate} min="2020-01-01"
                onChange={e => setScanDate(e.target.value)}
                className="bg-secondary border border-border text-foreground rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-sky-500"
              />
            </div>


            {/* Multi-Timeframe Toggle (長線保護短線) */}
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground font-medium">長線保護</label>
              <Button
                onClick={toggleMultiTimeframe}
                variant={useMultiTimeframe ? 'default' : 'secondary'}
                className={`px-4 py-2 text-sm ${useMultiTimeframe ? 'bg-blue-700/60 hover:bg-blue-600/60 border border-blue-600 text-blue-200' : ''}`}
              >
                {useMultiTimeframe ? '週月線過濾' : '僅日線'}
              </Button>
            </div>

            {/* Scan Result Badge */}
            {scanResults.length > 0 && !isScanning && (
              <div className="text-sm text-muted-foreground hidden sm:flex items-center gap-1.5">
                <span className="text-foreground/80 font-medium">{scanDate}</span>
                {' 選出 '}
                <span className="text-amber-400 font-bold">{scanResults.length}</span>
                {' 檔'}
                {scanMode === 'sop' && (
                  <span className="ml-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-900/50 text-amber-300">V2 SOP</span>
                )}
                {marketTrend && (
                  <span title={`大盤趨勢：${marketTrend}｜多頭＝大盤上漲，選股勝率較高｜盤整＝方向不明，需謹慎｜空頭＝大盤下跌，風險較大`}
                    className={`ml-1 px-1.5 py-0.5 rounded text-xs font-bold cursor-help ${
                    marketTrend === '多頭' ? 'bg-red-900/50 text-bull-badge' :
                    marketTrend === '空頭' ? 'bg-green-900/50 text-bear-badge' :
                    'bg-yellow-900/50 text-yellow-300'
                  }`}>{marketTrend}</span>
                )}
              </div>
            )}

            {/* ── Action Button ── */}
            <div className="flex items-center gap-2 ml-auto">
              <Button
                onClick={handleScan}
                disabled={isBusy || !scanDate}
                title="篩選符合條件的股票，並模擬買入出場計算報酬率（含手續費）"
                className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-foreground text-sm font-semibold whitespace-nowrap"
              >
                {isScanning || isFetchingForward ? (
                  <span className="flex items-center gap-2">
                    <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    {isScanning ? `掃描中 ${Math.round(scanProgress)}%` : '計算績效…'}
                  </span>
                ) : '掃描'}
              </Button>
              {isBusy && (
                <Button
                  onClick={cancelScan}
                  variant="destructive"
                  className="px-3 py-2.5 text-sm font-medium whitespace-nowrap"
                >
                  取消
                </Button>
              )}
            </div>
          </div>

          {/* Progress */}
          {(isScanning || isFetchingForward) && (
            <div className="px-5 pb-4 space-y-2 border-t border-border pt-3">
              <div className="text-xs text-muted-foreground flex items-center justify-between">
                <span>{isScanning ? (scanningStock || `掃描歷史數據（${scanDate}）…`) : '計算後續績效與回測引擎…'}</span>
                <div className="flex items-center gap-2">
                  {isScanning && scanningCount && <span className="text-muted-foreground font-mono text-[10px]">{scanningCount}</span>}
                  {isScanning && <span className="text-sky-400 font-mono">{Math.round(scanProgress)}%</span>}
                </div>
              </div>
              <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                <div className="h-full bg-sky-500 rounded-full transition-all duration-500"
                  style={{ width: isScanning ? `${scanProgress}%` : '100%',
                           animation: isFetchingForward ? 'pulse 1s infinite' : 'none' }} />
              </div>
            </div>
          )}

          {(scanError || forwardError) && (() => {
            const msg = scanError || forwardError || '';
            const isWarn = msg.includes('\u90e8\u5206\u8986\u84cb') || msg.includes('\u8986\u84cb\u7387') || msg.includes('無符合');
            const isInfo = msg.includes('正常現象');
            const colorCls = isInfo
              ? 'bg-blue-950/60 border border-blue-900 text-blue-300'
              : isWarn
                ? 'bg-amber-950/60 border border-amber-900 text-amber-300'
                : 'bg-red-950/60 border border-red-900 text-red-300';
            return (
            <div className={`mx-5 mb-4 px-4 py-3 rounded-lg text-sm leading-relaxed ${colorCls}`}>
              {msg.split('\n').map((line, i) => (
                <div key={i} className={line.startsWith('建議') || line.startsWith('可能原因') ? 'mt-1 opacity-80' : ''}>
                  {line.startsWith('建議') ? '💡 ' : line.startsWith('可能原因') ? '❓ ' : ''}{line}
                </div>
              ))}
            </div>
            );
          })()}
        </div>

        {/* Date Navigator — 歷史紀錄日期列表（主導航） */}
        <DateNavigator />

        {/* Loading indicator when auto-loading */}
        {(isLoadingCronSession) && scanResults.length === 0 && (
          <div className="text-center py-8 text-muted-foreground space-y-2">
            <div className="w-5 h-5 border-2 border-sky-500/30 border-t-sky-500 rounded-full animate-spin mx-auto" />
            <div className="text-sm">載入掃描結果中…</div>
          </div>
        )}

        {/* Dev: scan timing */}
        {process.env.NODE_ENV === 'development' && scanTiming && (
          <div className="text-[10px] font-mono text-muted-foreground/60 px-1 flex gap-3">
            <span>list {scanTiming.listMs}ms</span>
            <span>ingest {scanTiming.ingestMs}ms</span>
            <span>chunk {scanTiming.chunkMs}ms</span>
            <span>fwd {scanTiming.forwardMs}ms</span>
            <span className="text-sky-500/60">total {scanTiming.totalMs}ms</span>
          </div>
        )}

        {/* Chart Panel — 走圖區域 */}
        {scanResults.length > 0 && (
          <ScanChartPanel selectedStock={selectedStock} scanDate={scanDate} />
        )}

        {/* Results — 打板模式 */}
        {scanDirection === 'daban' && (
          <div className="space-y-4">
            <SectionBoundary section="打板掃描結果">
              <DabanResultsTable date={scanDate} onSelectStock={setSelectedStock} />
            </SectionBoundary>
          </div>
        )}

        {/* Results — 一般模式 */}
        {scanDirection !== 'daban' && scanResults.length > 0 && (
          <div className="flex gap-4">
            <div className="flex-1 min-w-0 space-y-4 overflow-x-auto">
              <SectionBoundary section="掃描結果">
                <ScanResultsTable onSelectStock={setSelectedStock} />
              </SectionBoundary>
            </div>

            {/* Sidebar — backfill + history */}
            <div className="w-44 shrink-0 hidden xl:block">
              <SessionHistory />
            </div>
          </div>
        )}

        {/* Empty state */}
        {!isScanning && !isFetchingForward && scanResults.length === 0 && !scanError && !isLoadingCronSession && (
          cronDates.length > 0 ? (
            <div className="text-center py-12 text-muted-foreground space-y-2">
              <div className="text-3xl">👆</div>
              <div className="text-sm font-medium">點擊上方日期查看掃描結果</div>
            </div>
          ) : (
            <div className="text-center py-16 text-muted-foreground space-y-3">
              <div className="text-5xl">🔬</div>
              <div className="text-lg font-medium text-muted-foreground">尚無歷史掃描紀錄</div>
              <div className="text-sm">請先掃描或點擊「補齊20天」建立歷史資料</div>
              <div className="flex flex-wrap justify-center gap-2 mt-4">
                <button
                  onClick={() => setScanDirection(scanDirection === 'long' ? 'short' : 'long')}
                  className="text-xs px-3 py-1.5 rounded-lg bg-secondary hover:bg-muted text-foreground/80 transition-colors"
                >
                  {scanDirection === 'long' ? '切換做空掃描' : '切換做多掃描'}
                </button>
              </div>
            </div>
          )
        )}

      </div>
    </div>
    </PageShell>
  );
}
