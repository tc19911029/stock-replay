'use client';

import { useEffect, useRef } from 'react';
import { getBullBearColors } from '@/lib/chart/colors';
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
import { subscribeRangeSync, getLastRange, LogicalRange, subscribeCrosshairSync } from './CandleChart';

/** Convert date string to lightweight-charts Time.
 *  Daily: 'YYYY-MM-DD' → string Time (business day)
 *  Intraday: 'YYYY-MM-DD HH:mm' → UTCTimestamp (seconds) */
function toTime(date: string): Time {
  if (date.includes(' ')) {
    const d = new Date(date.replace(' ', 'T') + '+08:00');
    return Math.floor(d.getTime() / 1000) as unknown as Time;
  }
  // 清除 TWSE 除權息日標記（如 "2025-11-17*" → "2025-11-17"）
  return date.replace(/\*$/, '') as Time;
}

function makeChart(container: HTMLElement, showTimeAxis: boolean): IChartApi {
  return createChart(container, {
    layout: {
      background: { type: ColorType.Solid, color: '#0f172a' },
      textColor: '#94a3b8',
    },
    grid: { vertLines: { color: '#1e293b' }, horzLines: { color: '#1e293b' } },
    rightPriceScale: { borderColor: '#334155', minimumWidth: 80, scaleMargins: { top: 0.08, bottom: 0.08 } },
    timeScale: { borderColor: '#334155', timeVisible: showTimeAxis, visible: true },
    crosshair: { mode: 1, vertLine: { labelVisible: false } },
    width: container.clientWidth,
    height: container.clientHeight || 80,
  });
}

/** 台股量顯示為「張」(1張=1000股)，其他市場顯示「股」 */
function formatVolume(vol: number, isTW: boolean): string {
  if (isTW) {
    const lots = Math.round(vol / 1000);
    return lots.toLocaleString();
  }
  return vol.toLocaleString();
}

// ── Volume ────────────────────────────────────────────────────────────────────
function VolumeChart({ candles, hoverCandle, isTW }: { candles: CandleWithIndicators[]; hoverCandle?: CandleWithIndicators | null; isTW?: boolean }) {
  const containerRef  = useRef<HTMLDivElement>(null);
  const chartRef      = useRef<IChartApi | null>(null);
  const volRef        = useRef<ISeriesApi<'Histogram'> | null>(null);
  const mv5Ref        = useRef<ISeriesApi<'Line'> | null>(null);
  const mv20Ref       = useRef<ISeriesApi<'Line'> | null>(null);
  const candlesRef    = useRef<CandleWithIndicators[]>(candles);
  useEffect(() => { candlesRef.current = candles; }, [candles]);

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
    // ── Crosshair sync from main chart ────────────────────────────────────
    const unsubCrosshair = subscribeCrosshairSync((time) => {
      if (!chartRef.current || !volRef.current) return;
      if (!time) { chartRef.current.clearCrosshairPosition(); return; }
      const c = candlesRef.current.find(x => x.date === time);
      if (c) chartRef.current.setCrosshairPosition(c.volume, toTime(time), volRef.current);
    });
    const ro = new ResizeObserver(() => {
      if (containerRef.current) chart.applyOptions({
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight || 80,
      });
    });
    ro.observe(containerRef.current);
    return () => { ro.disconnect(); unsub(); unsubCrosshair(); chart.remove(); };
  }, []);

  useEffect(() => {
    if (!volRef.current || !mv5Ref.current || !mv20Ref.current || candles.length === 0) return;
    const { bull, bear } = getBullBearColors();
    volRef.current.setData(candles.map(c => ({
      time: toTime(c.date), value: c.volume,
      color: c.close >= c.open ? `${bull}99` : `${bear}99`,
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
  const volColor = display && prevDisp ? (display.volume >= prevDisp.volume ? 'text-bull' : 'text-bear') : 'text-muted-foreground';

  return (
    <div className="relative h-full">
      <div className="absolute top-1 left-2 z-10 flex gap-3 text-xs font-mono pointer-events-none">
        <span className="text-muted-foreground">成交量{isTW ? '(張)' : ''}</span>
        <span className="text-blue-400">MV5 {display?.avgVol5 ? formatVolume(display.avgVol5, !!isTW) : '—'}</span>
        <span className={`font-bold ${volColor}`}>量 {display ? formatVolume(display.volume, !!isTW) : '—'} {volArrow}</span>
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
  const candlesRef   = useRef<CandleWithIndicators[]>(candles);
  useEffect(() => { candlesRef.current = candles; }, [candles]);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = makeChart(containerRef.current, false);
    difRef.current    = chart.addSeries(LineSeries, { color: '#3b82f6', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    signalRef.current = chart.addSeries(LineSeries, { color: '#f59e0b', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    histRef.current   = chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false });
    chartRef.current  = chart;

    const unsub = subscribeRangeSync((range: LogicalRange | null) => {
      if (range) chart.timeScale().setVisibleLogicalRange(range);
    });
    // ── Crosshair sync from main chart ────────────────────────────────────
    const unsubCrosshair = subscribeCrosshairSync((time) => {
      if (!chartRef.current || !difRef.current) return;
      if (!time) { chartRef.current.clearCrosshairPosition(); return; }
      const c = candlesRef.current.find(x => x.date === time);
      if (c != null && c.macdDIF != null)
        chartRef.current.setCrosshairPosition(c.macdDIF, toTime(time), difRef.current);
    });
    const ro = new ResizeObserver(() => {
      if (containerRef.current) chart.applyOptions({
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight || 80,
      });
    });
    ro.observe(containerRef.current);
    return () => { ro.disconnect(); unsub(); unsubCrosshair(); chart.remove(); };
  }, []);

  useEffect(() => {
    if (!difRef.current || !signalRef.current || !histRef.current || candles.length === 0) return;
    const { bull: macdBull, bear: macdBear } = getBullBearColors();
    // Include all bars (pad warmup with 0) so bar count matches main chart → logical range sync works
    difRef.current.setData(candles.map(c => ({ time: toTime(c.date), value: c.macdDIF ?? 0 })));
    signalRef.current.setData(candles.map(c => ({ time: toTime(c.date), value: c.macdSignal ?? 0 })));
    histRef.current.setData(candles.map(c => ({
      time: toTime(c.date), value: c.macdOSC ?? 0,
      color: (c.macdOSC ?? 0) >= 0 ? `${macdBull}99` : `${macdBear}99`,
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
        <span className="text-muted-foreground">MACD</span>
        <span className="text-amber-400">MACD10 {display?.macdSignal?.toFixed(2) ?? '—'}</span>
        <span className="text-blue-400">DIF {display?.macdDIF?.toFixed(2) ?? '—'}</span>
        <span className={display?.macdOSC != null && display.macdOSC >= 0 ? 'text-bull' : 'text-bear'}>
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
  const candlesRef   = useRef<CandleWithIndicators[]>(candles);
  useEffect(() => { candlesRef.current = candles; }, [candles]);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = makeChart(containerRef.current, false);

    const kSeries = chart.addSeries(LineSeries, { color: '#3b82f6', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    const dSeries = chart.addSeries(LineSeries, { color: '#f97316', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    kRef.current  = kSeries;
    dRef.current  = dSeries;
    kMarkRef.current = createSeriesMarkers(kSeries, []);
    chartRef.current = chart;

    const unsub = subscribeRangeSync((range: LogicalRange | null) => {
      if (range) chart.timeScale().setVisibleLogicalRange(range);
    });
    // ── Crosshair sync from main chart ────────────────────────────────────
    const unsubCrosshair = subscribeCrosshairSync((time) => {
      if (!chartRef.current || !kRef.current) return;
      if (!time) { chartRef.current.clearCrosshairPosition(); return; }
      const c = candlesRef.current.find(x => x.date === time);
      if (c != null && c.kdK != null)
        chartRef.current.setCrosshairPosition(c.kdK, toTime(time), kRef.current);
    });
    const ro = new ResizeObserver(() => {
      if (containerRef.current) chart.applyOptions({
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight || 80,
      });
    });
    ro.observe(containerRef.current);
    return () => { ro.disconnect(); unsub(); unsubCrosshair(); chart.remove(); };
  }, []);

  useEffect(() => {
    if (!kRef.current || !dRef.current || candles.length === 0) return;
    const { bull: kdBull, bear: kdBear } = getBullBearColors();
    // Pad warmup bars with 50 (neutral KD) so bar count matches main chart
    kRef.current.setData(candles.map(c => ({ time: toTime(c.date), value: c.kdK ?? 50 })));
    dRef.current.setData(candles.map(c => ({ time: toTime(c.date), value: c.kdD ?? 50 })));
    if (kMarkRef.current) {
      const dots: SeriesMarker<Time>[] = candles
        .filter(c => c.kdK != null && (c.kdK >= 80 || c.kdK <= 20))
        .map(c => ({
          time: toTime(c.date), position: 'inBar' as const, shape: 'circle' as const,
          color: c.kdK! >= 80 ? kdBull : kdBear, size: 0.5,
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
        <span className="text-muted-foreground">KD</span>
        <span className="text-blue-400">K5 {display?.kdK?.toFixed(2) ?? '—'} {kArrow}</span>
        <span className="text-orange-400">D5 {display?.kdD?.toFixed(2) ?? '—'} {dArrow}</span>
      </div>
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
}

// ── RSI ──────────────────────────────────────────────────────────────────────
function RSIChart({ candles, hoverCandle }: { candles: CandleWithIndicators[]; hoverCandle?: CandleWithIndicators | null }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef     = useRef<IChartApi | null>(null);
  const rsiRef       = useRef<ISeriesApi<'Line'> | null>(null);
  const markRef      = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const candlesRef   = useRef<CandleWithIndicators[]>(candles);
  useEffect(() => { candlesRef.current = candles; }, [candles]);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = makeChart(containerRef.current, false);

    const rsiSeries = chart.addSeries(LineSeries, { color: '#a855f7', lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
    rsiRef.current  = rsiSeries;
    markRef.current = createSeriesMarkers(rsiSeries, []);
    chartRef.current = chart;

    const unsub = subscribeRangeSync((range: LogicalRange | null) => {
      if (range) chart.timeScale().setVisibleLogicalRange(range);
    });
    const unsubCrosshair = subscribeCrosshairSync((time) => {
      if (!chartRef.current || !rsiRef.current) return;
      if (!time) { chartRef.current.clearCrosshairPosition(); return; }
      const c = candlesRef.current.find(x => x.date === time);
      if (c != null && c.rsi14 != null)
        chartRef.current.setCrosshairPosition(c.rsi14, toTime(time), rsiRef.current);
    });
    const ro = new ResizeObserver(() => {
      if (containerRef.current) chart.applyOptions({
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight || 80,
      });
    });
    ro.observe(containerRef.current);
    return () => { ro.disconnect(); unsub(); unsubCrosshair(); chart.remove(); };
  }, []);

  useEffect(() => {
    if (!rsiRef.current || candles.length === 0) return;
    const { bull: rsiBull, bear: rsiBear } = getBullBearColors();
    rsiRef.current.setData(candles.map(c => ({ time: toTime(c.date), value: c.rsi14 ?? 50 })));
    if (markRef.current) {
      const dots: SeriesMarker<Time>[] = candles
        .filter(c => c.rsi14 != null && (c.rsi14 >= 70 || c.rsi14 <= 30))
        .map(c => ({
          time: toTime(c.date), position: 'inBar' as const, shape: 'circle' as const,
          color: c.rsi14! >= 70 ? rsiBull : rsiBear, size: 0.5,
        }));
      markRef.current.setMarkers(dots);
    }
    const chart = chartRef.current;
    requestAnimationFrame(() => {
      const r = getLastRange();
      if (r && chart) chart.timeScale().setVisibleLogicalRange(r);
    });
  }, [candles]);

  const last = candles[candles.length - 1];
  const display = hoverCandle ?? last;
  const rsiVal = display?.rsi14;
  const rsiColor = rsiVal != null ? (rsiVal >= 70 ? 'text-bull' : rsiVal <= 30 ? 'text-bear' : 'text-purple-400') : 'text-muted-foreground';
  const rsiZone = rsiVal != null ? (rsiVal >= 70 ? '超買' : rsiVal <= 30 ? '超賣' : '') : '';

  return (
    <div className="relative h-full">
      <div className="absolute top-1 left-2 z-10 flex gap-3 text-xs font-mono pointer-events-none">
        <span className="text-muted-foreground">RSI(14)</span>
        <span className={rsiColor}>{rsiVal?.toFixed(2) ?? '—'} {rsiZone && <span className="text-[10px]">{rsiZone}</span>}</span>
      </div>
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
}

// ── Combined ──────────────────────────────────────────────────────────────────
export default function IndicatorCharts({ candles, hoverCandle, indicators, ticker }: {
  candles: CandleWithIndicators[];
  hoverCandle?: CandleWithIndicators | null;
  indicators?: { macd: boolean; kd: boolean; volume: boolean; rsi?: boolean };
  /** 股票代碼，用於判斷市場（.TW/.TWO=台股，量顯示為張） */
  ticker?: string;
}) {
  if (candles.length === 0) return null;
  const isTW = ticker ? /\.(TW|TWO)$/i.test(ticker) : false;
  const show = indicators ?? { macd: true, kd: true, volume: true, rsi: false };
  const panels = [
    show.volume && <div key="vol" className="flex-1 min-h-0 bg-card"><VolumeChart candles={candles} hoverCandle={hoverCandle} isTW={isTW} /></div>,
    show.kd && <div key="kd" className="flex-[1.8] min-h-0 bg-card"><KDChart candles={candles} hoverCandle={hoverCandle} /></div>,
    show.rsi && <div key="rsi" className="flex-[1.8] min-h-0 bg-card"><RSIChart candles={candles} hoverCandle={hoverCandle} /></div>,
    show.macd && <div key="macd" className="flex-[2.2] min-h-0 bg-card"><MACDChart candles={candles} hoverCandle={hoverCandle} /></div>,
  ].filter(Boolean);

  if (panels.length === 0) return <div className="h-full bg-card flex items-center justify-center text-xs text-muted-foreground/60">請開啟至少一個指標面板</div>;

  return (
    <div className="h-full flex flex-col divide-y divide-border overflow-hidden">
      {panels}
    </div>
  );
}
