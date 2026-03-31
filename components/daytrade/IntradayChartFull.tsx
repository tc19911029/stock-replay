'use client';

import { useEffect, useRef } from 'react';
import { useDaytradeStore } from '@/store/daytradeStore';

export function IntradayChartFull() {
  const mainRef = useRef<HTMLDivElement>(null);
  const kdRef   = useRef<HTMLDivElement>(null);
  const macdRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chartsRef = useRef<any[]>([]);
  const { displayCandles, replayIndex, isReplaying, currentSignals, signalThreshold } = useDaytradeStore();

  useEffect(() => {
    if (!mainRef.current || displayCandles.length === 0) return;
    let cancelled = false;

    import('lightweight-charts').then(mod => {
      if (cancelled) return;
      const { createChart, CandlestickSeries, LineSeries, HistogramSeries, createSeriesMarkers } = mod;

      // Cleanup
      chartsRef.current.forEach(c => { try { c.remove(); } catch {} });
      chartsRef.current = [];

      const visible = isReplaying ? displayCandles.slice(0, replayIndex + 1) : displayCandles;
      // 台灣時間 ISO string → Unix timestamp（lightweight-charts 用 UTC 渲染，所以直接用台灣時間當 UTC 傳入）
      const toTS = (t: string) => {
        // 把台灣時間當 UTC 解析，這樣圖表顯示的時間就是台灣時間
        const utcStr = t.endsWith('Z') ? t : t.split('+')[0] + 'Z';
        return Math.floor(new Date(utcStr).getTime() / 1000) as unknown as import('lightweight-charts').Time;
      };

      const chartOpts = (el: HTMLElement, h: number) => createChart(el, {
        width: el.clientWidth, height: h,
        layout: { background: { color: '#0f172a' }, textColor: '#64748b', fontSize: 10 },
        grid: { vertLines: { color: '#1e293b' }, horzLines: { color: '#1e293b' } },
        crosshair: { mode: 0 },
        timeScale: { timeVisible: true, secondsVisible: false },
        rightPriceScale: { borderColor: '#1e293b' },
      });

      // ── Main chart ──
      const mainChart = chartOpts(mainRef.current!, mainRef.current!.clientHeight);
      chartsRef.current.push(mainChart);

      const candleSeries = mainChart.addSeries(CandlestickSeries, {
        upColor: '#ef4444', downColor: '#22c55e',
        borderUpColor: '#ef4444', borderDownColor: '#22c55e',
        wickUpColor: '#ef4444', wickDownColor: '#22c55e',
      });
      candleSeries.setData(visible.map(c => ({ time: toTS(c.time), open: c.open, high: c.high, low: c.low, close: c.close })));

      // Signal markers on chart using plugin
      const filteredSigs = currentSignals.filter(s => s.score >= signalThreshold && (s.type === 'BUY' || s.type === 'SELL' || s.type === 'ADD' || s.type === 'REDUCE'));
      const markers = filteredSigs
        .map(sig => {
          const idx = visible.findIndex(c => c.time === sig.triggeredAt);
          if (idx < 0) return null;
          const isBuy = sig.type === 'BUY' || sig.type === 'ADD';
          return {
            time: toTS(sig.triggeredAt),
            position: isBuy ? 'belowBar' as const : 'aboveBar' as const,
            color: isBuy ? '#ef4444' : '#22c55e',
            shape: isBuy ? 'arrowUp' as const : 'arrowDown' as const,
            text: `${sig.label}(${sig.score})`,
          };
        })
        .filter(Boolean)
        .sort((a, b) => (a!.time as number) - (b!.time as number));

      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        createSeriesMarkers(candleSeries as any, markers as any);
      } catch {
        // markers plugin may not be available
      }

      // Volume
      const volSeries = mainChart.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' } });
      volSeries.setData(visible.map(c => ({ time: toTS(c.time), value: c.volume, color: c.close >= c.open ? 'rgba(239,68,68,0.4)' : 'rgba(34,197,94,0.4)' })));
      mainChart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.75, bottom: 0 } });

      // MA lines
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const addLine = (data: Array<{ time: any; value: number }>, color: string) => {
        if (data.length < 2) return;
        const s = mainChart.addSeries(LineSeries, { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
        s.setData(data);
      };
      addLine(visible.filter(c => c.ma5 != null).map(c => ({ time: toTS(c.time), value: c.ma5! })), '#f59e0b');
      addLine(visible.filter(c => c.ma10 != null).map(c => ({ time: toTS(c.time), value: c.ma10! })), '#a855f7');
      addLine(visible.filter(c => c.ma20 != null).map(c => ({ time: toTS(c.time), value: c.ma20! })), '#06b6d4');

      // VWAP
      addLine(visible.filter(c => c.vwap != null).map(c => ({ time: toTS(c.time), value: c.vwap! })), '#818cf8');

      mainChart.timeScale().fitContent();

      // ── KD chart ──
      if (kdRef.current) {
        const kdChart = chartOpts(kdRef.current, kdRef.current.clientHeight);
        chartsRef.current.push(kdChart);

        const kdK = visible.filter(c => c.kdK != null).map(c => ({ time: toTS(c.time), value: c.kdK! }));
        const kdD = visible.filter(c => c.kdD != null).map(c => ({ time: toTS(c.time), value: c.kdD! }));
        if (kdK.length > 1) {
          const kSeries = kdChart.addSeries(LineSeries, { color: '#f59e0b', lineWidth: 1, priceLineVisible: false, lastValueVisible: true });
          kSeries.setData(kdK);
        }
        if (kdD.length > 1) {
          const dSeries = kdChart.addSeries(LineSeries, { color: '#06b6d4', lineWidth: 1, priceLineVisible: false, lastValueVisible: true });
          dSeries.setData(kdD);
        }
        kdChart.timeScale().fitContent();
      }

      // ── MACD chart ──
      if (macdRef.current) {
        const macdChart = chartOpts(macdRef.current, macdRef.current.clientHeight);
        chartsRef.current.push(macdChart);

        const oscData = visible.filter(c => c.macdOSC != null).map(c => ({
          time: toTS(c.time), value: c.macdOSC!,
          color: c.macdOSC! >= 0 ? 'rgba(239,68,68,0.6)' : 'rgba(34,197,94,0.6)',
        }));
        const difData = visible.filter(c => c.macdDIF != null).map(c => ({ time: toTS(c.time), value: c.macdDIF! }));
        const sigData = visible.filter(c => c.macdSignal != null).map(c => ({ time: toTS(c.time), value: c.macdSignal! }));

        if (oscData.length > 1) {
          const oscSeries = macdChart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false });
          oscSeries.setData(oscData);
        }
        if (difData.length > 1) {
          const difSeries = macdChart.addSeries(LineSeries, { color: '#f59e0b', lineWidth: 1, priceLineVisible: false, lastValueVisible: true });
          difSeries.setData(difData);
        }
        if (sigData.length > 1) {
          const sigSeries = macdChart.addSeries(LineSeries, { color: '#06b6d4', lineWidth: 1, priceLineVisible: false, lastValueVisible: true });
          sigSeries.setData(sigData);
        }
        macdChart.timeScale().fitContent();
      }

      // Crosshair hover → update hoverCandle
      mainChart.subscribeCrosshairMove((param) => {
        if (!param || !param.time) {
          useDaytradeStore.getState().setHoverCandle(null);
          return;
        }
        const ts = param.time as number;
        const found = visible.find(c => toTS(c.time) === ts);
        if (found) {
          useDaytradeStore.getState().setHoverCandle(found);
        }
      });

      // Resize
      const ro = new ResizeObserver(() => {
        chartsRef.current.forEach((ch, i) => {
          const el = [mainRef.current, kdRef.current, macdRef.current][i];
          if (el) ch.applyOptions({ width: el.clientWidth });
        });
      });
      if (mainRef.current) ro.observe(mainRef.current);
    });

    return () => { cancelled = true; };
  }, [displayCandles, replayIndex, isReplaying]);

  return (
    <div className="flex flex-col h-full">
      <div ref={mainRef} className="flex-[5] min-h-0" />
      <div className="border-t border-slate-800 text-[10px] text-slate-500 px-2 py-0.5 flex items-center gap-3">
        <span>KD</span>
        <span className="text-amber-400">K9</span> <span className="text-cyan-400">D9</span>
      </div>
      <div ref={kdRef} className="flex-[1.5] min-h-0 border-t border-slate-800" />
      <div className="border-t border-slate-800 text-[10px] text-slate-500 px-2 py-0.5 flex items-center gap-3">
        <span>MACD</span>
        <span className="text-amber-400">DIF</span> <span className="text-cyan-400">Signal</span> <span>OSC</span>
      </div>
      <div ref={macdRef} className="flex-[1.5] min-h-0 border-t border-slate-800" />
    </div>
  );
}
