import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Candle } from '../types';
import type { MarketId } from '../lib/scanner/types';

export interface PortfolioHolding {
  id: string;
  symbol: string;
  name: string;
  shares: number;
  /** 用戶實際進場成本價（議題 92：用戶實際買進價 = entryPrice）*/
  costPrice: number;
  buyDate: string;
  /** 市場（舊資料缺值時預設視為 TW） */
  market?: MarketId;
  /** 進場當日 OHLC 快照，停損計算用（朱 5 步驟 S1） */
  entryKbar?: Candle;
  notes?: string;

  // ── v12 Phase 0.3 新增欄位（議題 92 進場價分流）──────────────────────────

  /**
   * 系統觸發日鎖定的突破點價格（議題 92）
   *
   * 用於：
   * - 真突破 3 天驗證（K/D 訊號）— close < triggerPrice → 撤銷
   * - 系統訊號參考價
   *
   * 跟 costPrice（用戶實際買進價）分開：
   * - costPrice 用於 Step 3 停損 / Step 5 停利（個人盈虧計算）
   * - triggerPrice 用於系統訊號驗證
   */
  triggerPrice?: number;

  /**
   * 進場時觸發的訊號字母（B/P/C/J/K/L/M/D/F/N/O/E/Q/A）
   * 用於 Step 3 停損方法對應、議題 28 再進場路徑判定等
   */
  triggerSignal?: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J' | 'K' | 'L' | 'M' | 'N' | 'O' | 'P' | 'Q';

  /**
   * 操作模式（Step 4 ② / ③）
   * 'short' = 短線（MA5/MA10）；'long' = 長線（MA20）
   * 用戶手動切換（議題 Step 4 ③ 升級長線）
   * 0513 ABCDE E：'wave' 已砍（fall-through 跟 short 一樣，誤導用戶）
   */
  operationMode?: 'short' | 'long';

  /**
   * 進階紀律啟用 flag（議題 B 寶典 #5/#6）
   * B/P 訊號累計獲利 ≥ 10% 後啟用「< 10% 續抱、≥ 10% 才停利」紀律
   */
  enhancedDisciplineEnabled?: boolean;

  /**
   * 末升段 flag（議題 13）
   * 持倉中股價達末升段標準後 trigger，影響 Step 3 ④ 切 trailing 3%
   */
  endPhaseTriggered?: boolean;

  /**
   * 持倉中追蹤的最高 close（trailing stop 用，議題 S3-3）
   * 用於末升段 SL = recentHigh × 0.97
   */
  recentHigh?: number;

  /**
   * C 訊號（盤整突破）盤整下緣 — 進場時從 lockwatch / scan 帶入
   * 用於絕對停損 ⑥-1 跌破盤整區
   */
  consolidationLow?: number;

  /**
   * F 訊號（V 反轉）V 底 — 進場時從 lockwatch / scan 帶入
   * 用於絕對停損 ⑥-5 跌破 V 底
   */
  vBottom?: number;

  /**
   * 進場時凍結的型態快照（議題 C2，2026-05-13）
   *
   * 為什麼存在：持股後 chart 即時偵測的 patternType / target / neckline 會隨 K 棒變動，
   * 導致 Step 5 停利目標每日跳動。進場當下凍結一份，往後顯示讀這個 snapshot。
   * 缺值時 backend fallback 到即時計算（向下相容舊持倉）。
   */
  entryPattern?: {
    patternType: string;
    necklinePrice: number;
    targetPrice: number;
    stopPrice?: number;
    /** 'bottom' = 底部型態（B/C/N/O 進場），'top' = 頂部反向（不常用） */
    kind: 'bottom' | 'top';
  };
}

/** 已賣出（已實現）的一筆交易紀錄 */
export interface RealizedTrade {
  id: string;
  symbol: string;
  name: string;
  market: MarketId;
  shares: number;
  buyPrice: number;
  buyDate: string;
  sellPrice: number;
  sellDate: string;
  /** 實現損益金額（已扣手續費前） */
  realizedPL: number;
  /** 實現損益 % */
  realizedPLPct: number;
  /** 賣出原因（系統建議分類或使用者自填） */
  reason?: string;
}

/** TW 與 CN 是兩個獨立帳戶，各自有現金池 */
export type CashByMarket = Record<MarketId, number>;

interface PortfolioStore {
  holdings: PortfolioHolding[];
  /** 已實現損益歷史（賣出紀錄） */
  realizedTrades: RealizedTrade[];
  /** 各市場現金（獨立帳戶，預設 TW 100 萬 / CN 100 萬） */
  cashBalance: CashByMarket;
  /** 不買股票要保留的現金比例 %（每市場通用，從各自 cashBalance 扣除），預設 0 */
  cashReservePct: number;
  add: (h: Omit<PortfolioHolding, 'id'>) => void;
  remove: (id: string) => void;
  update: (id: string, h: Partial<Omit<PortfolioHolding, 'id'>>) => void;
  /** 賣出一筆持倉：寫入 realizedTrades + 移除 holding + 把實現現金加回該市場 cashBalance */
  sell: (id: string, sellPrice: number, sellDate: string, reason?: string) => void;
  /** 清掉某筆已實現紀錄（手動修正用） */
  removeRealized: (id: string) => void;
  setCashBalance: (market: MarketId, v: number) => void;
  setCashReservePct: (v: number) => void;
  /** P1-2: 匯出持倉為 JSON（下載檔案） */
  exportJSON: () => void;
  /** P1-2: 從 JSON 匯入持倉（合併或覆蓋） */
  importJSON: (json: string, mode?: 'merge' | 'replace') => boolean;
}

export const usePortfolioStore = create<PortfolioStore>()(
  persist(
    (set) => ({
      holdings: [],
      realizedTrades: [],
      cashBalance: { TW: 1_000_000, CN: 1_000_000 },
      cashReservePct: 0,
      add: (h) => set(s => ({
        holdings: [...s.holdings, { ...h, id: Date.now().toString() }],
      })),
      remove: (id) => set(s => ({ holdings: s.holdings.filter(h => h.id !== id) })),
      update: (id, partial) => set(s => ({
        holdings: s.holdings.map(h => h.id === id ? { ...h, ...partial } : h),
      })),
      sell: (id, sellPrice, sellDate, reason) => set(s => {
        const h = s.holdings.find(x => x.id === id);
        if (!h) return s;
        const market: MarketId = (h.market ?? 'TW') as MarketId;
        const grossProceeds = sellPrice * h.shares;
        const buyAmount = h.costPrice * h.shares;
        // 雙邊交易成本（與 lib/portfolio/fees.ts FEE_RATES 一致）：
        //   TW: 買賣手續費 0.1425% + 賣出證交稅 0.3%
        //   CN: 買賣手續費 0.031%（含過戶費）+ 賣出印花稅 0.05%（2023.8 起；舊 0.1% 已過期）
        const roundTripCost = market === 'TW'
          ? Math.max(20, Math.round(buyAmount * 0.001425))   // 買進手續費（最低 20）
            + Math.max(20, Math.round(grossProceeds * 0.001425))  // 賣出手續費
            + Math.round(grossProceeds * 0.003)                   // 證交稅
          : Math.max(5, Math.round(buyAmount * 0.00031))        // 陸股佣金（最低 5）
            + Math.max(5, Math.round(grossProceeds * 0.00031))
            + Math.round(grossProceeds * 0.0005);                 // 印花稅 0.05%（2023.8 後）
        // netProceeds = 賣出總金額 - 賣出手續費 - 賣出稅（買進手續費已在買入時扣除）
        const netProceeds = market === 'TW'
          ? grossProceeds - Math.max(20, Math.round(grossProceeds * 0.001425)) - Math.round(grossProceeds * 0.003)
          : grossProceeds - Math.max(5, Math.round(grossProceeds * 0.00031)) - Math.round(grossProceeds * 0.0005);
        const realizedPL = grossProceeds - buyAmount - roundTripCost;
        const realizedPLPct = buyAmount > 0
          ? (realizedPL / buyAmount) * 100
          : 0;
        const trade: RealizedTrade = {
          id: `r${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
          symbol: h.symbol,
          name: h.name,
          market,
          shares: h.shares,
          buyPrice: h.costPrice,
          buyDate: h.buyDate,
          sellPrice,
          sellDate,
          realizedPL,
          realizedPLPct,
          reason,
        };
        return {
          holdings: s.holdings.filter(x => x.id !== id),
          realizedTrades: [trade, ...s.realizedTrades].slice(0, 200),
          // cashBalance 加實收（已扣賣出手續費+稅，未扣買進手續費因買進當時應已扣）
          cashBalance: { ...s.cashBalance, [market]: s.cashBalance[market] + netProceeds },
        };
      }),
      removeRealized: (id) => set(s => ({
        realizedTrades: s.realizedTrades.filter(t => t.id !== id),
      })),
      setCashBalance: (market, v) => set(s => ({
        cashBalance: { ...s.cashBalance, [market]: Math.max(0, v) },
      })),
      setCashReservePct: (v) => set({ cashReservePct: Math.min(100, Math.max(0, v)) }),
      exportJSON: () => {
        const { holdings } = usePortfolioStore.getState();
        const data = JSON.stringify({ version: 1, holdings, exportedAt: new Date().toISOString() }, null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `portfolio-backup-${new Date().toISOString().split('T')[0]}.json`;
        a.click();
        URL.revokeObjectURL(url);
      },
      importJSON: (json: string, mode = 'merge') => {
        try {
          const parsed = JSON.parse(json);
          const imported: PortfolioHolding[] = parsed.holdings ?? parsed;
          if (!Array.isArray(imported)) return false;
          // 基本驗證
          const valid = imported.every(h =>
            typeof h.symbol === 'string' && typeof h.shares === 'number' && typeof h.costPrice === 'number'
          );
          if (!valid) return false;
          set(s => {
            if (mode === 'replace') {
              return { holdings: imported.map(h => ({ ...h, id: h.id ?? Date.now().toString() + Math.random() })) };
            }
            // merge: 新增不重複的（依 symbol + buyDate 判斷）
            const existingKeys = new Set(s.holdings.map(h => `${h.symbol}_${h.buyDate}`));
            const newHoldings = imported
              .filter(h => !existingKeys.has(`${h.symbol}_${h.buyDate}`))
              .map(h => ({ ...h, id: Date.now().toString() + Math.random() }));
            return { holdings: [...s.holdings, ...newHoldings] };
          });
          return true;
        } catch {
          return false;
        }
      },
    }),
    {
      name: 'portfolio-v1',
      version: 3,
      migrate: (persisted: unknown, fromVersion: number) => {
        const state = (persisted ?? {}) as Record<string, unknown>;
        // v0/v1 → v2：cashBalance 從單一數字改成 { TW, CN }
        if (fromVersion < 2) {
          const oldCash = typeof state.cashBalance === 'number' ? state.cashBalance : 1_000_000;
          state.cashBalance = { TW: oldCash, CN: 1_000_000 };
        }
        // 保證即使 missing 也有預設值
        if (!state.cashBalance || typeof state.cashBalance !== 'object') {
          state.cashBalance = { TW: 1_000_000, CN: 1_000_000 };
        } else {
          const c = state.cashBalance as Partial<CashByMarket>;
          state.cashBalance = { TW: c.TW ?? 1_000_000, CN: c.CN ?? 1_000_000 };
        }
        if (!Array.isArray(state.realizedTrades)) state.realizedTrades = [];

        // v2 → v3：v12 fields default to false/undefined（避免 === false vs === undefined 不一致）
        if (fromVersion < 3 && Array.isArray(state.holdings)) {
          state.holdings = (state.holdings as Array<Record<string, unknown>>).map((h) => ({
            ...h,
            // boolean 欄位明確初始化 false（不能用 undefined，下游會誤判）
            enhancedDisciplineEnabled: h.enhancedDisciplineEnabled ?? false,
            endPhaseTriggered: h.endPhaseTriggered ?? false,
            // 數值欄位保留 undefined（缺資料就是缺）— consumer 用 != null 判
          }));
        }
        return state as Partial<PortfolioStore>;
      },
    },
  ),
);
