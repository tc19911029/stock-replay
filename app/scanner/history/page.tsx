'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ScanSession, MarketId } from '@/lib/scanner/types';
import ScanResultCard from '@/components/scanner/ScanResultCard';

export default function ScanHistoryPage() {
  const [market,   setMarket]   = useState<MarketId>('TW');
  const [sessions, setSessions] = useState<ScanSession[]>([]);
  const [selected, setSelected] = useState<ScanSession | null>(null);
  const [loading,  setLoading]  = useState(false);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/scanner/results?market=${market}`)
      .then(r => r.json())
      .then(d => setSessions(d.sessions ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [market]);

  const loadSession = async (date: string) => {
    try {
      const res = await fetch(`/api/scanner/results?market=${market}&date=${date}`);
      const data = await res.json();
      setSelected(data.sessions?.[0] ?? null);
    } catch {}
  };

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
            <button
              key={m}
              onClick={() => { setMarket(m); setSelected(null); }}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition ${
                market === m ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-400 hover:bg-slate-600'
              }`}
            >
              {m === 'TW' ? '台股' : 'A股'}
            </button>
          ))}
        </div>

        {loading && <p className="text-xs text-slate-500">載入中...</p>}

        {!loading && sessions.length === 0 && (
          <div className="text-center py-12 text-slate-500">
            <p className="text-sm">尚無掃描記錄，請先至掃描頁面執行掃描</p>
          </div>
        )}

        {/* Session list */}
        {!selected && sessions.map(s => (
          <button
            key={s.id}
            onClick={() => loadSession(s.date)}
            className="w-full flex items-center justify-between bg-slate-800/80 border border-slate-700 hover:border-blue-500 rounded-xl px-4 py-3 text-left transition"
          >
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
              <button
                onClick={() => setSelected(null)}
                className="text-xs text-slate-400 hover:text-white transition"
              >
                ← 返回列表
              </button>
            </div>
            {selected.results.map(r => (
              <ScanResultCard key={r.symbol} result={r} />
            ))}
          </div>
        )}

      </div>
    </div>
  );
}
