'use client';

import { useEffect, useRef, useState } from 'react';
import type { StockScanResult } from '@/lib/scanner/types';

/** localStorage：以 market:scanDate:direction 為 key 存 digest + 追問對話 */
const HISTORY_STORAGE_KEY = 'coach-digest-history-v1';
const HISTORY_MAX_ENTRIES = 30;

interface HistoryEntry {
  digest: DigestResponse;
  chat: ChatMessage[];
  savedAt: string;
}

type HistoryMap = Record<string, HistoryEntry>;

/**
 * storageKey 帶入 L4 session 版本（第一檔的 scanTime），
 * 使用者刷新 L4 後 scanTime 變 → key 變 → 舊歷史不會被載回。
 */
function storageKey(
  market: string,
  scanDate: string,
  direction: string,
  sessionVersion: string,
): string {
  return `${market}:${scanDate}:${direction}:${sessionVersion}`;
}

function computeSessionVersion(results: StockScanResult[]): string {
  return results[0]?.scanTime ?? 'empty';
}

/** 人類可讀的「上次分析時間」。今天顯示 HH:MM，其他顯示 MM-DD HH:MM */
function formatSavedAt(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const today = new Date();
    const sameDay =
      d.getFullYear() === today.getFullYear() &&
      d.getMonth() === today.getMonth() &&
      d.getDate() === today.getDate();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    if (sameDay) return `今天 ${hh}:${mm}`;
    const MM = String(d.getMonth() + 1).padStart(2, '0');
    const DD = String(d.getDate()).padStart(2, '0');
    return `${MM}/${DD} ${hh}:${mm}`;
  } catch {
    return '';
  }
}

function loadHistory(): HistoryMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed as HistoryMap : {};
  } catch {
    return {};
  }
}

function saveHistoryEntry(key: string, entry: HistoryEntry): void {
  if (typeof window === 'undefined') return;
  try {
    const map = loadHistory();
    map[key] = entry;
    // Prune: 保留最新 N 筆（按 savedAt desc）
    const entries = Object.entries(map);
    if (entries.length > HISTORY_MAX_ENTRIES) {
      entries.sort((a, b) => (b[1].savedAt ?? '').localeCompare(a[1].savedAt ?? ''));
      const kept = Object.fromEntries(entries.slice(0, HISTORY_MAX_ENTRIES));
      window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(kept));
    } else {
      window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(map));
    }
  } catch {
    // localStorage 滿了就算了
  }
}

function loadHistoryEntry(key: string): HistoryEntry | null {
  const map = loadHistory();
  return map[key] ?? null;
}

interface DigestPick {
  rank: number;
  symbol: string;
  reason: string;
}

interface DigestResponse {
  overview: string;
  topPicks: DigestPick[];
  watchOut: DigestPick[];
  sectorHint?: string;
  marketCaveat?: string;
  cached?: boolean;
}

interface ScanCoachDigestProps {
  market: 'TW' | 'CN';
  scanDate: string;
  direction: 'long' | 'short' | 'daban';
  marketTrend: string;
  results: StockScanResult[];
}

/** LLM 可能會回傳 "2345" 或 "2345.TW"，兩種都能對上 results */
function nameOf(symbol: string, results: StockScanResult[]): string {
  const bare = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
  const hit = results.find(r => r.symbol === symbol)
    ?? results.find(r => r.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '') === bare);
  return hit?.name ?? '';
}

/** 顯示時去掉 .TW/.TWO/.SS/.SZ 後綴，比較乾淨 */
function displaySymbol(symbol: string): string {
  return symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
}

function buildRequestBody(props: ScanCoachDigestProps) {
  // 只丟前 30 檔給 LLM，減少 token 成本並聚焦
  const candidates = props.results.slice(0, 30).map((r, idx) => ({
    rank: idx + 1,
    symbol: r.symbol,
    name: r.name,
    industry: r.industry,
    price: r.price,
    changePercent: r.changePercent,
    sixCond: r.sixConditionsScore,
    sixCondBreakdown: r.sixConditionsBreakdown,
    trendState: r.trendState,
    trendPosition: r.trendPosition,
    mtfScore: r.mtfScore,
    highWinRateTypes: r.highWinRateTypes,
    winnerBullish: r.winnerBullishPatterns,
    winnerBearish: r.winnerBearishPatterns,
    elimination: r.eliminationReasons,
    prohibitions: r.entryProhibitionReasons,
    turnoverRank: r.turnoverRank,
    histWinRate: r.histWinRate,
    // v12 fields（議題 33/65/93/13/27/88）
    matchedMethods: r.matchedMethods,
    patternType: r.lockWatchPayload?.patternType,
    patternAchievementRate: r.lockWatchPayload?.patternAchievementRate,
    patternTargetPrice: r.lockWatchPayload?.patternTargetPrice,
    triggerPrice: r.lockWatchPayload?.triggerPrice,
    endPhaseFlag: r.endPhaseFlag,
    volumeLevel: r.volumeLevel,
    kdDecliningWarning: r.kdDecliningWarning,
    seasonLineResistance: r.seasonLineResistance,
  }));
  return {
    market: props.market,
    scanDate: props.scanDate,
    direction: props.direction,
    marketTrend: props.marketTrend,
    candidates,
  };
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** 把 digest + 候選清單整理成 /api/chat 的 context 字串 */
function buildFollowupContext(
  digest: DigestResponse,
  props: ScanCoachDigestProps,
): string {
  const lines: string[] = [];
  lines.push(`[${props.market === 'TW' ? '台股' : '陸股 A 股'} ${props.scanDate} ${props.direction === 'long' ? '做多' : props.direction === 'short' ? '做空' : '打板'}候選分析]`);
  lines.push(`大盤趨勢：${props.marketTrend || '未知'}`);
  lines.push('');
  lines.push('## 剛才的分析：');
  if (digest.overview) lines.push(`總評：${digest.overview}`);
  if (digest.marketCaveat) lines.push(`⚠️ 大盤警示：${digest.marketCaveat}`);
  if (digest.topPicks.length > 0) {
    lines.push('🏆 最穩的：');
    for (const p of digest.topPicks) {
      const name = nameOf(p.symbol, props.results);
      lines.push(`  #${p.rank} ${displaySymbol(p.symbol)} ${name} — ${p.reason}`);
    }
  }
  if (digest.watchOut.length > 0) {
    lines.push('⚠️ 要小心：');
    for (const p of digest.watchOut) {
      const name = nameOf(p.symbol, props.results);
      lines.push(`  #${p.rank} ${displaySymbol(p.symbol)} ${name} — ${p.reason}`);
    }
  }
  if (digest.sectorHint) lines.push(`🏭 ${digest.sectorHint}`);

  lines.push('');
  lines.push('## 全部候選清單（供你查詢細節）：');
  for (const [idx, r] of props.results.slice(0, 30).entries()) {
    const b = r.sixConditionsBreakdown;
    const bits = [
      `#${idx + 1}`,
      `${displaySymbol(r.symbol)} ${r.name}`,
      r.industry ? `[${r.industry}]` : '',
      `${r.price.toFixed(2)} (${r.changePercent >= 0 ? '+' : ''}${r.changePercent.toFixed(1)}%)`,
      b ? `六條件${r.sixConditionsScore}/6[趨${b.trend ? '✓' : '✗'}位${b.position ? '✓' : '✗'}K${b.kbar ? '✓' : '✗'}均${b.ma ? '✓' : '✗'}量${b.volume ? '✓' : '✗'}指${b.indicator ? '✓' : '✗'}]` : `六條件${r.sixConditionsScore}/6`,
      `${r.trendState}・${r.trendPosition}`,
      r.mtfScore !== undefined ? `MTF${r.mtfScore}/4` : '',
    ].filter(Boolean);
    lines.push(bits.join(' '));
  }
  return lines.join('\n');
}

export function ScanCoachDigest(props: ScanCoachDigestProps) {
  const [data, setData] = useState<DigestResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 即時 raw trend（跟 banner / 結果欄同源）— props.marketTrend 是 saved session
  // 寫入的舊值（含降級邏輯，可能是「盤整」），但 banner 顯示「多頭」會跟 LLM
  // prompt 裡的「大盤趨勢：盤整」對不上，誤導 LLM 給「謹慎進場」建議。
  const [liveTrend, setLiveTrend] = useState<string>(props.marketTrend);
  useEffect(() => {
    let cancelled = false;
    if (!props.market || !props.scanDate) return;
    fetch(`/api/scanner/market-trend?market=${props.market}&date=${props.scanDate}`)
      .then((r) => r.json())
      .then((j: { ok?: boolean; trend?: string }) => {
        if (!cancelled && j.ok && j.trend) setLiveTrend(j.trend);
      })
      .catch(() => { /* keep prop fallback */ });
    return () => { cancelled = true; };
  }, [props.market, props.scanDate]);
  // 用 effective trend 覆寫 props.marketTrend 給下游（buildRequestBody 等）
  const effectiveProps = { ...props, marketTrend: liveTrend };

  // 追問狀態
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);

  // 歷史標記
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const aborted = useRef(false);

  // Session key：帶 scanTime，刷新 L4 後 key 變 → 舊歷史不被載回
  const sessionVersion = computeSessionVersion(props.results);
  const persistKey = storageKey(props.market, props.scanDate, props.direction, sessionVersion);

  // 切換市場/日期/方向/L4 版本時：先清狀態，再嘗試從 localStorage 載回歷史
  useEffect(() => {
    aborted.current = false;
    setError(null);
    setLoading(false);
    setInput('');
    setChatError(null);

    const hit = loadHistoryEntry(persistKey);
    if (hit) {
      setData(hit.digest);
      setChat(hit.chat);
      setSavedAt(hit.savedAt);
    } else {
      setData(null);
      setChat([]);
      setSavedAt(null);
    }

    return () => {
      aborted.current = true;
    };
  }, [persistKey]);

  // data / chat 變動時寫回 localStorage（只在有 data 時存；空分析不存）
  useEffect(() => {
    if (!data) return;
    const now = new Date().toISOString();
    saveHistoryEntry(persistKey, { digest: data, chat, savedAt: now });
    setSavedAt(now);
  }, [data, chat, persistKey]);

  const ask = async () => {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/coach/scan-digest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildRequestBody(effectiveProps)),
      });
      const body = await res.json();
      if (aborted.current) return;
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setData(body as DigestResponse);
      // 換一批新分析，清掉舊追問
      setChat([]);
      setChatError(null);
    } catch (err) {
      if (aborted.current) return;
      setError(err instanceof Error ? err.message : 'digest failed');
    } finally {
      if (!aborted.current) setLoading(false);
    }
  };

  /** 追問朱老師：送到 /api/chat，帶 digest+候選 context，streaming 回填 */
  const sendFollowup = async (question: string) => {
    const q = question.trim();
    if (!q || chatLoading || !data) return;
    const nextMessages: ChatMessage[] = [...chat, { role: 'user', content: q }];
    setChat([...nextMessages, { role: 'assistant', content: '' }]);
    setInput('');
    setChatLoading(true);
    setChatError(null);
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: nextMessages,
          context: buildFollowupContext(data, effectiveProps),
        }),
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let assistantText = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (aborted.current) return;
        assistantText += decoder.decode(value, { stream: true });
        setChat(prev => {
          const copy = [...prev];
          copy[copy.length - 1] = { role: 'assistant', content: assistantText };
          return copy;
        });
      }
    } catch (err) {
      if (aborted.current) return;
      setChatError(err instanceof Error ? err.message : 'chat failed');
      // 拿掉空 assistant
      setChat(prev => prev[prev.length - 1]?.content === '' ? prev.slice(0, -1) : prev);
    } finally {
      if (!aborted.current) setChatLoading(false);
    }
  };

  // 沒結果可分析
  if (props.results.length === 0) return null;

  // 初始：按鈕
  if (!data && !loading && !error) {
    return (
      <button
        onClick={ask}
        className="w-full mb-2 px-3 py-2 rounded-lg border border-purple-500/40 bg-gradient-to-r from-purple-500/15 to-indigo-500/15 hover:from-purple-500/25 hover:to-indigo-500/25 text-[12px] font-semibold text-purple-100 transition-all flex items-center justify-center gap-2"
      >
        <span>💬</span>
        <span>問朱老師怎麼看這 {Math.min(props.results.length, 30)} 檔</span>
      </button>
    );
  }

  if (loading) {
    return (
      <div className="w-full mb-2 px-3 py-3 rounded-lg border border-purple-500/30 bg-purple-500/5 text-center text-[11px] text-purple-200 animate-pulse">
        💬 老師分析中…（通常 3~6 秒）
      </div>
    );
  }

  if (error) {
    return (
      <div className="w-full mb-2 px-3 py-2 rounded-lg border border-red-500/30 bg-red-500/5 text-[11px] text-red-300 flex items-center justify-between gap-2">
        <span>💬 老師回覆異常</span>
        <button
          onClick={ask}
          className="text-[11px] text-red-200 hover:text-red-100 px-2 py-0.5 rounded bg-red-500/20 hover:bg-red-500/30"
        >重試</button>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="w-full mb-2 rounded-lg border border-purple-500/40 bg-gradient-to-br from-purple-500/10 via-card to-indigo-500/5 p-3 space-y-2 text-[11px]">
      <div className="flex items-center justify-between">
        <div className="font-semibold text-purple-200 flex items-center gap-1.5 min-w-0">
          <span className="shrink-0">💬 朱老師的話</span>
          {savedAt && (
            <span className="text-[9px] text-muted-foreground font-normal truncate">
              · {formatSavedAt(savedAt)}
            </span>
          )}
          {data.cached && (
            <span className="text-[9px] text-muted-foreground font-normal shrink-0">（cache）</span>
          )}
        </div>
        <button
          onClick={ask}
          className="text-[10px] text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-muted shrink-0"
          title="重新分析（會覆蓋歷史）"
        >🔄</button>
      </div>

      {data.overview && (
        <div className="text-foreground leading-relaxed">{data.overview}</div>
      )}

      {data.marketCaveat && (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-amber-200">
          ⚠️ {data.marketCaveat}
        </div>
      )}

      {data.topPicks.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] font-semibold text-emerald-300">🏆 老師認為最穩的：</div>
          {data.topPicks.map((p, i) => {
            const name = nameOf(p.symbol, props.results);
            return (
              <div key={`${p.symbol}-${i}`} className="pl-2 border-l-2 border-emerald-500/50">
                <div className="font-semibold text-emerald-200">
                  #{p.rank} {displaySymbol(p.symbol)}{name && ` ${name}`}
                </div>
                <div className="text-muted-foreground leading-snug">{p.reason}</div>
              </div>
            );
          })}
        </div>
      )}

      {data.watchOut.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] font-semibold text-amber-300">⚠️ 這幾檔要小心：</div>
          {data.watchOut.map((p, i) => {
            const name = nameOf(p.symbol, props.results);
            return (
              <div key={`${p.symbol}-${i}`} className="pl-2 border-l-2 border-amber-500/50">
                <div className="font-semibold text-amber-200">
                  #{p.rank} {displaySymbol(p.symbol)}{name && ` ${name}`}
                </div>
                <div className="text-muted-foreground leading-snug">{p.reason}</div>
              </div>
            );
          })}
        </div>
      )}

      {data.sectorHint && (
        <div className="rounded border border-sky-500/30 bg-sky-500/5 px-2 py-1.5 text-sky-200">
          🏭 {data.sectorHint}
        </div>
      )}

      {/* ── 追問區 ─────────────────────────────────────────────────── */}
      <div className="pt-2 mt-2 border-t border-purple-500/20 space-y-1.5">
        {chat.length > 0 && (
          <div className="space-y-1.5 max-h-[320px] overflow-y-auto pr-1">
            {chat.map((m, i) => (
              <div
                key={i}
                className={`rounded px-2 py-1.5 ${
                  m.role === 'user'
                    ? 'bg-blue-500/20 text-blue-100'
                    : 'bg-secondary/60 text-foreground border border-border'
                }`}
              >
                <div className="text-[9px] text-muted-foreground mb-0.5">
                  {m.role === 'user' ? '你' : '朱老師'}
                </div>
                <div className="text-[11px] leading-relaxed whitespace-pre-wrap">
                  {m.content || (chatLoading && i === chat.length - 1
                    ? <span className="text-muted-foreground animate-pulse">老師思考中…</span>
                    : '')}
                </div>
              </div>
            ))}
          </div>
        )}

        {chatError && (
          <div className="text-[10px] text-red-300 border border-red-500/30 rounded px-2 py-1">
            追問失敗：{chatError}
          </div>
        )}

        <div className="flex gap-1.5 items-end">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendFollowup(input);
              }
            }}
            placeholder={chatLoading ? '老師回覆中…' : '想追問？（Enter 送出，Shift+Enter 換行）'}
            disabled={chatLoading}
            rows={1}
            className="flex-1 min-w-0 px-2 py-1.5 bg-secondary/40 border border-border rounded text-[11px] text-foreground resize-none focus:outline-none focus:ring-1 focus:ring-purple-400 disabled:opacity-50"
          />
          <button
            onClick={() => sendFollowup(input)}
            disabled={!input.trim() || chatLoading}
            className="shrink-0 px-2.5 py-1.5 bg-purple-500/80 hover:bg-purple-500 disabled:opacity-40 text-white rounded text-[11px] font-semibold"
          >送出</button>
        </div>
      </div>
    </div>
  );
}
