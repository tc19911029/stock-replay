'use client';

import type { MarketTab } from '@/lib/market/classify';

interface MarketTabsProps {
  value: MarketTab;
  onChange: (tab: MarketTab) => void;
  counts?: { all: number; TW: number; CN: number };
}

const TABS: { id: MarketTab; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'TW', label: '台股' },
  { id: 'CN', label: '陸股' },
];

export default function MarketTabs({ value, onChange, counts }: MarketTabsProps) {
  return (
    <div className="flex gap-1">
      {TABS.map(t => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
            value === t.id
              ? 'bg-sky-600 text-foreground'
              : 'bg-secondary text-muted-foreground hover:bg-muted'
          }`}
        >
          {t.label}
          {counts && (
            <span className="ml-1 text-[10px] opacity-70">{counts[t.id]}</span>
          )}
        </button>
      ))}
    </div>
  );
}
