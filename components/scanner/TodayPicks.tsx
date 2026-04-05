'use client';

import Link from 'next/link';
import { StockScanResult } from '@/lib/scanner/types';
import { useWatchlistStore } from '@/store/watchlistStore';

const FLAG_LABELS: Record<string, string> = {
  BB_SQUEEZE_BREAKOUT: 'BB壓縮突破',
  VOLUME_CLIMAX: '量能爆發',
  MA_CONVERGENCE_BREAKOUT: '均線糾結突破',
  CONSOLIDATION_BREAKOUT: '整理突破',
  NEW_60D_HIGH: '60日新高',
  MOMENTUM_ACCELERATION: '動能加速',
  PROGRESSIVE_VOLUME: '連續增量',
};

function getAdvice(r: StockScanResult): { action: string; reason: string; risk: string } {
  const winRate = r.histWinRate ?? 50;
  const surge = r.surgeScore ?? 0;

  if (winRate >= 65 && surge >= 60) {
    return {
      action: '建議買入',
      reason: `歷史勝率${winRate}%，飆股潛力${surge}分，技術面強勢`,
      risk: '建議倉位：總資金的 15-20%，止損設在 -7%',
    };
  }
  if (winRate >= 50 && surge >= 50) {
    return {
      action: '可考慮買入',
      reason: `歷史勝率${winRate}%尚可，潛力${surge}分`,
      risk: '建議倉位：總資金的 10%，止損 -5%',
    };
  }
  return {
    action: '觀察為主',
    reason: `歷史勝率${winRate}%偏低，需謹慎`,
    risk: '若要進場，倉位不超過 5%，嚴格止損 -3%',
  };
}

interface Props {
  results: StockScanResult[];
  isLoading: boolean;
}

export default function TodayPicks({ results, isLoading }: Props) {
  const { add: addToWatchlist, has: inWatchlist } = useWatchlistStore();

  if (isLoading) {
    return (
      <div className="bg-gradient-to-r from-violet-900/30 to-blue-900/30 border border-violet-700/50 rounded-xl p-4">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-lg">🎯</span>
          <span className="text-sm font-bold text-foreground">今日精選推薦</span>
          <span className="text-xs text-violet-400 animate-pulse">掃描中...</span>
        </div>
      </div>
    );
  }

  if (results.length === 0) return null;

  // Select top 3: by sixConditionsScore, then changePercent
  const scored = results
    .sort((a, b) => b.sixConditionsScore - a.sixConditionsScore || b.changePercent - a.changePercent)
    .slice(0, 3);

  if (scored.length === 0) return null;

  return (
    <div className="bg-gradient-to-r from-violet-900/30 to-blue-900/30 border border-violet-700/50 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-lg">🎯</span>
          <span className="text-sm font-bold text-foreground">今日精選推薦 Top 3</span>
        </div>
        <span className="text-[10px] text-muted-foreground">六條件排序</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {scored.map((r, idx) => {
          const advice = getAdvice(r);
          const sym = r.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
          const watched = inWatchlist(r.symbol);

          return (
            <div key={r.symbol} className="bg-secondary/80 border border-border rounded-xl p-3 space-y-2">
              {/* Header: rank + symbol + grade */}
              <div className="flex items-center gap-2">
                <span className="text-xs font-black w-6 h-6 flex items-center justify-center rounded-full bg-gradient-to-br from-violet-600 to-blue-600 text-foreground">
                  {idx + 1}
                </span>
                <span className="text-sm font-bold text-foreground">{sym}</span>
                <span className="text-xs text-muted-foreground">{r.name}</span>
              </div>

              {/* Price + change */}
              <div className="flex items-center gap-3">
                <span className="text-lg font-mono font-bold text-foreground">{r.price.toFixed(2)}</span>
                <span className={`text-sm font-mono ${r.changePercent >= 0 ? 'text-bull' : 'text-bear'}`}>
                  {r.changePercent >= 0 ? '+' : ''}{r.changePercent.toFixed(2)}%
                </span>
              </div>

              {/* Scores */}
              <div className="flex items-center gap-2 text-[10px]">
                <span className="text-muted-foreground">條件 <span className="text-foreground font-bold">{r.sixConditionsScore}/6</span></span>
                {r.histWinRate != null && (
                  <span className={`px-1 rounded ${
                    r.histWinRate >= 65 ? 'bg-green-900/60 text-green-300' :
                    r.histWinRate >= 50 ? 'bg-yellow-900/60 text-yellow-300' :
                    'bg-red-900/60 text-red-300'
                  }`}>
                    勝率{r.histWinRate}%
                  </span>
                )}
              </div>

              {/* Key flags */}
              <div className="flex flex-wrap gap-1">
                {r.surgeFlags?.slice(0, 3).map(f => (
                  <span key={f} className="text-[9px] px-1 py-0.5 rounded bg-violet-900/60 text-violet-300">
                    {FLAG_LABELS[f] ?? f}
                  </span>
                ))}
              </div>

              {/* AI reason */}
              {r.aiReason && (
                <p className="text-[10px] text-blue-300 italic">{r.aiReason}</p>
              )}

              {/* Advice */}
              <div className={`text-xs px-2 py-1.5 rounded ${
                advice.action === '建議買入' ? 'bg-red-900/40 text-red-300' :
                advice.action === '可考慮買入' ? 'bg-orange-900/40 text-orange-300' :
                'bg-muted text-muted-foreground'
              }`}>
                <div className="font-bold">{advice.action}</div>
                <div className="text-[10px] mt-0.5 opacity-80">{advice.risk}</div>
              </div>

              {/* Actions */}
              <div className="flex gap-2">
                <button
                  onClick={() => { if (!watched) addToWatchlist(r.symbol, r.name); }}
                  className={`flex-1 px-2 py-1.5 rounded text-xs font-bold transition ${
                    watched ? 'bg-yellow-500/20 text-yellow-400' : 'bg-yellow-600 hover:bg-yellow-500 text-black'
                  }`}
                >
                  {watched ? '⭐ 已追蹤' : '⭐ 加入追蹤'}
                </button>
                <Link
                  href={`/?load=${sym}`}
                  className="flex-1 px-2 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-xs font-bold text-foreground text-center transition"
                >
                  走圖 →
                </Link>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
