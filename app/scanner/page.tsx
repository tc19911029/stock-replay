'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useScannerStore } from '@/store/scannerStore';
import ScanResultCard from '@/components/scanner/ScanResultCard';
import { MarketId } from '@/lib/scanner/types';

const MARKETS: Array<{ id: MarketId; label: string; desc: string }> = [
  { id: 'TW', label: '台灣股市', desc: '掃描 Top 50 台股（每日13:00）' },
  { id: 'CN', label: '中國A股', desc: '掃描 Top 20 A股（每日14:30）' },
];

export default function ScannerPage() {
  const {
    activeMarket, setActiveMarket,
    isScanning, scanProgress, currentResults,
    lastScanTime, error, runScan, loadHistory, history,
  } = useScannerStore();

  useEffect(() => { loadHistory(activeMarket); }, [activeMarket, loadHistory]);

  return (
    <div className="min-h-screen bg-[#0b1120] text-white">
      {/* Header */}
      <header className="border-b border-slate-800 px-4 py-2.5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-slate-400 hover:text-white text-sm transition">← 返回走圖</Link>
          <span className="text-base font-bold">🔍 市場掃描</span>
        </div>
        <Link href="/scanner/history" className="text-xs text-slate-400 hover:text-white transition">
          歷史記錄 →
        </Link>
      </header>

      <div className="p-4 space-y-4 max-w-3xl mx-auto">

        {/* Market tabs */}
        <div className="flex gap-2">
          {MARKETS.map(m => (
            <button
              key={m.id}
              onClick={() => setActiveMarket(m.id)}
              className={`flex-1 rounded-xl border px-4 py-3 text-left transition ${
                activeMarket === m.id
                  ? 'border-blue-500 bg-blue-600/20'
                  : 'border-slate-700 bg-slate-800/60 hover:border-slate-600'
              }`}
            >
              <div className="text-sm font-bold">{m.label}</div>
              <div className="text-xs text-slate-400 mt-0.5">{m.desc}</div>
            </button>
          ))}
        </div>

        {/* Scan trigger */}
        <div className="bg-slate-800/80 border border-slate-700 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-sm font-bold">
                {MARKETS.find(m => m.id === activeMarket)?.label} 掃描
              </h2>
              {lastScanTime && (
                <p className="text-xs text-slate-400 mt-0.5">
                  上次掃描：{new Date(lastScanTime).toLocaleString('zh-TW')}
                </p>
              )}
            </div>
            <button
              onClick={() => runScan(activeMarket)}
              disabled={isScanning}
              className="px-5 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg text-sm font-bold transition"
            >
              {isScanning ? '掃描中...' : '開始掃描'}
            </button>
          </div>

          {/* Progress bar */}
          {isScanning && (
            <div className="w-full bg-slate-700 rounded-full h-1.5">
              <div
                className="bg-blue-500 h-1.5 rounded-full transition-all duration-500"
                style={{ width: `${scanProgress}%` }}
              />
            </div>
          )}

          {error && (
            <p className="text-xs text-red-400 mt-2">⚠ {error}</p>
          )}
        </div>

        {/* Results */}
        {currentResults.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between px-1">
              <h3 className="text-sm font-bold text-slate-200">
                掃描結果 <span className="text-blue-400">{currentResults.length}</span> 檔符合條件
              </h3>
              <span className="text-xs text-slate-500">按六大條件得分排序 · 點「走圖」可直接載入</span>
            </div>
            {currentResults.map((r) => (
              <div key={r.symbol} className="relative">
                <ScanResultCard result={r} />
                <Link
                  href={`/?load=${r.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '')}`}
                  className="absolute top-3 right-3 px-2.5 py-1 bg-blue-600 hover:bg-blue-500 rounded text-xs font-bold text-white transition z-10"
                >
                  走圖 →
                </Link>
              </div>
            ))}
          </div>
        )}

        {!isScanning && currentResults.length === 0 && (
          <div className="text-center py-12 text-slate-500">
            <p className="text-4xl mb-3">🔍</p>
            <p className="text-sm">點擊「開始掃描」尋找符合朱老師六大條件的股票</p>
          </div>
        )}

        {/* Recent history summary */}
        {history.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-bold text-slate-400 px-1">近期掃描記錄</h3>
            {history.slice(0, 5).map(s => (
              <div key={s.id} className="flex items-center justify-between bg-slate-800/60 border border-slate-700 rounded-lg px-4 py-2 text-xs">
                <span className="text-slate-300">{s.date}</span>
                <span className="text-blue-400 font-bold">{s.resultCount} 檔符合</span>
                <span className="text-slate-500">{new Date(s.scanTime).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}</span>
              </div>
            ))}
          </div>
        )}

      </div>
    </div>
  );
}
