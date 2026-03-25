'use client';

import { useEffect, useRef, useState } from 'react';
import {
  createChart,
  IChartApi,
  ISeriesApi,
  ColorType,
  Time,
  CandlestickSeries,
  LineSeries,
  createSeriesMarkers,
  ISeriesMarkersPluginApi,
  SeriesMarker,
} from 'lightweight-charts';
import { CandleWithIndicators, RuleSignal, ChartSignalMarker } from '@/types';

const TW_RED   = '#ef4444';
const TW_GREEN = '#22c55e';

const MA_COLORS = {
  ma5:  '#facc15', // 黃（短線）
  ma10: '#a78bfa', // 紫
  ma20: '#38bdf8', // 天藍（中線）
  ma60: '#f43f5e', // 玫紅（長線，明顯區別於 MA5 黃色）
};

function toTime(date: string): Time { return date as Time; }

// ── Module-level time range sync ─────────────────────────────────────────────
let _syncing = false;
let _lastRange: { from: number; to: number } | null = null;

export type LogicalRange = { from: number; to: number };
export type RangeSyncCallback = (range: LogicalRange | null) => void;
const syncListeners = new Set<RangeSyncCallback>();

export function subscribeRangeSync(cb: RangeSyncCallback) {
  syncListeners.add(cb);
  return () => syncListeners.delete(cb);
}
export function getLastRange() { return _lastRange; }
export function broadcastRange(range: LogicalRange | null) {
  if (_syncing) return;
  _syncing = true;
  if (range) _lastRange = range;
  syncListeners.forEach(cb => cb(range));
  _syncing = false;
}

// ── Signal marker config ───────────────────────────────────────────────────────
const MARKER_CONFIG: Record<ChartSignalMarker['type'], {
  position: 'aboveBar' | 'belowBar';
  shape: 'arrowUp' | 'arrowDown';
  color: string;
}> = {
  BUY:    { position: 'belowBar', shape: 'arrowUp',   color: '#ef4444' },
  ADD:    { position: 'belowBar', shape: 'arrowUp',   color: '#f97316' },
  REDUCE: { position: 'aboveBar', shape: 'arrowDown', color: '#14b8a6' },
  SELL:   { position: 'aboveBar', shape: 'arrowDown', color: '#22c55e' },
  WATCH:  { position: 'aboveBar', shape: 'arrowDown', color: '#eab308' },
};

interface CandleChartProps {
  candles: CandleWithIndicators[];
  signals: RuleSignal[];
  chartMarkers?: ChartSignalMarker[];
  avgCost?: number;
  stopLossPrice?: number;
  onCrosshairMove?: (candle: CandleWithIndicators | null) => void;
  height?: number;
  fillContainer?: boolean;
}

export default function CandleChart({
  candles, signals, chartMarkers = [], avgCost, stopLossPrice, onCrosshairMove, height = 400, fillContainer = false,
}: CandleChartProps) {
  const containerRef   = useRef<HTMLDivElement>(null);
  const chartRef       = useRef<IChartApi | null>(null);
  const candleRef      = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const maRefs         = useRef<Record<string, ISeriesApi<'Line'>>>({});
  const markersPlugRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const avgCostLineRef   = useRef<ReturnType<ISeriesApi<'Candlestick'>['createPriceLine']> | null>(null);
  const stopLossLineRef  = useRef<ReturnType<ISeriesApi<'Candlestick'>['createPriceLine']> | null>(null);
  // Keep latest candles accessible inside event closures without re-subscribing
  const candlesRef     = useRef<CandleWithIndicators[]>(candles);
  const onCrosshairRef = useRef(onCrosshairMove);
  const [hoverCandle, setHoverCandle] = useState<CandleWithIndicators | null>(null);

  useEffect(() => { candlesRef.current = candles; }, [candles]);
  useEffect(() => { onCrosshairRef.current = onCrosshairMove; }, [onCrosshairMove]);

  useEffect(() => {
    if (!containerRef.current) return;

    const chartHeight = (fillContainer
      ? containerRef.current.clientHeight
      : height) || 400;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#0f172a' },
        textColor: '#94a3b8',
      },
      grid: {
        vertLines: { color: '#1e293b' },
        horzLines: { color: '#1e293b' },
      },
      crosshair: { mode: 1 },
      rightPriceScale: { borderColor: '#334155' },
      timeScale: { borderColor: '#334155', timeVisible: true },
      width: containerRef.current.clientWidth,
      height: chartHeight,
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: TW_RED, downColor: TW_GREEN,
      borderUpColor: TW_RED, borderDownColor: TW_GREEN,
      wickUpColor: TW_RED, wickDownColor: TW_GREEN,
    });

    const maKeys = ['ma5', 'ma10', 'ma20', 'ma60'] as const;
    const newMARef: Record<string, ISeriesApi<'Line'>> = {};
    for (const key of maKeys) {
      newMARef[key] = chart.addSeries(LineSeries, {
        color: MA_COLORS[key], lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
      });
    }

    chartRef.current  = chart;
    candleRef.current = candleSeries;
    maRefs.current    = newMARef;
    markersPlugRef.current = createSeriesMarkers(candleSeries, []);

    // ── 主圖廣播 logical range 給指標圖（bar-index 同步，對齊更精確） ──
    chart.timeScale().subscribeVisibleLogicalRangeChange(range => {
      broadcastRange(range as { from: number; to: number } | null);
    });

    // ── Crosshair → OHLCV display ─────────────────────────────────────
    chart.subscribeCrosshairMove(param => {
      if (!onCrosshairRef.current) return;
      if (!param.time) {
        setHoverCandle(null);
        onCrosshairRef.current?.(null);
        return;
      }
      const dateStr = param.time as string;
      const found = candlesRef.current.find(c => c.date === dateStr) ?? null;
      setHoverCandle(found);
      onCrosshairRef.current?.(found);
    });

    const ro = new ResizeObserver(() => {
      if (!containerRef.current) return;
      chart.applyOptions({ width: containerRef.current.clientWidth });
      if (fillContainer) chart.applyOptions({ height: containerRef.current.clientHeight });
    });
    ro.observe(containerRef.current);

    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load candle / MA data ────────────────────────────────────────────────
  useEffect(() => {
    if (!candleRef.current || candles.length === 0) return;

    candleRef.current.setData(candles.map(c => ({
      time: toTime(c.date), open: c.open, high: c.high, low: c.low, close: c.close,
    })));
    const maKeys = ['ma5', 'ma10', 'ma20', 'ma60'] as const;
    for (const key of maKeys) {
      maRefs.current[key]?.setData(
        candles.filter(c => c[key] != null).map(c => ({ time: toTime(c.date), value: c[key]! }))
      );
    }
    // scrollToPosition 後稍等一個 tick 再廣播，確保 range 已更新
    const chart = chartRef.current;
    if (chart) {
      // 預設顯示最近 80 根K棒（仿 WantGoo 6個月日線），讓K棒大小清晰
      const totalBars = candles.length;
      const visibleBars = 80;
      chart.timeScale().setVisibleLogicalRange({
        from: totalBars - visibleBars - 1,
        to:   totalBars + 3,
      });
      requestAnimationFrame(() => {
        const range = chart.timeScale().getVisibleLogicalRange();
        if (range) broadcastRange(range as { from: number; to: number });
      });
    }
  }, [candles]);

  // ── Avg cost price line ───────────────────────────────────────────────────
  useEffect(() => {
    if (!candleRef.current) return;
    if (avgCostLineRef.current) {
      try { candleRef.current.removePriceLine(avgCostLineRef.current); } catch {}
      avgCostLineRef.current = null;
    }
    if (avgCost && avgCost > 0) {
      avgCostLineRef.current = candleRef.current.createPriceLine({
        price: avgCost, color: '#fbbf24', lineWidth: 1,
        lineStyle: 2, axisLabelVisible: true, title: '均價',
      });
    }
  }, [avgCost]);

  // ── Stop-loss price line ──────────────────────────────────────────────────
  useEffect(() => {
    if (!candleRef.current) return;
    if (stopLossLineRef.current) {
      try { candleRef.current.removePriceLine(stopLossLineRef.current); } catch {}
      stopLossLineRef.current = null;
    }
    if (stopLossPrice && stopLossPrice > 0) {
      stopLossLineRef.current = candleRef.current.createPriceLine({
        price: stopLossPrice, color: '#ef4444', lineWidth: 1,
        lineStyle: 1, axisLabelVisible: true, title: '停損',
      });
    }
  }, [stopLossPrice]);

  // ── Chart markers ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!markersPlugRef.current) return;
    const converted: SeriesMarker<Time>[] = chartMarkers.map(m => {
      const cfg = MARKER_CONFIG[m.type];
      return { time: m.date as Time, position: cfg.position, shape: cfg.shape, color: cfg.color, text: m.label, size: 1 };
    });
    markersPlugRef.current.setMarkers(converted);
  }, [chartMarkers]);

  // MA legend: show hovered candle's values if hovering, else last candle
  const last = candles[candles.length - 1];
  const displayForLegend = hoverCandle ?? last;
  const idxForLegend = hoverCandle
    ? candles.findIndex(c => c.date === hoverCandle.date)
    : candles.length - 1;
  const prevForLegend = candles[idxForLegend - 1];

  return (
    <div className="relative w-full">
      {/* MA Legend — 跟著 crosshair 更新 */}
      <div className="absolute top-2 left-3 z-10 flex flex-wrap gap-x-3 gap-y-0.5 text-xs font-mono pointer-events-none">
        {(Object.entries(MA_COLORS) as [keyof typeof MA_COLORS, string][]).map(([key, color]) => {
          const val  = displayForLegend?.[key];
          const pVal = prevForLegend?.[key];
          const arrow = val != null && pVal != null ? (val >= pVal ? ' ↑' : ' ↓') : '';
          return (
            <span key={key} style={{ color }}>
              {key.toUpperCase()} {val != null ? val.toFixed(2) : '—'}{arrow}
            </span>
          );
        })}
      </div>

      {/* Signal badge — only show highest-priority non-WATCH signal */}
      {(() => {
        const PRIORITY: Record<string, number> = { SELL: 4, BUY: 3, REDUCE: 2, ADD: 1 };
        const filtered = signals.filter(s => s.type !== 'WATCH');
        if (filtered.length === 0) return null;
        const best = filtered.reduce((a, b) => (PRIORITY[b.type] ?? 0) > (PRIORITY[a.type] ?? 0) ? b : a);
        return (
          <div className="absolute top-2 right-3 z-10 pointer-events-none">
            <span className={`px-2.5 py-1 rounded text-xs font-bold shadow-lg ${
              best.type === 'BUY'    ? 'bg-red-600 text-white'    :
              best.type === 'ADD'    ? 'bg-orange-500 text-white' :
              best.type === 'SELL'   ? 'bg-green-700 text-white'  :
                                       'bg-teal-500 text-white'
            }`}>{best.label}</span>
          </div>
        );
      })()}

      <div ref={containerRef} className={fillContainer ? 'w-full h-full' : 'w-full'} style={fillContainer ? undefined : { height }} />
    </div>
  );
}
