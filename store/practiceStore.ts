/**
 * 走圖練習簿 store — 每檔股票一本紙上模擬交易帳本
 *
 * - key = `${market}:${stripSuffix(symbol)}`（每檔獨立）
 * - 跟著走圖游標的當日收盤價成交
 * - localStorage 持久化（zustand persist）
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { MarketId } from '@/lib/scanner/types';
import {
  buildTrade,
  practiceKey,
  type PracticeSession,
  type PracticeTrade,
} from '@/lib/practice/calcPractice';

const DEFAULT_INITIAL_CAPITAL = 1_000_000;
const DEFAULT_FEE_DISCOUNT = 0.57;  // TW 一般網路券商 5.7 折

interface ExecuteTradeArgs {
  date: string;
  shares: number;
  price: number;
  signalAtTime?: string;
}

interface PracticeStore {
  sessions: Record<string, PracticeSession>;

  /** 取得或自動建立 session（第一次進該股自動初始化） */
  getOrCreate: (market: MarketId, symbol: string) => PracticeSession;

  setInitialCapital: (market: MarketId, symbol: string, capital: number) => void;
  setFeeDiscount: (market: MarketId, symbol: string, discount: number) => void;

  buy: (market: MarketId, symbol: string, args: ExecuteTradeArgs) => void;
  sell: (market: MarketId, symbol: string, args: ExecuteTradeArgs) => void;
  undoLastTrade: (market: MarketId, symbol: string) => void;
  resetSession: (market: MarketId, symbol: string) => void;
}

function makeSession(market: MarketId, symbol: string): PracticeSession {
  const code = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
  return {
    symbol: code,
    market,
    initialCapital: DEFAULT_INITIAL_CAPITAL,
    feeDiscount: DEFAULT_FEE_DISCOUNT,
    trades: [],
    createdAt: new Date().toISOString(),
  };
}

export const usePracticeStore = create<PracticeStore>()(
  persist(
    (set, get) => ({
      sessions: {},

      getOrCreate: (market, symbol) => {
        const key = practiceKey(market, symbol);
        const existing = get().sessions[key];
        if (existing) return existing;
        const fresh = makeSession(market, symbol);
        set(s => ({ sessions: { ...s.sessions, [key]: fresh } }));
        return fresh;
      },

      setInitialCapital: (market, symbol, capital) => {
        const key = practiceKey(market, symbol);
        set(s => {
          const session = s.sessions[key] ?? makeSession(market, symbol);
          return {
            sessions: {
              ...s.sessions,
              [key]: { ...session, initialCapital: Math.max(0, capital) },
            },
          };
        });
      },

      setFeeDiscount: (market, symbol, discount) => {
        const key = practiceKey(market, symbol);
        set(s => {
          const session = s.sessions[key] ?? makeSession(market, symbol);
          // 限制 0.1 ~ 1.0（避免 0 或負數）
          const clamped = Math.min(1, Math.max(0.1, discount));
          return {
            sessions: {
              ...s.sessions,
              [key]: { ...session, feeDiscount: clamped },
            },
          };
        });
      },

      buy: (market, symbol, args) => {
        const key = practiceKey(market, symbol);
        set(s => {
          const session = s.sessions[key] ?? makeSession(market, symbol);
          const trade = buildTrade({
            date: args.date,
            side: 'BUY',
            shares: args.shares,
            price: args.price,
            market,
            symbol: session.symbol,
            feeDiscount: session.feeDiscount,
            signalAtTime: args.signalAtTime,
          });
          return {
            sessions: {
              ...s.sessions,
              [key]: { ...session, trades: [...session.trades, trade] },
            },
          };
        });
      },

      sell: (market, symbol, args) => {
        const key = practiceKey(market, symbol);
        set(s => {
          const session = s.sessions[key] ?? makeSession(market, symbol);
          const trade = buildTrade({
            date: args.date,
            side: 'SELL',
            shares: args.shares,
            price: args.price,
            market,
            symbol: session.symbol,
            feeDiscount: session.feeDiscount,
            signalAtTime: args.signalAtTime,
          });
          return {
            sessions: {
              ...s.sessions,
              [key]: { ...session, trades: [...session.trades, trade] },
            },
          };
        });
      },

      undoLastTrade: (market, symbol) => {
        const key = practiceKey(market, symbol);
        set(s => {
          const session = s.sessions[key];
          if (!session || session.trades.length === 0) return s;
          return {
            sessions: {
              ...s.sessions,
              [key]: { ...session, trades: session.trades.slice(0, -1) },
            },
          };
        });
      },

      resetSession: (market, symbol) => {
        const key = practiceKey(market, symbol);
        set(s => {
          const session = s.sessions[key];
          if (!session) return s;
          return {
            sessions: {
              ...s.sessions,
              [key]: { ...session, trades: [] },
            },
          };
        });
      },
    }),
    {
      name: 'practice-v1',
      version: 1,
      migrate: (persisted: unknown, _fromVersion: number) => {
        const state = (persisted ?? {}) as Record<string, unknown>;
        if (!state.sessions || typeof state.sessions !== 'object') {
          state.sessions = {};
        }
        return state as Partial<PracticeStore>;
      },
    },
  ),
);

export type { PracticeSession, PracticeTrade };
