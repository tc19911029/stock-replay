'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useScannerStore } from '@/store/scannerStore';
import { useWatchlistStore } from '@/store/watchlistStore';
import { useSettingsStore } from '@/store/settingsStore';
import ScanResultCard from '@/components/scanner/ScanResultCard';
import TodayPicks from '@/components/scanner/TodayPicks';
import { MarketId, StockScanResult } from '@/lib/scanner/types';

// ── Email notification hook ───────────────────────────────────────────────────
function useNotifyOnScanComplete(
  results: StockScanResult[],
  notifyEmail: string,
  minScore: number,
  market: MarketId,
) {
  const prevLen = useRef(0);
  const [notified, setNotified] = useState(false);

  useEffect(() => {
    if (results.length === 0 || results.length === prevLen.current) return;
    prevLen.current = results.length;
    setNotified(false);
    if (!notifyEmail) return;
    const hits = results.filter(r => r.sixConditionsScore >= minScore);
    if (hits.length === 0) return;
    fetch('/api/notify/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: notifyEmail, results: hits, market }),
    }).then(r => {
      if (r.ok) setNotified(true);
      else r.json().then(j => console.warn('通知發送失敗:', j)).catch(() => {});
    }).catch(e => console.warn('通知發送錯誤:', e));
  }, [results, notifyEmail, minScore, market]);

  return notified;
}

// ── AI report ─────────────────────────────────────────────────────────────────
function AiReport({ results }: { results: StockScanResult[] }) {
  const [report, setReport] = useState('');
  const [loading, setLoading] = useState(false);
  const [show, setShow] = useState(false);

  async function generate() {
    setLoading(true); setShow(true);
    const top5 = results.slice(0, 5).map(r =>
      `${r.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '')} ${r.name}：六大條件${r.sixConditionsScore}/6，趨勢${r.trendState}，位置${r.trendPosition}，漲跌${r.changePercent.toFixed(2)}%`
    ).join('\n');
    const prompt = `今日市場掃描結果（按朱老師六大條件評分）：\n\n${top5}\n\n請用繁體中文簡短分析這幾支股票的優先順序，以及今日市場整體狀況，不超過150字。`;
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], context: '' }),
      });
      if (!res.body) throw new Error('no body');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        setReport(text);
      }
    } catch {
      setReport('⚠ AI 分析失敗，請確認 API 金鑰已設定');
    } finally {
      setLoading(false);
    }
  }

  if (!show) {
    return (
      <button onClick={generate}
        className="w-full py-2 bg-purple-700/60 hover:bg-purple-600/80 border border-purple-600/40 rounded-lg text-xs font-bold text-purple-200 transition">
        🤖 生成 AI 分析報告（Top 5）
      </button>
    );
  }
  return (
    <div className="bg-slate-800 border border-purple-700/40 rounded-xl p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-bold text-purple-300">🤖 AI 分析報告</span>
        <button onClick={() => setShow(false)} className="text-slate-500 hover:text-slate-300 text-xs">✕</button>
      </div>
      {loading && !report && <p className="text-xs text-slate-400 animate-pulse">分析中...</p>}
      {report && <p className="text-xs text-slate-300 leading-relaxed whitespace-pre-wrap">{report}</p>}
    </div>
  );
}

// ── Scan info panel ────────────────────────────────────────────────────────────
function ScanInfoPanel({ minScore }: { minScore: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-slate-700 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-4 py-2.5 bg-slate-800/60 hover:bg-slate-800 text-xs font-bold text-slate-300 transition"
      >
        <span>掃描說明</span>
        <span className="text-slate-500 text-[10px]">{open ? '▲ 收起' : '▼ 展開'}</span>
      </button>
      {open && (
        <div className="px-4 py-3 bg-slate-900/60 space-y-2 text-xs text-slate-400">
          <div>
            <p className="text-slate-300 font-semibold mb-1">篩選條件</p>
            <p>• 朱老師六大條件 ≥{minScore} 分（趨勢、位置、K棒、均線、量能、指標）</p>
            <p>• 空頭趨勢股 / 乖離&gt;20% / KD&gt;88 自動排除</p>
          </div>
          <div>
            <p className="text-slate-300 font-semibold mb-1">飆股潛力分 (0-100)</p>
            <p>• 9 項子分數加權：動能加速(18%) + 波動擴張(12%) + 量能攀升(15%) + 突破型態(15%) + 趨勢品質(15%) + 長期品質(10%) + 價格位置(5%) + K棒力道(5%) + 指標共振(5%)</p>
            <p>• 等級：<span className="text-red-400">S(≥80)</span> <span className="text-orange-400">A(≥65)</span> <span className="text-yellow-400">B(≥50)</span> C(≥35) D(&lt;35)</p>
          </div>
          <div>
            <p className="text-slate-300 font-semibold mb-1">排序方式</p>
            <p>• <span className="text-blue-400">飆股潛力</span>：按潛力分排序（推薦）</p>
            <p>• <span className="text-blue-400">AI精選</span>：掃描後 AI 分析前15名，按 AI 判斷排序</p>
            <p>• 六大條件 / 漲跌幅 / 成交量：按對應欄位排序</p>
          </div>
          <div>
            <p className="text-slate-300 font-semibold mb-1">歷史勝率</p>
            <p>• 每支股票顯示過去 120 天內信號的 20 日勝率</p>
            <p>• <span className="text-green-400">綠色(≥65%)</span> = 信號可靠；<span className="text-red-400">紅色(&lt;50%)</span> = 歷史表現差，謹慎</p>
          </div>
          <div>
            <p className="text-slate-300 font-semibold mb-1">歷史日期掃描</p>
            <p>• 選擇過去的日期可模擬該日收盤後的掃描結果，用於驗證策略</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sort type ─────────────────────────────────────────────────────────────────
type SortKey = 'surge' | 'ai' | 'score' | 'change' | 'volume';

// ── Result stats banner ───────────────────────────────────────────────────────
function ResultStatsBanner({
  results,
  marketTrend,
}: {
  results: StockScanResult[];
  marketTrend: string | null;
}) {
  const maxScore = results.reduce((m, r) => Math.max(m, r.sixConditionsScore), 0);
  const avgScore = results.length > 0
    ? (results.reduce((s, r) => s + r.sixConditionsScore, 0) / results.length).toFixed(1)
    : '0.0';
  // 亞洲慣例：多頭=紅，空頭=綠
  const trendColor =
    marketTrend === '多頭' ? 'text-red-400' :
    marketTrend === '空頭' ? 'text-green-500' :
    'text-yellow-400';

  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-2.5 bg-slate-800/80 border border-slate-700 rounded-xl text-xs">
      <span className="text-slate-200 font-bold">找到 <span className="text-blue-400">{results.length}</span> 檔</span>
      <span className="text-slate-500">｜</span>
      <span className="text-slate-300">最高分 <span className="text-yellow-400 font-bold">{maxScore}/6</span></span>
      <span className="text-slate-500">｜</span>
      <span className="text-slate-300">平均分 <span className="text-slate-200 font-bold">{avgScore}/6</span></span>
      {marketTrend && (
        <>
          <span className="text-slate-500">｜</span>
          <span className="text-slate-300">大盤趨勢 <span className={`font-bold ${trendColor}`}>{marketTrend}</span></span>
        </>
      )}
    </div>
  );
}

// ── Sort controls ─────────────────────────────────────────────────────────────
function SortControls({ sort, setSort }: { sort: SortKey; setSort: (s: SortKey) => void }) {
  const options: Array<{ key: SortKey; label: string }> = [
    { key: 'surge',  label: '飆股潛力' },
    { key: 'ai',     label: 'AI精選' },
    { key: 'score',  label: '六大條件' },
    { key: 'change', label: '漲跌幅' },
    { key: 'volume', label: '成交量' },
  ];
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-[10px] text-slate-500">排序：</span>
      {options.map(o => (
        <button
          key={o.key}
          onClick={() => setSort(o.key)}
          className={`px-2.5 py-1 rounded-full text-[10px] font-bold border transition ${
            sort === o.key
              ? 'bg-blue-600 border-blue-500 text-white'
              : 'bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-500 hover:text-slate-300'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── Sort helper ───────────────────────────────────────────────────────────────
function sortResults(results: StockScanResult[], sort: SortKey): StockScanResult[] {
  const copy = [...results];
  if (sort === 'surge')  return copy.sort((a, b) => (b.surgeScore ?? 0) - (a.surgeScore ?? 0));
  if (sort === 'ai')     return copy.sort((a, b) => (a.aiRank ?? 999) - (b.aiRank ?? 999));
  if (sort === 'score')  return copy.sort((a, b) => b.sixConditionsScore - a.sixConditionsScore);
  if (sort === 'change') return copy.sort((a, b) => b.changePercent - a.changePercent);
  if (sort === 'volume') return copy.sort((a, b) => b.volume - a.volume);
  return copy;
}

// ── Market scan panel ─────────────────────────────────────────────────────────
function MarketPanel({ market, isActive }: { market: MarketId; isActive: boolean }) {
  const { getMarket, runScan, getHistory, setScanDate, aiRanking } = useScannerStore();
  const { add: addToWatchlist, has: inWatchlist } = useWatchlistStore();
  const { notifyEmail, notifyMinScore, getActiveStrategy } = useSettingsStore();
  const activeStrategy = getActiveStrategy();
  const state = getMarket(market);
  const history = getHistory(market);

  // Suppress Zustand persist hydration mismatch
  const [panelMounted, setPanelMounted] = useState(false);
  useEffect(() => setPanelMounted(true), []);

  const notified = useNotifyOnScanComplete(state.results, notifyEmail, notifyMinScore, market);

  // Track whether a scan has ever been attempted for this market this session
  const hasScanned = useRef(false);
  if (state.lastScanTime) hasScanned.current = true;

  const [sort, setSort] = useState<SortKey>('surge');
  const [minGrade, setMinGrade] = useState<string>('all');

  const LABEL = market === 'TW' ? '台灣股市' : '中國A股';
  const DESC   = market === 'TW'
    ? '當日成交量前500大台股（上市+上櫃）'
    : '滬深主板市值前500大（排除創業板/科創板/ST）';

  if (!isActive) return null;

  const gradeOrder = ['S', 'A', 'B', 'C', 'D'];
  const filtered = minGrade === 'all'
    ? state.results
    : state.results.filter(r => r.surgeGrade && gradeOrder.indexOf(r.surgeGrade) <= gradeOrder.indexOf(minGrade));
  const sorted = useMemo(() => sortResults(filtered, sort), [filtered, sort]);
  const sCount = state.results.filter(r => r.surgeGrade === 'S').length;
  const aCount = state.results.filter(r => r.surgeGrade === 'A').length;

  // Pagination
  const PAGE_SIZE = 50;
  const [page, setPage] = useState(0);
  const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
  const pagedResults = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  // Reset page when filter changes
  useEffect(() => { setPage(0); }, [minGrade, sort]);

  // Pre-compute surge ranks (avoid O(n²) in render loop)
  const surgeRankMap = useMemo(() => {
    const map = new Map<string, number>();
    [...state.results].sort((a, b) => (b.surgeScore ?? 0) - (a.surgeScore ?? 0))
      .forEach((r, i) => map.set(r.symbol, i));
    return map;
  }, [state.results]);

  return (
    <div className="space-y-4">
      {/* Scan trigger card */}
      <div className="bg-slate-800/80 border border-slate-700 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-bold">{LABEL} 掃描</h2>
              {panelMounted && (
                <Link href="/strategies" className="text-[10px] px-1.5 py-0.5 rounded bg-violet-900/60 text-violet-300 hover:bg-violet-800/60 transition">
                  策略：{activeStrategy.name}
                </Link>
              )}
              {panelMounted && state.marketTrend && (
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                  state.marketTrend === '多頭' ? 'bg-red-900/60 text-red-300' :
                  state.marketTrend === '空頭' ? 'bg-green-900/60 text-green-300' :
                  'bg-yellow-900/60 text-yellow-300'
                }`}>
                  大盤{state.marketTrend}
                  {state.marketTrend === '多頭' ? ` ▲ 門檻${activeStrategy.thresholds.bullMinScore}分` :
                   state.marketTrend === '空頭' ? ` ▼ 門檻${activeStrategy.thresholds.bearMinScore}分` :
                   ` → 門檻${activeStrategy.thresholds.sidewaysMinScore}分`}
                </span>
              )}
            </div>
            <p className="text-xs text-slate-500 mt-0.5">{DESC}</p>
            {panelMounted && state.lastScanTime && (
              <p className="text-xs text-slate-400 mt-0.5">
                上次掃描：{new Date(state.lastScanTime).toLocaleString('zh-TW')}
                {state.results.length > 0 && (
                  <span className="ml-2 text-blue-400">· {state.results.length} 檔符合</span>
                )}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {notified && (
              <span className="text-[10px] text-green-300 bg-green-900/40 px-1.5 py-0.5 rounded">✉ 通知已發送</span>
            )}
            <button
              onClick={() => runScan(market)}
              disabled={state.isScanning}
              className="px-5 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg text-sm font-bold transition"
            >
              {state.isScanning ? '掃描中...' : '開始掃描'}
            </button>
          </div>
        </div>

        {/* Date picker — optional historical date */}
        <div className="flex items-center gap-2 mt-3 mb-1">
          <label className="text-xs text-slate-400 shrink-0">掃描日期：</label>
          <input
            type="date"
            value={state.scanDate ?? ''}
            max={new Date().toISOString().split('T')[0]}
            onChange={e => setScanDate(market, e.target.value)}
            className="bg-slate-700 border border-slate-600 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500"
          />
          {state.scanDate && (
            <button
              onClick={() => setScanDate(market, '')}
              className="text-xs text-slate-500 hover:text-slate-300 transition"
            >
              ✕ 清除（改用最新）
            </button>
          )}
        </div>

        {/* Historical mode banner */}
        {state.scanDate && (
          <div className="flex items-center gap-2 px-3 py-2 bg-amber-900/40 border border-amber-700/50 rounded-lg text-xs text-amber-300 mt-2">
            <span className="text-sm">🕐</span>
            <span>歷史模式：模擬 {state.scanDate} 收盤後掃描</span>
          </div>
        )}

        {/* Scan info collapsible */}
        <ScanInfoPanel minScore={notifyMinScore ?? 4} />

        {state.isScanning && (
          <div className="space-y-1.5 mt-3">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>{state.scanningStock ? `正在掃描 ${state.scanningStock}` : '準備中...'}</span>
              <span>{state.scanningIndex > 0 && state.scanningTotal > 0 ? `${state.scanningIndex}/${state.scanningTotal}` : '...'}</span>
            </div>
            <div className="w-full bg-slate-700 rounded-full h-1.5">
              <div className="bg-blue-500 h-1.5 rounded-full transition-all duration-700"
                style={{ width: `${state.progress}%` }} />
            </div>
          </div>
        )}

        {state.error && <p className="text-xs text-red-400 mt-2">⚠ {state.error}</p>}
      </div>

      {/* Results (guard with panelMounted to prevent hydration mismatch from Zustand persist) */}
      {panelMounted && state.results.length > 0 && (
        <div className="space-y-2">
          {/* Stats banner */}
          <ResultStatsBanner results={state.results} marketTrend={state.marketTrend} />

          {/* Today's Picks — Top 3 recommendations */}
          <TodayPicks results={state.results} isLoading={state.isScanning} />

          {/* Sort controls + header + grade filter */}
          <div className="flex items-center justify-between px-1 flex-wrap gap-2">
            <h3 className="text-sm font-bold text-slate-200">
              掃描結果 <span className="text-blue-400">{filtered.length}</span>/{state.results.length} 檔
              {sCount > 0 && <span className="text-red-400 ml-2">S級:{sCount}</span>}
              {aCount > 0 && <span className="text-orange-400 ml-1">A級:{aCount}</span>}
              {aiRanking.isRanking && <span className="text-blue-400 ml-2 animate-pulse text-[10px]">AI分析中...</span>}
            </h3>
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-1">
                <span className="text-[10px] text-slate-500">篩選：</span>
                {['all', 'S', 'A', 'B'].map(g => (
                  <button key={g} onClick={() => setMinGrade(g)} className={`px-2 py-0.5 rounded-full text-[10px] font-bold border transition ${
                    minGrade === g ? 'bg-violet-600 border-violet-500 text-white' : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-300'
                  }`}>
                    {g === 'all' ? '全部' : `${g}級+`}
                  </button>
                ))}
              </div>
              <SortControls sort={sort} setSort={setSort} />
            </div>
          </div>

          <AiReport results={state.results} />

          {/* Pagination controls (top) */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 py-1">
              <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
                className="text-xs px-2 py-1 rounded bg-slate-800 text-slate-400 hover:bg-slate-700 disabled:opacity-30">← 上一頁</button>
              <span className="text-xs text-slate-500">{page + 1} / {totalPages}（共 {sorted.length} 檔）</span>
              <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
                className="text-xs px-2 py-1 rounded bg-slate-800 text-slate-400 hover:bg-slate-700 disabled:opacity-30">下一頁 →</button>
            </div>
          )}

          {pagedResults.map((r, idx) => {
            // Use AI rank if available, otherwise pre-computed surge rank
            const aiRank = r.aiRank;
            const surgeRank = surgeRankMap.get(r.symbol) ?? 999;
            const isTop3 = aiRank != null ? aiRank <= 3 : surgeRank < 3;
            const topNum = aiRank != null ? aiRank : surgeRank + 1;
            const crown   = ['🥇', '🥈', '🥉'][topNum - 1] ?? '';
            const watched = inWatchlist(r.symbol);
            const actions = (
              <>
                <button
                  onClick={e => { e.stopPropagation(); if (!watched) addToWatchlist(r.symbol, r.name); }}
                  className={`px-2 py-1 rounded text-xs font-bold transition ${
                    watched ? 'bg-yellow-500/20 text-yellow-400 cursor-default' : 'bg-slate-700 hover:bg-yellow-600/40 hover:text-yellow-300 text-slate-400'
                  }`}
                  title={watched ? '已在自選股' : '加入自選股'}
                >
                  {watched ? '⭐' : '☆'}
                </button>
                <Link
                  href={`/?load=${r.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '')}`}
                  className="px-2.5 py-1 bg-blue-600 hover:bg-blue-500 rounded text-xs font-bold text-white transition"
                >走圖 →</Link>
              </>
            );
            return (
              <div key={r.symbol} className={`relative mt-1 ${isTop3 ? 'ring-1 ring-yellow-500/60 rounded-xl' : ''}`}>
                {isTop3 && (
                  <div className="absolute -top-2 left-3 z-20">
                    <span className={`text-xs font-bold px-1.5 py-0.5 rounded-full leading-none ${
                      aiRank != null ? 'bg-blue-500 text-white' : 'bg-yellow-500 text-black'
                    }`}>
                      {crown} {aiRank != null ? `AI Top ${aiRank}` : `Top ${topNum}`}
                    </span>
                  </div>
                )}
                <ScanResultCard result={r} actions={actions} />
              </div>
            );
          })}

          {/* Pagination controls (bottom) */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 py-2">
              <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
                className="text-xs px-2 py-1 rounded bg-slate-800 text-slate-400 hover:bg-slate-700 disabled:opacity-30">← 上一頁</button>
              <span className="text-xs text-slate-500">{page + 1} / {totalPages}</span>
              <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
                className="text-xs px-2 py-1 rounded bg-slate-800 text-slate-400 hover:bg-slate-700 disabled:opacity-30">下一頁 →</button>
            </div>
          )}
        </div>
      )}

      {/* Empty states */}
      {panelMounted && !state.isScanning && state.results.length === 0 && (
        <div className="text-center py-10 text-slate-500">
          {hasScanned.current ? (
            <>
              <p className="text-3xl mb-2">😶</p>
              <p className="text-sm text-slate-400">今日市場條件嚴苛，無股票同時滿足 {notifyMinScore ?? 4} 大條件</p>
              <p className="text-xs text-slate-500 mt-1">請降低最低分數門檻或選擇其他日期</p>
            </>
          ) : (
            <>
              <p className="text-3xl mb-2">🔍</p>
              <p className="text-sm">點擊「開始掃描」尋找符合朱老師六大條件的股票</p>
              {!notifyEmail && (
                <Link href="/settings" className="mt-2 inline-block text-xs text-blue-400 hover:text-blue-300 transition">
                  📧 設定 Email 通知，掃描完自動發送 →
                </Link>
              )}
            </>
          )}
        </div>
      )}

      {/* Recent history */}
      {panelMounted && history.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between px-1">
            <h3 className="text-sm font-bold text-slate-400">近期掃描記錄</h3>
            <Link href="/scanner/history" className="text-xs text-blue-400 hover:text-blue-300 transition">
              查看全部 →
            </Link>
          </div>
          {history.slice(0, 3).map(s => (
            <Link
              key={s.id}
              href={`/scanner/history?market=${market}&id=${s.id}`}
              className="flex items-center justify-between bg-slate-800/60 border border-slate-700 hover:border-blue-500 rounded-lg px-4 py-2 text-xs transition"
            >
              <span className="text-slate-300">{s.date}</span>
              <span className="text-blue-400 font-bold">{s.resultCount} 檔符合</span>
              <span className="text-slate-500">{new Date(s.scanTime).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function ScannerPage() {
  const { activeMarket, setActiveMarket, getMarket } = useScannerStore();
  const tw = getMarket('TW');
  const cn = getMarket('CN');

  // Suppress hydration mismatch from Zustand persist (localStorage differs from SSR)
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const MARKETS: Array<{ id: MarketId; label: string }> = [
    { id: 'TW', label: '台灣股市' },
    { id: 'CN', label: '中國A股' },
  ];

  return (
    <div className="min-h-screen bg-[#0b1120] text-white">
      <header className="border-b border-slate-800 px-4 py-2.5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-slate-400 hover:text-white text-sm transition">← 返回走圖</Link>
          <span className="text-base font-bold">🔍 市場掃描</span>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/backtest" className="text-xs text-violet-400 hover:text-violet-300 transition">📅 歷史回測</Link>
          <Link href="/watchlist" className="text-xs text-slate-400 hover:text-white transition">⭐ 自選</Link>
          <Link href="/settings" className="text-xs text-slate-400 hover:text-white transition">⚙ 設定</Link>
          <Link href="/scanner/history" className="text-xs text-slate-400 hover:text-white transition">歷史 →</Link>
        </div>
      </header>

      <div className="p-4 space-y-4 max-w-3xl mx-auto">

        {/* Market tabs — show scan status badges */}
        <div className="flex gap-2">
          {MARKETS.map(m => {
            const s = m.id === 'TW' ? tw : cn;
            return (
              <button key={m.id} onClick={() => setActiveMarket(m.id)}
                className={`flex-1 rounded-xl border px-4 py-3 text-left transition ${
                  activeMarket === m.id ? 'border-blue-500 bg-blue-600/20' : 'border-slate-700 bg-slate-800/60 hover:border-slate-600'
                }`}>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-bold">{m.label}</span>
                  {mounted && s.isScanning && (
                    <span className="text-[10px] bg-blue-600 text-white px-1.5 py-0.5 rounded-full animate-pulse">掃描中</span>
                  )}
                  {mounted && !s.isScanning && s.results.length > 0 && (
                    <span className="text-[10px] bg-green-700/60 text-green-300 px-1.5 py-0.5 rounded-full">{s.results.length} 檔</span>
                  )}
                </div>
                {mounted && s.lastScanTime && !s.isScanning && (
                  <div className="text-[10px] text-slate-500 mt-0.5">
                    {new Date(s.lastScanTime).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {/* Active market panel */}
        <MarketPanel market={activeMarket} isActive={true} />

      </div>
    </div>
  );
}
