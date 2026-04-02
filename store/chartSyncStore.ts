/**
 * Chart synchronization store.
 *
 * Replaces the module-level mutable state in CandleChart.tsx and
 * IndicatorCharts.tsx with a proper Zustand store. This is SSR-safe,
 * React Strict Mode safe, and supports multiple chart instances.
 */

import { create } from 'zustand';

export interface LogicalRange {
  from: number;
  to: number;
}

export type RangeSyncCallback = (range: LogicalRange | null) => void;
export type CrosshairSyncCallback = (time: string | null) => void;

interface ChartSyncState {
  /** Last broadcasted logical range */
  lastRange: LogicalRange | null;
  /** Last broadcasted crosshair time */
  lastCrosshairTime: string | null;

  // ── Range sync ──
  _rangeSyncing: boolean;
  _rangeListeners: Set<RangeSyncCallback>;
  broadcastRange: (range: LogicalRange | null) => void;
  subscribeRangeSync: (cb: RangeSyncCallback) => () => void;

  // ── Crosshair sync ──
  _crosshairSyncing: boolean;
  _crosshairListeners: Set<CrosshairSyncCallback>;
  broadcastCrosshairTime: (time: string | null) => void;
  subscribeCrosshairSync: (cb: CrosshairSyncCallback) => () => void;
}

export const useChartSyncStore = create<ChartSyncState>((set, get) => ({
  lastRange: null,
  lastCrosshairTime: null,

  _rangeSyncing: false,
  _rangeListeners: new Set(),

  broadcastRange: (range) => {
    const state = get();
    if (state._rangeSyncing) return;
    set({ _rangeSyncing: true });
    if (range) set({ lastRange: range });
    state._rangeListeners.forEach((cb) => cb(range));
    set({ _rangeSyncing: false });
  },

  subscribeRangeSync: (cb) => {
    get()._rangeListeners.add(cb);
    return () => {
      get()._rangeListeners.delete(cb);
    };
  },

  _crosshairSyncing: false,
  _crosshairListeners: new Set(),

  broadcastCrosshairTime: (time) => {
    const state = get();
    if (state._crosshairSyncing) return;
    set({ _crosshairSyncing: true, lastCrosshairTime: time });
    state._crosshairListeners.forEach((cb) => cb(time));
    set({ _crosshairSyncing: false });
  },

  subscribeCrosshairSync: (cb) => {
    get()._crosshairListeners.add(cb);
    return () => {
      get()._crosshairListeners.delete(cb);
    };
  },
}));

// ── Convenience exports for backwards compatibility ──────────────────────────

export function broadcastRange(range: LogicalRange | null) {
  useChartSyncStore.getState().broadcastRange(range);
}

export function broadcastCrosshairTime(time: string | null) {
  useChartSyncStore.getState().broadcastCrosshairTime(time);
}

export function subscribeRangeSync(cb: RangeSyncCallback) {
  return useChartSyncStore.getState().subscribeRangeSync(cb);
}

export function subscribeCrosshairSync(cb: CrosshairSyncCallback) {
  return useChartSyncStore.getState().subscribeCrosshairSync(cb);
}

export function getLastRange() {
  return useChartSyncStore.getState().lastRange;
}
