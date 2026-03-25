'use client';

import { useState } from 'react';
import { StockScanResult } from '@/lib/scanner/types';

const SIGNAL_COLOR: Record<string, string> = {
  BUY: 'text-red-400', ADD: 'text-orange-400',
  SELL: 'text-green-400', REDUCE: 'text-yellow-400', WATCH: 'text-slate-400',
};
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

export default function ScanResultCard({ result: r }: { result: StockScanResult }) {
  const [expanded, setExpanded] = useState(false);

  const changePos = r.changePercent >= 0;
  const scoreColor =
    r.sixConditionsScore >= 5 ? 'bg-green-500/80 text-white' :
    r.sixConditionsScore >= 3 ? 'bg-yellow-500/80 text-black' :
    'bg-gray-600 text-gray-200';

  const buyRules   = r.triggeredRules.filter(t => t.signalType === 'BUY' || t.signalType === 'ADD');
  const watchRules = r.triggeredRules.filter(t => t.signalType === 'WATCH');
  const bd = r.sixConditionsBreakdown;

  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
      {/* Summary row */}
      <button
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-slate-700/40 transition text-left"
        onClick={() => setExpanded(v => !v)}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-white">{r.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '')}</span>
            <span className="text-xs text-slate-400 truncate">{r.name}</span>
          </div>
          {/* Six conditions chips */}
          {bd && (
            <div className="flex gap-1 mt-1 flex-wrap">
              {COND_LABELS.map(({ key, name }) => (
                <span key={key} className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                  bd[key] ? 'bg-green-800/60 text-green-300' : 'bg-slate-700 text-slate-500 line-through'
                }`}>
                  {name}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="text-right shrink-0">
          <div className="text-sm font-mono font-bold text-white">${r.price.toFixed(2)}</div>
          <div className={`text-xs font-mono ${changePos ? 'text-red-400' : 'text-green-400'}`}>
            {changePos ? '+' : ''}{r.changePercent.toFixed(2)}%
          </div>
        </div>

        <span className={`text-xs font-bold px-2 py-0.5 rounded shrink-0 ${scoreColor}`}>
          {r.sixConditionsScore}/6
        </span>

        {buyRules.length > 0 && (
          <span className={`text-xs font-bold shrink-0 ${SIGNAL_COLOR[buyRules[0].signalType]}`}>
            {SIGNAL_LABEL[buyRules[0].signalType]}
          </span>
        )}
        <span className="text-slate-600 text-xs shrink-0">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="border-t border-slate-700 px-4 pb-4 pt-3 space-y-3">
          <div className="text-xs text-slate-400">{r.trendState} · {r.trendPosition}</div>

          {buyRules.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-red-400 mb-1">觸發買入規則</p>
              <div className="space-y-1">
                {buyRules.map((rule, i) => (
                  <div key={i} className="text-xs text-slate-300">
                    <span className="text-yellow-400 font-medium">▶ {rule.ruleName}</span>
                    <p className="text-slate-500 mt-0.5 ml-3">{rule.reason}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {watchRules.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-slate-400 mb-1">觀察信號</p>
              <div className="flex flex-wrap gap-1">
                {watchRules.map((rule, i) => (
                  <span key={i} className="text-[10px] bg-slate-700 text-slate-400 px-2 py-0.5 rounded">{rule.ruleName}</span>
                ))}
              </div>
            </div>
          )}

          <div className="text-xs text-slate-500">
            量 {(r.volume / 1000).toFixed(0)}K · 掃描 {new Date(r.scanTime).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>
      )}
    </div>
  );
}
