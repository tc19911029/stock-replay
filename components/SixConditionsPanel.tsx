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

function ConditionRow({
  label,
  pass,
  detail,
  expanded,
  onToggle,
}: {
  label: { icon: string; name: string; tip: string; required: boolean };
  pass: boolean;
  detail: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const dot = pass
    ? <span className="text-green-400 text-sm">●</span>
    : <span className="text-red-400 text-sm">●</span>;

  return (
    <div className="border-b border-border last:border-0">
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/40 transition-colors"
        onClick={onToggle}
      >
        {dot}
        <span className="text-muted-foreground text-xs w-4">{label.icon}</span>
        <span className={`text-xs font-medium w-14 ${label.required ? 'text-foreground' : 'text-muted-foreground italic'}`} title={label.tip}>
          {label.name}
        </span>
        <span className="text-xs text-muted-foreground flex-1 truncate" title={label.tip}>{detail}</span>
        <span className="text-muted-foreground/60 text-xs">{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && (
        <div className="px-4 pb-2 text-xs text-muted-foreground leading-relaxed bg-secondary/40 space-y-1">
          <div>{detail}</div>
          <div className="text-[10px] text-muted-foreground border-t border-border pt-1">{label.tip}</div>
        </div>
      )}
    </div>
  );
}

export default function SixConditionsPanel() {
  const sixConditions = useReplayStore(s => s.sixConditions);
  const surgeScore    = useReplayStore(s => s.surgeScore);
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

  const rows: Array<{ key: ConditionKey; pass: boolean; detail: string }> = [
    { key: 'trend',     pass: sc.trend.pass,     detail: sc.trend.detail },
    { key: 'ma',        pass: sc.ma.pass,        detail: sc.ma.detail },
    { key: 'position',  pass: sc.position.pass,  detail: sc.position.detail },
    { key: 'volume',    pass: sc.volume.pass,     detail: sc.volume.detail },
    { key: 'kbar',      pass: sc.kbar.pass,      detail: sc.kbar.detail },
    { key: 'indicator', pass: sc.indicator.pass,  detail: sc.indicator.detail },
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

      {/* Surge Score */}
      {surgeScore && (
        <div className="px-3 py-2.5 border-t border-border">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] font-bold text-violet-400">飆股潛力分</span>
            <div className="flex items-center gap-1.5">
              <span className={`text-xs font-black px-1.5 py-0.5 rounded ${
                surgeScore.grade === 'S' ? 'bg-red-600 text-foreground' :
                surgeScore.grade === 'A' ? 'bg-orange-500 text-foreground' :
                surgeScore.grade === 'B' ? 'bg-yellow-500 text-black' :
                'bg-secondary text-foreground/80'
              }`}>{surgeScore.grade}</span>
              <span className="text-xs font-bold text-foreground">{surgeScore.totalScore}</span>
            </div>
          </div>
          <div className="w-full bg-muted rounded-full h-1.5 overflow-hidden mb-2">
            <div className={`h-full rounded-full transition-all ${
              surgeScore.totalScore >= 65 ? 'bg-red-500' :
              surgeScore.totalScore >= 50 ? 'bg-orange-500' :
              surgeScore.totalScore >= 35 ? 'bg-yellow-500' : 'bg-muted-foreground/60'
            }`} style={{ width: `${surgeScore.totalScore}%` }} />
          </div>
          {surgeScore.flags.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-1.5">
              {surgeScore.flags.map(f => (
                <span key={f} className="text-[9px] px-1.5 py-0.5 rounded bg-violet-900/60 text-violet-300">
                  {f === 'BB_SQUEEZE_BREAKOUT' ? 'BB壓縮突破' :
                   f === 'VOLUME_CLIMAX' ? '量能爆發' :
                   f === 'MA_CONVERGENCE_BREAKOUT' ? '均線糾結突破' :
                   f === 'CONSOLIDATION_BREAKOUT' ? '整理突破' :
                   f === 'NEW_60D_HIGH' ? '60日新高' :
                   f === 'MOMENTUM_ACCELERATION' ? '動能加速' :
                   f === 'PROGRESSIVE_VOLUME' ? '連續增量' : f}
                </span>
              ))}
            </div>
          )}
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
            {Object.entries(surgeScore.components).map(([key, comp]) => (
              <div key={key} className="flex items-center gap-1 text-[9px]">
                <div className="w-10 bg-muted rounded-full h-1 overflow-hidden">
                  <div className={`h-full rounded-full ${
                    comp.score >= 70 ? 'bg-red-500' : comp.score >= 50 ? 'bg-orange-500' : comp.score >= 30 ? 'bg-yellow-500' : 'bg-muted-foreground/60'
                  }`} style={{ width: `${comp.score}%` }} />
                </div>
                <span className="text-muted-foreground truncate">
                  {key === 'momentum' ? '動能' : key === 'volatility' ? '波動' :
                   key === 'volume' ? '量能' : key === 'breakout' ? '突破' :
                   key === 'trendQuality' ? '趨勢' : key === 'pricePosition' ? '位置' :
                   key === 'kbarStrength' ? 'K棒' : key === 'longTermQuality' ? '長期' : '指標'}
                </span>
                <span className="text-muted-foreground font-mono">{comp.score}</span>
              </div>
            ))}
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
