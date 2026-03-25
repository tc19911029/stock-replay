'use client';

import { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import { useScannerStore } from '@/store/scannerStore';
import { useWatchlistStore } from '@/store/watchlistStore';
import { useSettingsStore } from '@/store/settingsStore';
import ScanResultCard from '@/components/scanner/ScanResultCard';
import { MarketId, StockScanResult } from '@/lib/scanner/types';

const MARKETS: Array<{ id: MarketId; label: string; desc: string }> = [
  { id: 'TW', label: '台灣股市', desc: '掃描全市場台股上市+上櫃（每日13:00）' },
  { id: 'CN', label: '中國A股', desc: '掃描滬深主板，排除創業板與ST股（每日14:30）' },
];

function useNotifyOnScanComplete(results: StockScanResult[], notifyEmail: string, minScore: number, market: MarketId) {
  const prevLen = useRef(0);
  const [notified, setNotified] = useState(false);

  useEffect(() => {
    if (results.length === 0 || results.length === prevLen.current) return;
    prevLen.current = results.length;
    setNotified(false);
    if (!notifyEmail) return;
    const hits = results.filter(r => r.sixConditionsScore >= minScore);
    if (hits.length === 0) return;
    fetch('/api/notify/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: notifyEmail, results: hits, market }),
    }).then(r => r.ok && setNotified(true)).catch(() => {});
  }, [results, notifyEmail, minScore, market]);

  return notified;
}

function AiReport({ results }: { results: StockScanResult[] }) {
  const [report, setReport] = useState('');
  const [loading, setLoading] = useState(false);
  const [show, setShow] = useState(false);

  async function generate() {
    setLoading(true);
    setShow(true);
    const top5 = results.slice(0, 5).map(r =>
      `${r.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '')} ${r.name}：六大條件${r.sixConditionsScore}/6，趨勢${r.trendState}，位置${r.trendPosition}，漲跌${r.changePercent.toFixed(2)}%`
    ).join('\n');
    const prompt = `今日市場掃描結果（按朱老師六大條件評分）：\n\n${top5}\n\n請用繁體中文簡短分析這幾支股票的優先順序，以及今日市場整體狀況，不超過150字。`;
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], context: '' }),
      });
      if (!res.body) throw new Error('no body');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        setReport(text);
      }
    } catch {
      setReport('⚠ AI 分析失敗，請確認 API 金鑰已設定');
    } finally {
      setLoading(false);
    }
  }

  if (!show) {
    return (
      <button onClick={generate}
        className="w-full py-2 bg-purple-700/60 hover:bg-purple-600/80 border border-purple-600/40 rounded-lg text-xs font-bold text-purple-200 transition">
        🤖 生成 AI 分析報告（Top 5）
      </button>
    );
  }

  return (
    <div className="bg-slate-800 border border-purple-700/40 rounded-xl p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-bold text-purple-300">🤖 AI 分析報告</span>
        <button onClick={() => setShow(false)} className="text-slate-500 hover:text-slate-300 text-xs">✕</button>
      </div>
      {loading && !report && <p className="text-xs text-slate-400 animate-pulse">分析中...</p>}
      {report && <p className="text-xs text-slate-300 leading-relaxed whitespace-pre-wrap">{report}</p>}
    </div>
  );
}

export default function ScannerPage() {
  const {
    activeMarket, setActiveMarket,
    isScanning, scanProgress, scanningStock, scanningIndex, scanningTotal,
    currentResults, lastScanTime, error, runScan, loadHistory, history,
  } = useScannerStore();

  const { add: addToWatchlist, has: inWatchlist } = useWatchlistStore();
  const { notifyEmail, notifyMinScore } = useSettingsStore();

  useEffect(() => { loadHistory(activeMarket); }, [activeMarket, loadHistory]);
  const emailNotified = useNotifyOnScanComplete(currentResults, notifyEmail, notifyMinScore, activeMarket);

  return (
    <div className="min-h-screen bg-[#0b1120] text-white">
      {/* Header */}
      <header className="border-b border-slate-800 px-4 py-2.5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-slate-400 hover:text-white text-sm transition">← 返回走圖</Link>
          <span className="text-base font-bold">🔍 市場掃描</span>
        </div>
        <div className="flex items-center gap-3">
          {emailNotified
            ? <span className="text-[10px] text-green-300 bg-green-900/40 px-1.5 py-0.5 rounded">✉ 通知已發送</span>
            : notifyEmail && <span className="text-[10px] text-green-400">● Email通知已開啟</span>
          }
          <Link href="/watchlist" className="text-xs text-slate-400 hover:text-white transition">⭐ 自選</Link>
          <Link href="/settings" className="text-xs text-slate-400 hover:text-white transition">⚙ 設定</Link>
          <Link href="/scanner/history" className="text-xs text-slate-400 hover:text-white transition">歷史 →</Link>
        </div>
      </header>

      <div className="p-4 space-y-4 max-w-3xl mx-auto">

        {/* Market tabs */}
        <div className="flex gap-2">
          {MARKETS.map(m => (
            <button key={m.id} onClick={() => setActiveMarket(m.id)}
              className={`flex-1 rounded-xl border px-4 py-3 text-left transition ${
                activeMarket === m.id ? 'border-blue-500 bg-blue-600/20' : 'border-slate-700 bg-slate-800/60 hover:border-slate-600'
              }`}>
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
            <button onClick={() => runScan(activeMarket)} disabled={isScanning}
              className="px-5 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg text-sm font-bold transition">
              {isScanning ? '掃描中...' : '開始掃描'}
            </button>
          </div>

          {isScanning && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>{scanningStock ? `正在掃描 ${scanningStock}` : '準備中...'}</span>
                <span>{scanningIndex}/{scanningTotal}</span>
              </div>
              <div className="w-full bg-slate-700 rounded-full h-1.5">
                <div className="bg-blue-500 h-1.5 rounded-full transition-all duration-500" style={{ width: `${scanProgress}%` }} />
              </div>
            </div>
          )}

          {error && <p className="text-xs text-red-400 mt-2">⚠ {error}</p>}
        </div>

        {/* Results */}
        {currentResults.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between px-1">
              <h3 className="text-sm font-bold text-slate-200">
                掃描結果 <span className="text-blue-400">{currentResults.length}</span> 檔符合條件
              </h3>
              <span className="text-xs text-slate-500">按六大條件得分排序</span>
            </div>

            {/* AI report button */}
            <AiReport results={currentResults} />

            {currentResults.map((r, idx) => {
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
                  {/* Action buttons */}
                  <div className="absolute top-3 right-3 flex gap-1 z-10">
                    <button
                      onClick={() => watched ? null : addToWatchlist(r.symbol, r.name)}
                      className={`px-2 py-1 rounded text-xs font-bold transition ${
                        watched ? 'bg-yellow-500/20 text-yellow-400 cursor-default' : 'bg-slate-700 hover:bg-yellow-600/40 hover:text-yellow-300 text-slate-400'
                      }`}
                      title={watched ? '已在自選股' : '加入自選股'}
                    >
                      {watched ? '⭐' : '☆'}
                    </button>
                    <Link
                      href={`/?load=${r.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '')}`}
                      className="px-2.5 py-1 bg-blue-600 hover:bg-blue-500 rounded text-xs font-bold text-white transition"
                    >走圖 →</Link>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {!isScanning && currentResults.length === 0 && (
          <div className="text-center py-12 text-slate-500">
            <p className="text-4xl mb-3">🔍</p>
            <p className="text-sm">點擊「開始掃描」尋找符合朱老師六大條件的股票</p>
            {!notifyEmail && (
              <Link href="/settings" className="mt-3 inline-block text-xs text-blue-400 hover:text-blue-300 transition">
                📧 設定 Email 通知，掃描完自動發送 →
              </Link>
            )}
          </div>
        )}

        {/* Recent history */}
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
