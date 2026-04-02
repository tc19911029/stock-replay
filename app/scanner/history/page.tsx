'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { PageShell } from '@/components/shared';
import { useScannerStore } from '@/store/scannerStore';
import { ScanSession, MarketId } from '@/lib/scanner/types';
import ScanResultCard from '@/components/scanner/ScanResultCard';
import { useWatchlistStore } from '@/store/watchlistStore';

function ScanHistoryContent() {
  const searchParams = useSearchParams();
  const initialMarket = (searchParams.get('market') as MarketId) || 'TW';
  const initialId     = searchParams.get('id') ?? null;

  const [market,   setMarket]   = useState<MarketId>(initialMarket);
  const [selected, setSelected] = useState<ScanSession | null>(null);

  const { getHistory } = useScannerStore();
  const { add: addToWatchlist, has: inWatchlist } = useWatchlistStore();
  const sessions = getHistory(market);

  // Auto-select session from URL param
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (initialId && sessions.length > 0) {
      const found = sessions.find(s => s.id === initialId);
      if (found) setSelected(found);
    }
  }, [initialId, sessions.length]); // eslint-disable-line react-hooks/exhaustive-deps
  /* eslint-enable react-hooks/set-state-in-effect */

  return (
    <PageShell headerSlot={
      <span className="text-sm font-bold text-foreground">掃描歷史記錄</span>
    }>
      <div className="p-4 max-w-3xl mx-auto space-y-4">

        {/* Market toggle */}
        <div className="flex gap-2">
          {(['TW', 'CN'] as MarketId[]).map(m => {
            const hist = getHistory(m);
            return (
              <button key={m} onClick={() => { setMarket(m); setSelected(null); }}
                className={`flex-1 px-4 py-2 rounded-lg text-sm font-medium transition flex items-center justify-center gap-2 ${
                  market === m ? 'bg-blue-600 text-foreground' : 'bg-muted text-muted-foreground hover:bg-muted'
                }`}>
                {m === 'TW' ? '台股' : 'A股'}
                {hist.length > 0 && (
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${market === m ? 'bg-blue-500' : 'bg-muted'}`}>
                    {hist.length}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {sessions.length === 0 && (
          <div className="text-center py-12 text-muted-foreground">
            <p className="text-3xl mb-3">📭</p>
            <p className="text-sm">尚無掃描記錄</p>
            <Link href="/scanner" className="mt-2 inline-block text-xs text-blue-400 hover:text-blue-300 transition">
              前往掃描 →
            </Link>
          </div>
        )}

        {/* Session list */}
        {!selected && sessions.map(s => (
          <button key={s.id} onClick={() => setSelected(s)}
            className="w-full flex items-center justify-between bg-secondary/80 border border-border hover:border-blue-500 rounded-xl px-4 py-3 text-left transition">
            <div>
              <div className="text-sm font-bold text-foreground">{s.date}</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {new Date(s.scanTime).toLocaleString('zh-TW')}
              </div>
            </div>
            <div className="text-right">
              <div className="text-lg font-bold text-blue-400">{s.resultCount}</div>
              <div className="text-xs text-muted-foreground">檔符合</div>
            </div>
          </button>
        ))}

        {/* Detail view */}
        {selected && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-bold">
                  {selected.date} 掃描結果（{selected.resultCount} 檔）
                </h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {new Date(selected.scanTime).toLocaleString('zh-TW')}
                </p>
              </div>
              <button onClick={() => setSelected(null)}
                className="text-xs text-muted-foreground hover:text-foreground transition">
                ← 返回列表
              </button>
            </div>

            {/* Top Picks section */}
            {selected.topPicks && selected.topPicks.length > 0 && (
              <div className="bg-gradient-to-r from-violet-900/20 to-blue-900/20 border border-violet-700/50 rounded-xl p-4 mb-4">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-lg">🎯</span>
                  <span className="text-sm font-bold text-foreground">當日 Top 3 推薦</span>
                  <span className="text-[10px] text-muted-foreground">{selected.date}</span>
                </div>
                <div className="space-y-2">
                  {selected.topPicks.map((pick, pi) => (
                    <div key={pick.symbol} className="flex items-center gap-3 bg-secondary/60 rounded-lg px-3 py-2">
                      <span className={`text-xs font-black w-6 h-6 flex items-center justify-center rounded-full ${
                        pi === 0 ? 'bg-red-600 text-foreground' : pi === 1 ? 'bg-orange-500 text-foreground' : 'bg-yellow-500 text-black'
                      }`}>{pi + 1}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-bold text-foreground">{pick.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '')}</span>
                          <span className="text-xs text-muted-foreground">{pick.name}</span>
                          <span className={`text-[10px] font-bold px-1 rounded ${
                            pick.surgeGrade === 'S' ? 'bg-red-600 text-foreground' :
                            pick.surgeGrade === 'A' ? 'bg-orange-500 text-foreground' :
                            'bg-yellow-500 text-black'
                          }`}>{pick.surgeGrade}</span>
                        </div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          潛力{pick.surgeScore} · {pick.sixConditionsScore}/6
                          {pick.histWinRate != null && ` · 勝率${pick.histWinRate}%`}
                          {pick.aiReason && ` · ${pick.aiReason}`}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-sm font-mono text-foreground">${pick.price.toFixed(2)}</div>
                        <div className={`text-xs font-mono ${pick.changePercent >= 0 ? 'text-bull' : 'text-bear'}`}>
                          {pick.changePercent >= 0 ? '+' : ''}{pick.changePercent.toFixed(2)}%
                        </div>
                      </div>
                      <Link href={`/?load=${pick.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '')}`}
                        className="px-2 py-1 bg-blue-600 hover:bg-blue-500 rounded text-xs font-bold text-foreground shrink-0">
                        走圖
                      </Link>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {selected.results.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-6">此次掃描無符合條件的股票</p>
            )}

            {selected.results.map((r, idx) => {
              const isTop3  = idx < 3;
              const crown   = ['🥇', '🥈', '🥉'][idx] ?? '';
              const watched = inWatchlist(r.symbol);
              return (
                <div key={r.symbol} className={`relative ${isTop3 ? 'ring-1 ring-yellow-500/60 rounded-xl' : ''}`}>
                  {isTop3 && (
                    <div className="absolute -top-2 left-3 z-20">
                      <span className="text-xs bg-yellow-500 text-black font-bold px-1.5 py-0.5 rounded-full leading-none">
                        {crown} Top {idx + 1}
                      </span>
                    </div>
                  )}
                  <ScanResultCard result={r} />
                  <div className="absolute top-3 right-3 flex gap-1 z-10">
                    <button
                      onClick={() => watched ? undefined : addToWatchlist(r.symbol, r.name)}
                      className={`px-2 py-1 rounded text-xs font-bold transition ${
                        watched ? 'bg-yellow-500/20 text-yellow-400 cursor-default' : 'bg-muted hover:bg-yellow-600/40 hover:text-yellow-300 text-muted-foreground'
                      }`}
                      title={watched ? '已在自選股' : '加入自選股'}>
                      {watched ? '⭐' : '☆'}
                    </button>
                    <Link
                      href={`/?load=${r.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '')}`}
                      className="px-2.5 py-1 bg-blue-600 hover:bg-blue-500 rounded text-xs font-bold text-foreground transition">
                      走圖 →
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
        )}

      </div>
    </PageShell>
  );
}

export default function ScanHistoryPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center">
        <p className="text-muted-foreground text-sm animate-pulse">載入中...</p>
      </div>
    }>
      <ScanHistoryContent />
    </Suspense>
  );
}
