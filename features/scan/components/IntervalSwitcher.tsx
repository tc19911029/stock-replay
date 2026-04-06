'use client';

import type { ScanInterval } from '@/lib/datasource/findAnchorIndex';

const INTERVALS: { label: string; value: ScanInterval }[] = [
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
        {INTERVALS.map(opt => (
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
