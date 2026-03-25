'use client';

import { useEffect, useRef } from 'react';
import {
  createChart,
  IChartApi,
  ISeriesApi,
  ColorType,
  Time,
  LineSeries,
  HistogramSeries,
  createSeriesMarkers,
  ISeriesMarkersPluginApi,
  SeriesMarker,
} from 'lightweight-charts';
import { CandleWithIndicators } from '@/types';
import { subscribeRangeSync, getLastRange, LogicalRange } from './CandleChart';

function toTime(date: string): Time { return date as Time; }

function makeChart(container: HTMLElement, showTimeAxis: boolean): IChartApi {
  return createChart(container, {
    layout: {
      background: { type: ColorType.Solid, color: '#0f172a' },
      textColor: '#94a3b8',
    },
    grid: { vertLines: { color: '#1e293b' }, horzLines: { color: '#1e293b' } },
    rightPriceScale: { borderColor: '#334155' },
    timeScale: { borderColor: '#334155', timeVisible: showTimeAxis, visible: true },
    crosshair: { mode: 1 },
    width: container.clientWidth,
    height: container.clientHeight || 80,
  });
}

// ── Volume ────────────────────────────────────────────────────────────────────
function VolumeChart({ candles, hoverCandle }: { candles: CandleWithIndicators[]; hoverCandle?: CandleWithIndicators | null }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef     = useRef<IChartApi | null>(null);
  const volRef       = useRef<ISeriesApi<'Histogram'> | null>(null);
  const mv5Ref       = useRef<ISeriesApi<'Line'> | null>(null);
  const mv20Ref      = useRef<ISeriesApi<'Line'> | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = makeChart(containerRef.current, false);
    volRef.current  = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false });
    mv5Ref.current  = chart.addSeries(LineSeries, { color: '#3b82f6', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    mv20Ref.current = chart.addSeries(LineSeries, { color: '#f59e0b', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    chartRef.current = chart;

    const unsub = subscribeRangeSync((range: LogicalRange | null) => {
      if (range) chart.timeScale().setVisibleLogicalRange(range);
    });
    const ro = new ResizeObserver(() => {
      if (containerRef.current) chart.applyOptions({
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight || 80,
      });
    });
    ro.observe(containerRef.current);
    return () => { ro.disconnect(); unsub(); chart.remove(); };
  }, []);

  useEffect(() => {
    if (!volRef.current || !mv5Ref.current || !mv20Ref.current || candles.length === 0) return;
    const TW_RED = '#ef4444'; const TW_GREEN = '#22c55e';
    volRef.current.setData(candles.map(c => ({
      time: toTime(c.date), value: c.volume,
      color: c.close >= c.open ? `${TW_RED}99` : `${TW_GREEN}99`,
    })));
    const mv5Data = candles.map((c, i) => {
      if (i < 4) return null;
      const avg = candles.slice(i - 4, i + 1).reduce((s, x) => s + x.volume, 0) / 5;
      return { time: toTime(c.date), value: avg };
    }).filter(Boolean) as { time: Time; value: number }[];
    const mv20Data = candles.map((c, i) => {
      if (i < 19) return null;
      const avg = candles.slice(i - 19, i + 1).reduce((s, x) => s + x.volume, 0) / 20;
      return { time: toTime(c.date), value: avg };
    }).filter(Boolean) as { time: Time; value: number }[];
    mv5Ref.current.setData(mv5Data);
    mv20Ref.current.setData(mv20Data);
    const chart = chartRef.current;
    requestAnimationFrame(() => {
      const r = getLastRange();
      if (r && chart) chart.timeScale().setVisibleLogicalRange(r);
    });
  }, [candles]);

  const last = candles[candles.length - 1];
  const display = hoverCandle ?? last;
  const displayIdx = hoverCandle ? candles.findIndex(c => c.date === hoverCandle.date) : candles.length - 1;
  const prevDisp = candles[displayIdx - 1];
  const volArrow = display && prevDisp ? (display.volume >= prevDisp.volume ? '↑' : '↓') : '';
  const volColor = display && prevDisp ? (display.volume >= prevDisp.volume ? 'text-red-400' : 'text-green-400') : 'text-slate-400';

  return (
    <div className="relative h-full">
      <div className="absolute top-1 left-2 z-10 flex gap-3 text-xs font-mono pointer-events-none">
        <span className="text-slate-400">成交量</span>
        <span className="text-blue-400">MV5 {display?.avgVol5 ? (display.avgVol5 / 1000).toFixed(0) + 'K' : '—'}</span>
        <span className={`font-bold ${volColor}`}>量 {display ? (display.volume / 1000).toFixed(0) + 'K' : '—'} {volArrow}</span>
      </div>
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
}

// ── MACD ─────────────────────────────────────────────────────────────────────
function MACDChart({ candles, hoverCandle }: { candles: CandleWithIndicators[]; hoverCandle?: CandleWithIndicators | null }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef     = useRef<IChartApi | null>(null);
  const difRef       = useRef<ISeriesApi<'Line'> | null>(null);
  const signalRef    = useRef<ISeriesApi<'Line'> | null>(null);
  const histRef      = useRef<ISeriesApi<'Histogram'> | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = makeChart(containerRef.current, false);
    difRef.current    = chart.addSeries(LineSeries, { color: '#3b82f6', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    signalRef.current = chart.addSeries(LineSeries, { color: '#f59e0b', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    histRef.current   = chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false });
    chartRef.current  = chart;

    const unsub = subscribeRangeSync(range => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (range) chart.timeScale().setVisibleRange(range as any);
    });
    const ro = new ResizeObserver(() => {
      if (containerRef.current) chart.applyOptions({
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight || 80,
      });
    });
    ro.observe(containerRef.current);
    return () => { ro.disconnect(); unsub(); chart.remove(); };
  }, []);

  useEffect(() => {
    if (!difRef.current || !signalRef.current || !histRef.current || candles.length === 0) return;
    // Include all bars (pad warmup with 0) so bar count matches main chart → logical range sync works
    difRef.current.setData(candles.map(c => ({ time: toTime(c.date), value: c.macdDIF ?? 0 })));
    signalRef.current.setData(candles.map(c => ({ time: toTime(c.date), value: c.macdSignal ?? 0 })));
    histRef.current.setData(candles.map(c => ({
      time: toTime(c.date), value: c.macdOSC ?? 0,
      color: (c.macdOSC ?? 0) >= 0 ? '#ef444499' : '#22c55e99',
    })));
    const chart = chartRef.current;
    requestAnimationFrame(() => {
      const r = getLastRange();
      if (r && chart) chart.timeScale().setVisibleLogicalRange(r);
    });
  }, [candles]);

  const last = candles[candles.length - 1];
  const display = hoverCandle ?? last;
  const displayIdx = hoverCandle ? candles.findIndex(c => c.date === hoverCandle.date) : candles.length - 1;
  const prevDisp = candles[displayIdx - 1];
  const oscArrow = display?.macdOSC != null && prevDisp?.macdOSC != null ? (display.macdOSC >= prevDisp.macdOSC ? '↑' : '↓') : '';

  return (
    <div className="relative h-full">
      <div className="absolute top-1 left-2 z-10 flex gap-3 text-xs font-mono pointer-events-none">
        <span className="text-slate-400">MACD</span>
        <span className="text-amber-400">MACD9 {display?.macdSignal?.toFixed(2) ?? '—'}</span>
        <span className="text-blue-400">DIF {display?.macdDIF?.toFixed(2) ?? '—'}</span>
        <span className={display?.macdOSC != null && display.macdOSC >= 0 ? 'text-red-400' : 'text-green-400'}>
          OSC {display?.macdOSC?.toFixed(2) ?? '—'} {oscArrow}
        </span>
      </div>
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
}

// ── KD ────────────────────────────────────────────────────────────────────────
function KDChart({ candles, hoverCandle }: { candles: CandleWithIndicators[]; hoverCandle?: CandleWithIndicators | null }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef     = useRef<IChartApi | null>(null);
  const kRef         = useRef<ISeriesApi<'Line'> | null>(null);
  const dRef         = useRef<ISeriesApi<'Line'> | null>(null);
  const kMarkRef     = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = makeChart(containerRef.current, true);

    const kSeries = chart.addSeries(LineSeries, { color: '#3b82f6', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    const dSeries = chart.addSeries(LineSeries, { color: '#f97316', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    kRef.current  = kSeries;
    dRef.current  = dSeries;
    kMarkRef.current = createSeriesMarkers(kSeries, []);
    chartRef.current = chart;

    const unsub = subscribeRangeSync(range => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (range) chart.timeScale().setVisibleRange(range as any);
    });
    const ro = new ResizeObserver(() => {
      if (containerRef.current) chart.applyOptions({
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight || 80,
      });
    });
    ro.observe(containerRef.current);
    return () => { ro.disconnect(); unsub(); chart.remove(); };
  }, []);

  useEffect(() => {
    if (!kRef.current || !dRef.current || candles.length === 0) return;
    // Pad warmup bars with 50 (neutral KD) so bar count matches main chart
    kRef.current.setData(candles.map(c => ({ time: toTime(c.date), value: c.kdK ?? 50 })));
    dRef.current.setData(candles.map(c => ({ time: toTime(c.date), value: c.kdD ?? 50 })));
    if (kMarkRef.current) {
      const dots: SeriesMarker<Time>[] = candles
        .filter(c => c.kdK != null && (c.kdK >= 80 || c.kdK <= 20))
        .map(c => ({
          time: toTime(c.date), position: 'inBar' as const, shape: 'circle' as const,
          color: c.kdK! >= 80 ? '#ef4444' : '#22c55e', size: 0.5,
        }));
      kMarkRef.current.setMarkers(dots);
    }
    const chart = chartRef.current;
    requestAnimationFrame(() => {
      const r = getLastRange();
      if (r && chart) chart.timeScale().setVisibleLogicalRange(r);
    });
  }, [candles]);

  const last = candles[candles.length - 1];
  const display = hoverCandle ?? last;
  const displayIdx = hoverCandle ? candles.findIndex(c => c.date === hoverCandle.date) : candles.length - 1;
  const prevDisp = candles[displayIdx - 1];
  const kArrow = display?.kdK != null && prevDisp?.kdK != null ? (display.kdK >= prevDisp.kdK ? '↑' : '↓') : '';
  const dArrow = display?.kdD != null && prevDisp?.kdD != null ? (display.kdD >= prevDisp.kdD ? '↑' : '↓') : '';

  return (
    <div className="relative h-full">
      <div className="absolute top-1 left-2 z-10 flex gap-3 text-xs font-mono pointer-events-none">
        <span className="text-slate-400">KD</span>
        <span className="text-blue-400">K9 {display?.kdK?.toFixed(2) ?? '—'} {kArrow}</span>
        <span className="text-orange-400">D9 {display?.kdD?.toFixed(2) ?? '—'} {dArrow}</span>
      </div>
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
}

// ── Combined ──────────────────────────────────────────────────────────────────
export default function IndicatorCharts({ candles, hoverCandle }: { candles: CandleWithIndicators[]; hoverCandle?: CandleWithIndicators | null }) {
  if (candles.length === 0) return null;
  return (
    <div className="h-full flex flex-col divide-y divide-slate-700 overflow-hidden">
      <div className="flex-1 min-h-0 bg-slate-900"><VolumeChart candles={candles} hoverCandle={hoverCandle} /></div>
      <div className="flex-1 min-h-0 bg-slate-900"><KDChart candles={candles} hoverCandle={hoverCandle} /></div>
      <div className="flex-[1.4] min-h-0 bg-slate-900"><MACDChart candles={candles} hoverCandle={hoverCandle} /></div>
    </div>
  );
}
