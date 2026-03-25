import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface SettingsStore {
  notifyEmail: string;
  notifyMinScore: number;
  setNotifyEmail: (email: string) => void;
  setNotifyMinScore: (score: number) => void;
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      notifyEmail: '',
      notifyMinScore: 5,
      setNotifyEmail: (email) => set({ notifyEmail: email }),
      setNotifyMinScore: (score) => set({ notifyMinScore: score }),
    }),
    { name: 'settings-v2' }
  )
);
