'use client';

import type { ScanInterval } from '@/lib/datasource/findAnchorIndex';

const MINUTE_INTERVALS: { label: string; value: ScanInterval }[] = [
  { label: '1分', value: '1m' },
  { label: '5分', value: '5m' },
  { label: '15分', value: '15m' },
  { label: '60分', value: '60m' },
];

const DAILY_INTERVALS: { label: string; value: ScanInterval }[] = [
  { label: '日K', value: '1d' },
  { label: '週K', value: '1wk' },
  { label: '月K', value: '1mo' },
];

interface IntervalSwitcherProps {
  value: ScanInterval;
  onChange: (interval: ScanInterval) => void;
  signalDateLabel?: string | null;
}

export function IntervalSwitcher({ value, onChange, signalDateLabel }: IntervalSwitcherProps) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <div className="flex gap-0.5">
        {MINUTE_INTERVALS.map(opt => (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            className={`px-2 py-0.5 rounded text-[10px] font-bold transition ${
              value === opt.value
                ? 'bg-blue-600 text-foreground'
                : 'bg-secondary hover:bg-secondary/80 text-foreground/60'
            }`}
          >
            {opt.label}
          </button>
        ))}
        <span className="w-px h-3.5 bg-border/60 mx-0.5 self-center" />
        {DAILY_INTERVALS.map(opt => (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            className={`px-2 py-0.5 rounded text-[10px] font-bold transition ${
              value === opt.value
                ? 'bg-blue-600 text-foreground'
                : 'bg-secondary hover:bg-secondary/80 text-foreground/60'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
      {signalDateLabel && (
        <span className="text-[10px] text-muted-foreground/80 font-mono">
          {signalDateLabel}
        </span>
      )}
    </div>
  );
}
