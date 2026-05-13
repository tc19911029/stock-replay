'use client';

import { useState, useEffect, useRef } from 'react';
import { useBacktestStore } from '@/store/backtestStore';
import { useReplayStore } from '@/store/replayStore';
import { ScanResultsCompact } from './components/ScanResultsCompact';
import { DabanResultsCompact } from './components/DabanResultsCompact';
import { ScanCoachDigest } from './components/ScanCoachDigest';
import { MarketTrendBanner } from './components/MarketTrendBanner';
import { LockWatchPanel } from './components/LockWatchPanel';
// 2026-05-11 ReentryCandidatesPanel 移除：用戶反饋無實質用途（跟 B 回後買上漲重疊高、書本對齊度低）。檔案保留供日後重做
import { SectionBoundary } from '@/components/ErrorBoundary';
import type { SelectedStock } from './components/ScanChartPanel';
import {
  BULLISH_TRACK_LETTERS,
  BULLISH_TRACK_SET,
  REVERSAL_TRACK_LETTERS,
  REVERSAL_TRACK_SET,
  SYSTEM_TRACK_SET,
  LETTER_NAMES,
} from '@/lib/scanner/buyMethodTracks';

interface ScanPanelVerticalProps {
  onSelectStock?: (stock: SelectedStock) => void;
}

export function ScanPanelVertical({ onSelectStock }: ScanPanelVerticalProps) {
  const {
    market, scanDate,
    useMultiTimeframe, toggleMultiTimeframe,
    setMarket,
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
    activeBuyMethod, setActiveBuyMethod, isLoadingBuyMethod,
    // setScanOnly 暫保留 destructure（以後可能會加回手動掃描）
  } = useBacktestStore();
  void setScanOnly;
  void useMultiTimeframe;
  void toggleMultiTimeframe;

  const [coachCollapsed, setCoachCollapsed] = useState(true);

  // 載入歷史日期；市場/方向切換後自動載入最新結果
  const conditionMountedRef = useRef(false);
  useEffect(() => {
    const isInitialMount = !conditionMountedRef.current;
    conditionMountedRef.current = true;

    if (scanDirection === 'daban') {
      fetchCronDates(market, 'long');
      return;
    }
    const dir = scanDirection === 'short' ? 'short' : 'long';
    if (isInitialMount) {
      autoLoadLatest();
    } else {
      fetchCronDates(market, dir).then(() => {
        const dates = useBacktestStore.getState().cronDates.filter(c => c.market === market);
        if (dates.length > 0) {
          const bestDate = dates.find(c => c.resultCount > 0)?.date ?? dates[0].date;
          useBacktestStore.getState().loadCronSession(market, bestDate, { scanOnly: true, direction: dir });
        }
      });
    }

    // Periodic refresh
    const timer = window.setInterval(() => {
      const dir2 = useBacktestStore.getState().scanDirection === 'short' ? 'short' : 'long';
      fetchCronDates(useBacktestStore.getState().market, dir2);
    }, 5 * 60 * 1000);

    return () => window.clearInterval(timer);
  }, [market, scanDirection, fetchCronDates]); // eslint-disable-line react-hooks/exhaustive-deps

  const isBusy = isScanning || isFetchingForward;

  return (
    <div className="flex flex-col min-h-0 h-full text-foreground text-xs">
      {/* ── 頂端：大盤 banner（最高優先資訊；點擊載入大盤指數走圖）── */}
      {scanDirection !== 'daban' && (
        <MarketTrendBanner
          market={market}
          marketTrend={marketTrend ?? null}
          scanDate={scanDate ?? null}
          onSelectStock={onSelectStock}
        />
      )}

      {/* ── 日期導航：點哪天看哪天的結果（取代上方 date picker）── */}
      {cronDates.some(c => c.market === market) && (
        <div className="shrink-0 px-2.5 py-1.5 border-b border-border bg-card/40">
          <div className="grid grid-cols-11 gap-1">
            {cronDates.filter(c => c.market === market)
              .filter((c, i, arr) => arr.findIndex(x => x.date === c.date) === i)
              .slice(0, 22)
              .map(c => {
                const isActive = c.date === scanDate;
                return (
                  <button key={c.date}
                    onClick={() => {
                      if (isBusy || isLoadingCronSession) return;
                      if (scanDirection === 'daban') {
                        useBacktestStore.setState({ scanDate: c.date });
                      } else {
                        useBacktestStore.getState().loadCronSession(c.market, c.date, { scanOnly: true, direction: scanDirection });
                      }
                    }}
                    disabled={isBusy || isLoadingCronSession}
                    className={`text-center px-0.5 py-0.5 rounded text-[9px] font-mono truncate ${
                      isActive ? 'bg-sky-700 text-sky-100 font-semibold' : 'bg-secondary/60 text-muted-foreground hover:bg-secondary'
                    } ${isBusy || isLoadingCronSession ? 'opacity-50' : ''}`}
                    title={`${c.date}｜${c.resultCount >= 0 ? c.resultCount + ' 檔' : ''}`}
                  >
                    {c.date.slice(5)}
                  </button>
                );
              })}
          </div>
        </div>
      )}

      {/* ── Toolbar: vertical stacked ── */}
      <div className="shrink-0 px-2.5 py-2 border-b border-border space-y-1.5">
        {/* Row 1: Market + Direction */}
        <div className="flex items-center gap-1.5">
          <div className="flex rounded overflow-hidden border border-border">
            {(['TW', 'CN'] as const).map(m => (
              <button key={m} onClick={async () => {
                if (m === market) return;
                setMarket(m);
                clearCurrent();
                const dir = scanDirection === 'long' || scanDirection === 'short' ? scanDirection : 'long';
                setScanDirection(dir);

                // 如果當前走圖是市場指數（^TWII / 000001.SS），自動切到新市場的指數
                // 個股 ticker 不動，避免使用者切市場意外失去當前看的股
                const currentTicker = useReplayStore.getState().currentStock?.ticker;
                const INDEX_TICKERS = new Set(['^TWII', '000001.SS', '000300.SS']);
                if (currentTicker && INDEX_TICKERS.has(currentTicker)) {
                  const newIndex = m === 'TW' ? '^TWII' : '000001.SS';
                  if (currentTicker !== newIndex) {
                    useReplayStore.getState().loadStock(newIndex, '1d', '2y').catch(() => {});
                  }
                }

                await fetchCronDates(m, dir);
                const mDates = useBacktestStore.getState().cronDates.filter(c => c.market === m);
                if (mDates.length > 0) {
                  const bestDate = mDates.find(c => c.resultCount > 0)?.date ?? mDates[0].date;
                  useBacktestStore.getState().loadCronSession(m, bestDate, { scanOnly: true, direction: dir });
                }
              }}
                className={`px-2 py-1 text-[11px] font-medium ${market === m ? 'bg-blue-600 text-foreground' : 'bg-secondary text-muted-foreground hover:bg-muted'}`}>
                {m === 'TW' ? '台股' : '陸股'}
              </button>
            ))}
          </div>

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

          {/* 長線保護短線 toggle — 暫時隱藏（保留 store 邏輯，日後可恢復）
          {scanDirection !== 'daban' && (
            <button onClick={toggleMultiTimeframe}
              className={`px-1.5 py-1 rounded text-[10px] font-medium border ${useMultiTimeframe ? 'bg-blue-700/60 border-blue-600 text-blue-200' : 'bg-secondary border-border text-muted-foreground hover:bg-muted'}`}>
              長線保護短線
            </button>
          )}
          */}

        </div>

        {/* 4 區塊策略選擇（書本五步法分層）— 只在做多時顯示
            ┌─ Step 1 池子 ─ A
            ├─ Step 2 多頭進場 ─ B/C/E/J/K/L/M/P（從 Step 1 挑）
            ├─ 反轉訊號 ─ D/F/N/O（不過 Step 1）
            └─ 戰法軌 ─ Q（自含 SOP，套戒律）
        */}
        {scanDirection === 'long' && (() => {
          // META: name 從 LETTER_NAMES 單一事實來源讀；track/ma 是本 panel 特有顯示欄位
          const META: Record<string, { name: string; track: string; ma: string }> = {
            A: { name: LETTER_NAMES.A, track: '預選池', ma: '—' },
            B: { name: LETTER_NAMES.B, track: '多頭軌', ma: 'MA5' },
            C: { name: LETTER_NAMES.C, track: '多頭軌', ma: 'MA10' },
            D: { name: LETTER_NAMES.D, track: '轉折軌', ma: 'MA20' },
            E: { name: LETTER_NAMES.E, track: '多頭軌', ma: 'MA10' },
            F: { name: LETTER_NAMES.F, track: '轉折軌', ma: 'MA3' },
            J: { name: LETTER_NAMES.J, track: '多頭軌', ma: 'MA20' },
            K: { name: LETTER_NAMES.K, track: '多頭軌', ma: 'MA10' },
            L: { name: LETTER_NAMES.L, track: '多頭軌', ma: 'MA10' },
            M: { name: LETTER_NAMES.M, track: '多頭軌', ma: 'MA10' },
            N: { name: LETTER_NAMES.N, track: '轉折軌', ma: 'MA10' },
            O: { name: LETTER_NAMES.O, track: '轉折軌', ma: 'MA20' },
            P: { name: LETTER_NAMES.P, track: '多頭軌', ma: 'MA5' },
            Q: { name: LETTER_NAMES.Q, track: '戰法軌', ma: 'MA10' },
          };
          type M = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'J' | 'K' | 'L' | 'M' | 'N' | 'O' | 'P' | 'Q';
          const renderBtn = (method: M, color: string) => {
            const m = META[method];
            const isBullish = BULLISH_TRACK_SET.has(method);
            const isReversal = REVERSAL_TRACK_SET.has(method);
            const isSystem = SYSTEM_TRACK_SET.has(method);
            const tooltip = method === 'A'
              ? `A · ${m.name}（書本五步法 Step 1 預選池：六條件 + 戒律 + 淘汰法）。多頭軌字母 B/C/E/J/K/L/M/P 都從這個池子挑進場時機。`
              : isBullish
                ? `${method} · ${m.name} · ${m.track} · 守 ${m.ma}\n✓ 從 Step 1 池子篩選（結果為 A 子集；若池子被重新生成過，舊 session 不會 retro-filter）`
                : isReversal
                  ? `${method} · ${m.name} · ${m.track} · 守 ${m.ma}\n⚠ 全市場掃 — 不過 Step 1（書本：抓底/反轉就不能先過六條件，過了就抓不到底）`
                  : isSystem
                    ? `${method} · ${m.name} · ${m.track} · 守 ${m.ma}\n⚠ 全市場掃 — 自含 SOP（過戒律但不過 Step 1）`
                    : `${method} · ${m.name} · ${m.track} · 守 ${m.ma}`;
            return (
              <button key={method}
                onClick={() => setActiveBuyMethod(method)}
                disabled={isLoadingBuyMethod}
                className={`px-2 py-0.5 rounded text-[10px] font-medium border transition-colors disabled:opacity-50 ${
                  activeBuyMethod === method
                    ? color
                    : 'bg-secondary border-border text-muted-foreground hover:bg-muted'
                }`}
                title={tooltip}>
                {m.name}
              </button>
            );
          };

          return (
            <div className="space-y-1.5">
              {/* Step 1：選股池 */}
              <div className="space-y-0.5">
                <div className="text-[9px] text-muted-foreground/70 px-0.5"
                  title="Step 1 預選池：過六條件 + 戒律 + 淘汰法的合格股票。所有 Step 2 多頭軌字母都從這個池子挑。">
                  <span className="font-bold text-amber-300/80">Step 1 選股池</span>
                  <span className="ml-1.5">過六條件 + 戒律 + 淘汰法的合格股票（所有 Step 2 多頭軌的源頭）</span>
                </div>
                <div className="flex items-center gap-1 flex-wrap">
                  {renderBtn('A', 'bg-amber-700/70 border-amber-600 text-amber-100')}
                </div>
              </div>

              {/* Step 2：多頭進場（從 Step 1 池子挑）*/}
              <div className="space-y-0.5">
                <div className="text-[9px] text-muted-foreground/70 px-0.5"
                  title="多頭軌字母（B/C/E/J/K/L/M/P）只從 Step 1 池子裡挑；結果必為 A 子集">
                  <span className="font-bold text-red-300/80">Step 2 多頭進場</span>
                  <span className="ml-1.5">✓ 從 Step 1 池子挑進場時機 · 書本 8 種多頭位置</span>
                </div>
                <div className="flex items-center gap-1 flex-wrap">
                  {BULLISH_TRACK_LETTERS.map(m =>
                    renderBtn(m, 'bg-red-700/70 border-red-600 text-red-100'),
                  )}
                </div>
              </div>

              {/* 反轉訊號（不過 Step 1，全市場掃）*/}
              <div className="space-y-0.5">
                <div className="text-[9px] text-muted-foreground/70 px-0.5"
                  title="反轉軌字母（D/F/N/O）全市場掃，不過 Step 1；結果可能不在 A 池子裡，這是書本要求（抓底就不能先過六條件）">
                  <span className="font-bold text-blue-300/80">反轉訊號</span>
                  <span className="ml-1.5">⚠ 全市場抓底 / 反轉 · 不過六條件（過了就抓不到底）</span>
                </div>
                <div className="flex items-center gap-1 flex-wrap">
                  {REVERSAL_TRACK_LETTERS.map(m =>
                    renderBtn(m, 'bg-blue-700/70 border-blue-600 text-blue-100'),
                  )}
                </div>
              </div>

              {/* 戰法軌（朱老師三均線）*/}
              <div className="space-y-0.5">
                <div className="text-[9px] text-muted-foreground/70 px-0.5"
                  title="戰法軌（Q）自含 SOP（MA24 趨勢判定）+ 過戒律，但不過 Step 1；結果可能不在 A 池子裡">
                  <span className="font-bold text-purple-300/80">朱老師戰法</span>
                  <span className="ml-1.5">⚠ 三條均線戰法（書本《抓住線圖》p.262）· 自含 SOP + 過戒律</span>
                </div>
                <div className="flex items-center gap-1 flex-wrap">
                  {renderBtn('Q', 'bg-purple-700/70 border-purple-600 text-purple-100')}
                </div>
              </div>
            </div>
          );
        })()}

        {/* 進度提示（cron 已自動跑掃描 + 22 天日期列已可切歷史，原手動掃描按鈕拿掉）*/}
        {isBusy && (
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span>{isScanning ? `掃描中 ${Math.round(scanProgress)}%` : '載入中…'}</span>
            <button onClick={cancelScan}
              className="ml-auto shrink-0 px-1.5 py-0.5 bg-red-700 hover:bg-red-600 text-foreground text-[10px] rounded">
              取消
            </button>
          </div>
        )}

      </div>

      {/* ── 鎖股觀察（4 區塊之後，結果列表之前）── */}
      <div className="shrink-0 border-b border-border bg-card/40">
        {scanDirection !== 'daban' && <LockWatchPanel market={market} onSelectStock={onSelectStock} />}
      </div>

      {/* 朱老師跨檔分析（只在非打板時顯示） */}
      <div className="shrink-0 border-b border-border bg-card/40">
        {scanDirection !== 'daban' && scanResults.length > 0 && (
          <div>
            <button
              onClick={() => setCoachCollapsed(v => !v)}
              className="w-full flex items-center justify-between px-2.5 py-1 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors">
              <span className="font-medium">朱老師分析</span>
              <span>{coachCollapsed ? '▶' : '▼'}</span>
            </button>
            {!coachCollapsed && (
              <div className="px-2.5 pb-1.5 max-h-[55vh] overflow-y-auto">
                <ScanCoachDigest
                  market={market}
                  scanDate={scanDate}
                  direction={scanDirection === 'short' ? 'short' : 'long'}
                  marketTrend={String(marketTrend ?? '')}
                  results={scanResults}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── 下方可滑動：股票卡片清單 ── */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* Progress bar */}
        {(isScanning || isFetchingForward) && (
          <div className="px-2.5 py-1.5 border-b border-border">
            <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-0.5">
              <span className="truncate">{isScanning ? (scanningStock || '掃描中…') : '計算績效…'}</span>
              {isScanning && scanningCount && <span className="font-mono shrink-0">{scanningCount}</span>}
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
            <div className={`mx-2.5 my-1.5 px-2.5 py-2 rounded text-[10px] leading-relaxed ${colorClass}`}>
              {msg.split('\n').map((line, i) => (
                <div key={i}>{line}</div>
              ))}
            </div>
          );
        })()}

        {/* Results — compact card view */}
        <div className="py-1.5">
          {scanDirection === 'daban' ? (
            <SectionBoundary section="打板掃描結果">
              <DabanResultsCompact date={scanDate} onSelectStock={onSelectStock} />
            </SectionBoundary>
          ) : (
            <SectionBoundary section="掃描結果">
              <ScanResultsCompact onSelectStock={onSelectStock} />
            </SectionBoundary>
          )}
        </div>
      </div>
    </div>
  );
}
