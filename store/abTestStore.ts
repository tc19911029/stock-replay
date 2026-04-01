/**
 * abTestStore.ts — A/B 測試 Store
 *
 * 管理「朱SOP+最大量」vs「系統第一名」的頭對頭回測比較。
 * 使用 SSE 串流讀取 /api/backtest/ab-test 的進度與結果。
 */

import { create } from 'zustand';
import { MarketId } from '@/lib/scanner/types';
import {
  ABTestResult,
  ABTestProgressEvent,
} from '@/lib/backtest/ABTestEngine';

// ── Types ──────────────────────────────────────────────────────────────────────

interface ABTestState {
  // Config
  market:         MarketId;
  fromDate:       string;
  toDate:         string;
  sampleInterval: number;  // 1=每交易日, 5=每週, 10=每兩週

  // Run state
  isRunning:     boolean;
  progress:      number;     // 0-100
  statusMessage: string;
  currentDate:   string;     // 正在處理的日期
  error:         string | null;

  // Result
  result: ABTestResult | null;

  // Actions
  setMarket:         (m: MarketId) => void;
  setFromDate:       (d: string) => void;
  setToDate:         (d: string) => void;
  setSampleInterval: (n: number) => void;
  runTest:           () => Promise<void>;
  clearResult:       () => void;
}

// ── Store ──────────────────────────────────────────────────────────────────────

export const useABTestStore = create<ABTestState>((set, get) => ({
  // Default config
  market:         'TW',
  fromDate:       getDefaultFromDate(),
  toDate:         getDefaultToDate(),
  sampleInterval: 5,

  // Run state
  isRunning:     false,
  progress:      0,
  statusMessage: '',
  currentDate:   '',
  error:         null,
  result:        null,

  // Actions
  setMarket:         (m)  => set({ market: m }),
  setFromDate:       (d)  => set({ fromDate: d }),
  setToDate:         (d)  => set({ toDate: d }),
  setSampleInterval: (n)  => set({ sampleInterval: n }),
  clearResult:       ()   => set({ result: null, error: null, statusMessage: '' }),

  runTest: async () => {
    const { market, fromDate, toDate, sampleInterval, isRunning } = get();
    if (isRunning) return;

    set({
      isRunning: true,
      progress: 0,
      statusMessage: '啟動中...',
      currentDate: '',
      error: null,
      result: null,
    });

    try {
      const res = await fetch('/api/backtest/ab-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          market,
          fromDate,
          toDate,
          sampleInterval,
          topN: [1],        // 只比較第1名
          quintiles: false,  // 不需要五分位
        }),
      });

      if (!res.ok || !res.body) {
        throw new Error(`API 回傳 ${res.status}`);
      }

      // 讀取 SSE 串流
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const event = JSON.parse(line.slice(6)) as ABTestProgressEvent;
              handleSSEEvent(event, set);
            } catch {
              // Ignore malformed lines
            }
          }
        }
      }

      // Process remaining buffer
      if (buffer.startsWith('data: ')) {
        try {
          const event = JSON.parse(buffer.slice(6)) as ABTestProgressEvent;
          handleSSEEvent(event, set);
        } catch {
          // Ignore
        }
      }
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : '未知錯誤',
        isRunning: false,
      });
    }
  },
}));

// ── SSE Event Handler ──────────────────────────────────────────────────────────

function handleSSEEvent(
  event: ABTestProgressEvent,
  set: (s: Partial<ABTestState>) => void,
) {
  switch (event.type) {
    case 'status':
      set({ statusMessage: event.message });
      break;

    case 'date_start':
      set({
        currentDate: event.date,
        progress: Math.round((event.current / event.total) * 100),
        statusMessage: `處理 ${event.date}（${event.current}/${event.total}）`,
      });
      break;

    case 'date_done':
      // Progress already updated by date_start
      break;

    case 'complete':
      set({
        result: event.result,
        isRunning: false,
        progress: 100,
        statusMessage: '完成',
      });
      break;

    case 'error':
      set({
        error: event.message,
        isRunning: false,
      });
      break;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function getDefaultFromDate(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 3);
  return d.toISOString().split('T')[0];
}

function getDefaultToDate(): string {
  // 需要往回推 30 天確保有足夠的前瞻數據
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().split('T')[0];
}
