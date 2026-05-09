'use client';

/**
 * LockWatch 鎖股觀察名單面板（v12 Phase 1.6）
 *
 * 顯示 F V 反轉 / N 型態確認觸發後的觀察階段股票。
 * 議題 23/65/93/61：F/N 走 LockWatch；單檔合併寫入。
 *
 * 收合預設關閉（避免占主畫面）；展開後顯示當日 active 紀錄。
 */

import { useEffect, useState, useCallback } from 'react';
import { useWatchlistStore } from '@/store/watchlistStore';
import type { LockWatchDailySnapshot, LockWatchRecord } from '@/lib/scanner/lockWatchTypes';

interface LockWatchPanelProps {
  market: 'TW' | 'CN';
}

interface ApiResponse {
  ok: boolean;
  snapshot: LockWatchDailySnapshot | null;
  dates: string[];
  error?: string;
}

const SIGNAL_LABEL: Record<'F' | 'N', { name: string; color: string }> = {
  F: { name: 'V反轉', color: 'bg-rose-800/80 text-rose-300' },
  N: { name: '型態確認', color: 'bg-indigo-800/80 text-indigo-300' },
};

const PATTERN_NAME: Record<NonNullable<LockWatchRecord['patternType']>, string> = {
  'head-shoulder': '頭肩底',
  'complex-head-shoulder': '複式頭肩底',
  'triple-bottom': '三重底',
  'falling-diamond': '跌菱形',
  'rounding-bottom': '圓弧底',
  'descending-wedge': '下降楔形',
  'double-bottom': '雙重底',
};

const STAGE_STYLE: Record<LockWatchRecord['currentStage'], { label: string; color: string }> = {
  observation: { label: '觀察中', color: 'text-amber-300' },
  'entry-signal': { label: '可進場', color: 'text-emerald-300 font-bold' },
  purchased: { label: '已買進', color: 'text-sky-300' },
  revoked: { label: '已撤銷', color: 'text-muted-foreground/60 line-through' },
  'manually-removed': { label: '手動移除', color: 'text-muted-foreground/60 line-through' },
  'structure-broken': { label: '結構失效', color: 'text-rose-400/70 line-through' },
};

export function LockWatchPanel({ market }: LockWatchPanelProps) {
  const [collapsed, setCollapsed] = useState(true);
  const [snapshot, setSnapshot] = useState<LockWatchDailySnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removingKey, setRemovingKey] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/lockwatch?market=${market}`);
      const json = (await res.json()) as ApiResponse;
      if (!json.ok) {
        setError(json.error ?? 'load failed');
      } else {
        setSnapshot(json.snapshot);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [market]);

  const removeRecord = useCallback(
    async (symbol: string, triggerSignal: 'F' | 'N') => {
      const key = `${symbol}-${triggerSignal}`;
      setRemovingKey(key);
      try {
        const res = await fetch('/api/lockwatch/remove', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ market, symbol, triggerSignal, reason: 'user' }),
        });
        const json = (await res.json()) as { ok: boolean; error?: string };
        if (!json.ok) {
          alert(`移除失敗：${json.error ?? 'unknown'}`);
        } else {
          await fetchData();
        }
      } catch (err) {
        alert(`移除失敗：${String(err)}`);
      } finally {
        setRemovingKey(null);
      }
    },
    [market, fetchData],
  );

  // 進入時就 fetch 一次抓 active count；展開不展開都顯示徽章
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Active = 觀察中 / 可進場（已買進、撤銷、移除不在主視圖突出）
  const activeRecords = (snapshot?.records ?? []).filter(
    (r) => r.currentStage === 'observation' || r.currentStage === 'entry-signal',
  );
  const activeCount = activeRecords.length;
  const totalCount = snapshot?.records.length ?? 0;

  return (
    <div className="border-b border-border/60">
      <button
        onClick={() => setCollapsed((v) => !v)}
        className={`w-full flex items-center justify-between px-2.5 py-1.5 text-[11px] hover:bg-muted/40 transition-colors ${
          activeCount > 0
            ? 'bg-amber-900/30 text-amber-200 hover:bg-amber-900/40'
            : 'text-muted-foreground hover:text-foreground'
        }`}
        title="v12 新功能：F V反轉 / N 型態確認 觸發後自動加入觀察名單，等趨勢確認再進場"
      >
        <span className="flex items-center gap-1.5">
          <span className="text-[9px] font-bold uppercase tracking-wider opacity-70">v12</span>
          <span className="font-semibold">🔒 鎖股觀察</span>
          {activeCount > 0 ? (
            <span className="text-[10px] font-mono bg-amber-700 text-amber-100 px-1.5 py-px rounded font-bold">
              {activeCount} 檔
            </span>
          ) : (
            <span className="text-[9px] opacity-50">（暫無）</span>
          )}
          {snapshot?.date && (
            <span className="text-[9px] font-mono opacity-60">{snapshot.date.slice(5)}</span>
          )}
        </span>
        <span className="text-xs">{collapsed ? '▶' : '▼'}</span>
      </button>

      {!collapsed && (
        <div className="px-2.5 pb-1.5">
          {loading && (
            <div className="text-[10px] text-muted-foreground py-1">載入中…</div>
          )}
          {error && (
            <div className="text-[10px] text-rose-400 py-1">⚠️ {error}</div>
          )}
          {!loading && !error && totalCount === 0 && (
            <div className="text-[10px] text-muted-foreground/70 py-1">
              目前無觀察名單（F V 反轉 / N 型態確認觸發後會自動加入）
            </div>
          )}
          {!loading && !error && totalCount > 0 && (
            <div className="space-y-0.5 max-h-[40vh] overflow-y-auto">
              {(snapshot?.records ?? []).map((r) => (
                <LockWatchRow
                  key={`${r.symbol}-${r.triggerSignal}-${r.triggeredDate}`}
                  record={r}
                  onRemove={removeRecord}
                  removing={removingKey === `${r.symbol}-${r.triggerSignal}`}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LockWatchRow({
  record,
  onRemove,
  removing,
}: {
  record: LockWatchRecord;
  onRemove: (symbol: string, triggerSignal: 'F' | 'N') => void;
  removing: boolean;
}) {
  const sig = SIGNAL_LABEL[record.triggerSignal];
  const stage = STAGE_STYLE[record.currentStage];
  const patternName = record.patternType ? PATTERN_NAME[record.patternType] : null;
  const inWatchlist = useWatchlistStore((s) => s.has(record.symbol));
  // 已結束的紀錄（撤銷/移除/結構失效/已買進）不可再移除
  const canRemove =
    record.currentStage === 'observation' || record.currentStage === 'entry-signal';

  return (
    <div className="flex items-center gap-1.5 text-[10px] py-0.5 border-b border-border/30 last:border-0">
      <span
        className={`text-[8px] px-1 h-3.5 flex items-center rounded-sm shrink-0 ${sig.color}`}
        title={record.triggerSignal === 'N' && patternName ? `${sig.name}：${patternName}` : sig.name}
      >
        {record.triggerSignal}
      </span>
      <span className="font-mono shrink-0 w-12">{record.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '')}</span>
      {patternName && (
        <span className="text-[9px] text-muted-foreground shrink-0">{patternName}</span>
      )}
      <span className="font-mono text-[9px] text-muted-foreground shrink-0" title="觸發鎖定價">
        @{record.triggerPrice.toFixed(2)}
      </span>
      {record.patternTargetPrice != null && (
        <span className="font-mono text-[9px] text-emerald-400/80 shrink-0" title="型態目標價">
          →{record.patternTargetPrice.toFixed(2)}
        </span>
      )}
      {record.patternAchievementRate != null && (
        <span className="text-[9px] text-amber-300/80 shrink-0" title="型態達成率（書本）">
          {(record.patternAchievementRate * 100).toFixed(0)}%
        </span>
      )}
      <span className={`text-[9px] ml-auto shrink-0 ${stage.color}`}>{stage.label}</span>
      <span className="text-[9px] text-muted-foreground/60 font-mono shrink-0">
        +{record.daysObserved}d
      </span>
      {/* 🛒 進場：直接跳到 portfolio 進場表單帶入 v12 欄位 */}
      {(record.currentStage === 'observation' || record.currentStage === 'entry-signal') && (
        <button
          onClick={() => {
            const code = record.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
            const url = `/portfolio?prefill=${encodeURIComponent(code)}&trigger=${record.triggerSignal}&price=${record.triggerPrice}`;
            window.open(url, '_self');
          }}
          className="text-[9px] text-emerald-400 hover:text-emerald-300 px-1 rounded border border-emerald-700/50 hover:bg-emerald-900/30 shrink-0 font-bold"
          title={`🛒 進場：跳到持倉表單，自動填入 ${record.triggerSignal} 訊號 + 觸發價 ${record.triggerPrice.toFixed(2)}`}
        >
          🛒
        </button>
      )}
      {!inWatchlist && record.currentStage === 'entry-signal' && (
        <button
          onClick={() => useWatchlistStore.getState().add(record.symbol, record.symbol, record.triggerPrice)}
          className="text-[9px] text-amber-400 hover:text-amber-300 px-1 rounded border border-amber-700/50 hover:bg-amber-900/30 shrink-0"
          title="加入自選股"
        >
          +
        </button>
      )}
      {canRemove && (
        <button
          onClick={() => {
            if (confirm(`移除 ${record.symbol} ${sig.name}？`)) {
              onRemove(record.symbol, record.triggerSignal);
            }
          }}
          disabled={removing}
          className="text-[9px] text-rose-400 hover:text-rose-300 px-1 rounded border border-rose-700/50 hover:bg-rose-900/30 shrink-0 disabled:opacity-40"
          title="手動移除（議題 17）"
        >
          {removing ? '…' : '✕'}
        </button>
      )}
    </div>
  );
}
