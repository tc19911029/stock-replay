'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useScannerStore } from '@/store/scannerStore';
import { ScanSession, MarketId } from '@/lib/scanner/types';
import ScanResultCard from '@/components/scanner/ScanResultCard';
import { useWatchlistStore } from '@/store/watchlistStore';

export default function ScanHistoryPage() {
  const [market,   setMarket]   = useState<MarketId>('TW');
  const [selected, setSelected] = useState<ScanSession | null>(null);

  const { getHistory } = useScannerStore();
  const { add: addToWatchlist, has: inWatchlist } = useWatchlistStore();
  const sessions = getHistory(market);

  return (
    <div className="min-h-screen bg-[#0b1120] text-white">
      <header className="border-b border-slate-800 px-4 py-2.5 flex items-center gap-3">
        <Link href="/scanner" className="text-slate-400 hover:text-white text-sm transition">← 返回掃描</Link>
        <span className="text-base font-bold">📅 掃描歷史記錄</span>
      </header>

      <div className="p-4 max-w-3xl mx-auto space-y-4">

        {/* Market toggle */}
        <div className="flex gap-2">
          {(['TW', 'CN'] as MarketId[]).map(m => (
            <button key={m} onClick={() => { setMarket(m); setSelected(null); }}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition ${
                market === m ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-400 hover:bg-slate-600'
              }`}>
              {m === 'TW' ? '台股' : 'A股'}
            </button>
          ))}
        </div>

        {sessions.length === 0 && (
          <div className="text-center py-12 text-slate-500">
            <p className="text-sm">尚無掃描記錄，請先至掃描頁面執行掃描</p>
          </div>
        )}

        {/* Session list */}
        {!selected && sessions.map(s => (
          <button key={s.id} onClick={() => setSelected(s)}
            className="w-full flex items-center justify-between bg-slate-800/80 border border-slate-700 hover:border-blue-500 rounded-xl px-4 py-3 text-left transition">
            <div>
              <div className="text-sm font-bold text-white">{s.date}</div>
              <div className="text-xs text-slate-500 mt-0.5">
                {new Date(s.scanTime).toLocaleString('zh-TW')}
              </div>
            </div>
            <div className="text-right">
              <div className="text-lg font-bold text-blue-400">{s.resultCount}</div>
              <div className="text-xs text-slate-400">檔符合</div>
            </div>
          </button>
        ))}

        {/* Detail view */}
        {selected && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold">
                {selected.date} 掃描結果（{selected.resultCount} 檔）
              </h2>
              <button onClick={() => setSelected(null)}
                className="text-xs text-slate-400 hover:text-white transition">
                ← 返回列表
              </button>
            </div>
            {selected.results.map((r, idx) => {
              const isTop3 = idx < 3;
              const crown = ['🥇', '🥈', '🥉'][idx] ?? '';
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
                      onClick={() => watched ? null : addToWatchlist(r.symbol, r.name)}
                      className={`px-2 py-1 rounded text-xs font-bold transition ${
                        watched ? 'bg-yellow-500/20 text-yellow-400 cursor-default' : 'bg-slate-700 hover:bg-yellow-600/40 hover:text-yellow-300 text-slate-400'
                      }`}
                      title={watched ? '已在自選股' : '加入自選股'}>
                      {watched ? '⭐' : '☆'}
                    </button>
                    <Link
                      href={`/?load=${r.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '')}`}
                      className="px-2.5 py-1 bg-blue-600 hover:bg-blue-500 rounded text-xs font-bold text-white transition">
                      走圖 →
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
        )}

      </div>
    </div>
  );
}
