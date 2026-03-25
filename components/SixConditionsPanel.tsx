'use client';

import { useState } from 'react';
import { useReplayStore } from '@/store/replayStore';
import { SixConditionsResult } from '@/lib/analysis/trendAnalysis';

const CONDITION_LABELS = [
  { key: 'trend',     icon: '①', name: '趨勢' },
  { key: 'position',  icon: '②', name: '位置' },
  { key: 'kbar',      icon: '③', name: 'K棒' },
  { key: 'ma',        icon: '④', name: '均線' },
  { key: 'volume',    icon: '⑤', name: '成交量' },
  { key: 'indicator', icon: '⑥', name: '指標' },
] as const;

type ConditionKey = typeof CONDITION_LABELS[number]['key'];

function ScoreDots({ score, total = 6 }: { score: number; total?: number }) {
  return (
    <span className="flex gap-0.5 items-center">
      {Array.from({ length: total }).map((_, i) => (
        <span
          key={i}
          className={`inline-block w-2 h-2 rounded-full ${
            i < score ? 'bg-green-400' : 'bg-gray-600'
          }`}
        />
      ))}
    </span>
  );
}

function ConditionRow({
  label,
  pass,
  detail,
  expanded,
  onToggle,
}: {
  label: { icon: string; name: string };
  pass: boolean;
  detail: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const dot = pass
    ? <span className="text-green-400 text-sm">●</span>
    : <span className="text-red-400 text-sm">●</span>;

  return (
    <div className="border-b border-gray-700 last:border-0">
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-700/40 transition-colors"
        onClick={onToggle}
      >
        {dot}
        <span className="text-gray-400 text-xs w-4">{label.icon}</span>
        <span className="text-xs font-medium text-gray-200 w-10">{label.name}</span>
        <span className="text-xs text-gray-400 flex-1 truncate">{detail}</span>
        <span className="text-gray-600 text-xs">{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && (
        <div className="px-4 pb-2 text-xs text-gray-400 leading-relaxed bg-gray-800/40">
          {detail}
        </div>
      )}
    </div>
  );
}

export default function SixConditionsPanel() {
  const sixConditions = useReplayStore(s => s.sixConditions);
  const [expanded, setExpanded] = useState<ConditionKey | null>(null);

  if (!sixConditions) {
    return (
      <div className="bg-gray-800 rounded-lg p-3 text-xs text-gray-500">
        載入資料後顯示六大條件…
      </div>
    );
  }

  const sc = sixConditions as SixConditionsResult;
  const score = sc.totalScore;

  const scoreColor =
    score >= 5 ? 'text-green-400' :
    score >= 3 ? 'text-yellow-400' :
    'text-red-400';

  const toggle = (key: ConditionKey) =>
    setExpanded(prev => prev === key ? null : key);

  const rows: Array<{ key: ConditionKey; pass: boolean; detail: string }> = [
    { key: 'trend',     pass: sc.trend.pass,     detail: sc.trend.detail },
    { key: 'position',  pass: sc.position.pass,  detail: sc.position.detail },
    { key: 'kbar',      pass: sc.kbar.pass,      detail: sc.kbar.detail },
    { key: 'ma',        pass: sc.ma.pass,         detail: sc.ma.detail },
    { key: 'volume',    pass: sc.volume.pass,     detail: sc.volume.detail },
    { key: 'indicator', pass: sc.indicator.pass,  detail: sc.indicator.detail },
  ];

  return (
    <div className="bg-gray-800 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-gray-750 border-b border-gray-700">
        <span className="text-xs font-semibold text-gray-200">六大進場條件 (朱老師SOP)</span>
        <div className="flex items-center gap-2">
          <ScoreDots score={score} />
          <span className={`text-xs font-bold ${scoreColor}`}>{score}/6</span>
        </div>
      </div>

      {/* Rows */}
      <div>
        {rows.map((row, i) => {
          const label = CONDITION_LABELS[i];
          return (
            <ConditionRow
              key={row.key}
              label={label}
              pass={row.pass}
              detail={row.detail}
              expanded={expanded === row.key}
              onToggle={() => toggle(row.key)}
            />
          );
        })}
      </div>

      {/* Summary */}
      <div className="px-3 py-2 border-t border-gray-700 bg-gray-800/60">
        <p className="text-xs text-gray-500">
          {score >= 5
            ? '條件充分，可考慮進場（仍需確認K線實際走勢）'
            : score >= 3
            ? '條件部分符合，觀察後續發展'
            : '條件不足，建議觀望'}
        </p>
      </div>
    </div>
  );
}
