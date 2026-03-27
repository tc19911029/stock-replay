'use client';

import { useState } from 'react';
import { useReplayStore } from '@/store/replayStore';
import { useSettingsStore } from '@/store/settingsStore';
import { BUILT_IN_STRATEGIES } from '@/lib/strategy/StrategyConfig';
import { SixConditionsResult } from '@/lib/analysis/trendAnalysis';
import { detectSellSignals } from '@/lib/analysis/sellSignals';

const CONDITION_LABELS = [
  { key: 'trend',     icon: '①', name: '趨勢',   tip: '確認多頭結構：高點墊高、低點墊高、MA5 > MA20' },
  { key: 'position',  icon: '②', name: '位置',   tip: '回測 MA10/MA20 後翻多，不在末升段（高檔過熱區）' },
  { key: 'kbar',      icon: '③', name: 'K棒',    tip: '今日收紅K，且實體飽滿（實體/振幅 ≥ 設定比例）' },
  { key: 'ma',        icon: '④', name: '均線',   tip: '均線多頭排列：MA5 > MA10 > MA20，MA5 向上' },
  { key: 'volume',    icon: '⑤', name: '成交量', tip: '今日成交量 ≥ 5日均量的 1.5 倍（量能放大）' },
  { key: 'indicator', icon: '⑥', name: '指標',   tip: 'MACD 柱狀翻紅，或 KD 金叉（K > D 且 20 ≤ K ≤ 85）' },
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
  label: { icon: string; name: string; tip: string };
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
        <span className="text-xs font-medium text-gray-200 w-10" title={label.tip}>{label.name}</span>
        <span className="text-xs text-gray-400 flex-1 truncate" title={label.tip}>{detail}</span>
        <span className="text-gray-600 text-xs">{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && (
        <div className="px-4 pb-2 text-xs text-gray-400 leading-relaxed bg-gray-800/40 space-y-1">
          <div>{detail}</div>
          <div className="text-[10px] text-slate-500 border-t border-slate-700 pt-1">{label.tip}</div>
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
        <span className="text-xs font-semibold text-gray-200">六大進場條件 ({strategyName})</span>
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
      <div className={`px-3 py-2.5 border-t border-gray-700 ${
        score >= 5 ? 'bg-green-900/40' : score >= 3 ? 'bg-yellow-900/30' : 'bg-slate-800/60'
      }`}>
        <p className={`text-xs font-bold ${
          score >= 5 ? 'text-green-300' : score >= 3 ? 'text-yellow-300' : 'text-slate-400'
        }`}>
          {score >= 5
            ? '✅ 條件充分 — 可考慮進場'
            : score >= 3
            ? '⏳ 條件部分符合 — 觀察後續'
            : '🚫 條件不足 — 建議觀望'}
        </p>
        {score >= 5 && (
          <p className="text-[10px] text-green-500 mt-0.5">仍需確認K線實際走勢與成交量</p>
        )}
      </div>

      {/* Surge Score */}
      {surgeScore && (
        <div className="px-3 py-2.5 border-t border-gray-700">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] font-bold text-violet-400">飆股潛力分</span>
            <div className="flex items-center gap-1.5">
              <span className={`text-xs font-black px-1.5 py-0.5 rounded ${
                surgeScore.grade === 'S' ? 'bg-red-600 text-white' :
                surgeScore.grade === 'A' ? 'bg-orange-500 text-white' :
                surgeScore.grade === 'B' ? 'bg-yellow-500 text-black' :
                'bg-slate-600 text-slate-300'
              }`}>{surgeScore.grade}</span>
              <span className="text-xs font-bold text-white">{surgeScore.totalScore}</span>
            </div>
          </div>
          <div className="w-full bg-gray-700 rounded-full h-1.5 overflow-hidden mb-2">
            <div className={`h-full rounded-full transition-all ${
              surgeScore.totalScore >= 65 ? 'bg-red-500' :
              surgeScore.totalScore >= 50 ? 'bg-orange-500' :
              surgeScore.totalScore >= 35 ? 'bg-yellow-500' : 'bg-slate-600'
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
                <div className="w-10 bg-gray-700 rounded-full h-1 overflow-hidden">
                  <div className={`h-full rounded-full ${
                    comp.score >= 70 ? 'bg-red-500' : comp.score >= 50 ? 'bg-orange-500' : comp.score >= 30 ? 'bg-yellow-500' : 'bg-slate-600'
                  }`} style={{ width: `${comp.score}%` }} />
                </div>
                <span className="text-slate-500 truncate">
                  {key === 'momentum' ? '動能' : key === 'volatility' ? '波動' :
                   key === 'volume' ? '量能' : key === 'breakout' ? '突破' :
                   key === 'trendQuality' ? '趨勢' : key === 'pricePosition' ? '位置' :
                   key === 'kbarStrength' ? 'K棒' : key === 'longTermQuality' ? '長期' : '指標'}
                </span>
                <span className="text-slate-400 font-mono">{comp.score}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Sell Signals */}
      {sellSignals.length > 0 && (
        <div className="mt-3 pt-3 border-t border-slate-700">
          <div className="text-[10px] font-bold text-slate-400 mb-1.5">⚠ 出場警示</div>
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
