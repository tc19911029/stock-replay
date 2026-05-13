# 0513 ABCDE — 自創邏輯 audit + 補書本對齊

## 為什麼建立

用戶質疑「天天修但天天有新 bug」。Root cause 之一：書本沒明寫的 gap 我用「合理推論」填，每個自創邏輯都是潛在 bug 來源（如 lockwatch Phase C 反覆 7 commits 後砍光）。

## 31 個自創 magic number 清單

### ✅ CRITICAL 已標 JSDoc（6 個 / 0513）

| 檔案:行 | 自創常數 | 用途 | 書本對齊狀態 |
|---|---|---|---|
| `lib/analysis/v12LetterN.ts:226` | `* 1.20` | 不追過頭 padding | 書本本意支持，已標 |
| `lib/analysis/v12LetterN.ts:233` | `* 0.97` | 已達標 padding | 業界慣例，已標 |
| `lib/analysis/v12LetterN.ts:833` | `* 1.03` | 頂部對稱已達標 | 對稱 0.97，已標 |
| `lib/analysis/highWinRateEntry.ts:128-129` | MAX_LOOKBACK=120 / MIN_CONSOLIDATION=40 | 一字底盤整參數 | 抓住飆股 25 #9 精神，已標 |
| `lib/sell/v12TakeProfit.ts:80` | `<= 0.02` 距離壓力區 | 到達壓力提示 | 5 步驟 5 ④#1 精神，已標 |

### 🟠 HIGH 待補（影響 verdict / entry）

| 檔案:行 | 自創常數 | 動作 |
|---|---|---|
| `lib/analysis/volumePatterns.ts:38` | `* 1.3` | 改 import `BOOK_VOL_RATIO_MIN` |
| `lib/analysis/volumePatterns.ts:44` | `* 0.5` 止跌量 | 加 JSDoc 標自創 |
| `lib/analysis/highWinRateEntry.ts:143` | `>= 0.15` 開口度 | 加 JSDoc 標自創 |
| `lib/sell/v12Operation.ts:95` | `< 0.10` 升級條件 | 改 import `PROFIT_TARGET_RULE_PCT` |
| `lib/sell/v12Operation.ts:160` | `>= 0.30` 升級超長線 | 加常數 SUPER_LONG_PROFIT_PCT 進 bookThresholds |
| `lib/sell/v12TakeProfit.ts:228` | `>= 0.20` 累計利潤 | 改 import `PROFIT_HIGH_TIER_PCT` |
| `lib/analysis/sellSignals.ts:88` | `* 0.99` 跌破 MA20 1% 緩衝 | 加 JSDoc 標自創 |
| `lib/analysis/redKValidator.ts:69` | `>= 0.03` 跳空 3% | 加 JSDoc 標自創 |
| `lib/analysis/gapAnalysis.ts:74` | `> 0.3` 有意義跳空 | 已標 "arbitrary"，補正式 JSDoc |

### 🟡 MEDIUM 待補（最少歷史天數 idx<N）

15+ 處 `if (idx < 30)` `if (idx < 25)` 等 — 預估 1 小時批量加註

### 🟢 LOW 待補（純 cosmetic）

3-5 處不影響判定的 padding，最後處理

## 補完策略

1. ✅ Critical 6 個已標（0513）
2. 🟠 High 8 個 — 下輪做（每個約 5 min）
3. 🟡 Medium 15+ 個 — 統一搬到 bookThresholds.ts + 加 JSDoc
4. 🟢 Low — 最後

## 鎖死規則

從 0513 起，PR review checklist 必含：
- 新加 magic number → JSDoc `⚠️ 自創 padding（書本沒明寫量化）` + 為什麼書本本意支持
- 改 bookThresholds.ts → 跑 contracts test
- 改 letterSOP.ts → 跑 cross-source test（強制等於 SIGNAL_TO_TRAILING_MA / LETTER_NAMES）
