'use client';

/**
 * WinnerPatternAlerts.tsx — Phase 8 走圖整合
 *
 * 走圖過程中即時顯示 33 種贏家圖像觸發狀態：
 * - 15 種多轉空秘笈圖（紅色警示）
 * - 18 種空轉多秘笈圖（綠色提示）
 *
 * 設計原則：
 * - 無觸發時顯示低調佔位符
 * - 有觸發時依信心度排序，展開顯示描述
 */

import { useState } from 'react';
import { useReplayStore } from '@/store/replayStore';
import type { PatternSignal } from '@/lib/rules/winnerPatternRules';

// ── Sub-components ─────────────────────────────────────────────────────────────

function PatternGroup({
  title,
  patterns,
  type,
}: {
  title: string;
  patterns: PatternSignal[];
  type: 'bearish' | 'bullish';
}) {
  const [expanded, setExpanded] = useState(false);

  const isBear = type === 'bearish';
  const accentBg   = isBear ? 'bg-red-900/30 border-red-700' : 'bg-green-900/30 border-green-700';
  const accentText = isBear ? 'text-red-300' : 'text-green-300';
  const badge      = isBear ? 'bg-red-600 text-white' : 'bg-green-700 text-white';
  const icon       = isBear ? '⚠️' : '✨';

  if (patterns.length === 0) {
    return (
      <div className="flex items-center gap-2 py-1">
        <span className="text-xs text-slate-600">—</span>
        <span className="text-xs text-slate-600">{title} — 無圖像觸發</span>
      </div>
    );
  }

  // Sort by confidence descending
  const sorted = [...patterns].sort((a, b) => b.confidence - a.confidence);

  return (
    <div className={`border rounded overflow-hidden ${accentBg}`}>
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none"
        onClick={() => setExpanded(v => !v)}
      >
        <span className="text-sm">{icon}</span>
        <span className={`text-xs font-bold px-2 py-0.5 rounded ${badge}`}>
          {patterns.length} 圖
        </span>
        <span className={`text-xs flex-1 ${accentText}`}>{title}</span>
        <span className="text-slate-500 text-xs">{expanded ? '▲' : '▼'}</span>
      </div>
      {expanded && (
        <div className="px-3 pb-2 border-t border-slate-700/40 space-y-2">
          {sorted.map(p => (
            <div key={p.id} className="pt-1">
              <div className="flex items-center gap-2">
                <span className={`text-xs font-semibold ${accentText}`}>{p.name}</span>
                <span className="text-xs text-slate-500">信心 {p.confidence}%</span>
              </div>
              <p className="text-xs text-slate-500 leading-relaxed">{p.description}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────

export default function WinnerPatternAlerts() {
  const { winnerPatterns, allCandles, currentIndex } = useReplayStore();

  if (allCandles.length === 0 || currentIndex < 5) return null;
  if (!winnerPatterns) return null;

  const { bearishPatterns, bullishPatterns, compositeAdjust } = winnerPatterns;
  const hasAny = bearishPatterns.length > 0 || bullishPatterns.length > 0;

  return (
    <div className="bg-slate-800 rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-300">33 種贏家圖像</h2>
        {hasAny && (
          <span className={`text-xs font-bold px-2 py-0.5 rounded ${
            compositeAdjust > 0
              ? 'bg-green-700/60 text-green-300'
              : compositeAdjust < 0
              ? 'bg-red-800/60 text-red-300'
              : 'bg-slate-700 text-slate-400'
          }`}>
            調整 {compositeAdjust > 0 ? '+' : ''}{compositeAdjust}
          </span>
        )}
      </div>

      {/* 空轉多（做多信號）— 顯示在前，多頭市場下更重要 */}
      <PatternGroup
        title="空轉多圖像（做多信號）"
        patterns={bullishPatterns}
        type="bullish"
      />

      {/* 多轉空（出場警示）*/}
      <PatternGroup
        title="多轉空圖像（出場警示）"
        patterns={bearishPatterns}
        type="bearish"
      />

      {/* 無觸發時的提示 */}
      {!hasAny && (
        <p className="text-xs text-slate-600 text-center py-1">
          當前 K 棒未觸發任何贏家圖像
        </p>
      )}
    </div>
  );
}
