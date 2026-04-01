'use client';

import { useBacktestStore } from '@/store/backtestStore';

export function SessionHistory() {
  const {
    sessions, loadSession, market, scanDate,
    cronDates, isFetchingCron, loadCronSession, isLoadingCronSession,
    isFetchingForward,
  } = useBacktestStore();

  const userSessions = sessions.filter(s => s.market === market);
  const userDates = new Set(userSessions.map(s => s.scanDate));

  // Cron dates that don't have a user-backtested session
  const cronOnly = cronDates
    .filter(c => c.market === market && !userDates.has(c.date))
    .sort((a, b) => b.date.localeCompare(a.date));

  // Merge: user sessions first (they have richer data), then cron-only
  const allDates = [
    ...userSessions.map(s => ({ type: 'user' as const, date: s.scanDate, session: s })),
    ...cronOnly.map(c => ({ type: 'cron' as const, date: c.date, cron: c })),
  ].sort((a, b) => b.date.localeCompare(a.date));

  if (allDates.length === 0 && !isFetchingCron) return null;

  const sessionsWithStats = userSessions.filter(s => s.stats?.winRate != null);
  const avgWinRate = sessionsWithStats.length > 0
    ? Math.round(sessionsWithStats.reduce((sum, s) => sum + (s.stats?.winRate ?? 0), 0) / sessionsWithStats.length)
    : null;
  const totalTrades = sessionsWithStats.reduce((sum, s) => sum + (s.stats?.count ?? 0), 0);

  const isBusy = isLoadingCronSession || isFetchingForward;

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
      <div className="p-2 space-y-1 max-h-[600px] overflow-y-auto">
        {isFetchingCron && allDates.length === 0 && (
          <div className="text-[10px] text-slate-600 text-center py-3">載入歷史中…</div>
        )}
        {allDates.map(item => {
          const isActive = item.date === scanDate;

          if (item.type === 'user') {
            const s = item.session;
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
          }

          // Cron-only entry
          const c = item.cron!;
          return (
            <button
              key={`cron-${c.date}`}
              onClick={() => !isBusy && loadCronSession(c.market, c.date)}
              disabled={isBusy}
              className={`w-full text-left px-3 py-2.5 rounded-lg transition-colors ${
                isActive
                  ? 'bg-amber-900/30 border border-amber-800/50'
                  : 'hover:bg-slate-800 border border-transparent'
              } ${isBusy ? 'opacity-50 cursor-wait' : ''}`}
            >
              <div className="flex items-center gap-1.5">
                <span className={`font-mono text-xs font-semibold ${isActive ? 'text-amber-300' : 'text-slate-400'}`}>
                  {c.date}
                </span>
                <span className="text-[9px] px-1 py-0.5 rounded bg-slate-800 text-slate-500" title="自動掃描（尚未回測）">
                  自動
                </span>
              </div>
              <div className="flex items-center gap-2 mt-0.5 text-[11px] text-slate-600">
                {c.resultCount >= 0 ? <span>{c.resultCount} 檔</span> : <span>點擊載入</span>}
                <span>｜</span>
                <span className="text-slate-600">點擊回測</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
