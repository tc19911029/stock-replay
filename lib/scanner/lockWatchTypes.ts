/**
 * 鎖股觀察名單（LockWatch）資料結構
 *
 * v12 Phase 0.3 / 議題 23 / 65 / 93
 *
 * 適用範圍：F V 反轉 / N 型態確認（觸發時 detectTrend 通常還沒翻多，需走觀察階段）
 *
 * **不適用**：
 * - D 一字底（觸發 = 即時翻多事件，直接進場）
 * - O 打底完成（要件已含「反轉多頭確認」，直接進場）
 * - K 橫盤突破（多頭軌，走 ScanRecord.provisional）
 * - 多頭軌訊號（B/P/C/E/J/L/M）— 直接進場
 * - Q 戰法（獨立 SOP）
 *
 * 書本依據：
 * - 寶典 Part 11-1 第 7 位置「等型態確認」p.697
 * - 5 步驟 步驟 1 第 7 章「鎖股觀察」p.106
 * - 寶典 p.689 #12「最佳的 3-5 檔再檢視一遍」
 */

import type { MarketId } from './types';

/**
 * 一筆觀察名單紀錄
 *
 * 跨日持續追蹤，每日 cron 更新狀態。
 */
export interface LockWatchRecord {
  symbol: string;
  market: MarketId;

  /** 觸發日 ISO yyyy-mm-dd */
  triggeredDate: string;

  /** 觸發訊號（v12 議題 93：只有 F / N 走 LockWatch）*/
  triggerSignal: 'F' | 'N';

  /**
   * N 訊號的具體型態類型
   * - 'head-shoulder' 頭肩底
   * - 'complex-head-shoulder' 複式頭肩底
   * - 'triple-bottom' 三重底
   * - 'falling-diamond' 跌菱形
   * - 'rounding-bottom' 圓弧底
   * - 'descending-wedge' 下降楔形
   * - 'double-bottom' 雙重底
   */
  patternType?:
    | 'head-shoulder'
    | 'complex-head-shoulder'
    | 'triple-bottom'
    | 'falling-diamond'
    | 'rounding-bottom'
    | 'descending-wedge'
    | 'double-bottom';

  /**
   * 觸發日鎖定的突破點價格（議題 24 / 75）
   * - F：V 底反彈起點 close
   * - N：型態頸線價
   *
   * 撤銷判定基準：close < triggerPrice → 撤銷（議題 94）
   */
  triggerPrice: number;

  /**
   * 型態目標價（N 訊號用，議題 Step 5 ②）
   *
   * 達目標價 → 觸發 Step 5 停利訊號
   *
   * 計算公式（依型態）：
   * - 頭肩底：頸線 + (頸線 - 頭部最低)
   * - 三重底：頸線 + 平均底部到頸線高度
   * - 圓弧底：弧底深度 × 1.5
   * - 雙重底：頸線 + 高度
   */
  patternTargetPrice?: number;

  /**
   * 型態達成率（抓飆股 p.314-342 書本明寫）
   * 用於排序與 UI 顯示
   */
  patternAchievementRate?: number;

  /**
   * 當前生命週期階段
   *
   * 議題 23 / 65 / 93 / 17 / 62：
   * - observation：結構成立等趨勢確認
   * - entry-signal：趨勢確認 + SOP 過，可進場
   * - purchased：用戶已買進（同步寫入持倉 watchlist）
   * - revoked：訊號失效（close < triggerPrice / 翻空 / 結構失效）
   * - manually-removed：用戶手動移除
   * - structure-broken：結構失效自動移除
   */
  currentStage:
    | 'observation'
    | 'entry-signal'
    | 'purchased'
    | 'revoked'
    | 'manually-removed'
    | 'structure-broken';

  /**
   * 已觀察天數（資訊用，非過期判定）
   * 議題 17 鎖定純書本不限期，daysObserved 純供 UI 顯示
   */
  daysObserved: number;

  /** 完整事件歷史 */
  history: LockWatchEvent[];
}

export interface LockWatchEvent {
  date: string;
  event:
    | 'triggered'
    | 'provisional-pass'
    | 'provisional-revoke'
    | 'trend-confirmed'      // detectTrend 翻多 → entry-signal 升級
    | 'sop-passed'           // 進場 SOP 通過
    | 'purchased'            // 用戶買進
    | 'manual-remove'        // 用戶手動移除
    | 'structure-broken';    // 結構失效自動移除
  detail?: string;
}

/**
 * 一日的觀察名單（議題 61：單檔合併寫入避免 Blob 成本爆炸）
 *
 * 儲存路徑：data/lock-watch/{market}/{date}.json
 */
export interface LockWatchDailySnapshot {
  market: MarketId;
  /** 快照日期 ISO yyyy-mm-dd */
  date: string;
  /** 該日觀察名單股票（含所有 active 紀錄）*/
  records: LockWatchRecord[];
  /** 最後更新時間 ISO timestamp */
  lastUpdated: string;
}
