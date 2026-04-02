'use client';

import { useState } from 'react';
import { useReplayStore } from '@/store/replayStore';
import { RuleSignal } from '@/types';

const TYPE_CONFIG: Record<RuleSignal['type'], { bg: string; border: string; dot: string; badge: string }> = {
  BUY:    { bg: 'bg-red-900/30',     border: 'border-red-600',    dot: 'bg-red-400',    badge: 'bg-red-600 text-foreground' },
  ADD:    { bg: 'bg-orange-900/30',  border: 'border-orange-500', dot: 'bg-orange-400', badge: 'bg-orange-500 text-foreground' },
  WATCH:  { bg: 'bg-yellow-900/30',  border: 'border-yellow-600', dot: 'bg-yellow-400', badge: 'bg-yellow-600 text-black' },
  REDUCE: { bg: 'bg-teal-900/30',    border: 'border-teal-500',   dot: 'bg-teal-400',   badge: 'bg-teal-500 text-foreground' },
  SELL:   { bg: 'bg-green-900/30',   border: 'border-green-600',  dot: 'bg-green-400',  badge: 'bg-green-700 text-foreground' },
};

function SignalCard({ sig }: { sig: RuleSignal }) {
  const [expanded, setExpanded] = useState(false);
  const cfg = TYPE_CONFIG[sig.type];

  return (
    <div className={`${cfg.bg} border ${cfg.border} rounded overflow-hidden`}>
      {/* Header row */}
      <div
        className="flex items-center gap-2 p-2 cursor-pointer select-none hover:brightness-110"
        onClick={() => setExpanded(e => !e)}
      >
        <span className={`w-2 h-2 rounded-full ${cfg.dot} shrink-0`} />
        <span className={`px-2 py-0.5 rounded text-xs font-bold ${cfg.badge}`}>{sig.label}</span>
        <span className="text-xs text-foreground/80 flex-1 leading-tight">{sig.description}</span>
        <span className="text-muted-foreground text-xs shrink-0">{expanded ? '▲' : '▼ 分析'}</span>
      </div>

      {/* Expandable reason panel */}
      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-border/50">
          <p className="text-xs font-semibold text-muted-foreground mb-1.5">操作建議分析</p>
          <div className="space-y-1.5">
            {sig.reason.split('\n').filter(Boolean).map((line, i) => {
              const isBold = line.startsWith('【');
              const parts  = isBold ? line.split('】') : null;
              return (
                <p key={i} className="text-xs text-foreground/80 leading-relaxed">
                  {isBold && parts ? (
                    <>
                      <span className="text-yellow-400 font-semibold">【{parts[0].slice(1)}】</span>
                      {parts.slice(1).join('】')}
                    </>
                  ) : line}
                </p>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** 共振摘要 bar */
function ResonanceSummary({ signals }: { signals: RuleSignal[] }) {
  const buyCount = signals.filter(s => s.type === 'BUY' || s.type === 'ADD').length;
  const sellCount = signals.filter(s => s.type === 'SELL' || s.type === 'REDUCE').length;
  const watchCount = signals.filter(s => s.type === 'WATCH').length;

  if (buyCount === 0 && sellCount === 0 && watchCount === 0) return null;

  return (
    <div className="flex items-center gap-2 px-2 py-1.5 bg-card rounded text-xs mb-2">
      <span className="text-muted-foreground font-medium">共振:</span>
      {buyCount > 0 && (
        <span className={`px-1.5 py-0.5 rounded font-bold ${buyCount >= 3 ? 'bg-red-600 text-foreground' : buyCount >= 2 ? 'bg-red-800/60 text-red-300' : 'text-red-400'}`}>
          買 ×{buyCount}
        </span>
      )}
      {sellCount > 0 && (
        <span className={`px-1.5 py-0.5 rounded font-bold ${sellCount >= 3 ? 'bg-green-700 text-foreground' : sellCount >= 2 ? 'bg-green-800/60 text-green-300' : 'text-green-400'}`}>
          賣 ×{sellCount}
        </span>
      )}
      {watchCount > 0 && (
        <span className="text-yellow-500">觀察 ×{watchCount}</span>
      )}
    </div>
  );
}

export default function RuleAlerts() {
  const { currentSignals, allCandles, currentIndex } = useReplayStore();
  const currentDate = allCandles[currentIndex]?.date;
  const [showWeak, setShowWeak] = useState(false);

  // 分成強信號（BUY/SELL/ADD/REDUCE）和觀察信號（WATCH）
  const actionSignals = currentSignals.filter(s => s.type !== 'WATCH');
  const watchSignals = currentSignals.filter(s => s.type === 'WATCH');

  return (
    <div className="bg-secondary rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-foreground/80">規則提示與操作建議</h2>
        {currentDate && (
          <span className="text-xs text-muted-foreground">{currentDate}</span>
        )}
      </div>

      {/* 共振摘要 */}
      <ResonanceSummary signals={currentSignals} />

      {currentSignals.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-4">本根K線無觸發規則</p>
      ) : (
        <div className="space-y-2">
          {/* 動作信號（BUY/SELL/ADD/REDUCE） */}
          {actionSignals.map((sig, i) => (
            <SignalCard key={`${sig.ruleId}-${i}`} sig={sig} />
          ))}

          {/* WATCH 信號折疊 */}
          {watchSignals.length > 0 && (
            <>
              <button
                onClick={() => setShowWeak(v => !v)}
                className="w-full text-xs text-muted-foreground hover:text-muted-foreground py-1 transition"
              >
                {showWeak ? '▲ 收起觀察信號' : `▼ 觀察信號 (${watchSignals.length})`}
              </button>
              {showWeak && watchSignals.map((sig, i) => (
                <SignalCard key={`watch-${sig.ruleId}-${i}`} sig={sig} />
              ))}
            </>
          )}

          <p className="text-xs text-muted-foreground/60 text-center pt-1">點選卡片展開詳細分析</p>
        </div>
      )}

      <p className="text-xs text-muted-foreground/60 mt-3 text-center">
        提示僅供練習參考，實際交易需自行判斷
      </p>
    </div>
  );
}
