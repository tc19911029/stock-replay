'use client';

import { useRef, useEffect, useCallback } from 'react';
import { createChart, type IChartApi, type DeepPartial, type ChartOptions, ColorType } from 'lightweight-charts';
import { useTheme } from 'next-themes';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';

interface ChartContainerProps {
  className?: string;
  loading?: boolean;
  height?: number;
  onChartReady?: (chart: IChartApi) => void;
  children?: React.ReactNode;
}

/** Returns theme-aware chart options for lightweight-charts */
export function useChartTheme() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  return {
    isDark,
    chartOptions: {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: isDark ? '#94a3b8' : '#64748b',
        fontFamily: 'var(--font-geist-sans), system-ui, sans-serif',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)' },
        horzLines: { color: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)' },
      },
      crosshair: {
        vertLine: { color: isDark ? '#475569' : '#94a3b8', labelBackgroundColor: isDark ? '#1e293b' : '#f1f5f9' },
        horzLine: { color: isDark ? '#475569' : '#94a3b8', labelBackgroundColor: isDark ? '#1e293b' : '#f1f5f9' },
      },
      timeScale: {
        borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)',
        timeVisible: true,
        secondsVisible: false,
      },
      rightPriceScale: {
        borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)',
      },
    } as DeepPartial<ChartOptions>,
    candleColors: {
      upColor: isDark ? '#4ade80' : '#16a34a',
      downColor: isDark ? '#f87171' : '#dc2626',
      borderUpColor: isDark ? '#4ade80' : '#16a34a',
      borderDownColor: isDark ? '#f87171' : '#dc2626',
      wickUpColor: isDark ? '#4ade80' : '#16a34a',
      wickDownColor: isDark ? '#f87171' : '#dc2626',
    },
  };
}

/**
 * ChartContainer — thin wrapper for lightweight-charts that:
 * - Auto-resizes with ResizeObserver
 * - Applies theme-aware colors
 * - Shows skeleton while loading
 * - Exposes chart via onChartReady callback
 */
export function ChartContainer({
  className,
  loading = false,
  height = 400,
  onChartReady,
  children,
}: ChartContainerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const { chartOptions } = useChartTheme();

  const initChart = useCallback(() => {
    if (!containerRef.current || chartRef.current) return;
    const chart = createChart(containerRef.current, {
      ...chartOptions,
      width: containerRef.current.clientWidth,
      height,
      autoSize: true,
    });
    chartRef.current = chart;
    onChartReady?.(chart);
  }, [chartOptions, height, onChartReady]);

  useEffect(() => {
    if (loading) return;
    initChart();
    return () => {
      chartRef.current?.remove();
      chartRef.current = null;
    };
  }, [loading, initChart]);

  // Update chart options on theme change
  useEffect(() => {
    chartRef.current?.applyOptions(chartOptions);
  }, [chartOptions]);

  if (loading) {
    return <Skeleton className={cn('rounded-lg', className)} style={{ height }} />;
  }

  return (
    <div className={cn('relative rounded-lg overflow-hidden', className)}>
      <div ref={containerRef} style={{ height }} />
      {children}
    </div>
  );
}
