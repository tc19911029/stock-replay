'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { useReplayStore } from '@/store/replayStore';
import type { CandleWithIndicators } from '@/types';
import { ChevronUp, ChevronDown } from 'lucide-react';
import type { ScanInterval } from '@/lib/datasource/findAnchorIndex';
import { useScanTimeframe } from '../hooks/useScanTimeframe';
import { IntervalSwitcher } from './IntervalSwitcher';

const CandleChart = dynamic(() => import('@/components/CandleChart'), { ssr: false });
const IndicatorCharts = dynamic(() => import('@/components/IndicatorCharts'), { ssr: false });

export interface SelectedStock {
  symbol: string;   // e.g. "2330.TW"
  name: string;
  market: 'TW' | 'CN';
}

interface ScanChartPanelProps {
  selectedStock: SelectedStock | null;
  scanDate?: string;
}

export function ScanChartPanel({ selectedStock, scanDate }: ScanChartPanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [hoverCandle, setHoverCandle] = useState<CandleWithIndicators | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [interval, setInterval] = useState<ScanInterval>('1d');

  const {
    allCandles, currentSignals, chartMarkers,
    isLoadingStock, loadStock, jumpToIndex,
    startPolling, stopPolling, dataGaps,
  } = useReplayStore();

  // 用兩個獨立的 ref 追蹤，避免 symbol 改變時被 scanDate 變化覆蓋
  const prevSymbolRef = useRef<string | null>(null);
  const prevScanDateRef = useRef<string | null>(null);

  // 切換股票時重置為日K
  useEffect(() => {
    if (selectedStock && selectedStock.symbol !== prevSymbolRef.current) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setInterval('1d');
      prevSymbolRef.current = selectedStock.symbol;
    }
  }, [selectedStock, setInterval]);

  // Load stock when selection or scanDate changes (always daily)
  useEffect(() => {
    if (!selectedStock) return;

    const prevSymbol = prevSymbolRef.current;
    const prevScanDate = prevScanDateRef.current;

    // 只有符號和日期都沒變才跳過
    if (prevSymbol === selectedStock.symbol && prevScanDate === scanDate) return;

    prevSymbolRef.current = selectedStock.symbol;
    prevScanDateRef.current = scanDate ?? null;

    // 不同股票：完整重載
    // 同一股票、不同 scanDate：重新 load（因為股價資料會不同）
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadError(null);
    loadStock(selectedStock.symbol, '1d', '2y', scanDate).then(() => {
      setLoadError(null);
      // API 可能查不到中文名（回傳 ticker），用掃描結果的名字覆蓋
      const current = useReplayStore.getState().currentStock;
      if (current && selectedStock.name && (!current.name || /\.(TW|TWO|SS|SZ)$/i.test(current.name))) {
        useReplayStore.setState({
          currentStock: { ...current, name: selectedStock.name },
        });
      }
      // 盤中 polling：scanDate 為今天或未指定時才啟動
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
      if (!scanDate || scanDate === today) {
        startPolling();
      }
    }).catch((err: unknown) => {
      setLoadError(err instanceof Error ? err.message : String(err));
    });
    return () => { stopPolling(); };
  }, [selectedStock, scanDate, loadStock, startPolling, stopPolling]);

  // 根據 interval 聚合 K 棒 + 定位訊號日
  const { displayCandles, anchorDate, signalDateLabel } = useScanTimeframe(
    allCandles, scanDate, interval,
  );

  const toggleCollapse = useCallback(() => setCollapsed(c => !c), []);

  if (!selectedStock) {
    return (
      <div className="bg-card border border-border rounded-lg p-4 text-center text-muted-foreground text-sm">
        點擊下方表格的「走圖」查看個股走勢
      </div>
    );
  }

  // 週K/月K 時不顯示日線訊號標記，改用 highlightDate
  const effectiveMarkers = interval === '1d' ? chartMarkers : [];

  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden">
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-2 border-b border-border cursor-pointer hover:bg-secondary/30"
        onClick={toggleCollapse}
      >
        <div className="flex items-center gap-2 text-sm">
          <span className="font-mono font-bold text-foreground">
            {selectedStock.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '')}
          </span>
          <span className="text-foreground/80">{selectedStock.name}</span>
          {isLoadingStock && (
            <span className="w-3 h-3 border border-sky-500/30 border-t-sky-500 rounded-full animate-spin" />
          )}
        </div>
        <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
          <IntervalSwitcher
            value={interval}
            onChange={setInterval}
            signalDateLabel={signalDateLabel}
          />
          <button
            className="text-muted-foreground hover:text-foreground p-1"
            onClick={toggleCollapse}
          >
            {collapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
          </button>
        </div>
      </div>

      {/* Data gap warning */}
      {!collapsed && dataGaps.length > 0 && interval === '1d' && (
        <div className="px-4 py-1.5 bg-yellow-500/10 border-b border-yellow-500/30 text-yellow-400 text-xs flex items-center justify-between">
          <span>
            資料斷層：{dataGaps.map(g => `${g.fromDate} → ${g.toDate}（${g.calendarDays}天）`).join('、')}
          </span>
          <button
            className="ml-2 px-2 py-0.5 rounded bg-yellow-500/20 hover:bg-yellow-500/30 text-yellow-300 text-xs whitespace-nowrap"
            onClick={() => {
              if (!selectedStock) return;
              loadStock(selectedStock.symbol, '1d', '2y').catch(() => {});
            }}
          >
            重新下載
          </button>
        </div>
      )}

      {/* Chart area */}
      {!collapsed && displayCandles.length > 0 && (
        <div className="space-y-0">
          <div style={{ height: 320 }}>
            <CandleChart
              candles={displayCandles}
              signals={interval === '1d' ? currentSignals : []}
              chartMarkers={effectiveMarkers}
              onCrosshairMove={setHoverCandle}
              height={320}
              fillContainer
              highlightDate={anchorDate ?? undefined}
              centerOnDate={anchorDate ?? undefined}
            />
          </div>
          <div className="h-[180px] flex flex-col border-t border-border">
            <IndicatorCharts
              candles={displayCandles}
              hoverCandle={hoverCandle}
              indicators={{ macd: true, kd: true, volume: true }}
              ticker={selectedStock?.symbol}
            />
          </div>
        </div>
      )}

      {!collapsed && isLoadingStock && displayCandles.length === 0 && (
        <div className="flex items-center justify-center h-[320px] text-muted-foreground">
          <span className="w-5 h-5 border-2 border-sky-500/30 border-t-sky-500 rounded-full animate-spin mr-2" />
          載入 K 線資料中…
        </div>
      )}

      {!collapsed && loadError && !isLoadingStock && displayCandles.length === 0 && (
        <div className="flex flex-col items-center justify-center h-[200px] text-red-400 text-sm gap-1">
          <div>載入 {selectedStock?.name || selectedStock?.symbol} 的數據失敗</div>
          <div className="text-xs text-red-400/70 max-w-md text-center">{loadError}</div>
        </div>
      )}
    </div>
  );
}
