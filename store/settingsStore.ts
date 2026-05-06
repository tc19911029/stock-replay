import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  StrategyConfig,
  BUILT_IN_STRATEGIES,
  ZHU_PURE_BOOK,
  clampThresholds,
} from '@/lib/strategy/StrategyConfig';

/** 漲跌色彩主題：asia = 紅漲綠跌（台灣/大陸），western = 綠漲紅跌（歐美） */
export type ColorTheme = 'asia' | 'western';

interface SettingsStore {
  notifyEmail: string;
  notifyMinScore: number;
  colorTheme: ColorTheme;
  stopLossPercent: number;
  // 策略版本管理（書本門檻寫死於 StrategyConfig，UI 不再開放編輯）
  activeStrategyId: string;
  customStrategies: StrategyConfig[];
  setNotifyEmail: (email: string) => void;
  setNotifyMinScore: (score: number) => void;
  setColorTheme: (theme: ColorTheme) => void;
  setStopLossPercent: (pct: number) => void;
  // 策略版本管理 actions
  setActiveStrategy: (id: string) => void;
  addCustomStrategy: (s: StrategyConfig) => void;
  updateCustomStrategy: (id: string, updates: Partial<Omit<StrategyConfig, 'id' | 'isBuiltIn'>>) => void;
  deleteCustomStrategy: (id: string) => void;
  getActiveStrategy: () => StrategyConfig;
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set, get) => ({
      notifyEmail: '',
      notifyMinScore: 5,
      colorTheme: 'asia' as ColorTheme,
      stopLossPercent: 7,
      activeStrategyId: 'zhu-pure-book',
      customStrategies: [],
      setNotifyEmail: (email) => set({ notifyEmail: email }),
      setNotifyMinScore: (score) => set({ notifyMinScore: score }),
      setColorTheme: (theme) => {
        set({ colorTheme: theme });
        if (typeof document !== 'undefined') {
          if (theme === 'western') {
            document.documentElement.setAttribute('data-color-theme', 'western');
          } else {
            document.documentElement.removeAttribute('data-color-theme');
          }
        }
      },
      setStopLossPercent: (pct) => set({ stopLossPercent: Math.max(1, Math.min(20, pct)) }),
      setActiveStrategy: (id) => {
        set({ activeStrategyId: id });
        // 同步寫 server，讓 cron / ScanPipeline 使用同一套策略
        if (typeof window !== 'undefined') {
          const { customStrategies } = get();
          const custom = customStrategies.find(s => s.id === id);
          const body = custom
            ? { strategyId: null, customConfig: custom }
            : { strategyId: id, customConfig: null };
          fetch('/api/strategy/active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }).catch(err => console.warn('[settingsStore] 同步 active strategy 失敗:', err));
        }
      },
      addCustomStrategy: (s) =>
        set(state => ({
          customStrategies: [...state.customStrategies, {
            ...s,
            thresholds: clampThresholds(s.thresholds),
          }],
        })),
      updateCustomStrategy: (id, updates) =>
        set(state => ({
          customStrategies: state.customStrategies.map(s =>
            s.id === id
              ? {
                  ...s,
                  ...updates,
                  thresholds: updates.thresholds
                    ? clampThresholds(updates.thresholds)
                    : s.thresholds,
                }
              : s
          ),
        })),
      deleteCustomStrategy: (id) => {
        const wasActive = get().activeStrategyId === id;
        set(state => ({
          customStrategies: state.customStrategies.filter(s => s.id !== id),
          activeStrategyId: wasActive ? 'zhu-pure-book' : state.activeStrategyId,
        }));
        // 刪到正在用的 → 同步 server，否則 cron / ScanPipeline 還會抓舊 customConfig
        if (wasActive && typeof window !== 'undefined') {
          fetch('/api/strategy/active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ strategyId: 'zhu-pure-book', customConfig: null }),
          }).catch(err => console.warn('[settingsStore] 刪策略後同步 active failed:', err));
        }
      },
      getActiveStrategy: () => {
        const { activeStrategyId, customStrategies } = get();
        const all = [...BUILT_IN_STRATEGIES, ...customStrategies];
        return all.find(s => s.id === activeStrategyId) ?? ZHU_PURE_BOOK;
      },
    }),
    { name: 'settings-v4' }
  )
);

/** Helper: resolve a strategy by ID (for server-side use where store isn't available) */
export function resolveStrategy(
  strategyId: string | undefined,
  customStrategies: StrategyConfig[] = [],
): StrategyConfig {
  if (!strategyId) return ZHU_PURE_BOOK;
  const all = [...BUILT_IN_STRATEGIES, ...customStrategies];
  return all.find(s => s.id === strategyId) ?? ZHU_PURE_BOOK;
}
