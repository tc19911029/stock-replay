import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export interface AnalysisChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AnalysisChatStore {
  /** 走圖問老師的對話（條件 ↔ 問老師 切換時不會掉）*/
  messages: AnalysisChatMessage[];
  setMessages: (m: AnalysisChatMessage[]) => void;
  /** 用 updater fn 來原子更新（streaming 時需要） */
  updateMessages: (updater: (prev: AnalysisChatMessage[]) => AnalysisChatMessage[]) => void;
  clear: () => void;
}

// 持久化上限：避免長期累積 AI 對話撐爆 localStorage（每條回應 1-3KB）。
// 50 條≈100-200KB，足夠保留近期上下文且不影響其他 store 配額。
const PERSIST_MESSAGE_LIMIT = 50;

const safeStorage = {
  getItem: (name: string) => {
    try { return localStorage.getItem(name); } catch { return null; }
  },
  setItem: (name: string, value: string) => {
    try {
      localStorage.setItem(name, value);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'QuotaExceededError') {
        // quota 爆 → 清掉自己降級重試（保留其他 store 不被波及）
        try { localStorage.removeItem(name); localStorage.setItem(name, value); } catch { /* still full */ }
      }
    }
  },
  removeItem: (name: string) => {
    try { localStorage.removeItem(name); } catch { /* ignore */ }
  },
};

export const useAnalysisChatStore = create<AnalysisChatStore>()(
  persist(
    (set) => ({
      messages: [],
      setMessages: (m) => set({ messages: m }),
      updateMessages: (updater) => set((s) => ({ messages: updater(s.messages) })),
      clear: () => set({ messages: [] }),
    }),
    {
      name: 'analysis-chat-v1',
      storage: createJSONStorage(() => safeStorage),
      // 持久化時只存最後 N 條，避免無限累積
      partialize: (s) => ({ messages: s.messages.slice(-PERSIST_MESSAGE_LIMIT) }),
    },
  ),
);
