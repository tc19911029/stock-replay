import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  StrategyConfig,
  StrategyThresholds,
  BUILT_IN_STRATEGIES,
  ZHU_PURE_BOOK,
  clampThresholds,
} from '@/lib/strategy/StrategyConfig';

/** @deprecated Use StrategyThresholds from StrategyConfig instead */
export type StrategyParams = Pick<
  StrategyThresholds,
  'kdMaxEntry' | 'deviationMax' | 'volumeRatioMin' | 'upperShadowMax' | 'minScore' | 'marketTrendFilter' | 'bullMinScore' | 'sidewaysMinScore' | 'bearMinScore'
>;

export const DEFAULT_STRATEGY: StrategyParams = {
  kdMaxEntry: 88,
  deviationMax: 0.20,
  volumeRatioMin: 1.5,
  upperShadowMax: 0.20,
  minScore: 4,
  marketTrendFilter: true,
  bullMinScore: 4,
  sidewaysMinScore: 5,
  bearMinScore: 6,
};

/** 漲跌色彩主題：asia = 紅漲綠跌（台灣/大陸），western = 綠漲紅跌（歐美） */
export type ColorTheme = 'asia' | 'western';

interface SettingsStore {
  notifyEmail: string;
  notifyMinScore: number;
  colorTheme: ColorTheme;
  stopLossPercent: number;
  strategy: StrategyParams;
  // 策略版本管理
  activeStrategyId: string;
  customStrategies: StrategyConfig[];
  setNotifyEmail: (email: string) => void;
  setNotifyMinScore: (score: number) => void;
  setColorTheme: (theme: ColorTheme) => void;
  setStopLossPercent: (pct: number) => void;
  /** @deprecated Use getActiveStrategy().thresholds instead */
  setStrategy: (params: Partial<StrategyParams>) => void;
  /** @deprecated Use getActiveStrategy().thresholds instead */
  resetStrategy: () => void;
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
      strategy: DEFAULT_STRATEGY,
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
      setStrategy: (params) => set(s => ({ strategy: { ...s.strategy, ...params } })),
      resetStrategy: () => set({ strategy: DEFAULT_STRATEGY }),
      setActiveStrategy: (id) => set({ activeStrategyId: id }),
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
      deleteCustomStrategy: (id) =>
        set(state => ({
          customStrategies: state.customStrategies.filter(s => s.id !== id),
          activeStrategyId:
            state.activeStrategyId === id ? 'zhu-pure-book' : state.activeStrategyId,
        })),
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
