'use client';

import { useState, ReactNode } from 'react';
import { StockScanResult } from '@/lib/scanner/types';
import { formatTime } from '@/lib/format';

const SIGNAL_LABEL: Record<string, string> = {
  BUY: '買入', ADD: '加碼', SELL: '賣出', REDUCE: '減碼', WATCH: '觀察',
};

const COND_LABELS: Array<{ key: keyof StockScanResult['sixConditionsBreakdown']; name: string }> = [
  { key: 'trend',     name: '趨勢' },
  { key: 'position',  name: '位置' },
  { key: 'kbar',      name: 'K棒' },
  { key: 'ma',        name: '均線' },
  { key: 'volume',    name: '量能' },
  { key: 'indicator', name: '指標' },
];

const FLAG_LABELS: Record<string, string> = {
  BB_SQUEEZE_BREAKOUT: 'BB壓縮突破',
  VOLUME_CLIMAX: '量能爆發',
  MA_CONVERGENCE_BREAKOUT: '均線糾結突破',
  CONSOLIDATION_BREAKOUT: '整理突破',
  NEW_60D_HIGH: '60日新高',
  MOMENTUM_ACCELERATION: '動能加速',
  PROGRESSIVE_VOLUME: '連續增量',
};

const COMPONENT_LABELS: Record<string, string> = {
  momentum: '動能加速',
  volatility: '波動擴張',
  volume: '量能攀升',
  breakout: '突破型態',
  trendQuality: '趨勢品質',
  pricePosition: '價格位置',
  kbarStrength: 'K棒力道',
  indicatorConfluence: '指標共振',
  longTermQuality: '長期品質',
};

function ScoreBar({ score, label }: { score: number; label: string }) {
  const color = score >= 70 ? 'bg-red-500' : score >= 50 ? 'bg-orange-500' : score >= 30 ? 'bg-yellow-500' : 'bg-muted';
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-muted-foreground w-16 shrink-0 text-right">{label}</span>
      <div className="flex-1 bg-muted rounded-full h-1.5 overflow-hidden">
        <div className={`h-full rounded-full ${color} transition-all`} style={{ width: `${score}%` }} />
      </div>
      <span className="text-muted-foreground font-mono w-7 text-right">{score}</span>
    </div>
  );
}

export default function ScanResultCard({ result: r, actions }: { result: StockScanResult; actions?: ReactNode }) {
  const [expanded, setExpanded] = useState(false);

  const changePos = r.changePercent >= 0;
  const bd = r.sixConditionsBreakdown;
  const buyRules   = r.triggeredRules.filter(t => t.signalType === 'BUY' || t.signalType === 'ADD');
  const watchRules = r.triggeredRules.filter(t => t.signalType === 'WATCH');

  return (
    <div className="bg-secondary border border-border rounded-xl overflow-hidden">
      {/* Top row */}
      <div className="flex items-center gap-2 px-4 pt-3 pb-1">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-foreground font-mono">{r.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '')}</span>
            <span className="text-xs text-muted-foreground truncate">{r.name}</span>
            {buyRules.length > 0 && (
              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full border ${
                buyRules[0].signalType === 'BUY' ? 'border-red-500/50 text-red-400' : 'border-orange-500/50 text-orange-400'
              }`}>
                {SIGNAL_LABEL[buyRules[0].signalType]}
              </span>
            )}
          </div>
          {/* AI annotation */}
          <div className="flex items-center gap-2 mt-0.5">
            {r.aiRank && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                r.aiConfidence === 'high' ? 'bg-red-900/60 text-red-300' :
                r.aiConfidence === 'medium' ? 'bg-orange-900/60 text-orange-300' :
                'bg-muted text-muted-foreground'
              }`}>
                AI #{r.aiRank}
              </span>
            )}
          </div>
        </div>

        {/* Price + change */}
        <div className="text-right shrink-0">
          <div className="text-sm font-mono font-bold text-foreground">{r.price.toFixed(2)}</div>
          <div className={`text-xs font-mono ${changePos ? 'text-bull' : 'text-bear'}`}>
            {changePos ? '+' : ''}{r.changePercent.toFixed(2)}%
          </div>
        </div>

        {/* Six conditions score */}
        <span className={`text-xs font-bold px-2 py-1 rounded shrink-0 ${
          r.sixConditionsScore >= 5 ? 'bg-red-600/80 text-foreground' :
          r.sixConditionsScore >= 3 ? 'bg-yellow-500/80 text-black' :
          'bg-muted text-muted-foreground'
        }`}>
          {r.sixConditionsScore}/6
        </span>

        {actions && <div className="flex gap-1 shrink-0">{actions}</div>}
      </div>

      {/* Condition chips + surge flags */}
      <div className="flex gap-1 px-4 pb-2 flex-wrap">
        {bd && COND_LABELS.map(({ key, name }) => (
          <span key={key} className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
            bd[key] ? 'bg-red-900/60 text-red-300' : 'bg-muted text-muted-foreground line-through'
          }`}>
            {name}
          </span>
        ))}
        {r.surgeFlags?.map(flag => (
          <span key={flag} className="text-[10px] px-1.5 py-0.5 rounded bg-violet-900/60 text-violet-300 font-medium">
            {FLAG_LABELS[flag] ?? flag}
          </span>
        ))}
      </div>

      {/* AI reason + historical win rate */}
      <div className="flex items-center gap-2 px-4 pb-2 flex-wrap">
        {r.aiReason && (
          <p className="text-[10px] text-blue-300 italic">{r.aiReason}</p>
        )}
        {r.histWinRate != null && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
            r.histWinRate >= 65 ? 'bg-green-900/60 text-green-300' :
            r.histWinRate >= 50 ? 'bg-yellow-900/60 text-yellow-300' :
            'bg-red-900/60 text-red-300'
          }`}>
            歷史勝率 {r.histWinRate}% ({r.histSignalCount}次)
          </span>
        )}
      </div>

      {/* Expand toggle */}
      <button
        className="w-full flex items-center justify-between px-4 py-1.5 hover:bg-muted/40 transition text-left border-t border-border/50"
        onClick={() => setExpanded(v => !v)}
      >
        <span className="text-[10px] text-muted-foreground">{r.trendState} · {r.trendPosition}</span>
        <span className="text-muted-foreground/60 text-xs">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="border-t border-border px-4 pb-4 pt-3 space-y-3">
          {/* Surge score breakdown */}
          {r.surgeComponents && (
            <div>
              <p className="text-xs font-semibold text-violet-400 mb-2">飆股潛力分析</p>
              <div className="space-y-1.5">
                {(Object.entries(r.surgeComponents) as [string, { score: number; detail: string }][]).map(([key, comp]) => (
                  <div key={key}>
                    <ScoreBar score={comp.score} label={COMPONENT_LABELS[key] ?? key} />
                    {comp.detail && (
                      <p className="text-[10px] text-muted-foreground ml-[72px] mt-0.5">{comp.detail}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {buyRules.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-red-400 mb-1">觸發買入規則</p>
              <div className="space-y-1">
                {buyRules.map((rule, i) => (
                  <div key={i} className="text-xs text-foreground/80">
                    <span className="text-yellow-400 font-medium">▶ {rule.ruleName}</span>
                    <p className="text-muted-foreground mt-0.5 ml-3">{rule.reason}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {watchRules.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-muted-foreground mb-1">觀察信號</p>
              <div className="flex flex-wrap gap-1">
                {watchRules.map((rule, i) => (
                  <span key={i} className="text-[10px] bg-muted text-muted-foreground px-2 py-0.5 rounded">{rule.ruleName}</span>
                ))}
              </div>
            </div>
          )}

          <div className="text-xs text-muted-foreground">
            量 {(r.volume / 1000).toFixed(0)}K · 掃描 {formatTime(r.scanTime)}
          </div>
        </div>
      )}
    </div>
  );
}
