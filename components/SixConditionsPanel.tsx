'use client';

import { useState } from 'react';
import { useReplayStore } from '@/store/replayStore';
import { SixConditionsResult } from '@/lib/analysis/trendAnalysis';
import { detectSellSignals } from '@/lib/analysis/sellSignals';
import { EmptyState } from '@/components/shared';

const HIGH_WIN_POS_NUM: Record<string, string> = {
  '🎯 打底趨勢確認': '①',
  '🎯 回後買上漲':   '②',
  '🎯 盤整突破':     '③',
  '🎯 均線糾結突破': '④',
  '🎯 強勢短回續攻': '⑤',
  '🎯 假跌破反彈':   '⑥',
};

const CONDITION_LABELS = [
  { key: 'trend',     icon: '①', name: '趨勢條件', tip: '日線波浪型態符合「頭頭高、底底高」多頭架構', required: true },
  { key: 'ma',        icon: '②', name: '均線條件', tip: 'MA5>MA10>MA20 三線多排，MA10/20 方向向上', required: true },
  { key: 'position',  icon: '③', name: '股價位置', tip: '收盤在 MA10、MA20 之上，判斷初升/主升/末升段', required: true },
  { key: 'volume',    icon: '④', name: '成交量',   tip: '攻擊量 ≥ 前一日 × 1.3（書本 p.54，2 倍更強）', required: true },
  { key: 'kbar',      icon: '⑤', name: '進場K線', tip: '價漲、量增、紅K實體棒 > 2%', required: true },
  { key: 'indicator', icon: '⑥', name: '指標參考', tip: 'MACD 綠柱縮短或紅柱延長；KD 黃金交叉向上多排', required: false },
] as const;

type ConditionKey = typeof CONDITION_LABELS[number]['key'];

function _ScoreDots({ score, total = 6 }: { score: number; total?: number }) {
  return (
    <span className="flex gap-1 items-center">
      {Array.from({ length: total }).map((_, i) => (
        <span
          key={i}
          className={`inline-block w-2.5 h-2.5 rounded-full transition-colors ${
            i < score ? 'bg-green-400 shadow-[0_0_4px_rgba(74,222,128,0.4)]' : 'bg-muted-foreground/30'
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
    <span className={`text-[10px] font-mono px-2 py-0.5 rounded-md ${
      pass ? 'bg-green-900/40 text-green-300 border border-green-800/50' : 'bg-muted text-muted-foreground border border-transparent'
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
        className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left hover:bg-muted/40 transition-colors"
        onClick={onToggle}
      >
        {dot}
        <span className="text-muted-foreground/70 text-xs w-4 font-mono">{label.icon}</span>
        <span className="text-sm font-medium w-16 shrink-0 text-foreground" title={label.tip}>
          {label.name}
        </span>
        {changed === 'gained' && <span className="text-[9px] px-1.5 py-0.5 rounded-md bg-green-600 text-white font-bold animate-pulse">NEW</span>}
        {changed === 'lost' && <span className="text-[9px] px-1.5 py-0.5 rounded-md bg-red-600 text-white font-bold">LOST</span>}
        {metric && <MetricBadge label={metric} pass={pass} />}
        <span className="flex-1" />
        <span className={`text-muted-foreground/40 text-[10px] transition-transform ${expanded ? 'rotate-180' : ''}`}>▼</span>
      </button>
      {/* Progress bar (always visible for quantitative conditions) */}
      {progress && (
        <div className="px-3 pb-1">
          <MiniProgress value={progress.value} target={progress.target} pass={pass} />
        </div>
      )}
      {expanded && (
        <div className="px-4 pb-2 text-xs text-muted-foreground leading-relaxed bg-secondary/40">
          <div className="whitespace-pre-line break-words">{detail}</div>
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
  const [expanded, setExpanded] = useState<ConditionKey | null>(null);

  const sellSignals = detectSellSignals(allCandles, currentIndex);

  if (!sixConditions) {
    return (
      <EmptyState
        variant="compact"
        icon="📊"
        title="尚未載入股票"
        description="請先在上方選擇一檔股票，即可查看六大條件評分"
      />
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
      <div className="flex items-center justify-between px-3 py-2.5 bg-secondary border-b border-border">
        <span className="text-sm font-semibold text-foreground">六大進場條件</span>
        <span className={`text-base font-bold tabular-nums ${scoreColor}`}>{score}/6</span>
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
      <div className={`px-3 py-3 border-t border-border ${
        isCoreReady ? 'bg-green-900/40' : coreScore >= 3 ? 'bg-yellow-900/30' : 'bg-secondary/60'
      }`}>
        <p className={`text-sm font-bold ${
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

      {/* 🎯 高勝率位置加成（書本 p.749-754 + 圖表 12-1-7） */}
      {sc.highWinTags.length > 0 && (
        <div className="px-3 py-2 border-t border-border bg-green-900/10">
          <div className="text-[10px] font-bold text-green-400 mb-1">🎯 高勝率位置加成（{sc.highWinTags.length}/6）</div>
          <div className="flex flex-wrap gap-1">
            {sc.highWinTags.map(tag => {
              const num = HIGH_WIN_POS_NUM[tag] ?? '';
              return (
                <span key={tag} className="text-[10px] px-2 py-0.5 rounded bg-green-900/40 text-green-300 border border-green-800/50">
                  {num && <span className="text-green-500 mr-0.5">{num}</span>}{tag.replace('🎯 ', '')}
                </span>
              );
            })}
          </div>
        </div>
      )}

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
