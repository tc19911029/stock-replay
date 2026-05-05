'use client';

/**
 * 走圖頁單支股票朱老師分析 — 對應掃描頁 ScanCoachDigest 的走圖版。
 *
 * 取 replayStore 當前 K 棒/訊號/趨勢，送 /api/coach/chart-digest 換結構化建議。
 * 回覆格式：overview / verdict / verdictReason / reasoning[] / caveat
 *
 * 持久化：localStorage key = market:symbol:date，切換股票或日期不會互污染。
 */

import { useEffect, useRef, useState } from 'react';
import { useReplayStore } from '@/store/replayStore';
import { usePortfolioStore } from '@/store/portfolioStore';
import { classifySignal } from '@/lib/rules/signalClassifier';
import type { CandleWithIndicators } from '@/types';

const HISTORY_STORAGE_KEY = 'chart-coach-digest-v1';
const HISTORY_MAX_ENTRIES = 40;

interface DigestResponse {
  overview: string;
  verdict: string;
  verdictReason: string;
  reasoning: string[];
  caveat?: string;
  cached?: boolean;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface HistoryEntry {
  digest: DigestResponse;
  chat: ChatMessage[];
  savedAt: string;
}

type HistoryMap = Record<string, HistoryEntry>;

function storageKey(market: string, symbol: string, date: string): string {
  return `${market}:${symbol}:${date}`;
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
    const entries = Object.entries(map);
    if (entries.length > HISTORY_MAX_ENTRIES) {
      entries.sort((a, b) => (b[1].savedAt ?? '').localeCompare(a[1].savedAt ?? ''));
      const kept = Object.fromEntries(entries.slice(0, HISTORY_MAX_ENTRIES));
      window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(kept));
    } else {
      window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(map));
    }
  } catch {
    // quota 滿就算了
  }
}

function loadHistoryEntry(key: string): HistoryEntry | null {
  return loadHistory()[key] ?? null;
}

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

function displaySymbol(s: string): string {
  return s.replace(/\.(TW|TWO|SS|SZ)$/i, '');
}

/** verdict -> 配色 */
function verdictStyle(v: string): { bg: string; text: string; border: string } {
  const s = v || '觀望';
  if (s.includes('進場') || s.includes('續抱')) {
    return { bg: 'bg-red-900/30', text: 'text-red-200', border: 'border-red-500/50' };
  }
  if (s.includes('出場') || s.includes('減碼')) {
    return { bg: 'bg-green-900/30', text: 'text-green-200', border: 'border-green-500/50' };
  }
  return { bg: 'bg-yellow-900/30', text: 'text-yellow-200', border: 'border-yellow-500/50' };
}

function buildFollowupContext(
  digest: DigestResponse,
  symbol: string,
  name: string,
  date: string,
  candle: CandleWithIndicators,
): string {
  const lines: string[] = [];
  lines.push(`[走圖頁單股分析 · ${displaySymbol(symbol)} ${name} · ${date}]`);
  lines.push('');
  lines.push('## 剛才的分析：');
  if (digest.overview) lines.push(`總評：${digest.overview}`);
  lines.push(`結論：${digest.verdict} — ${digest.verdictReason}`);
  if (digest.reasoning.length > 0) {
    lines.push('分析要點：');
    for (const r of digest.reasoning) lines.push(`  · ${r}`);
  }
  if (digest.caveat) lines.push(`⚠️ ${digest.caveat}`);
  lines.push('');
  lines.push('## 當前 K 棒：');
  lines.push(`O=${candle.open} H=${candle.high} L=${candle.low} C=${candle.close} V=${candle.volume}`);
  if (candle.ma5 != null)  lines.push(`MA5=${candle.ma5.toFixed(2)}`);
  if (candle.ma20 != null) lines.push(`MA20=${candle.ma20.toFixed(2)}`);
  return lines.join('\n');
}

export default function ChartCoachAdvice() {
  const {
    currentSignals, allCandles, currentIndex, currentStock,
    trendState, trendPosition, sixConditions, longProhibitions, winnerPatterns,
  } = useReplayStore();
  const { holdings } = usePortfolioStore();

  const candle = allCandles[currentIndex];
  const prev   = allCandles[currentIndex - 1];
  const symbol = currentStock?.ticker ?? '';
  const name   = currentStock?.name ?? '';
  const date   = candle?.date ?? '';

  // 判斷市場：.TW/.TWO → TW；.SS/.SZ → CN
  const market: 'TW' | 'CN' = /\.(SS|SZ)$/i.test(symbol) ? 'CN' : 'TW';
  const bareSymbol = displaySymbol(symbol);

  const held = holdings.find(h => displaySymbol(h.symbol) === bareSymbol);
  const hasPosition = !!held;

  const [data, setData] = useState<DigestResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);

  const [savedAt, setSavedAt] = useState<string | null>(null);
  const aborted = useRef(false);

  const persistKey = (symbol && date) ? storageKey(market, bareSymbol, date) : '';

  // 切股票/切日期：重設 state + 嘗試載入歷史
  useEffect(() => {
    aborted.current = false;
    setError(null);
    setLoading(false);
    setInput('');
    setChatError(null);

    if (!persistKey) {
      setData(null);
      setChat([]);
      setSavedAt(null);
      return;
    }

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

  // data/chat 變動 → 持久化
  useEffect(() => {
    if (!data || !persistKey) return;
    const now = new Date().toISOString();
    saveHistoryEntry(persistKey, { digest: data, chat, savedAt: now });
    setSavedAt(now);
  }, [data, chat, persistKey]);

  const ask = async () => {
    if (loading || !candle || !symbol) return;
    setLoading(true);
    setError(null);
    try {
      const changePercent = prev ? ((candle.close - prev.close) / prev.close) * 100 : undefined;

      const signals = currentSignals.slice(0, 15).map(s => ({
        label: s.label,
        description: s.description,
        subtype: s.subtype ?? classifySignal(s),
      }));

      const res = await fetch('/api/coach/chart-digest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          market,
          symbol: bareSymbol,
          name,
          date,
          ohlcv: {
            open: candle.open, high: candle.high, low: candle.low, close: candle.close,
            volume: candle.volume,
            changePercent,
          },
          ma: { ma5: candle.ma5, ma10: candle.ma10, ma20: candle.ma20, ma60: candle.ma60 },
          indicator: {
            kdK: candle.kdK, kdD: candle.kdD,
            macdDIF: candle.macdDIF, macdSignal: candle.macdSignal, macdOSC: candle.macdOSC,
          },
          trend: trendState ?? '',
          trendPosition: trendPosition ?? '',
          sixCond: sixConditions?.totalScore,
          sixCondBreakdown: sixConditions ? {
            trend:     sixConditions.trend.pass,
            position:  sixConditions.position.pass,
            kbar:      sixConditions.kbar.pass,
            ma:        sixConditions.ma.pass,
            volume:    sixConditions.volume.pass,
            indicator: sixConditions.indicator.pass,
          } : undefined,
          signals,
          prohibitions: longProhibitions?.reasons ?? [],
          winnerBullishPatterns: winnerPatterns?.bullishPatterns.map(p => p.name) ?? [],
          winnerBearishPatterns: winnerPatterns?.bearishPatterns.map(p => p.name) ?? [],
          hasPosition,
          positionCost: held?.costPrice ?? null,
        }),
      });
      const body = await res.json();
      if (aborted.current) return;
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setData(body as DigestResponse);
      setChat([]);
      setChatError(null);
    } catch (err) {
      if (aborted.current) return;
      setError(err instanceof Error ? err.message : 'digest failed');
    } finally {
      if (!aborted.current) setLoading(false);
    }
  };

  const sendFollowup = async (question: string) => {
    const q = question.trim();
    if (!q || chatLoading || !data || !candle) return;
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
          context: buildFollowupContext(data, symbol, name, date, candle),
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
      setChat(prev => prev[prev.length - 1]?.content === '' ? prev.slice(0, -1) : prev);
    } finally {
      if (!aborted.current) setChatLoading(false);
    }
  };

  if (!candle || !symbol) return null;

  // 初始：按鈕
  if (!data && !loading && !error) {
    return (
      <button
        onClick={ask}
        className="w-full mb-3 px-3 py-2 rounded-lg border border-purple-500/40 bg-gradient-to-r from-purple-500/15 to-indigo-500/15 hover:from-purple-500/25 hover:to-indigo-500/25 text-[12px] font-semibold text-purple-100 transition-all flex items-center justify-center gap-2"
      >
        <span>💬</span>
        <span>問朱老師怎麼看 {bareSymbol} {name}</span>
      </button>
    );
  }

  if (loading) {
    return (
      <div className="w-full mb-3 px-3 py-3 rounded-lg border border-purple-500/30 bg-purple-500/5 text-center text-[11px] text-purple-200 animate-pulse">
        💬 老師分析中…（通常 3~6 秒）
      </div>
    );
  }

  if (error) {
    return (
      <div className="w-full mb-3 px-3 py-2 rounded-lg border border-red-500/30 bg-red-500/5 text-[11px] text-red-300 flex items-center justify-between gap-2">
        <span>💬 老師回覆異常：{error}</span>
        <button
          onClick={ask}
          className="text-[11px] text-red-200 hover:text-red-100 px-2 py-0.5 rounded bg-red-500/20 hover:bg-red-500/30"
        >重試</button>
      </div>
    );
  }

  if (!data) return null;

  const vs = verdictStyle(data.verdict);

  return (
    <div className="w-full mb-3 rounded-lg border border-purple-500/40 bg-gradient-to-br from-purple-500/10 via-card to-indigo-500/5 p-3 space-y-2 text-[11px]">
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

      {/* Verdict — 結論優先 */}
      <div className={`rounded border px-2.5 py-1.5 ${vs.bg} ${vs.border}`}>
        <div className="flex items-center gap-2">
          <span className={`text-[10px] font-semibold ${vs.text}`}>結論</span>
          <span className={`text-sm font-bold ${vs.text}`}>{data.verdict}</span>
        </div>
        {data.verdictReason && (
          <div className={`text-[11px] leading-snug mt-0.5 ${vs.text}`}>{data.verdictReason}</div>
        )}
      </div>

      {data.overview && (
        <div className="text-foreground leading-relaxed">{data.overview}</div>
      )}

      {data.reasoning.length > 0 && (
        <div className="space-y-0.5 pl-1">
          {data.reasoning.map((r, i) => (
            <div key={i} className="text-muted-foreground leading-snug flex items-start gap-1.5">
              <span className="text-purple-400 shrink-0">•</span>
              <span>{r}</span>
            </div>
          ))}
        </div>
      )}

      {data.caveat && (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-amber-200">
          ⚠️ {data.caveat}
        </div>
      )}

      {/* 追問區 */}
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
