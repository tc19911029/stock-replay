'use client';

import { useBacktestStore } from '@/store/backtestStore';

export function SessionHistory() {
  const {
    sessions, loadSession, market, scanDate,
    cronDates, isFetchingCron, loadCronSession, isLoadingCronSession,
    isFetchingForward, backfillHistory, isBackfilling, backfillProgress,
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
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border bg-secondary/40">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">回測歷史</h3>
          {!isBackfilling && allDates.length < 5 && (
            <button
              onClick={() => backfillHistory(market, 20)}
              className="text-[9px] px-1.5 py-0.5 rounded bg-sky-900/50 text-sky-400 hover:bg-sky-800/50 transition-colors"
              title="補齊過去20個交易日的掃描結果"
            >
              補齊20天
            </button>
          )}
          {isBackfilling && (
            <span className="text-[9px] text-sky-500">
              {backfillProgress.done}/{backfillProgress.total} 補齊中…
            </span>
          )}
        </div>
        {avgWinRate != null && sessionsWithStats.length >= 2 && (
          <div className="flex items-center gap-2 mt-1 text-[10px]">
            <span className="text-muted-foreground">{sessionsWithStats.length} 次掃描</span>
            <span className="text-muted-foreground">·</span>
            <span className={avgWinRate >= 50 ? 'text-bull' : 'text-bear'}>
              平均勝率 {avgWinRate}%
            </span>
            <span className="text-muted-foreground">·</span>
            <span className="text-muted-foreground">{totalTrades} 筆交易</span>
          </div>
        )}
      </div>
      <div className="p-2 space-y-1 max-h-[600px] overflow-y-auto">
        {isFetchingCron && allDates.length === 0 && (
          <div className="text-[10px] text-muted-foreground/60 text-center py-3">載入歷史中…</div>
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
                    : 'hover:bg-secondary border border-transparent'
                }`}
              >
                <div className={`font-mono text-xs font-semibold ${isActive ? 'text-sky-300' : 'text-foreground/80'}`}>
                  {s.scanDate}
                </div>
                <div className="flex items-center gap-2 mt-0.5 text-[11px] text-muted-foreground">
                  <span>{s.scanResults.length} 檔</span>
                  {wr != null && (
                    <>
                      <span>｜</span>
                      <span className={wr >= 50 ? 'text-bull' : 'text-bear'}>勝率 {wr}%</span>
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
                  : 'hover:bg-secondary border border-transparent'
              } ${isBusy ? 'opacity-50 cursor-wait' : ''}`}
            >
              <div className="flex items-center gap-1.5">
                <span className={`font-mono text-xs font-semibold ${isActive ? 'text-amber-300' : 'text-muted-foreground'}`}>
                  {c.date}
                </span>
                <span className="text-[9px] px-1 py-0.5 rounded bg-secondary text-muted-foreground" title="自動掃描（尚未回測）">
                  自動
                </span>
              </div>
              <div className="flex items-center gap-2 mt-0.5 text-[11px] text-muted-foreground/60">
                {c.resultCount >= 0 ? <span>{c.resultCount} 檔</span> : <span>點擊載入</span>}
                <span>｜</span>
                <span className="text-muted-foreground/60">點擊回測</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
