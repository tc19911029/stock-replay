'use client';

import { useEffect, useRef } from 'react';
import { useReplayStore } from '@/store/replayStore';

const SPEED_OPTIONS = [
  { label: '慢', ms: 1500 },
  { label: '1×', ms: 800  },
  { label: '快', ms: 350  },
  { label: '極速', ms: 100 },
];

const INTERVAL_LABEL: Record<string, string> = { '1d': '日', '1wk': '週', '1mo': '月' };

export default function ReplayControls() {
  const {
    allCandles, currentIndex, isPlaying, playSpeed, currentInterval,
    nextCandle, prevCandle, startPlay, stopPlay, setPlaySpeed, resetReplay, jumpToIndex,
  } = useReplayStore();

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (isPlaying) {
      timerRef.current = setInterval(() => {
        const s = useReplayStore.getState();
        if (s.currentIndex >= s.allCandles.length - 1) s.stopPlay();
        else s.nextCandle();
      }, playSpeed);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [isPlaying, playSpeed]);

  const total     = allCandles.length;
  const pos       = currentIndex + 1;
  const remaining = total - pos;
  const kLabel    = INTERVAL_LABEL[currentInterval] ?? '日';

  return (
    <div className="bg-slate-800/80 border border-slate-700 rounded-lg px-2 py-1.5 flex items-center gap-2">
      {/* Prev / Play / Next */}
      <div className="flex gap-1 shrink-0">
        <button onClick={prevCandle} disabled={currentIndex <= 0 || isPlaying}
          suppressHydrationWarning
          className="w-7 h-7 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-30 text-xs transition flex items-center justify-center">
          ◀
        </button>
        {isPlaying ? (
          <button onClick={stopPlay} suppressHydrationWarning
            className="px-2 h-7 rounded bg-amber-600 hover:bg-amber-500 text-xs font-bold transition whitespace-nowrap">
            ⏸
          </button>
        ) : (
          <button onClick={startPlay} disabled={currentIndex >= total - 1} suppressHydrationWarning
            className="px-2 h-7 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-30 text-xs font-bold transition whitespace-nowrap">
            ▶
          </button>
        )}
        <button onClick={nextCandle} disabled={currentIndex >= total - 1 || isPlaying}
          suppressHydrationWarning
          className="w-7 h-7 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-30 text-xs transition flex items-center justify-center">
          ▶
        </button>
      </div>

      {/* Scrubber + position */}
      <div className="flex-1 flex flex-col gap-0.5 min-w-0">
        <input
          type="range" min={0} max={Math.max(0, total - 1)} value={currentIndex}
          onChange={e => jumpToIndex(Number(e.target.value))}
          className="w-full accent-blue-500 cursor-pointer h-1"
        />
        <div className="flex justify-between text-xs text-slate-500 font-mono leading-none">
          <span className="truncate">{allCandles[0]?.date?.slice(0, 7) ?? ''}</span>
          <span className={remaining > 0 ? 'text-slate-400' : 'text-green-400'}>
            {kLabel} {pos}/{total}
          </span>
          <span className="truncate">{allCandles[total - 1]?.date?.slice(0, 7) ?? ''}</span>
        </div>
      </div>

      {/* Speed */}
      <div className="flex gap-0.5 shrink-0">
        {SPEED_OPTIONS.map(opt => (
          <button key={opt.ms} onClick={() => setPlaySpeed(opt.ms)}
            className={`w-8 h-7 rounded text-xs font-medium transition ${
              playSpeed === opt.ms ? 'bg-blue-600 text-white' : 'bg-slate-700 hover:bg-slate-600 text-slate-400'
            }`}>
            {opt.label}
          </button>
        ))}
      </div>

      {/* Reset */}
      <button onClick={resetReplay}
        className="shrink-0 w-7 h-7 rounded bg-slate-700 hover:bg-red-900/60 text-slate-400 hover:text-red-300 text-xs transition flex items-center justify-center"
        title="重置走圖">
        ↺
      </button>
    </div>
  );
}
