'use client';

/**
 * ProhibitionAlerts.tsx — Phase 7 走圖整合
 *
 * 走圖過程中即時顯示：
 * 1. 做多10大戒律觸發狀態（紅色警示）
 * 2. 做空10大戒律觸發狀態（綠色警示）
 * 3. 做空六條件評分（空頭市場時顯示）
 *
 * 設計原則：
 * - 未觸發戒律時顯示「✅ 通過」（綠色/低調）
 * - 觸發時顯示紅色警示 + 具體原因
 * - 做空六條件只在趨勢為空頭時展開顯示
 */

import { useState } from 'react';
import { useReplayStore } from '@/store/replayStore';

// ── Sub-components ─────────────────────────────────────────────────────────────

function ProhibitionSection({
  title,
  prohibited,
  reasons,
  direction,
}: {
  title:      string;
  prohibited: boolean;
  reasons:    string[];
  direction:  'long' | 'short';
}) {
  const [expanded, setExpanded] = useState(false);

  // Color scheme：做多用紅 (亞洲漲=紅)，做空用綠 (亞洲跌=綠)
  const okColor   = direction === 'long' ? 'text-bull'   : 'text-bear';
  const warnBg    = direction === 'long' ? 'bg-red-900/30 border-red-700' : 'bg-green-900/30 border-green-700';
  const warnText  = direction === 'long' ? 'text-red-300'  : 'text-green-300';
  const warnBadge = direction === 'long' ? 'bg-red-600 text-foreground' : 'bg-green-700 text-foreground';

  if (!prohibited) {
    return (
      <div className="flex items-center gap-2 py-1">
        <span className={`text-xs font-medium ${okColor}`}>✅</span>
        <span className="text-xs text-muted-foreground">{title} — 無戒律觸發</span>
      </div>
    );
  }

  return (
    <div className={`border rounded overflow-hidden ${warnBg}`}>
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none"
        onClick={() => setExpanded(v => !v)}
      >
        <span className="text-sm">⚠️</span>
        <span className={`text-xs font-bold px-2 py-0.5 rounded ${warnBadge}`}>禁止</span>
        <span className={`text-xs flex-1 ${warnText}`}>{title} — {reasons.length} 條戒律觸發</span>
        <span className="text-muted-foreground text-xs">{expanded ? '▲' : '▼'}</span>
      </div>
      {expanded && (
        <div className="px-3 pb-2 border-t border-border/40 space-y-1">
          {reasons.map((r, i) => (
            <p key={i} className={`text-xs leading-relaxed ${warnText}`}>• {r}</p>
          ))}
        </div>
      )}
    </div>
  );
}

function ShortConditionsSection() {
  const { shortConditions, trendState } = useReplayStore();
  const [expanded, setExpanded] = useState(false);

  if (!shortConditions) return null;

  const score = shortConditions.totalScore;
  const ready = shortConditions.isCoreReady;
  const scoreColor = ready ? 'text-green-400' : score >= 3 ? 'text-yellow-500' : 'text-muted-foreground';

  const conditions = [
    { label: '①趨勢空頭', pass: shortConditions.trend.pass },
    { label: '②均線空排', pass: shortConditions.ma.pass },
    { label: '③位置在均線下', pass: shortConditions.position.pass },
    { label: '④量能配合', pass: shortConditions.volume.pass },
    { label: '⑤黑K實體棒', pass: shortConditions.kbar.pass },
    { label: '⑥指標輔助', pass: shortConditions.indicator.pass },
  ];

  return (
    <div className="border border-border/50 rounded overflow-hidden">
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none bg-secondary/40"
        onClick={() => setExpanded(v => !v)}
      >
        <span className="text-xs text-muted-foreground">做空六條件</span>
        <span className={`text-sm font-bold ${scoreColor}`}>{score}/6</span>
        {ready && <span className="text-xs bg-green-700 text-foreground px-1.5 py-0.5 rounded font-bold">可放空</span>}
        {!ready && score >= 3 && <span className="text-xs text-yellow-500">待觀察</span>}
        <span className="text-muted-foreground text-xs ml-auto">{expanded ? '▲' : '▼'}</span>
      </div>
      {expanded && (
        <div className="px-3 pb-2 pt-1 space-y-1 bg-card/20">
          {conditions.map((c, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className={c.pass ? 'text-green-400 text-xs' : 'text-muted-foreground/60 text-xs'}>
                {c.pass ? '✅' : '○'}
              </span>
              <span className={`text-xs ${c.pass ? 'text-foreground/80' : 'text-muted-foreground/60'}`}>{c.label}</span>
            </div>
          ))}
          {!ready && (
            <p className="text-xs text-muted-foreground/60 pt-1">前5條未全過 → 不可進場做空</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────

export default function ProhibitionAlerts() {
  const { longProhibitions, shortProhibitions, trendState, allCandles, currentIndex } = useReplayStore();

  if (allCandles.length === 0 || currentIndex < 5) return null;

  return (
    <div className="bg-secondary rounded-lg p-4 space-y-3">
      <h2 className="text-sm font-semibold text-foreground/80">進場10大戒律</h2>

      {/* 做多戒律（多頭市場時主要顯示） */}
      {longProhibitions && (
        <ProhibitionSection
          title="做多"
          prohibited={longProhibitions.prohibited}
          reasons={longProhibitions.reasons}
          direction="long"
        />
      )}

      {/* 做空戒律（永遠顯示，不限趨勢） */}
      {shortProhibitions && (
        <ProhibitionSection
          title="做空"
          prohibited={shortProhibitions.prohibited}
          reasons={shortProhibitions.reasons}
          direction="short"
        />
      )}

      {/* 做空六條件（空頭市場時顯示） */}
      <ShortConditionsSection />

      {/* 進場評估摘要 */}
      {longProhibitions && (
        <div className={`text-xs px-3 py-2 rounded ${
          longProhibitions.prohibited
            ? 'bg-red-900/20 text-red-400 border border-red-800/40'
            : 'bg-card/40 text-muted-foreground'
        }`}>
          {longProhibitions.prohibited
            ? `🚫 今日${longProhibitions.reasons.length}條戒律觸發 — 不宜進場做多`
            : '✅ 戒律全數通過 — 可參考六條件決定是否進場'}
        </div>
      )}
    </div>
  );
}
