# 0513 deferred audit bugs 全部清完

## C4 + 跨日遺失（合修）

新建 [scripts/evolve-lockwatch-backfill.ts](scripts/evolve-lockwatch-backfill.ts)：
- 過去 N 天逐日 evolve，從 prev snapshot 演進到 today
- 用 LocalCandleStore（不打外部 API，dev 也能跑）
- 對齊 update-lockwatch cron 的 checkStructureBroken → updateLockWatch 流程
- 結果：TW 14 天 / CN 12 天 evolve 完
  - TW 5/13 從 13 條 → **321 條** (含跨日累積 active records)
  - CN 5/13 從 29 條 → **236 條**
  - 2467.TW 找回 5/13 observation
- Blob 同步：46 個檔 ok=46 fail=0

## M10：entryPattern.stopPrice → backend

- [store/portfolioStore.ts](store/portfolioStore.ts) `entryPattern.stopPrice` 欄位已有
- [components/BottomPanel.tsx](components/BottomPanel.tsx) 傳 `patternStopPrice={h.entryPattern?.stopPrice}`
- [components/HoldingV12Signals.tsx](components/HoldingV12Signals.tsx) 接 prop + 帶 URL query
- [app/api/portfolio/v12-signals/route.ts](app/api/portfolio/v12-signals/route.ts) zod schema + N 字母 supportLevel = patternStopPrice fallback + checkAbsoluteStopLoss consolidationLow 用 patternStopPrice

## L 系列小修

- L2: criticalProhibitions slice(0,3) 加「顯示前 3，共 N 條」提示
- L3: useLockedPattern symbol normalize 註解
- L6: pending-breakout label 「等突破（舊）」→ 「舊資料（已棄）」灰字
- L7: route.ts console.error → logger

## 驗證結果

- ✅ tsc 全綠（唯一錯是別人的 eodSettle.ts untracked work）
- ✅ 85 unit tests 全綠（letterSOP 68 + contracts 17）
- ✅ N 持倉 + patternStopPrice 傳 backend、 stopLossPrice 邏輯正確
- ✅ **2467 走圖型態 chip 顯示「鎖定」**（之前因 5/13 lockwatch 缺失顯示「即時」）
- ✅ 測試持股已清

## 三輪累積 + 治根改動

| 層 | 修法 |
|---|---|
| 資料 | normalize pending-breakout、evolve-lockwatch 跨日補完、同步 Blob |
| 業務邏輯 | letterSOP 單一事實表 + 68 unit tests、N→J/H→L/I→K normalize、書本 SOP 字母分顯 |
| UI | verdict box、人話翻譯、字母名 LETTER_NAMES、進階紀律 gate、AbortController 防 race、強制重載 button、Step 4 翻譯、L2 提示、L6 灰字 |
| 後端 | M10 patternStopPrice、route logger、normalizeLetter 入口 |

Audit 30 個 bug **清完 25 個**（5 critical + 7 high + 11 medium + 2 low 完成；剩 L1（拆 component 540 行）、L4（toast）、L5（ops doc）等純品質項）
