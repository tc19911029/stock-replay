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

import { getBullBearColors } from '@/lib/chart/colors';
import { findPivots } from '@/lib/analysis/trendAnalysis';

const MA_COLORS = {
  ma5:   '#facc15', // 黃
  ma10:  '#3b82f6', // 藍
  ma20:  '#a855f7', // 紫
  ma60:  '#e2e8f0', // 白
  ma240: '#f97316', // 橘
};

/** Convert date string to lightweight-charts Time.
 *  Daily: 'YYYY-MM-DD' → string Time (business day)
 *  Intraday: 'YYYY-MM-DD HH:mm' → UTCTimestamp (seconds)
 *  注意：用 'Z' 假裝 CST 時間是 UTC，讓 TradingView X軸直接顯示正確的亞洲時間 */
function toTime(date: string): Time {
  if (date.includes(' ')) {
    const d = new Date(date.replace(' ', 'T') + ':00Z');
    return Math.floor(d.getTime() / 1000) as unknown as Time;
  }
  // 清除 TWSE 除權息日標記（如 "2025-11-17*" → "2025-11-17"）
  return date.replace(/\*$/, '') as Time;
}

// ── Chart sync — imported from store, re-exported for backwards compatibility ─
import {
  broadcastRange,
  broadcastCrosshairTime,
  subscribeRangeSync,
  subscribeCrosshairSync,
  getLastRange,
} from '@/store/chartSyncStore';
import type { LogicalRange, RangeSyncCallback } from '@/store/chartSyncStore';

export {
  broadcastRange,
  broadcastCrosshairTime,
  subscribeRangeSync,
  subscribeCrosshairSync,
  getLastRange,
};
export type { LogicalRange, RangeSyncCallback };

// ── Signal marker config ───────────────────────────────────────────────────────
function getMarkerConfig(): Record<ChartSignalMarker['type'], {
  position: 'aboveBar' | 'belowBar';
  shape: 'arrowUp' | 'arrowDown';
  color: string;
}> {
  const { bull, bear } = getBullBearColors();
  return {
    BUY:    { position: 'belowBar', shape: 'arrowUp',   color: bull },
    ADD:    { position: 'belowBar', shape: 'arrowUp',   color: '#f97316' },
    REDUCE: { position: 'aboveBar', shape: 'arrowDown', color: '#14b8a6' },
    SELL:   { position: 'aboveBar', shape: 'arrowDown', color: bear },
    WATCH:  { position: 'aboveBar', shape: 'arrowDown', color: '#eab308' },
  };
}

interface CandleChartProps {
  candles: CandleWithIndicators[];
  signals: RuleSignal[];
  chartMarkers?: ChartSignalMarker[];
  avgCost?: number;
  stopLossPrice?: number;
  onCrosshairMove?: (candle: CandleWithIndicators | null) => void;
  onDoubleClick?: (candle: CandleWithIndicators) => void;
  height?: number;
  fillContainer?: boolean;
  maToggles?: { ma5: boolean; ma10: boolean; ma20: boolean; ma60: boolean; ma240: boolean };
  showBollinger?: boolean;
  /** 顯示書本 p.37/p.38 切線（下降切線+上升切線），預設開 */
  showTrendlines?: boolean;
  /** 顯示上升切線（底底高），獨立 toggle；若 undefined 則跟 showTrendlines */
  showAscendingTrendline?: boolean;
  /** 顯示下降切線（頭頭低），獨立 toggle；若 undefined 則跟 showTrendlines */
  showDescendingTrendline?: boolean;
  /** 顯示 MA5 分段頭底標記（寶典 p.21-22），預設關 */
  showPivots?: boolean;
  /** 顯示前高壓/前低撐/大量撐壓線，預設關 */
  showSupportResistance?: boolean;
  /** 高亮指定日期的 K 棒（黃色菱形標記） */
  highlightDate?: string;
  /** 將指定日期的 K 棒捲動至畫面中央 */
  centerOnDate?: string;
}

export default function CandleChart({
  candles, signals, chartMarkers = [], avgCost, stopLossPrice, onCrosshairMove, onDoubleClick, height = 400, fillContainer = false,
  maToggles = { ma5: true, ma10: true, ma20: true, ma60: true, ma240: false },
  showBollinger = false,
  showTrendlines = true,
  showAscendingTrendline,
  showDescendingTrendline,
  showPivots = false,
  showSupportResistance = false,
  highlightDate,
  centerOnDate,
}: CandleChartProps) {
  const containerRef   = useRef<HTMLDivElement>(null);
  const chartRef       = useRef<IChartApi | null>(null);
  const candleRef      = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const maRefs         = useRef<Record<string, ISeriesApi<'Line'>>>({});
  const bbRefs         = useRef<{ upper?: ISeriesApi<'Line'>; lower?: ISeriesApi<'Line'> }>({});
  const trendlineRefs  = useRef<{ descending?: ISeriesApi<'Line'>; ascending?: ISeriesApi<'Line'> }>({});
  const markersPlugRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const avgCostLineRef   = useRef<ReturnType<ISeriesApi<'Candlestick'>['createPriceLine']> | null>(null);
  const stopLossLineRef  = useRef<ReturnType<ISeriesApi<'Candlestick'>['createPriceLine']> | null>(null);
  const srLineRefs       = useRef<ReturnType<ISeriesApi<'Candlestick'>['createPriceLine']>[]>([]);
  // Keep latest candles accessible inside event closures without re-subscribing
  const candlesRef     = useRef<CandleWithIndicators[]>(candles);
  const timeMapRef     = useRef<Map<string | number, CandleWithIndicators>>(new Map());
  const onCrosshairRef = useRef(onCrosshairMove);
  const onDoubleClickRef = useRef(onDoubleClick);
  const [hoverCandle, setHoverCandle] = useState<CandleWithIndicators | null>(null);
  const [trendlineStatus, setTrendlineStatus] = useState<{
    ascending: { anchorIndex: number; anchorPrice: number; slope: number } | null;
    descending: { anchorIndex: number; anchorPrice: number; slope: number } | null;
  }>({ ascending: null, descending: null });

  useEffect(() => {
    candlesRef.current = candles;
    const map = new Map<string | number, CandleWithIndicators>();
    for (const c of candles) map.set(toTime(c.date) as string | number, c);
    timeMapRef.current = map;
  }, [candles]);
  useEffect(() => { onCrosshairRef.current = onCrosshairMove; }, [onCrosshairMove]);
  useEffect(() => { onDoubleClickRef.current = onDoubleClick; }, [onDoubleClick]);

  useEffect(() => {
    if (!containerRef.current) return;

    const chartHeight = (fillContainer
      ? containerRef.current.clientHeight
      : height) || 400;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#0f172a' },
        textColor: '#94a3b8',
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: '#1e293b' },
        horzLines: { color: '#1e293b' },
      },
      crosshair: { mode: 1, vertLine: { labelVisible: false } },
      rightPriceScale: { borderColor: '#334155', minimumWidth: 80 },
      timeScale: { borderColor: '#334155', timeVisible: true, rightOffset: 15 },
      width: containerRef.current.clientWidth,
      height: chartHeight,
    });

    const { bull, bear } = getBullBearColors();
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: bull, downColor: bear,
      borderUpColor: bull, borderDownColor: bear,
      wickUpColor: bull, wickDownColor: bear,
    });

    const maKeys = ['ma5', 'ma10', 'ma20', 'ma60', 'ma240'] as const;
    const newMARef: Record<string, ISeriesApi<'Line'>> = {};
    for (const key of maKeys) {
      newMARef[key] = chart.addSeries(LineSeries, {
        color: MA_COLORS[key], lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
      });
    }

    // ── Bollinger Bands ──
    bbRefs.current.upper = chart.addSeries(LineSeries, {
      color: 'rgba(34, 197, 94, 0.5)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, lineStyle: 2,
    });
    bbRefs.current.lower = chart.addSeries(LineSeries, {
      color: 'rgba(34, 197, 94, 0.5)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, lineStyle: 2,
    });

    // ── 切線（書本 p.37/p.38 警示用，不做進出場） ──
    // 單一實線從 fromIndex 延伸到今日+未來 15 個營業日
    trendlineRefs.current.descending = chart.addSeries(LineSeries, {
      color: '#10b981',  // 綠：下降切線（連頭頭低）
      lineWidth: 1, priceLineVisible: false, lastValueVisible: false, lineStyle: 0,
    });
    trendlineRefs.current.ascending = chart.addSeries(LineSeries, {
      color: '#ef4444',   // 紅：上升切線（連底底高）
      lineWidth: 1, priceLineVisible: false, lastValueVisible: false, lineStyle: 0,
    });

    chartRef.current  = chart;
    candleRef.current = candleSeries;
    maRefs.current    = newMARef;
    markersPlugRef.current = createSeriesMarkers(candleSeries, []);

    // ── 主圖廣播 logical range 給指標圖（bar-index 同步，對齊更精確） ──
    chart.timeScale().subscribeVisibleLogicalRangeChange(range => {
      broadcastRange(range as { from: number; to: number } | null);
    });

    // ── Crosshair → OHLCV display + broadcast to sub-charts ─────────────
    chart.subscribeCrosshairMove(param => {
      if (!param.time) {
        setHoverCandle(null);
        onCrosshairRef.current?.(null);
        broadcastCrosshairTime(null);
        return;
      }
      const found = timeMapRef.current.get(param.time as string | number) ?? null;
      broadcastCrosshairTime(found?.date ?? null);
      setHoverCandle(found);
      onCrosshairRef.current?.(found);
    });

    // ── Double-click → jump to candle ─────────────────────────────────
    let _lastHoverCandle: CandleWithIndicators | null = null;
    // Track hover candle for dblclick (crosshair already subscribed above,
    // so we piggyback via a second subscription using a local var)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dblClickCrosshairHandler = (param: any) => {
      if (param.time) {
        _lastHoverCandle = candlesRef.current.find(c => c.date === (param.time as string)) ?? null;
      } else {
        _lastHoverCandle = null;
      }
    };
    chart.subscribeCrosshairMove(dblClickCrosshairHandler);
    const handleDblClick = () => {
      if (onDoubleClickRef.current && _lastHoverCandle) {
        onDoubleClickRef.current(_lastHoverCandle);
      }
    };
    containerRef.current.addEventListener('dblclick', handleDblClick);

    const ro = new ResizeObserver(() => {
      if (!containerRef.current) return;
      chart.applyOptions({ width: containerRef.current.clientWidth });
      if (fillContainer) chart.applyOptions({ height: containerRef.current.clientHeight });
    });
    ro.observe(containerRef.current);

    return () => {
      containerRef.current?.removeEventListener('dblclick', handleDblClick);
      chart.unsubscribeCrosshairMove(dblClickCrosshairHandler);
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load candle / MA data ────────────────────────────────────────────────
  useEffect(() => {
    if (!candleRef.current || candles.length === 0) return;

    candleRef.current.setData(candles.map(c => ({
      time: toTime(c.date), open: c.open, high: c.high, low: c.low, close: c.close,
    })));
    /** 過濾 null/undefined/NaN（分鐘K MA 數據不足時會產生 NaN） */
    const validNum = (v: number | undefined | null): v is number =>
      v != null && Number.isFinite(v);
    const maKeys = ['ma5', 'ma10', 'ma20', 'ma60', 'ma240'] as const;
    for (const key of maKeys) {
      maRefs.current[key]?.setData(
        candles.filter(c => validNum(c[key])).map(c => ({ time: toTime(c.date), value: c[key]! }))
      );
    }
    // Bollinger Bands
    bbRefs.current.upper?.setData(
      candles.filter(c => validNum(c.bbUpper)).map(c => ({ time: toTime(c.date), value: c.bbUpper! }))
    );
    bbRefs.current.lower?.setData(
      candles.filter(c => validNum(c.bbLower)).map(c => ({ time: toTime(c.date), value: c.bbLower! }))
    );

    // ── 切線（書本 p.37/p.38）──
    // 實線從 fromIndex 延伸：往前 20 + 往後 20 交易日
    // 上升/下降線可獨立 toggle；fallback 用 showTrendlines 總開關相容舊用法
    const showAsc = showAscendingTrendline ?? showTrendlines;
    const showDesc = showDescendingTrendline ?? showTrendlines;
    let descInfo: { anchorIndex: number; anchorPrice: number; slope: number } | null = null;
    let ascInfo: { anchorIndex: number; anchorPrice: number; slope: number } | null = null;
    if ((showAsc || showDesc) && candles.length >= 3) {
      const lastIdx = candles.length - 1;
      // UI 規則（非書本嚴格規則）：最近兩個頭連成下降線、最近兩個底連成上升線，不管高低大小
      // 切線只用已確認 pivot，進行中段的 provisional 不拿來畫線
      // 書本嚴格規則（頭頭低/底底高）仍用於 detectTrendlineBreakout 的警示訊號
      const pivots = findPivots(candles, lastIdx, 8);
      const recentHighs = pivots.filter(p => p.type === 'high').slice(0, 2);
      const recentLows = pivots.filter(p => p.type === 'low').slice(0, 2);
      // 線的延伸：第二近 pivot 往前 20 天 + 最近 pivot 往後 20 天
      const EDGE_PAD = 20;
      const lastDate = candles[lastIdx]?.date ?? '';
      const buildFutureDates = (count: number): string[] => {
        const fd: string[] = [];
        if (!lastDate || lastDate.includes(' ')) return fd;
        const d = new Date(lastDate + 'T00:00:00Z');
        let added = 0;
        while (added < count) {
          d.setUTCDate(d.getUTCDate() + 1);
          const dow = d.getUTCDay();
          if (dow === 0 || dow === 6) continue;
          fd.push(d.toISOString().slice(0, 10));
          added++;
        }
        return fd;
      };
      /** 從 startIdx 到 endIdx 畫線（以 anchorIndex/anchorPrice + slope 決定每點值） */
      const buildLine = (startIdx: number, endIdx: number, anchorIndex: number, anchorPrice: number, slope: number) => {
        const pts: { time: ReturnType<typeof toTime>; value: number }[] = [];
        const safeStart = Math.max(0, startIdx);
        // 在已存在的 K 棒範圍內畫
        for (let i = safeStart; i <= Math.min(endIdx, lastIdx); i++) {
          if (i < 0 || i >= candles.length) continue;
          pts.push({ time: toTime(candles[i].date), value: anchorPrice + slope * (i - anchorIndex) });
        }
        // 若 endIdx 超過今天，延伸到未來
        if (endIdx > lastIdx) {
          const futureCount = endIdx - lastIdx;
          const futureDates = buildFutureDates(futureCount);
          futureDates.forEach((fd, k) => {
            const futureIdx = lastIdx + 1 + k;
            pts.push({ time: toTime(fd), value: anchorPrice + slope * (futureIdx - anchorIndex) });
          });
        }
        return pts;
      };

      // 下降線：連最近兩個頭（findPivots 回傳 newest-first，highs[1]=older, highs[0]=newer）
      // 範圍：older - 10 天 ~ newer + 10 天
      if (showDesc && recentHighs.length === 2) {
        const older = recentHighs[1];
        const newer = recentHighs[0];
        const slope = (newer.price - older.price) / (newer.index - older.index);
        trendlineRefs.current.descending?.setData(
          buildLine(older.index - EDGE_PAD, newer.index + EDGE_PAD, older.index, older.price, slope)
        );
        descInfo = { anchorIndex: older.index, anchorPrice: older.price, slope };
      } else {
        trendlineRefs.current.descending?.setData([]);
      }
      // 上升線：連最近兩個底；範圍：older - 10 天 ~ newer + 10 天
      if (showAsc && recentLows.length === 2) {
        const older = recentLows[1];
        const newer = recentLows[0];
        const slope = (newer.price - older.price) / (newer.index - older.index);
        trendlineRefs.current.ascending?.setData(
          buildLine(older.index - EDGE_PAD, newer.index + EDGE_PAD, older.index, older.price, slope)
        );
        ascInfo = { anchorIndex: older.index, anchorPrice: older.price, slope };
      } else {
        trendlineRefs.current.ascending?.setData([]);
      }
    } else {
      trendlineRefs.current.descending?.setData([]);
      trendlineRefs.current.ascending?.setData([]);
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 切線狀態同步給 legend
    setTrendlineStatus({ ascending: ascInfo, descending: descInfo });
    // scrollToPosition 後稍等一個 tick 再廣播，確保 range 已更新
    const chart = chartRef.current;
    if (chart) {
      const totalBars = candles.length;
      const visibleBars = 80;

      if (centerOnDate) {
        // 以指定日期為中心，前後各顯示 40 根
        let centerIdx = candles.findIndex(c => c.date === centerOnDate);
        if (centerIdx === -1) {
          // fallback: 找最近前一根
          for (let i = candles.length - 1; i >= 0; i--) {
            if (candles[i].date <= centerOnDate) { centerIdx = i; break; }
          }
        }
        if (centerIdx === -1) centerIdx = totalBars - 1;
        const half = Math.floor(visibleBars / 2);
        chart.timeScale().setVisibleLogicalRange({
          from: centerIdx - half,
          to:   centerIdx + half,
        });
      } else {
        // 預設顯示最近 80 根K棒（仿 WantGoo 6個月日線），讓K棒大小清晰
        chart.timeScale().setVisibleLogicalRange({
          from: totalBars - visibleBars - 1,
          to:   totalBars + 3,
        });
      }
      requestAnimationFrame(() => {
        const range = chart.timeScale().getVisibleLogicalRange();
        if (range) broadcastRange(range as { from: number; to: number });
      });
    }
  }, [candles, centerOnDate, showTrendlines, showAscendingTrendline, showDescendingTrendline]);

  // ── MA visibility toggle ─────────────────────────────────────────────────
  useEffect(() => {
    const maKeys = ['ma5', 'ma10', 'ma20', 'ma60', 'ma240'] as const;
    for (const key of maKeys) {
      const series = maRefs.current[key];
      if (series) {
        series.applyOptions({ visible: maToggles[key] });
      }
    }
  }, [maToggles]);

  // ── Bollinger Bands visibility ──
  useEffect(() => {
    bbRefs.current.upper?.applyOptions({ visible: showBollinger });
    bbRefs.current.lower?.applyOptions({ visible: showBollinger });
  }, [showBollinger]);

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
        price: stopLossPrice, color: '#f87171', lineWidth: 1,
        lineStyle: 1, axisLabelVisible: true, title: '停損',
      });
    }
  }, [stopLossPrice]);

  // ── Chart markers ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!markersPlugRef.current) return;
    const markerCfg = getMarkerConfig();
    const converted: SeriesMarker<Time>[] = chartMarkers.map(m => {
      const cfg = markerCfg[m.type];
      return { time: toTime(m.date), position: cfg.position, shape: cfg.shape, color: cfg.color, text: m.label, size: 1 };
    });
    // 加入訊號日高亮標記
    if (highlightDate && candles.some(c => c.date === highlightDate)) {
      converted.push({
        time: toTime(highlightDate),
        position: 'belowBar',
        shape: 'circle',
        color: '#facc15',
        text: '訊號日',
        size: 2,
      });
    }
    // 加入頭底標記（寶典 p.21-22 MA5 分段轉折波，書本規則無振幅門檻）
    // 只顯示已確認 pivot（不含 provisional），進行中段不算頭/底
    if (showPivots && candles.length >= 20) {
      const pivots = findPivots(candles, candles.length - 1, 30);
      for (const p of pivots) {
        const c = candles[p.index];
        if (!c) continue;
        converted.push({
          time: toTime(c.date),
          position: p.type === 'high' ? 'aboveBar' : 'belowBar',
          shape: p.type === 'high' ? 'arrowDown' : 'arrowUp',
          color: p.type === 'high' ? '#ec4899' : '#06b6d4',
          text: p.type === 'high' ? '頭' : '底',
          size: 1,
        });
      }
    }
    // lightweight-charts 要求 markers 按時間升序
    converted.sort((a, b) => {
      const ta = String(a.time);
      const tb = String(b.time);
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
    markersPlugRef.current.setMarkers(converted);
  }, [chartMarkers, highlightDate, candles, showPivots]);

  // ── Support/resistance price lines (前高壓 / 前低撐 / 大量撐壓) ──────────
  useEffect(() => {
    if (!candleRef.current) return;
    // 清除舊線
    for (const line of srLineRefs.current) {
      try { candleRef.current.removePriceLine(line); } catch { /* noop */ }
    }
    srLineRefs.current = [];

    if (!showSupportResistance || candles.length < 20) return;

    const lastIdx = candles.length - 1;
    const currClose = candles[lastIdx].close;

    // 1. 前高壓 / 前低撐 — 取最近 pivots 中的極值
    const pivots = findPivots(candles, lastIdx, 12);
    const highs = pivots.filter(p => p.type === 'high').map(p => p.price);
    const lows  = pivots.filter(p => p.type === 'low').map(p => p.price);
    if (highs.length) {
      const prevHigh = Math.max(...highs);
      srLineRefs.current.push(candleRef.current.createPriceLine({
        price: prevHigh, color: '#ec4899', lineWidth: 1, lineStyle: 2,
        axisLabelVisible: true, title: '前高壓',
      }));
    }
    if (lows.length) {
      const prevLow = Math.min(...lows);
      srLineRefs.current.push(candleRef.current.createPriceLine({
        price: prevLow, color: '#10b981', lineWidth: 1, lineStyle: 2,
        axisLabelVisible: true, title: '前低撐',
      }));
    }

    // 2. 大量撐/壓 — 最近 60 根 K 棒中最大量的收盤價
    const lookback = 60;
    const start = Math.max(0, lastIdx - lookback + 1);
    let maxVol = -Infinity;
    let maxVolIdx = -1;
    for (let i = start; i <= lastIdx; i++) {
      if (candles[i].volume > maxVol) {
        maxVol = candles[i].volume;
        maxVolIdx = i;
      }
    }
    if (maxVolIdx >= 0) {
      const bigVolPrice = candles[maxVolIdx].close;
      const isSupport = bigVolPrice <= currClose;
      srLineRefs.current.push(candleRef.current.createPriceLine({
        price: bigVolPrice,
        color: isSupport ? '#10b981' : '#ec4899',
        lineWidth: 1, lineStyle: 2, axisLabelVisible: true,
        title: isSupport ? '大量撐' : '大量壓',
      }));
    }
  }, [showSupportResistance, candles]);

  // MA legend: show hovered candle's values if hovering, else last candle
  const last = candles[candles.length - 1];
  const displayForLegend = hoverCandle ?? last;
  const idxForLegend = hoverCandle
    ? candles.findIndex(c => c.date === hoverCandle.date)
    : candles.length - 1;
  const prevForLegend = candles[idxForLegend - 1];

  return (
    <div className="relative w-full h-full">
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

      {/* 切線圖例 — 只在有線時顯示 */}
      {showTrendlines && (trendlineStatus.ascending || trendlineStatus.descending) && (() => {
        const refIdx = idxForLegend >= 0 ? idxForLegend : candles.length - 1;
        const ascVal = trendlineStatus.ascending
          ? trendlineStatus.ascending.anchorPrice + trendlineStatus.ascending.slope * (refIdx - trendlineStatus.ascending.anchorIndex)
          : null;
        const descVal = trendlineStatus.descending
          ? trendlineStatus.descending.anchorPrice + trendlineStatus.descending.slope * (refIdx - trendlineStatus.descending.anchorIndex)
          : null;
        return (
          <div className="absolute top-7 left-3 z-10 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] font-mono pointer-events-none">
            {ascVal != null && (
              <span className="flex items-center gap-1" style={{ color: '#ef4444' }}>
                <span className="inline-block w-4 h-[3px]" style={{ background: '#ef4444' }} />
                上升切線 {ascVal.toFixed(2)}
              </span>
            )}
            {descVal != null && (
              <span className="flex items-center gap-1" style={{ color: '#10b981' }}>
                <span className="inline-block w-4 h-[3px]" style={{ background: '#10b981' }} />
                下降切線 {descVal.toFixed(2)}
              </span>
            )}
          </div>
        );
      })()}

      {/* Signal badge — only show highest-priority non-WATCH signal */}
      {(() => {
        const PRIORITY: Record<string, number> = { SELL: 4, BUY: 3, REDUCE: 2, ADD: 1 };
        const filtered = signals.filter(s => s.type !== 'WATCH');
        if (filtered.length === 0) return null;
        const best = filtered.reduce((a, b) => (PRIORITY[b.type] ?? 0) > (PRIORITY[a.type] ?? 0) ? b : a);
        return (
          <div className="absolute top-2 right-3 z-10 pointer-events-none">
            <span className={`px-2.5 py-1 rounded text-xs font-bold shadow-lg text-white ${
              best.type === 'BUY'    ? 'bg-bull/20 text-bull border border-bull'  :
              best.type === 'ADD'    ? 'bg-orange-500'  :
              best.type === 'SELL'   ? 'bg-bear/20 text-bear border border-bear'  :
                                       'bg-teal-500'
            }`}>{best.label}</span>
          </div>
        );
      })()}

      <div ref={containerRef} className={fillContainer ? 'w-full h-full' : 'w-full'} style={fillContainer ? undefined : { height }} />
    </div>
  );
}
