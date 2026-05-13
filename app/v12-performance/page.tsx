'use client';

/**
 * v12 14 軌策略績效儀表板
 *
 * 對 production 過去 20 天歷史 scan 結果做後驗統計：
 * - 每個字母總命中、平均報酬（5 天）、勝率、Sharpe-like
 * - 紅綠 heatmap 一眼看出哪個字母最強
 *
 * Source: /api/v12/strategy-performance
 */

import { useEffect, useState } from 'react';
import { LETTER_NAMES } from '@/lib/scanner/buyMethodTracks';

interface LetterStats {
  letter: string;
  hits: number;
  days: number;
  avgEntry: number;
  avgRet5d: number | null;
  winRate5d: number | null;
  bestRet: number | null;
  worstRet: number | null;
  sharpeLike: number | null;
  uniqueSymbols: number;
}

const TRACK_COLOR: Record<string, string> = {
  B: 'border-red-700/60', P: 'border-red-700/60', C: 'border-red-700/60', E: 'border-red-700/60',
  J: 'border-red-700/60', K: 'border-red-700/60', L: 'border-red-700/60', M: 'border-red-700/60',
  D: 'border-blue-700/60', F: 'border-blue-700/60', N: 'border-blue-700/60', O: 'border-blue-700/60',
  Q: 'border-purple-700/60',
  G: 'border-stone-600/60', H: 'border-stone-600/60', I: 'border-stone-600/60',
};

function retColor(val: number | null): string {
  if (val == null) return 'text-muted-foreground';
  if (val > 5) return 'text-emerald-400 font-bold';
  if (val > 0) return 'text-emerald-300';
  if (val < -5) return 'text-rose-400 font-bold';
  if (val < 0) return 'text-rose-300';
  return 'text-foreground';
}

function winColor(rate: number | null): string {
  if (rate == null) return 'text-muted-foreground';
  if (rate >= 60) return 'text-emerald-400 font-bold';
  if (rate >= 50) return 'text-emerald-300';
  if (rate >= 40) return 'text-amber-300';
  return 'text-rose-300';
}

export default function V12PerformancePage() {
  const [tw, setTw] = useState<LetterStats[]>([]);
  const [cn, setCn] = useState<LetterStats[]>([]);
  const [loading, setLoading] = useState(false);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [twRes, cnRes] = await Promise.all([
        fetch('/api/v12/strategy-performance?market=TW'),
        fetch('/api/v12/strategy-performance?market=CN'),
      ]);
      const twJson = await twRes.json();
      const cnJson = await cnRes.json();
      setTw(twJson.stats ?? []);
      setCn(cnJson.stats ?? []);
      setGeneratedAt(twJson.generatedAt ?? null);
    } catch (err) {
      console.error('load failed', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  return (
    <div className="min-h-screen bg-background p-4 md:p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-foreground">v12 14 軌策略績效</h1>
            <p className="text-xs text-muted-foreground mt-1">
              過去 20 天歷史 scan 後驗（持有 5 天統計）
              {generatedAt && ` · 計算於 ${new Date(generatedAt).toLocaleString('zh-TW')}`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <a
              href="/v12-deep-analytics"
              className="px-3 py-1.5 text-xs bg-purple-600 hover:bg-purple-500 text-white rounded"
            >
              🔬 深度分析
            </a>
            <button
              onClick={load}
              disabled={loading}
              className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded disabled:opacity-50"
            >
              {loading ? '計算中…' : '🔄 重新計算'}
            </button>
          </div>
        </div>

        {/* 三軌制圖例 */}
        <div className="text-[11px] text-muted-foreground flex items-center gap-3 flex-wrap">
          <span><span className="text-red-400">▲</span> 多頭軌</span>
          <span><span className="text-blue-400">◆</span> 轉折軌</span>
          <span><span className="text-purple-400">●</span> 戰法軌</span>
          <span className="opacity-60">G/H/I 為 v11 字母（J/K/L 為 v12 改名）</span>
        </div>

        {/* TW Table */}
        <div>
          <h2 className="text-sm font-bold text-foreground mb-2">🇹🇼 TW 台股</h2>
          <PerformanceTable stats={tw} loading={loading} />
        </div>

        {/* CN Table */}
        <div>
          <h2 className="text-sm font-bold text-foreground mb-2">🇨🇳 CN 陸股</h2>
          <PerformanceTable stats={cn} loading={loading} />
        </div>

        <div className="text-[10px] text-muted-foreground bg-muted/30 p-3 rounded">
          <p className="font-bold mb-1">說明</p>
          <ul className="space-y-0.5">
            <li>· <b>命中</b>：該字母在過去 20 天總共觸發次數（同股不同天計多次）</li>
            <li>· <b>平均報酬 5d</b>：進場後 5 個交易日的 close 報酬率平均（樣本內後驗）</li>
            <li>· <b>勝率 5d</b>：5 天後 close &gt; entry 的比例</li>
            <li>· <b>Sharpe-like</b>：avgRet / stdev（&gt;0.3 算強，&gt;0.5 算優秀）</li>
            <li>· 樣本量小於 10 時統計結果僅供參考</li>
            <li>· 此為「全部命中股都進場」的簡化模型，不含手續費 / 滑點 / 倉位限制</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

function PerformanceTable({ stats, loading }: { stats: LetterStats[]; loading: boolean }) {
  if (loading) return <div className="text-xs text-muted-foreground py-4">計算中…</div>;
  if (stats.length === 0) return <div className="text-xs text-muted-foreground py-4">無資料</div>;
  return (
    <div className="bg-card border border-border rounded-lg overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="bg-muted/40 text-muted-foreground">
          <tr>
            <th className="px-2 py-1.5 text-left">字母</th>
            <th className="px-2 py-1.5 text-left">名稱</th>
            <th className="px-2 py-1.5 text-right">命中</th>
            <th className="px-2 py-1.5 text-right">天數</th>
            <th className="px-2 py-1.5 text-right">獨股</th>
            <th className="px-2 py-1.5 text-right">平均 5d</th>
            <th className="px-2 py-1.5 text-right">勝率 5d</th>
            <th className="px-2 py-1.5 text-right">最佳</th>
            <th className="px-2 py-1.5 text-right">最差</th>
            <th className="px-2 py-1.5 text-right">Sharpe</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/40">
          {stats.map((s) => (
            <tr key={s.letter} className={`border-l-2 ${TRACK_COLOR[s.letter] ?? ''}`}>
              <td className="px-2 py-1.5 font-bold">{s.letter}</td>
              <td className="px-2 py-1.5 text-foreground/80">{LETTER_NAMES[s.letter] ?? s.letter}</td>
              <td className="px-2 py-1.5 text-right font-mono">{s.hits}</td>
              <td className="px-2 py-1.5 text-right font-mono text-muted-foreground">{s.days}</td>
              <td className="px-2 py-1.5 text-right font-mono text-muted-foreground">{s.uniqueSymbols}</td>
              <td className={`px-2 py-1.5 text-right font-mono ${retColor(s.avgRet5d)}`}>
                {s.avgRet5d != null ? `${s.avgRet5d >= 0 ? '+' : ''}${s.avgRet5d}%` : '—'}
              </td>
              <td className={`px-2 py-1.5 text-right font-mono ${winColor(s.winRate5d)}`}>
                {s.winRate5d != null ? `${s.winRate5d}%` : '—'}
              </td>
              <td className={`px-2 py-1.5 text-right font-mono ${retColor(s.bestRet)}`}>
                {s.bestRet != null ? `${s.bestRet >= 0 ? '+' : ''}${s.bestRet}%` : '—'}
              </td>
              <td className={`px-2 py-1.5 text-right font-mono ${retColor(s.worstRet)}`}>
                {s.worstRet != null ? `${s.worstRet >= 0 ? '+' : ''}${s.worstRet}%` : '—'}
              </td>
              <td className="px-2 py-1.5 text-right font-mono text-foreground/80">
                {s.sharpeLike != null ? s.sharpeLike : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
