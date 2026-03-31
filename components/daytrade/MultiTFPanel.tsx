'use client';

import { useDaytradeStore } from '@/store/daytradeStore';
import type { IntradayTimeframe } from '@/lib/daytrade/types';

export function MultiTFPanel() {
  const { mtfState } = useDaytradeStore();
  if (!mtfState) return <div className="text-xs text-slate-600 p-4 text-center">載入數據後顯示</div>;

  const tfs: IntradayTimeframe[] = ['60m', '15m', '5m', '1m'];
  const labels: Record<string, string> = { '60m': '大方向', '15m': '結構強弱', '5m': '進出節奏', '1m': '確認時機' };
  const biasColor = mtfState.overallBias === 'bullish' ? 'text-red-400 bg-red-900/40' :
                    mtfState.overallBias === 'bearish' ? 'text-green-400 bg-green-900/40' :
                    'text-yellow-400 bg-yellow-900/40';
  const biasLabel = mtfState.overallBias === 'bullish' ? '偏多' : mtfState.overallBias === 'bearish' ? '偏空' : '中性';

  return (
    <div className="space-y-3 p-1">
      {/* Overall */}
      <div className={`text-center py-2 rounded-lg border ${biasColor} border-current/20`}>
        <div className="text-lg font-black">{biasLabel}</div>
        <div className="text-xs opacity-70">共振分 {mtfState.confluenceScore}</div>
      </div>

      {/* Per timeframe */}
      {tfs.map(tf => {
        const s = mtfState.timeframes[tf];
        const icon = s.trend === 'bullish' ? '🟢' : s.trend === 'bearish' ? '🔴' : '🟡';
        const trendLabel = s.trend === 'bullish' ? '多頭' : s.trend === 'bearish' ? '空頭' : '盤整';
        const maLabel = s.maAlignment === 'bullish' ? 'MA多排' : s.maAlignment === 'bearish' ? 'MA空排' : 'MA混合';
        const vwapLabel = s.vwapRelation === 'above' ? 'VWAP上' : s.vwapRelation === 'below' ? 'VWAP下' : 'VWAP附近';
        return (
          <div key={tf} className="bg-slate-800/50 rounded-lg p-2.5 space-y-1">
            <div className="flex items-center gap-2 text-xs">
              <span className="font-bold text-white">{tf}</span>
              <span>{icon}</span>
              <span className={s.trend === 'bullish' ? 'text-red-400' : s.trend === 'bearish' ? 'text-green-400' : 'text-yellow-400'}>
                {trendLabel}
              </span>
              <span className="ml-auto text-slate-500 text-[10px]">{labels[tf]}</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="flex-1 bg-slate-900 rounded-full h-1.5">
                <div className={`h-full rounded-full transition-all ${
                  s.trend === 'bullish' ? 'bg-red-500' : s.trend === 'bearish' ? 'bg-green-500' : 'bg-yellow-500'
                }`} style={{ width: `${s.trendStrength}%` }} />
              </div>
              <span className="text-[10px] text-slate-500 w-6 text-right">{s.trendStrength}</span>
            </div>
            <div className="flex gap-2 text-[10px] text-slate-500">
              <span>{maLabel}</span>
              <span>{vwapLabel}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
