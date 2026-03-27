import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  StrategyConfig,
  StrategyThresholds,
  BUILT_IN_STRATEGIES,
  ZHU_V1,
} from '@/lib/strategy/StrategyConfig';

/** @deprecated Use StrategyThresholds from StrategyConfig instead */
export type StrategyParams = Pick<
  StrategyThresholds,
  'kdMaxEntry' | 'deviationMax' | 'volumeRatioMin' | 'upperShadowMax' | 'minScore'
>;

export const DEFAULT_STRATEGY: StrategyParams = {
  kdMaxEntry: 88,
  deviationMax: 0.20,
  volumeRatioMin: 1.5,
  upperShadowMax: 0.20,
  minScore: 4,
};

interface SettingsStore {
  notifyEmail: string;
  notifyMinScore: number;
  strategy: StrategyParams;
  // 策略版本管理
  activeStrategyId: string;
  customStrategies: StrategyConfig[];
  setNotifyEmail: (email: string) => void;
  setNotifyMinScore: (score: number) => void;
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
      strategy: DEFAULT_STRATEGY,
      activeStrategyId: 'zhu-v1',
      customStrategies: [],
      setNotifyEmail: (email) => set({ notifyEmail: email }),
      setNotifyMinScore: (score) => set({ notifyMinScore: score }),
      setStrategy: (params) => set(s => ({ strategy: { ...s.strategy, ...params } })),
      resetStrategy: () => set({ strategy: DEFAULT_STRATEGY }),
      setActiveStrategy: (id) => set({ activeStrategyId: id }),
      addCustomStrategy: (s) =>
        set(state => ({ customStrategies: [...state.customStrategies, s] })),
      updateCustomStrategy: (id, updates) =>
        set(state => ({
          customStrategies: state.customStrategies.map(s =>
            s.id === id ? { ...s, ...updates } : s
          ),
        })),
      deleteCustomStrategy: (id) =>
        set(state => ({
          customStrategies: state.customStrategies.filter(s => s.id !== id),
          activeStrategyId:
            state.activeStrategyId === id ? 'zhu-v1' : state.activeStrategyId,
        })),
      getActiveStrategy: () => {
        const { activeStrategyId, customStrategies } = get();
        const all = [...BUILT_IN_STRATEGIES, ...customStrategies];
        return all.find(s => s.id === activeStrategyId) ?? ZHU_V1;
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
  if (!strategyId) return ZHU_V1;
  const all = [...BUILT_IN_STRATEGIES, ...customStrategies];
  return all.find(s => s.id === strategyId) ?? ZHU_V1;
}
