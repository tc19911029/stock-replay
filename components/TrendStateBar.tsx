'use client';

import { useReplayStore } from '@/store/replayStore';

export default function TrendStateBar() {
  const trendState    = useReplayStore(s => s.trendState);
  const trendPosition = useReplayStore(s => s.trendPosition);
  const sixConditions = useReplayStore(s => s.sixConditions);
  const trendColor =
    trendState === '多頭' ? 'bg-green-600/80 text-green-100' :
    trendState === '空頭' ? 'bg-red-600/80 text-red-100' :
    'bg-gray-600/80 text-gray-200';

  const trendArrow =
    trendState === '多頭' ? '▲' :
    trendState === '空頭' ? '▼' : '—';

  const positionColor =
    trendPosition === '末升段(高檔)' ? 'bg-orange-600/70 text-orange-100' :
    trendPosition === '主升段' ? 'bg-green-500/70 text-green-100' :
    trendPosition === '起漲段' ? 'bg-emerald-600/70 text-emerald-100' :
    trendPosition === '末跌段(低檔)' ? 'bg-blue-600/70 text-blue-100' :
    'bg-gray-600/70 text-gray-200';

  const sc = sixConditions;

  return (
    <div className="flex items-center gap-2 flex-wrap text-xs px-1 py-1">
      {/* Trend state */}
      <span className={`px-2 py-0.5 rounded font-semibold ${trendColor}`}>
        {trendArrow} {trendState}
      </span>

      {/* Position stage */}
      <span className={`px-2 py-0.5 rounded ${positionColor}`}>
        {trendPosition}
      </span>

      {/* MA alignment */}
      {sc && (
        <span className={`px-2 py-0.5 rounded ${sc.ma.pass ? 'bg-green-700/60 text-green-200' : 'bg-gray-700/60 text-gray-400'}`}>
          MA {sc.ma.pass ? '多排 ✓' : '未多排'}
        </span>
      )}

      {/* MACD */}
      {sc && (
        <span className={`px-2 py-0.5 rounded ${sc.indicator.macd ? 'bg-green-700/60 text-green-200' : 'bg-gray-700/60 text-gray-400'}`}>
          MACD {sc.indicator.macd ? '紅柱 ✓' : '綠柱'}
        </span>
      )}

      {/* KD */}
      {sc && (
        <span className={`px-2 py-0.5 rounded ${sc.indicator.kd ? 'bg-green-700/60 text-green-200' : 'bg-gray-700/60 text-gray-400'}`}>
          KD {sc.indicator.kd ? '多排 ✓' : '未多排'}
        </span>
      )}

      {/* Volume */}
      {sc && (
        <span className={`px-2 py-0.5 rounded ${sc.volume.pass ? 'bg-green-700/60 text-green-200' : 'bg-gray-700/60 text-gray-400'}`}>
          量 {sc.volume.ratio != null ? `${sc.volume.ratio}x` : '—'}
          {sc.volume.pass ? ' ✓' : ''}
        </span>
      )}

      {/* Score badge */}
      {sc && (
        <span className={`ml-auto px-2 py-0.5 rounded font-bold ${
          sc.totalScore >= 5 ? 'bg-green-500/80 text-white' :
          sc.totalScore >= 3 ? 'bg-yellow-500/80 text-black' :
          'bg-red-500/80 text-white'
        }`}>
          {sc.totalScore}/6
        </span>
      )}
    </div>
  );
}
