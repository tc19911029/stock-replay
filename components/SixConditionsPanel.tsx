'use client';

import { useState } from 'react';
import { useReplayStore } from '@/store/replayStore';
import { useSettingsStore } from '@/store/settingsStore';
import { BUILT_IN_STRATEGIES } from '@/lib/strategy/StrategyConfig';
import { SixConditionsResult } from '@/lib/analysis/trendAnalysis';
import { detectSellSignals } from '@/lib/analysis/sellSignals';

const CONDITION_LABELS = [
  { key: 'trend',     icon: '①', name: '趨勢條件', tip: '日線波浪型態符合「頭頭高、底底高」多頭架構', required: true },
  { key: 'ma',        icon: '②', name: '均線條件', tip: 'MA10、MA20 多頭排列，均線方向向上', required: true },
  { key: 'position',  icon: '③', name: '股價位置', tip: '收盤在 MA10、MA20 之上，判斷初升/主升/末升段', required: true },
  { key: 'volume',    icon: '④', name: '成交量',   tip: '攻擊量 ≥ 前一日 × 1.3（2倍更強）', required: true },
  { key: 'kbar',      icon: '⑤', name: '進場K線', tip: '價漲、量增、紅K實體棒 > 2%', required: true },
  { key: 'indicator', icon: '⑥', name: '指標參考', tip: 'MACD 綠柱縮短或紅柱延長；KD 黃金交叉向上多排', required: false },
] as const;

type ConditionKey = typeof CONDITION_LABELS[number]['key'];

function ScoreDots({ score, total = 6 }: { score: number; total?: number }) {
  return (
    <span className="flex gap-0.5 items-center">
      {Array.from({ length: total }).map((_, i) => (
        <span
          key={i}
          className={`inline-block w-2 h-2 rounded-full ${
            i < score ? 'bg-green-400' : 'bg-muted-foreground/60'
          }`}
        />
      ))}
    </span>
  );
}

/** Mini progress bar for quantitative conditions */
function MiniProgress({ value, target, pass }: { value: number; target: number; pass: boolean }) {
  const pct = Math.min(100, Math.max(0, (value / target) * 100));
  return (
    <div className="w-full bg-muted rounded-full h-1 overflow-hidden mt-1">
      <div
        className={`h-full rounded-full transition-all ${pass ? 'bg-green-500' : pct >= 70 ? 'bg-yellow-500' : 'bg-red-500/60'}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/** Metric badge showing the key numeric value */
function MetricBadge({ label, pass }: { label: string; pass: boolean }) {
  return (
    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
      pass ? 'bg-green-900/50 text-green-300' : 'bg-muted text-muted-foreground'
    }`}>
      {label}
    </span>
  );
}

function ConditionRow({
  label,
  pass,
  detail,
  metric,
  progress,
  changed,
  expanded,
  onToggle,
}: {
  label: { icon: string; name: string; tip: string; required: boolean };
  pass: boolean;
  detail: string;
  metric?: string;
  progress?: { value: number; target: number };
  changed?: 'gained' | 'lost';
  expanded: boolean;
  onToggle: () => void;
}) {
  const dot = pass
    ? <span className="text-green-400 text-sm">●</span>
    : <span className="text-red-400 text-sm">●</span>;

  return (
    <div className={`border-b border-border last:border-0 ${
      changed === 'gained' ? 'bg-green-900/20' : changed === 'lost' ? 'bg-red-900/20' : ''
    }`}>
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/40 transition-colors"
        onClick={onToggle}
      >
        {dot}
        <span className="text-muted-foreground text-xs w-4">{label.icon}</span>
        <span className={`text-xs font-medium w-14 shrink-0 ${label.required ? 'text-foreground' : 'text-muted-foreground italic'}`} title={label.tip}>
          {label.name}
        </span>
        {changed === 'gained' && <span className="text-[9px] px-1 py-0 rounded bg-green-600 text-white font-bold animate-pulse">NEW</span>}
        {changed === 'lost' && <span className="text-[9px] px-1 py-0 rounded bg-red-600 text-white font-bold">LOST</span>}
        {metric && <MetricBadge label={metric} pass={pass} />}
        <span className="flex-1" />
        <span className="text-muted-foreground/60 text-xs">{expanded ? '▲' : '▼'}</span>
      </button>
      {/* Progress bar (always visible for quantitative conditions) */}
      {progress && (
        <div className="px-3 pb-1">
          <MiniProgress value={progress.value} target={progress.target} pass={pass} />
        </div>
      )}
      {expanded && (
        <div className="px-4 pb-2 text-xs text-muted-foreground leading-relaxed bg-secondary/40 space-y-1">
          <div className="whitespace-normal break-words">{detail}</div>
          <div className="text-[10px] text-muted-foreground border-t border-border pt-1">{label.tip}</div>
        </div>
      )}
    </div>
  );
}

export default function SixConditionsPanel() {
  const sixConditions     = useReplayStore(s => s.sixConditions);
  const prevSixConditions = useReplayStore(s => s.prevSixConditions);
  const allCandles    = useReplayStore(s => s.allCandles);
  const currentIndex  = useReplayStore(s => s.currentIndex);
  const strategyName = useSettingsStore(s => {
    const all = [...BUILT_IN_STRATEGIES, ...s.customStrategies];
    return all.find(st => st.id === s.activeStrategyId)?.name ?? '朱老師六大條件';
  });
  const [expanded, setExpanded] = useState<ConditionKey | null>(null);

  const sellSignals = detectSellSignals(allCandles, currentIndex);

  if (!sixConditions) {
    return (
      <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
        <p className="text-2xl mb-2">📊</p>
        <p className="text-sm font-medium text-muted-foreground">尚未載入股票</p>
        <p className="text-xs text-muted-foreground mt-1">請先在上方選擇一檔股票，即可查看六大條件評分</p>
      </div>
    );
  }

  const sc = sixConditions as SixConditionsResult;
  const score = sc.totalScore;
  const coreScore = sc.coreScore ?? 0;
  const isCoreReady = sc.isCoreReady ?? false;

  const scoreColor =
    isCoreReady ? 'text-green-400' :
    coreScore >= 3 ? 'text-yellow-400' :
    'text-red-400';

  const toggle = (key: ConditionKey) =>
    setExpanded(prev => prev === key ? null : key);

  // Build metric badges and progress bars from numeric data
  const volRatio = sc.volume.ratio;
  const volThreshold = sc.volume.threshold ?? 1.3;
  const bodyPct = sc.kbar.bodyPct ?? 0;
  const kdK = sc.indicator.kdK;
  const macdOSC = sc.indicator.macdOSC;
  const deviation = sc.position.deviation;

  // Detect condition transitions (for "just changed" indicators)
  const prev = prevSixConditions as SixConditionsResult | null;
  const changedKeys: Set<ConditionKey> = new Set();
  if (prev) {
    const keys: Array<{ key: ConditionKey; now: boolean; was: boolean }> = [
      { key: 'trend',     now: sc.trend.pass,     was: prev.trend.pass },
      { key: 'ma',        now: sc.ma.pass,        was: prev.ma.pass },
      { key: 'position',  now: sc.position.pass,  was: prev.position.pass },
      { key: 'volume',    now: sc.volume.pass,     was: prev.volume.pass },
      { key: 'kbar',      now: sc.kbar.pass,      was: prev.kbar.pass },
      { key: 'indicator', now: sc.indicator.pass,  was: prev.indicator.pass },
    ];
    for (const { key, now, was } of keys) {
      if (now !== was) changedKeys.add(key);
    }
  }

  const rows: Array<{
    key: ConditionKey;
    pass: boolean;
    detail: string;
    metric?: string;
    progress?: { value: number; target: number };
    changed?: 'gained' | 'lost';
  }> = [
    {
      key: 'trend', pass: sc.trend.pass, detail: sc.trend.detail,
      metric: sc.trend.state,
      changed: changedKeys.has('trend') ? (sc.trend.pass ? 'gained' : 'lost') : undefined,
    },
    {
      key: 'ma', pass: sc.ma.pass, detail: sc.ma.detail,
      changed: changedKeys.has('ma') ? (sc.ma.pass ? 'gained' : 'lost') : undefined,
    },
    {
      key: 'position', pass: sc.position.pass, detail: sc.position.detail,
      metric: deviation !== null && deviation !== undefined ? `乖離${(deviation * 100).toFixed(1)}%` : undefined,
      changed: changedKeys.has('position') ? (sc.position.pass ? 'gained' : 'lost') : undefined,
    },
    {
      key: 'volume', pass: sc.volume.pass, detail: sc.volume.detail,
      metric: volRatio !== null && volRatio !== undefined ? `×${volRatio}` : undefined,
      progress: volRatio !== null && volRatio !== undefined ? { value: volRatio, target: volThreshold } : undefined,
      changed: changedKeys.has('volume') ? (sc.volume.pass ? 'gained' : 'lost') : undefined,
    },
    {
      key: 'kbar', pass: sc.kbar.pass, detail: sc.kbar.detail,
      metric: `實體${(bodyPct * 100).toFixed(1)}%`,
      progress: { value: bodyPct, target: 0.02 },
      changed: changedKeys.has('kbar') ? (sc.kbar.pass ? 'gained' : 'lost') : undefined,
    },
    {
      key: 'indicator', pass: sc.indicator.pass, detail: sc.indicator.detail,
      metric: [
        macdOSC !== null && macdOSC !== undefined ? `OSC${macdOSC > 0 ? '+' : ''}${macdOSC.toFixed(2)}` : null,
        kdK !== null && kdK !== undefined ? `K${kdK.toFixed(0)}` : null,
      ].filter(Boolean).join(' ') || undefined,
      changed: changedKeys.has('indicator') ? (sc.indicator.pass ? 'gained' : 'lost') : undefined,
    },
  ];

  return (
    <div className="bg-secondary rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-secondary border-b border-border">
        <span className="text-xs font-semibold text-foreground">六大進場條件 ({strategyName})</span>
        <div className="flex items-center gap-2">
          <ScoreDots score={coreScore} total={5} />
          {sc.indicator.pass && <span className="text-green-400 text-[10px]">+⑥</span>}
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
              metric={row.metric}
              progress={row.progress}
              changed={row.changed}
              expanded={expanded === row.key}
              onToggle={() => toggle(row.key)}
            />
          );
        })}
      </div>

      {/* Summary */}
      <div className={`px-3 py-2.5 border-t border-border ${
        isCoreReady ? 'bg-green-900/40' : coreScore >= 3 ? 'bg-yellow-900/30' : 'bg-secondary/60'
      }`}>
        <p className={`text-xs font-bold ${
          isCoreReady ? 'text-green-300' : coreScore >= 3 ? 'text-yellow-300' : 'text-muted-foreground'
        }`}>
          {isCoreReady
            ? sc.indicator.pass
              ? '✅ 六條件全過 — 可考慮進場'
              : '✅ 核心5條件充分 — 指標待確認'
            : coreScore >= 3
            ? `⏳ 核心條件 ${coreScore}/5 — 觀察後續`
            : `🚫 核心條件不足 ${coreScore}/5 — 建議觀望`}
        </p>
        {isCoreReady && !sc.indicator.pass && (
          <p className="text-[10px] text-yellow-500 mt-0.5">第⑥指標參考為輔助條件，可後面補上</p>
        )}
      </div>

      {/* Sell Signals */}
      {sellSignals.length > 0 && (
        <div className="mt-3 pt-3 border-t border-border">
          <div className="text-[10px] font-bold text-muted-foreground mb-1.5">⚠ 出場警示</div>
          <div className="space-y-1">
            {sellSignals.map(sig => (
              <div key={sig.type} className={`text-[10px] px-2 py-1 rounded flex items-start gap-1.5 ${
                sig.severity === 'high' ? 'bg-red-900/40 text-red-300' :
                sig.severity === 'medium' ? 'bg-orange-900/40 text-orange-300' :
                'bg-yellow-900/30 text-yellow-400'
              }`}>
                <span className="font-bold shrink-0">{sig.label}</span>
                <span className="text-[9px] opacity-80">{sig.detail}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
