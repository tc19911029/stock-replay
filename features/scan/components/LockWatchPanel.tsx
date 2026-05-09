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
import type { LockWatchDailySnapshot, LockWatchRecord } from '@/lib/scanner/lockWatchTypes';
import type { SelectedStock } from './ScanChartPanel';

interface LockWatchPanelProps {
  market: 'TW' | 'CN';
  onSelectStock?: (stock: SelectedStock) => void;
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

export function LockWatchPanel({ market, onSelectStock }: LockWatchPanelProps) {
  const [collapsed, setCollapsed] = useState(true);
  const [snapshot, setSnapshot] = useState<LockWatchDailySnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removingKey, setRemovingKey] = useState<string | null>(null);
  // 股票名稱對照（symbol → name），lockwatch record 沒存 name 欄位，UI 端從 stock list API 拉
  const [nameMap, setNameMap] = useState<Record<string, string>>({});

  // 拉股票名稱對照表（每市場一次，cache 在 component state）
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/scanner/list?market=${market}`)
      .then((r) => r.json())
      .then((j: { ok?: boolean; stocks?: Array<{ symbol: string; name: string }> }) => {
        if (cancelled || !j.ok || !j.stocks) return;
        const map: Record<string, string> = {};
        for (const s of j.stocks) map[s.symbol] = s.name;
        setNameMap(map);
      })
      .catch(() => { /* fallback 顯示空名稱 */ });
    return () => { cancelled = true; };
  }, [market]);

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

  // 沒任何 active record 時整個區塊不渲染（避免「暫無」一行佔版面）
  // loading / error 時保留顯示
  if (!loading && !error && activeCount === 0) {
    return null;
  }

  return (
    <div className="border-b border-border/60">
      <button
        onClick={() => setCollapsed((v) => !v)}
        className={`w-full flex items-center justify-between px-2.5 py-1 text-[11px] hover:bg-muted/40 transition-colors ${
          activeCount > 0
            ? 'bg-amber-900/30 text-amber-200 hover:bg-amber-900/40'
            : 'text-muted-foreground hover:text-foreground'
        }`}
        title="F V 反轉 / N 型態確認 觸發後自動加入觀察名單，等趨勢確認再進場"
      >
        <span className="flex items-center gap-1.5">
          <span className="font-semibold">鎖股觀察</span>
          <span className="text-[10px] font-mono bg-amber-700 text-amber-100 px-1.5 py-px rounded font-bold">
            {activeCount} 檔
          </span>
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
            <div className="overflow-x-auto max-h-[40vh] overflow-y-auto">
              <table className="w-full text-[11px]">
                <thead className="text-[10px] text-muted-foreground border-b border-border/50 sticky top-0 bg-card">
                  <tr>
                    <th className="text-left py-1 px-1.5">訊號</th>
                    <th className="text-left py-1 px-1.5">代號</th>
                    <th className="text-left py-1 px-1.5">名稱</th>
                    <th className="text-left py-1 px-1.5">型態</th>
                    <th className="text-right py-1 px-1.5" title="觸發鎖定價">鎖定價</th>
                    <th className="text-right py-1 px-1.5" title="型態目標價（書本）">目標價</th>
                    <th className="text-right py-1 px-1.5" title="型態達成率">達成率</th>
                    <th className="text-center py-1 px-1.5">階段</th>
                    <th className="text-right py-1 px-1.5" title="觀察天數">天</th>
                    <th className="text-center py-1 px-1.5">動作</th>
                  </tr>
                </thead>
                <tbody>
                  {(snapshot?.records ?? []).map((r) => (
                    <LockWatchTableRow
                      key={`${r.symbol}-${r.triggerSignal}-${r.triggeredDate}`}
                      record={r}
                      name={nameMap[r.symbol] ?? ''}
                      market={market}
                      onRemove={removeRecord}
                      onSelect={onSelectStock}
                      removing={removingKey === `${r.symbol}-${r.triggerSignal}`}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LockWatchTableRow({
  record,
  name,
  market,
  onRemove,
  onSelect,
  removing,
}: {
  record: LockWatchRecord;
  name: string;
  market: 'TW' | 'CN';
  onRemove: (symbol: string, triggerSignal: 'F' | 'N') => void;
  onSelect?: (stock: SelectedStock) => void;
  removing: boolean;
}) {
  const sig = SIGNAL_LABEL[record.triggerSignal];
  const stage = STAGE_STYLE[record.currentStage];
  const patternName = record.patternType ? PATTERN_NAME[record.patternType] : null;
  // 已結束的紀錄（撤銷/移除/結構失效/已買進）不可再移除
  const canRemove =
    record.currentStage === 'observation' || record.currentStage === 'entry-signal';
  const symbolBare = record.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');

  // 點代號 / 名稱 → 切到走圖
  const handleSelect = () => {
    onSelect?.({ symbol: record.symbol, name: name || symbolBare, market });
  };

  return (
    <tr className="border-b border-border/30 hover:bg-muted/20">
      <td className="py-1 px-1.5">
        {/* 訊號用中文名（V反轉 / 型態確認）取代 F/N 字母 */}
        <span className={`text-[9px] px-1 py-0.5 rounded-sm ${sig.color}`} title={`${sig.name} (${record.triggerSignal})`}>
          {sig.name}
        </span>
      </td>
      <td
        className="py-1 px-1.5 font-mono cursor-pointer hover:text-sky-300"
        onClick={handleSelect}
        title="點擊切換到走圖"
      >
        {symbolBare}
      </td>
      <td
        className="py-1 px-1.5 truncate max-w-[6rem] cursor-pointer hover:text-sky-300"
        onClick={handleSelect}
        title="點擊切換到走圖"
      >
        {name || '—'}
      </td>
      <td className="py-1 px-1.5 text-muted-foreground">{patternName ?? '—'}</td>
      <td className="py-1 px-1.5 text-right font-mono tabular-nums">
        {record.triggerPrice.toFixed(2)}
      </td>
      <td className="py-1 px-1.5 text-right font-mono tabular-nums text-emerald-400/80">
        {record.patternTargetPrice != null ? record.patternTargetPrice.toFixed(2) : '—'}
      </td>
      <td className="py-1 px-1.5 text-right font-mono tabular-nums text-amber-300/80">
        {record.patternAchievementRate != null
          ? `${(record.patternAchievementRate * 100).toFixed(0)}%`
          : '—'}
      </td>
      <td className={`py-1 px-1.5 text-center text-[10px] ${stage.color}`}>
        {stage.label}
      </td>
      <td className="py-1 px-1.5 text-right font-mono text-muted-foreground/60 text-[10px]">
        {record.daysObserved}d
      </td>
      <td className="py-1 px-1.5">
        <div className="flex items-center justify-center gap-1">
          {(record.currentStage === 'observation' || record.currentStage === 'entry-signal') && (
            <button
              onClick={() => {
                const url = `/portfolio?prefill=${encodeURIComponent(symbolBare)}&trigger=${record.triggerSignal}&price=${record.triggerPrice}`;
                window.open(url, '_self');
              }}
              className="text-[10px] text-emerald-400 hover:text-emerald-300 px-1.5 rounded border border-emerald-700/50 hover:bg-emerald-900/30 font-bold"
              title={`進場：跳到持倉表單，自動填入 ${record.triggerSignal} 訊號 + 觸發價 ${record.triggerPrice.toFixed(2)}`}
            >
              進場
            </button>
          )}
          {canRemove && (
            <button
              onClick={() => {
                if (confirm(`移除 ${symbolBare} ${sig.name}？`)) {
                  onRemove(record.symbol, record.triggerSignal);
                }
              }}
              disabled={removing}
              className="text-[10px] text-rose-400 hover:text-rose-300 px-1 rounded border border-rose-700/50 hover:bg-rose-900/30 disabled:opacity-40"
              title="手動移除"
            >
              {removing ? '…' : '✕'}
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}
