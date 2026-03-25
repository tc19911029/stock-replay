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
  ma5:  '#f59e0b',
  ma10: '#a78bfa',
  ma20: '#3b82f6',
  ma60: '#f97316',
};

function toTime(date: string): Time { return date as Time; }

// ── Module-level time range sync ─────────────────────────────────────────────
let _syncing = false;
let _lastRange: { from: Time; to: Time } | null = null;

export type RangeSyncCallback = (range: { from: Time; to: Time } | null) => void;
const syncListeners = new Set<RangeSyncCallback>();

export function subscribeRangeSync(cb: RangeSyncCallback) {
  syncListeners.add(cb);
  return () => syncListeners.delete(cb);
}
export function getLastRange() { return _lastRange; }
export function broadcastRange(range: { from: Time; to: Time } | null) {
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
  onCrosshairMove?: (candle: CandleWithIndicators | null) => void;
  height?: number;
}

export default function CandleChart({
  candles, signals, chartMarkers = [], avgCost, onCrosshairMove, height = 400,
}: CandleChartProps) {
  const containerRef   = useRef<HTMLDivElement>(null);
  const chartRef       = useRef<IChartApi | null>(null);
  const candleRef      = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const maRefs         = useRef<Record<string, ISeriesApi<'Line'>>>({});
  const markersPlugRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const avgCostLineRef = useRef<ReturnType<ISeriesApi<'Candlestick'>['createPriceLine']> | null>(null);
  // Keep latest candles accessible inside event closures without re-subscribing
  const candlesRef     = useRef<CandleWithIndicators[]>(candles);
  const onCrosshairRef = useRef(onCrosshairMove);
  const [hoverCandle, setHoverCandle] = useState<CandleWithIndicators | null>(null);

  useEffect(() => { candlesRef.current = candles; }, [candles]);
  useEffect(() => { onCrosshairRef.current = onCrosshairMove; }, [onCrosshairMove]);

  useEffect(() => {
    if (!containerRef.current) return;

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
      height,
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

    // ── 主圖廣播時間範圍給指標圖（單向，time-based） ─────────────────
    chart.timeScale().subscribeVisibleTimeRangeChange(range => {
      broadcastRange(range as { from: Time; to: Time } | null);
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
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
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
      chart.timeScale().scrollToPosition(8, false);
      requestAnimationFrame(() => {
        const range = chart.timeScale().getVisibleRange();
        if (range) broadcastRange(range as { from: Time; to: Time });
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

      {/* Signal badges */}
      {signals.length > 0 && (
        <div className="absolute top-2 right-3 z-10 flex flex-col items-end gap-1 pointer-events-none">
          {signals.map((sig, i) => (
            <span key={i} className={`px-2 py-0.5 rounded text-xs font-bold shadow ${
              sig.type === 'BUY'    ? 'bg-red-600 text-white'    :
              sig.type === 'ADD'    ? 'bg-orange-500 text-white' :
              sig.type === 'SELL'   ? 'bg-green-700 text-white'  :
              sig.type === 'REDUCE' ? 'bg-teal-500 text-white'   :
                                      'bg-yellow-500 text-black'
            }`}>{sig.label}</span>
          ))}
        </div>
      )}

      <div ref={containerRef} className="w-full" style={{ height }} />
    </div>
  );
}
