# B — E2E test plan：14 字母 × hot path

## 為什麼

833 memory entries / 389 commits / 67% 是 fix — 但全專案 unit test 只有 letterSOP 68 + contracts 17 = 85。改 A 處不知道 B 處炸，用戶用 UI 才發現。

## 範圍

每個字母（B/C/D/E/F/J/K/L/M/N/O/P/Q + v11 G/H/I alias）必驗：

| Path | 預期 | 驗證手段 |
|---|---|---|
| 進場 detector | matched=true / triggered=true | 預設 K 線 fixture |
| 字母 SOP 一致性 | letterSOP.operatingMA === SIGNAL_TO_TRAILING_MA === getOperationMA(letter, 'short') | ✅ 已做（letterSOP.test.ts cross-source） |
| 持倉 verdict | 損益 < -5% → 緊盯停損 / -5% < x < 10% → 繼續持有 / >= 10% → 可續抱 | 模擬 API response 跑 holdingVerdict() |
| inapplicableSellSignals | N/F 不該因 BREAK_MA5/10 升 verdict | 注入 sellSig fixture |
| step5HintFor | 對應書本頁碼 | letterSOP.takeProfitHint 已 ✅ |
| 進階紀律 gate | 只對 B/P 啟用 | letterSOP.enhancedDiscipline 已 ✅ |

## 預估工作

| 任務 | 時間 |
|---|---|
| 建 K 線 fixtures（每字母 1 個觸發 case + 1 個失效 case） | 1 天 |
| 寫 detector unit tests | 1 天 |
| 寫 holdingVerdict unit tests | 0.5 天 |
| 寫 SignalSummaryCard verdict tests | 0.5 天 |
| 寫 LockWatchPanel UI integration test | 0.5 天 |
| 跑通過 + 修發現的 bug | 0.5 天 |
| **合計** | **4 天** |

## Phased

- **B1 (1 天)**：補 holdingVerdict 純函式 unit tests（最快收益，立刻能跑）
- **B2 (1 天)**：建 detector K 線 fixtures（最重要的資料準備）
- **B3 (1 天)**：detector unit tests
- **B4 (1 天)**：UI integration test（用 RTL）

從 B1 開始最有效。

## 框架

- Jest（既有）+ ts-jest + @testing-library/react（需 add）
- fixtures 放 `__tests__/fixtures/candles/{symbol}-{date}.json`
- 共用 helper `__tests__/utils/mockHolding.ts`

## 完工標準

- 14 字母 × 4 path = 56 個 test minimum
- 每個 detector commit 強制有 test
- 加新字母 → 必須補 fixture + test
