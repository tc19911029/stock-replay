'use client';

/**
 * LockWatch 鎖股觀察名單面板（v12 Phase 1.6）
 *
 * 顯示 F V 反轉 / N 型態確認觸發後的觀察階段股票。
 * 議題 23/65/93/61：F/N 走 LockWatch；單檔合併寫入。
 *
 * 收合預設關閉（避免占主畫面）；展開後顯示當日 active 紀錄。
 */

import { useEffect, useState, useCallback, useMemo } from 'react';
import type { LockWatchRecord } from '@/lib/scanner/lockWatchTypes';
import type { SelectedStock } from './ScanChartPanel';
import { useWatchlistStore } from '@/store/watchlistStore';
import { LETTER_NAMES } from '@/lib/scanner/buyMethodTracks';
import { useLockwatchSnapshot } from '@/lib/hooks/useLockwatchSnapshot';

interface LockWatchPanelProps {
  market: 'TW' | 'CN';
  onSelectStock?: (stock: SelectedStock) => void;
}

// 字母→名稱讀 lib/scanner/buyMethodTracks.ts 單一事實來源
const SIGNAL_LABEL: Record<'F' | 'N', { name: string; color: string }> = {
  F: { name: LETTER_NAMES.F, color: 'bg-rose-800/80 text-rose-300' },
  N: { name: LETTER_NAMES.N, color: 'bg-indigo-800/80 text-indigo-300' },
};

const PATTERN_NAME: Record<NonNullable<LockWatchRecord['patternType']>, string> = {
  'head-shoulder': '頭肩底',
  'complex-head-shoulder': '複式頭肩底',
  'triple-bottom': '三重底',
  'falling-diamond': '跌菱形',
  'rounding-bottom': '圓弧底',
  'descending-wedge': '下降楔形',
  'double-bottom': '雙重底',
  'n-shape': 'N 字底',
  'head-shoulder-top': '頭肩頂',
  'triple-top': '三重頂',
  'double-top': '雙重頂',
};

// 2026-05-13 對齊書本：observation = 觸發書本進場條件（已可進場）；
// pending-breakout / entry-signal 為舊資料 stage，向下相容顯示
const STAGE_STYLE: Record<LockWatchRecord['currentStage'], { label: string; color: string }> = {
  observation: { label: '已觸發', color: 'text-emerald-300 font-bold' },
  'pending-breakout': { label: '舊資料（已棄）', color: 'text-muted-foreground/60' },
  'entry-signal': { label: '已觸發', color: 'text-emerald-300 font-bold' },
  purchased: { label: '已買進', color: 'text-sky-300' },
  revoked: { label: '已撤銷', color: 'text-muted-foreground/60 line-through' },
  'manually-removed': { label: '手動移除', color: 'text-muted-foreground/60 line-through' },
  'structure-broken': { label: '結構失效', color: 'text-rose-400/70 line-through' },
};

export function LockWatchPanel({ market, onSelectStock }: LockWatchPanelProps) {
  const [collapsed, setCollapsed] = useState(true);
  const { snapshot, loading, error, reload } = useLockwatchSnapshot(market);
  const [removingKey, setRemovingKey] = useState<string | null>(null);
  // 股票名稱對照（symbol → name），lockwatch record 沒存 name 欄位，UI 端從 stock list API 拉
  const [nameMap, setNameMap] = useState<Record<string, string>>({});
  // 排序設定
  type SortKey = 'signal' | 'symbol' | 'name' | 'pattern' | 'triggerPrice' | 'currentClose' | 'upside' | 'achievement' | 'stage' | 'triggeredDate' | 'days';
  const [sortKey, setSortKey] = useState<SortKey>('upside');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [favFirst, setFavFirst] = useState(false);
  const watchlistItems = useWatchlistStore((s) => s.items);  // 訂閱以便 toggle 自選後重新排序
  const inWatchlistSet = useMemo(() => new Set(watchlistItems.map(i => i.symbol)), [watchlistItems]);
  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(k); setSortDir('desc'); }
  };
  const sortIndicator = (k: SortKey) => sortKey === k ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';

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
          await reload();
        }
      } catch (err) {
        alert(`移除失敗：${String(err)}`);
      } finally {
        setRemovingKey(null);
      }
    },
    [market, reload],
  );

  // 2026-05-13 對齊書本：書本沒有 pending-breakout 概念，從 active 隱藏
  // observation = 已觸發書本進場條件；entry-signal 為舊資料 alias
  const activeRecords = (snapshot?.records ?? []).filter(
    (r) => r.currentStage === 'observation' || r.currentStage === 'entry-signal',
  );
  const activeCount = activeRecords.length;
  const totalCount = snapshot?.records.length ?? 0;

  // 2026-05-13 對齊書本：observation = 已觸發書本進場條件（最高優先）
  const STAGE_ORDER: Record<LockWatchRecord['currentStage'], number> = {
    observation: 0,
    'entry-signal': 0,        // 舊資料 alias
    'pending-breakout': 1,    // 舊資料：還沒過真突破，排次優
    purchased: 2,
    'manually-removed': 3,
    revoked: 4,
    'structure-broken': 5,
  };

  const sortedRecords = useMemo(() => {
    // 0514 用戶反饋：結構失效不要顯示（型態已死，留著佔版面）。已撤銷/手動移除留著當「軟失敗」紀錄
    const arr = (snapshot?.records ?? []).filter(r => r.currentStage !== 'structure-broken');
    arr.sort((a, b) => {
      // 自選優先（toggle 開時）
      if (favFirst) {
        const af = inWatchlistSet.has(a.symbol) ? 0 : 1;
        const bf = inWatchlistSet.has(b.symbol) ? 0 : 1;
        if (af !== bf) return af - bf;
      }
      let cmp = 0;
      switch (sortKey) {
        case 'signal': cmp = a.triggerSignal.localeCompare(b.triggerSignal); break;
        case 'symbol': cmp = a.symbol.localeCompare(b.symbol); break;
        case 'name': cmp = (nameMap[a.symbol] ?? '').localeCompare(nameMap[b.symbol] ?? ''); break;
        case 'pattern': cmp = (a.patternType ?? '').localeCompare(b.patternType ?? ''); break;
        case 'triggerPrice': cmp = a.triggerPrice - b.triggerPrice; break;
        case 'currentClose': {
          const aC = a.currentClose ?? -Infinity;
          const bC = b.currentClose ?? -Infinity;
          cmp = aC - bC;
          break;
        }
        case 'upside': {
          // Phase D：用現價算到目標的爬升空間（跟 UI 顯示一致）
          const aRef = a.currentClose ?? a.triggerPrice;
          const bRef = b.currentClose ?? b.triggerPrice;
          const aU = a.patternTargetPrice && aRef > 0
            ? (a.patternTargetPrice - aRef) / aRef
            : -Infinity;
          const bU = b.patternTargetPrice && bRef > 0
            ? (b.patternTargetPrice - bRef) / bRef
            : -Infinity;
          cmp = aU - bU;
          break;
        }
        case 'achievement': cmp = (a.patternAchievementRate ?? 0) - (b.patternAchievementRate ?? 0); break;
        case 'stage': cmp = (STAGE_ORDER[a.currentStage] ?? 99) - (STAGE_ORDER[b.currentStage] ?? 99); break;
        case 'triggeredDate': cmp = a.triggeredDate.localeCompare(b.triggeredDate); break;
        case 'days': cmp = a.daysObserved - b.daysObserved; break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [snapshot, sortKey, sortDir, favFirst, nameMap, inWatchlistSet]);

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
        title="反轉訊號觸發紀錄：型態確認（突破頸線，書本《寶典》Part 11-1 #7「等型態確認」p.697）、V 反轉（書本《抓住K線》V 反轉戰法）。書本明寫觸發當下即進場訊號。本表保留紀錄是為了走圖鎖定型態+頸線+目標價、以及進場按鈕一鍵帶入持倉。"
      >
        <span className="flex items-center gap-1.5">
          <span className="font-semibold">反轉訊號紀錄</span>
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
          {/* 對齊書本：型態確認 / V 反轉 觸發即進場訊號（寶典 Part 11-1 #7 + 抓住K線 V 反轉戰法） */}
          <div className="text-[10px] text-emerald-200/80 bg-emerald-900/15 border border-emerald-700/30 rounded px-2 py-1 my-1.5 leading-relaxed space-y-1">
            <div>
              <span className="font-bold text-emerald-300">這是「已觸發」紀錄</span>：
              <span className="font-semibold ml-1">型態確認</span>＝突破頸線（書本 8 種底部型態，《寶典》Part 11-1 第 7 位置 p.697「型態確認上漲大量紅 K」）；
              <span className="font-semibold ml-1">V 反轉</span>＝反轉戰法（《抓住K線》4 條件：連跌+變盤線止跌+紅K帶量+突破前K高）。
              <span className="font-semibold">書本明寫觸發當下即進場訊號。</span>
            </div>
            <div className="text-muted-foreground/80">
              本表保留紀錄是為了：(1) 點代號開走圖時鎖定型態 chip+頸線+目標價（標「鎖定」不跳動）；(2) 一鍵進場帶入持倉的 entryPattern 凍結。
            </div>
          </div>
          {/* 排序選項列 */}
          <div className="flex items-center gap-2 py-1.5 text-[10px]">
            <span className="text-muted-foreground/60">排序：</span>
            <button
              onClick={() => setFavFirst(v => !v)}
              className={`px-1.5 py-0.5 rounded font-medium transition ${
                favFirst
                  ? 'bg-amber-700/60 text-amber-100'
                  : 'bg-secondary text-muted-foreground/70 hover:text-foreground'
              }`}
              title="開啟後，已加自選的 row 永遠排在最前面"
            >
              {favFirst ? '✓ 自選優先' : '自選優先'}
            </button>
            <span className="text-muted-foreground/40">|</span>
            <span className="text-muted-foreground/60 text-[9px]">表頭點擊切換排序欄位</span>
          </div>
          {loading && (
            <div className="text-[10px] text-muted-foreground py-1">載入中…</div>
          )}
          {error && (
            <div className="text-[10px] text-rose-400 py-1">⚠️ {error}</div>
          )}
          {!loading && !error && totalCount === 0 && (
            <div className="text-[10px] text-muted-foreground/70 py-1">
              目前無反轉訊號紀錄（書本：V 反轉 / 型態確認 觸發後會自動加入）
            </div>
          )}
          {!loading && !error && totalCount > 0 && (
            <div className="overflow-x-auto max-h-[40vh] overflow-y-auto">
              {/* 整表禁止換行（td/th 都套 whitespace-nowrap）— 避免「型態確認」、按鈕擠成兩行 */}
              <table className="w-full text-[11px] [&_th]:whitespace-nowrap [&_td]:whitespace-nowrap">
                <thead className="text-[11px] text-muted-foreground border-b border-border/50 sticky top-0 bg-card">
                  <tr>
                    <th onClick={() => toggleSort('signal')}
                        className="text-left py-1.5 px-2 cursor-pointer hover:text-foreground select-none"
                        title="觸發類型：V 反轉（變盤線止跌+紅K突破）/ 型態確認（書本 25 種底部型態）。點擊排序">
                      訊號{sortIndicator('signal')}
                    </th>
                    <th onClick={() => toggleSort('symbol')}
                        className="text-left py-1.5 px-2 cursor-pointer hover:text-foreground select-none"
                        title="點擊排序">
                      代號{sortIndicator('symbol')}
                    </th>
                    <th onClick={() => toggleSort('name')}
                        className="text-left py-1.5 px-2 cursor-pointer hover:text-foreground select-none"
                        title="點擊排序">
                      名稱{sortIndicator('name')}
                    </th>
                    <th onClick={() => toggleSort('pattern')}
                        className="text-left py-1.5 px-2 cursor-pointer hover:text-foreground select-none"
                        title="型態確認訊號的具體型態。點擊排序">
                      型態{sortIndicator('pattern')}
                    </th>
                    <th onClick={() => toggleSort('triggerPrice')}
                        className="text-center py-1.5 px-2 cursor-pointer hover:text-foreground select-none"
                        title="型態確認=突破時的型態頸線價；V 反轉=反彈起點 close。點擊排序">
                      鎖定價{sortIndicator('triggerPrice')}
                    </th>
                    <th onClick={() => toggleSort('currentClose')}
                        className="text-center py-1.5 px-2 cursor-pointer hover:text-foreground select-none"
                        title="現價（每日 cron 維護的最近 close）+ 相對鎖定價的漲跌幅。點擊排序">
                      現價{sortIndicator('currentClose')}
                    </th>
                    <th onClick={() => toggleSort('upside')}
                        className="text-center py-1.5 px-2 cursor-pointer hover:text-foreground select-none"
                        title="目標價及爬升空間（從現價算起，反映「現在進場到目標還能賺多少」）。點擊按爬升空間排序">
                      目標價{sortIndicator('upside')}
                    </th>
                    <th onClick={() => toggleSort('achievement')}
                        className="text-center py-1.5 px-2 cursor-pointer hover:text-foreground select-none"
                        title="書本明寫的型態達成率（《抓飆股》p.314-342）。點擊排序">
                      達成率{sortIndicator('achievement')}
                    </th>
                    <th onClick={() => toggleSort('stage')}
                        className="text-center py-1.5 px-2 cursor-pointer hover:text-foreground select-none"
                        title="已觸發 / 已買進 / 已撤銷 / 手動移除。結構失效不顯示（型態已死直接濾掉）。點擊排序">
                      階段{sortIndicator('stage')}
                    </th>
                    <th onClick={() => toggleSort('triggeredDate')}
                        className="text-center py-1.5 px-2 cursor-pointer hover:text-foreground select-none"
                        title="該記錄被鎖定（觸發 LockWatch）的日期。點擊排序">
                      觸發日{sortIndicator('triggeredDate')}
                    </th>
                    <th onClick={() => toggleSort('days')}
                        className="text-center py-1.5 px-2 cursor-pointer hover:text-foreground select-none"
                        title="觸發後經過的交易日數。點擊排序">
                      天數{sortIndicator('days')}
                    </th>
                    <th className="text-center py-1.5 px-2 min-w-[110px]">動作</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedRecords.map((r) => (
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
  const inWatchlist = useWatchlistStore((s) => s.has(record.symbol));
  // 2026-05-13 對齊書本：pending-breakout 不再 active，移除按鈕只對 observation/entry-signal 顯示
  const canRemove =
    record.currentStage === 'observation' || record.currentStage === 'entry-signal';
  const symbolBare = record.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
  // Phase D：用現價算到目標價的爬升空間（從現價買進到目標還能賺多少）
  const refPrice = record.currentClose ?? record.triggerPrice;
  const upsidePct =
    record.patternTargetPrice != null && refPrice > 0
      ? ((record.patternTargetPrice - refPrice) / refPrice) * 100
      : null;
  // 現價相對鎖定價的漲幅（看現在已經漲多少）
  const closeVsTriggerPct =
    record.currentClose != null && record.triggerPrice > 0
      ? ((record.currentClose - record.triggerPrice) / record.triggerPrice) * 100
      : null;

  // 點代號 / 名稱 → 切到走圖
  const handleSelect = () => {
    onSelect?.({ symbol: record.symbol, name: name || symbolBare, market });
  };

  return (
    <tr className="border-b border-border/30 hover:bg-muted/20">
      <td className="whitespace-nowrap py-1.5 px-2">
        {/* 訊號 badge 跟其他列字體統一 [11px] */}
        <span className={`inline-block text-[11px] px-1.5 py-0.5 rounded-sm ${sig.color}`} title={sig.name}>
          {sig.name}
        </span>
      </td>
      <td
        className="py-1.5 px-2 font-mono cursor-pointer hover:text-sky-300"
        onClick={handleSelect}
        title="點擊切換到走圖"
      >
        {symbolBare}
      </td>
      <td
        className="py-1.5 px-2 truncate max-w-[6rem] cursor-pointer hover:text-sky-300"
        onClick={handleSelect}
        title="點擊切換到走圖"
      >
        {name || '—'}
      </td>
      <td className="whitespace-nowrap py-1.5 px-2 text-muted-foreground">{patternName ?? '—'}</td>
      <td className="whitespace-nowrap py-1.5 px-2 text-center font-mono tabular-nums">
        {record.triggerPrice.toFixed(2)}
      </td>
      {/* Phase D：現價（每日 cron 維護的最近 close） */}
      <td
        className="whitespace-nowrap py-1.5 px-2 text-center font-mono tabular-nums"
        title={
          record.currentClose != null
            ? `最近一次更新時 close = ${record.currentClose.toFixed(2)}（每日 cron 自動維護）`
            : '尚未有 cron update，現價未維護'
        }
      >
        {record.currentClose != null ? (
          <>
            {record.currentClose.toFixed(2)}
            {closeVsTriggerPct != null && (
              <span className={`ml-1 ${closeVsTriggerPct >= 0 ? 'text-rose-300/70' : 'text-emerald-300/70'}`}>
                {closeVsTriggerPct >= 0 ? '+' : ''}{closeVsTriggerPct.toFixed(1)}%
              </span>
            )}
          </>
        ) : (
          <span className="text-muted-foreground/40">—</span>
        )}
      </td>
      {/* 目標價 + 爬升空間 %（Phase D：基準改為現價，反映「現在進場到目標還能賺多少」） */}
      <td
        className="whitespace-nowrap py-1.5 px-2 text-center font-mono tabular-nums text-emerald-400/80"
        title={
          upsidePct != null
            ? `型態目標價 ${record.patternTargetPrice!.toFixed(2)}（從現價 ${refPrice.toFixed(2)} 爬升 ${upsidePct >= 0 ? '+' : ''}${upsidePct.toFixed(1)}%）`
            : undefined
        }
      >
        {record.patternTargetPrice != null ? (
          <>
            {record.patternTargetPrice.toFixed(2)}
            {upsidePct != null && (
              <span className={`ml-1 ${upsidePct >= 0 ? 'text-emerald-300/70' : 'text-rose-400/70'}`}>
                {upsidePct >= 0 ? '+' : ''}{upsidePct.toFixed(1)}%
              </span>
            )}
          </>
        ) : (
          '—'
        )}
      </td>
      <td className="whitespace-nowrap py-1.5 px-2 text-center font-mono tabular-nums text-amber-300/80">
        {record.patternAchievementRate != null
          ? `${(record.patternAchievementRate * 100).toFixed(0)}%`
          : '—'}
      </td>
      <td className={`whitespace-nowrap py-1.5 px-2 text-center ${stage.color}`}>
        {stage.label}
      </td>
      <td className="whitespace-nowrap py-1.5 px-2 text-center font-mono text-muted-foreground/80 text-[10px]">
        {record.triggeredDate.slice(5)}
      </td>
      <td className="whitespace-nowrap py-1.5 px-2 text-center font-mono text-muted-foreground/60">
        {record.daysObserved}d
      </td>
      {/* 動作欄：3 個按鈕統一同寬 + 同 padding，固定 min-w-[110px] 防擠 */}
      <td className="whitespace-nowrap py-1.5 px-2">
        <div className="flex items-center justify-center gap-1 min-w-[100px]">
          {canRemove ? (
            <button
              onClick={() => {
                // 帶上鎖股的型態 + 頸線 + 目標價 + 結構失效價 → /portfolio 寫入 holding.entryPattern
                // 議題 C2：避免 Step 5 停利目標每日重算跳動
                const ep = new URLSearchParams({
                  prefill: symbolBare,
                  trigger: record.triggerSignal,
                  price: String(record.triggerPrice),
                });
                if (record.patternType) ep.set('patternType', record.patternType);
                // N 訊號：triggerPrice = 頸線價（書本撤銷判定基準）
                if (record.triggerSignal === 'N') ep.set('neckline', String(record.triggerPrice));
                if (record.patternTargetPrice != null) ep.set('target', String(record.patternTargetPrice));
                // F 訊號：vBottom = 結構失效價（跌破即出場）
                if (record.vBottom != null) ep.set('stop', String(record.vBottom));
                window.open(`/portfolio?${ep.toString()}`, '_self');
              }}
              className="shrink-0 px-2 py-0.5 rounded border border-emerald-700/50 text-emerald-400 hover:text-emerald-300 hover:bg-emerald-900/30 font-bold"
              title={`進場：跳到持倉表單，自動填入 ${sig.name} 訊號 + 觸發價 ${record.triggerPrice.toFixed(2)}`}
            >
              進場
            </button>
          ) : <span className="w-[42px]" />}
          {/* 自選 toggle — 加入/移除自選股；不可動的記錄佔位保持等寬 */}
          {canRemove ? (
            inWatchlist ? (
              <button
                onClick={() => useWatchlistStore.getState().remove(record.symbol)}
                className="shrink-0 px-2 py-0.5 rounded border border-amber-700/50 bg-amber-900/30 text-amber-300 hover:bg-amber-900/50 font-bold"
                title={`已在自選股，點擊取消（${symbolBare}）`}
              >
                ✓自選
              </button>
            ) : (
              <button
                onClick={() =>
                  useWatchlistStore.getState().add(record.symbol, name || record.symbol, record.triggerPrice)
                }
                className="shrink-0 px-2 py-0.5 rounded border border-amber-700/50 text-amber-400 hover:text-amber-300 hover:bg-amber-900/30 font-bold"
                title={`加入自選股（${symbolBare} 觸發價 ${record.triggerPrice.toFixed(2)}）`}
              >
                自選
              </button>
            )
          ) : <span className="w-[36px]" />}
          {canRemove ? (
            <button
              onClick={() => {
                if (confirm(`移除 ${symbolBare} ${sig.name}？`)) {
                  onRemove(record.symbol, record.triggerSignal);
                }
              }}
              disabled={removing}
              className="shrink-0 px-1.5 py-0.5 rounded border border-rose-700/50 text-rose-400 hover:text-rose-300 hover:bg-rose-900/30 disabled:opacity-40"
              title="手動移除"
            >
              {removing ? '…' : '✕'}
            </button>
          ) : <span className="w-[22px]" />}
        </div>
      </td>
    </tr>
  );
}
