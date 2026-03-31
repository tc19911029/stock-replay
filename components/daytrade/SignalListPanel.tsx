'use client';

import { useDaytradeStore } from '@/store/daytradeStore';

export function SignalListPanel() {
  const { currentSignals, signalThreshold, setSignalThreshold } = useDaytradeStore();
  const filtered = currentSignals.filter(s => s.score >= signalThreshold);
  const recent = [...filtered].reverse().slice(0, 30);

  const typeColor: Record<string, string> = {
    BUY: 'border-l-red-500 bg-red-950/20', SELL: 'border-l-green-500 bg-green-950/20',
    ADD: 'border-l-orange-500 bg-orange-950/20', REDUCE: 'border-l-teal-500 bg-teal-950/20',
    STOP_LOSS: 'border-l-purple-500 bg-purple-950/20', RISK: 'border-l-yellow-500 bg-yellow-950/20',
    WATCH: 'border-l-slate-500 bg-slate-800/30',
  };

  return (
    <div className="space-y-1 p-1">
      <div className="flex items-center gap-2 px-1 mb-1">
        <span className="text-[10px] text-slate-500">共 {currentSignals.length} 個</span>
        <span className="text-[10px] text-slate-600">門檻:</span>
        {[0, 55, 65, 75].map(v => (
          <button key={v} onClick={() => setSignalThreshold(v)}
            className={`text-[10px] px-1.5 py-0.5 rounded ${signalThreshold === v ? 'bg-sky-600 text-white' : 'text-slate-500 hover:text-white'}`}>
            {v === 0 ? '全部' : `≥${v}`}
          </button>
        ))}
        <span className="text-[10px] text-sky-400 ml-auto">{filtered.length} 筆</span>
      </div>
      {recent.length === 0 && <div className="text-xs text-slate-600 text-center py-8">無符合條件的訊號</div>}
      {recent.map(sig => (
        <div key={sig.id} className={`border-l-2 rounded-r-lg p-2 text-xs ${typeColor[sig.type] ?? typeColor.WATCH}`}>
          <div className="flex items-center gap-1.5">
            <span className={`font-black text-[10px] px-1 rounded ${
              sig.type === 'BUY' ? 'bg-red-700 text-white' :
              sig.type === 'SELL' ? 'bg-green-700 text-white' :
              'bg-slate-700 text-slate-300'
            }`}>{sig.type}</span>
            <span className="font-bold text-white">{sig.label}</span>
            <span className="text-slate-600 text-[10px]">{sig.timeframe}</span>
            <span className="ml-auto text-[10px] bg-slate-800 px-1 rounded">{sig.score}</span>
          </div>
          <div className="mt-1 text-slate-400 text-[11px]">{sig.reason}</div>
          <div className="mt-0.5 flex items-center gap-2 text-[10px] text-slate-600 flex-wrap">
            <span>{sig.triggeredAt.split('T')[1]?.slice(0,5)} @ {sig.price.toFixed(2)}</span>
            {sig.metadata.stopLossPrice && (
              <span className="text-green-500">止損 {sig.metadata.stopLossPrice.toFixed(1)}</span>
            )}
            {sig.metadata.targetPrice && (
              <span className="text-red-400">目標 {sig.metadata.targetPrice.toFixed(1)}</span>
            )}
            {sig.metadata.riskRewardRatio != null && (
              <span className={`px-1 rounded ${sig.metadata.riskRewardRatio >= 1.5 ? 'bg-green-900/50 text-green-300' : sig.metadata.riskRewardRatio >= 1 ? 'bg-yellow-900/50 text-yellow-300' : 'bg-red-900/50 text-red-300'}`}>
                R:R {sig.metadata.riskRewardRatio.toFixed(1)}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
