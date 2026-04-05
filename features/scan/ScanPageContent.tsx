'use client';

import { useState, useEffect, useCallback } from 'react';
import { useBacktestStore } from '@/store/backtestStore';
import {
  SessionHistory,
  ScanResultsTable,
} from '@/features/scan';
import { PageShell } from '@/components/shared';
import { SectionBoundary } from '@/components/ErrorBoundary';
import { Button } from '@/components/ui/button';

// ── Compact Scan Panel (embeddable in other pages) ───────────────────────────

export function ScanPanel() {
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
  } = useBacktestStore();

  const [maxDate, setMaxDate] = useState('2099-12-31');
  useEffect(() => { setMaxDate(new Date().toISOString().split('T')[0]); }, []);

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
        <div className="flex items-center gap-1.5">
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

      {/* Error / Warning */}
      {(scanError || forwardError) && (() => {
        const msg = scanError || forwardError || '';
        const isWarning = msg.includes('\u90e8\u5206\u8986\u84cb') || msg.includes('\u8986\u84cb\u7387');
        return (
          <div className={`mx-3 my-1.5 px-3 py-1.5 rounded text-[11px] ${
            isWarning
              ? 'bg-amber-950/60 border border-amber-900 text-amber-300'
              : 'bg-red-950/60 border border-red-900 text-red-300'
          }`}>
            {msg}
          </div>
        );
      })()}

      {/* Results table */}
      <div className="overflow-y-auto" style={{ maxHeight: 'calc(40vh - 60px)' }}>
        <div className="px-3 py-2">
          <SectionBoundary section="掃描結果">
            <ScanResultsTable />
          </SectionBoundary>
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

export default function ScanPageContent({ defaultMode = 'full' }: ScanPageContentProps) {
  const {
    market, scanDate,
    useMultiTimeframe, toggleMultiTimeframe,
    sessions,
    setMarket, setScanDate,
    isScanning, scanProgress, scanningStock, scanningCount, scanError,
    scanResults, isFetchingForward, forwardError,
    clearCurrent,
    setScanOnly,
    scanMode,
    scanDirection, setScanDirection,
    marketTrend,
    cancelScan,
    cronDates, fetchCronDates,
  } = useBacktestStore();

  /* eslint-disable react-hooks/set-state-in-effect */
  // 載入 cron 歷史日期
  useEffect(() => { fetchCronDates(market); }, [market, fetchCronDates]);

  // 用 state 避免 SSR hydration mismatch
  const [maxDate, setMaxDate] = useState('2099-12-31');
  useEffect(() => { setMaxDate(new Date().toISOString().split('T')[0]); }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

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
                  <Button key={m} onClick={() => { setMarket(m); clearCurrent(); }}
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
                <Button onClick={() => { setScanDirection('long'); clearCurrent(); }}
                  variant={scanDirection === 'long' ? 'default' : 'secondary'}
                  className={`px-3 py-2 rounded-none text-sm font-medium ${scanDirection === 'long' ? 'bg-red-600 hover:bg-red-500' : ''}`}>做多</Button>
                <Button onClick={() => { setScanDirection('short'); clearCurrent(); }}
                  variant={scanDirection === 'short' ? 'default' : 'secondary'}
                  className={`px-3 py-2 rounded-none text-sm font-medium ${scanDirection === 'short' ? 'bg-green-600 hover:bg-green-500' : ''}`}>做空</Button>
              </div>
            </div>

            {/* Date */}
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground font-medium">訊號日期</label>
              <input type="date" value={scanDate} max={maxDate} min="2020-01-01"
                onChange={e => { setScanDate(e.target.value); clearCurrent(); }}
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
            const isWarn = msg.includes('\u90e8\u5206\u8986\u84cb') || msg.includes('\u8986\u84cb\u7387');
            return (
            <div className={`mx-5 mb-4 px-4 py-2.5 rounded-lg text-sm ${
              isWarn ? 'bg-amber-950/60 border border-amber-900 text-amber-300' : 'bg-red-950/60 border border-red-900 text-red-300'
            }`}>
              {msg}
            </div>
            );
          })()}
        </div>

        {/* History sidebar (standalone, when no scan results yet but cron data exists) */}
        {scanResults.length === 0
          && (sessions.filter(s => s.market === market).length > 0 || cronDates.length > 0) && (
          <div className="max-w-xs">
            <SessionHistory />
          </div>
        )}

        {/* Results */}
        {scanResults.length > 0 && (
          <div className="flex gap-4">
            <div className="flex-1 min-w-0 space-y-4 overflow-x-auto">

              {/* Scan Results Table */}
              <SectionBoundary section="掃描結果">
                <ScanResultsTable />
              </SectionBoundary>

            </div>

            {/* Sidebar */}
            <div className="w-44 shrink-0 hidden xl:block">
              <SessionHistory />
            </div>
          </div>
        )}

        {/* Empty state (only when no cron history either) */}
        {!isScanning && !isFetchingForward && scanResults.length === 0 && !scanError && cronDates.length === 0 && sessions.filter(s => s.market === market).length === 0 && (
          scanProgress ? (
            <div className="text-center py-16 text-muted-foreground space-y-3">
              <div className="text-5xl">📭</div>
              <div className="text-lg font-medium text-muted-foreground">本日無符合條件的個股</div>
              {marketTrend && (
                <div className={`inline-block px-3 py-1.5 rounded-lg text-sm font-medium ${
                  marketTrend === '空頭' ? 'bg-green-900/40 text-green-300' :
                  marketTrend === '盤整' ? 'bg-yellow-900/30 text-yellow-300' :
                  'bg-muted text-muted-foreground'
                }`}>
                  大盤狀態：{String(marketTrend)}
                  {marketTrend === '空頭' && ' — 空頭市場選股困難，建議觀望或切換做空模式'}
                  {marketTrend === '盤整' && ' — 盤整行情，嚴格條件下難找到標的'}
                </div>
              )}
              <div className="text-sm space-y-1">
                <p className="font-medium">可能的原因：</p>
                <ul className="text-xs text-muted-foreground space-y-0.5">
                  <li>大盤處於空頭或盤整，門檻自動提高</li>
                  <li>該日期（{scanDate}）市場整體量能不足</li>
                  <li>策略條件較嚴格（可在「策略」頁面調整門檻）</li>
                </ul>
              </div>
              <div className="flex flex-wrap justify-center gap-2 mt-4">
                <button
                  onClick={() => setScanDirection(scanDirection === 'long' ? 'short' : 'long')}
                  className="text-xs px-3 py-1.5 rounded-lg bg-secondary hover:bg-muted text-foreground/80 transition-colors"
                >
                  {scanDirection === 'long' ? '切換做空掃描' : '切換做多掃描'}
                </button>
              </div>
            </div>
          ) : (
            <div className="text-center py-20 text-muted-foreground space-y-2">
              <div className="text-5xl">🔬</div>
              <div className="text-lg font-medium text-muted-foreground">選擇市場、日期、策略，開始回測</div>
              <div className="text-sm">嚴謹模式：進場用隔日開盤價，成本模型台股/陸股分開計算</div>
              <div className="text-sm">每筆交易保留完整進出場紀錄與命中原因</div>
            </div>
          )
        )}

      </div>
    </div>
    </PageShell>
  );
}
