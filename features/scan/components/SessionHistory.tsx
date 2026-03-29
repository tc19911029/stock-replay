'use client';

import { useBacktestStore } from '@/store/backtestStore';

export function SessionHistory() {
  const { sessions, loadSession, market, scanDate } = useBacktestStore();
  const filtered = sessions.filter(s => s.market === market);
  if (filtered.length === 0) return null;

  const sessionsWithStats = filtered.filter(s => s.stats?.winRate != null);
  const avgWinRate = sessionsWithStats.length > 0
    ? Math.round(sessionsWithStats.reduce((sum, s) => sum + (s.stats?.winRate ?? 0), 0) / sessionsWithStats.length)
    : null;
  const totalTrades = sessionsWithStats.reduce((sum, s) => sum + (s.stats?.count ?? 0), 0);

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
      <div className="px-4 py-2.5 border-b border-slate-800 bg-slate-800/40">
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">回測歷史</h3>
        {avgWinRate != null && sessionsWithStats.length >= 2 && (
          <div className="flex items-center gap-2 mt-1 text-[10px]">
            <span className="text-slate-500">{sessionsWithStats.length} 次掃描</span>
            <span className="text-slate-500">·</span>
            <span className={avgWinRate >= 50 ? 'text-red-400' : 'text-green-500'}>
              平均勝率 {avgWinRate}%
            </span>
            <span className="text-slate-500">·</span>
            <span className="text-slate-500">{totalTrades} 筆交易</span>
          </div>
        )}
      </div>
      <div className="p-2 space-y-1">
        {filtered.map(s => {
          const isActive = s.scanDate === scanDate;
          const wr = s.stats?.winRate;
          return (
            <button
              key={s.id}
              onClick={() => loadSession(s.id)}
              className={`w-full text-left px-3 py-2.5 rounded-lg transition-colors ${
                isActive
                  ? 'bg-sky-900/40 border border-sky-800/60'
                  : 'hover:bg-slate-800 border border-transparent'
              }`}
            >
              <div className={`font-mono text-xs font-semibold ${isActive ? 'text-sky-300' : 'text-slate-300'}`}>
                {s.scanDate}
              </div>
              <div className="flex items-center gap-2 mt-0.5 text-[11px] text-slate-500">
                <span>{s.scanResults.length} 檔</span>
                {wr != null && (
                  <>
                    <span>｜</span>
                    <span className={wr >= 50 ? 'text-red-400' : 'text-green-500'}>勝率 {wr}%</span>
                  </>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
