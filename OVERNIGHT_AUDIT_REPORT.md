# 夜班深度 Audit 報告（2026-05-10 02:00 - 06:30，~4.5 hr）

**用戶要求**：7 小時 overnight 持續 audit + 修問題，「不要停一直跑」。

**戰績**：兩輪深度 audit 找到 **7 個 bug 全修 + 1 dead code 警告**。tsc + 34 suites / **429 tests pass**。PR #49 OPEN/MERGEABLE/CI 全綠。

---

## TL;DR — 最重要的 5 件事

### 1. L1/L4 沒消失，是 worktree 沒同步主 repo data

worktree 沒有主 repo 的 4500 個 data 檔，dev server 讀不到歷史資料。
**修法**：hardlink rsync（不能 symlink，Turbopack 拒絕 out-of-root）。
**現況**：L1 正常 / L2 收盤 / L3 收盤 / L4 收盤。

### 2. 找到 7 個 bug，全已修

| # | bug | 影響 | commit |
|---|---|---|---|
| 1 | **scanBuyMethod sixConditionsScore=0** hardcode | 所有掃描結果 0/6，UI 4 處嚴重誤導 | `5d8b242` |
| 2 | **detectDescendingWedge 永遠不觸發**（span 寫反了 + 1-day 假 wedge）| 5000+ 股全 0 命中 | `006dfa7` |
| 3 | **detectLetterN 過晚觸發**（已過 target 仍報進場）| 70% N 訊號是雜訊 | `5d8b242` |
| 4 | **detectTopPatterns 對稱問題**（已達 target 仍警示）| 14 個雜訊頂部訊號 | `7a920f4` |
| 5 | **detectVReversal 沒檢查 body ≥ 2%**（連 0.1% 紅K都觸發）| 9→6 (TW)、13→11 (CN) 過濾雜訊 | `72c75b2` |
| 6 | **detectABCBreakout 多頭判斷時機誤**（用「今日 trend」太嚴）| 兩市場 0 命中 → TW 5 / CN 2 | `72c75b2` |
| 7 | **N 字底 patternTargetPrice 用 close 不是 A 高**（target 漂移無法被 0.97 過濾）| 10→2 過濾 8 個過晚觸發 | `b74447a` |

### 3. LockWatch 觀察天數 0 不是 bug

5/8 觸發 + 5/9-5/10 週末，自上次觸發起無新交易日。週一 5/11 收盤後 cron +1。

### 4. v12Signals.ts 是 dead code（已標警告）

- `detectV12J/K/L/M/N/O/P/Q + detectV12Signal + evaluateStockV12` production 沒人呼叫
- 只有 scripts/v12-replay-comparison.ts 提到（且寫 TODO）
- 但 `V12Letter` type export 仍被多處 import → 整檔不能刪
- 加 ⚠️ DEAD CODE WARNING 註解 + 未來清理計畫

### 5. PR #49 Ready to Merge

- 11 commits / OPEN / MERGEABLE
- CI: check SUCCESS / Vercel SUCCESS / Vercel Preview Comments SUCCESS

---

## Round 1 Audit（02:00-04:00）

### Phase 1: L1/L4 ✓
- TW: health=good / coverage 100% / L2 fresh 2080 quotes / L4 22 個歷史日期
- CN: health=good / coverage 96.7% / L2 fresh 3062 quotes
- CN 103 SS 主板下載失敗（17 永久停牌 + 86 暫時 fail）— 不影響核心

### Phase 2: v12 全字母掃描 ✓
最終 5/8 結果：

| | TW | CN |
|---|---|---|
| B/C/D/G/J/K/L/O | 0 | 0 |
| E | 1 | 0 |
| F (V反轉) | 6 | 11 |
| G (ABC) | 5 | 2 |
| H | 3 | 1 |
| I | 1 | 1 |
| M (軌道線) | 1 | 0 |
| **N (型態確認)** | **17** | **7** |
| P (高檔拉回) | 1 | 1 |
| Q (三均線戰法) | 3 | 7 |

### Phase 3: 策略合理性 ✓
抽樣 5+ 檔逐字母驗證 detail（detail string 完整、書本 reference 對應）。

### Phase 4: LockWatch daysObserved=0 ✓ 不是 bug

### Phase 5: 11 種型態 audit ✓
修法後最終命中（5/8 TW，27 底部 + 13 頂部）。5 天歷史穩定。

### Phase 6/7: 修補 + 報告 ✓

---

## Round 2 深度 Audit（04:00-06:30）

逐一審視 14 個 detector + 戒律 + 淘汰 + MTF + sellSignals + provisional + Step 0 大盤 gate + step1Pool。

### F V 反轉缺 body 門檻（修 commit 72c75b2）
原邏輯 `if (today.close <= today.open)` 連 0.1% 紅K都算「紅K帶量」。
不對齊書本 SOP ⑤「紅K實體棒 > 2%」+ B/C/D/E/N/O/P/Q 都有此門檻。
修法：加 `if (bodyPct < 2.0) return null`。

### G ABC 突破 detectTrend 檢查時機誤（修 commit 72c75b2）
原邏輯：「今日 detectTrend = 多頭」。但 ABC 修正末段 + 突破當日結構是 LH+LL（短空）或盤整，trend 幾乎不會是多頭。書本 p.697 本意是「**修正之前**是多頭」。
修法：用 `abc.legAHighIdx` 處的 detectTrend 判斷修正之前是否多頭。
影響：G 5/8 兩市場 0 → TW 5 / CN 2 命中。

### N 字底 patternTargetPrice 漂移（修 commit b74447a）
原邏輯 `target = candles[idx].close + nHeight` 用今日 close 當突破點 → target 跟著 close 漂移。
書本《抓飆股》Part 7：N 字底突破 A 高後再漲 nHeight。
修法：`target = a.price + nHeight`。影響：n-shape 10→2 過濾雜訊。

### 其他 audit 結論（沒 bug）

- **B/C/D/E/H/I/M/O/P/Q**：邏輯對齊書本各章節，無明顯 bug
- **戒律 10 條** (entryProhibitions): 7 條實作（2/3/4/6/7/8/9），1/5/10 由其他層處理（六條件、MarketScanner）。對齊書本 p.57 + p.82-85
- **淘汰法 R1-R7+R9**: 對齊書本 p.659-662（R8/R10/R11 移除原因合理）
- **MTF 週/月線**: 週線前 5 條件全過 = gate；月線只要 score ≥ 1 = 加分
- **sellSignals**: 涵蓋 20+ 種出場訊號，對齊書本《抓住線圖》第 3 篇 p.150-154 + 寶典 Part 11-1 + 朱老師獲利方程式
- **Provisional 3 天**: 對齊書本《抓飆股》p.338「停留 3 天」
- **Step 0 大盤 gate**: trend=多頭 + close ≥ MA20 + MA20 上揚 + pivot pair
- **step1Pool 7 檔太少**: 設計嚴格的副作用，非 bug
- **33 圖像 detector**: 邏輯對齊 Part 12 秘笈圖
- **CandleChart 切線**: pivots newest-first 處理正確

### 1 個 dead code 警告

`lib/analysis/v12Signals.ts` 整檔的 `detectV12X` 系列+ `evaluateStockV12`是死程式碼（commit `b74447a` 加 ⚠️ 註解）。

---

## 不是 bug 但記錄的 follow-up

1. **detectStrategyD 連 5 天兩市場 0 命中** — 條件嚴格（40 天盤整+量縮+均線糾結 3%）但合理
2. **rule07 indicatorDivergence 只檢查「空頭」**（書本是「頭頭低」，比空頭寬鬆）— 影響中等
3. **多頭軌 Step 1 池子嚴格**（TW 7 檔），可考慮放寬 indicator 條件
4. **CN head-shoulder-top 0 命中** — 5/8 真實當日結構，非 bug
5. **CN 103 SS 主板下載失敗** — 17 永久停牌 + 86 暫時 fail
6. **LockWatch 沒「target-reached」自動升級停利通知**
7. **LockWatch storage append 不會撤銷舊雜訊紀錄**（已 workaround 手動清重跑）
8. **新型態 happy-path 測試缺**（需構造 MA5 序列觸發 pivot 鏈）
9. **dead code v12Signals.ts** — 後續抽 V12Letter type 到獨立檔再刪實作

---

## 工具留下來

- `scripts/audit-pattern-coverage.ts` — 全市場跑 11 種 detector 統計命中
- `scripts/probe-pattern.ts` — 個股探針（含 pivot 列表 + detail）

## 環境設定（hardlink rsync 主 repo data + symlink env）

```bash
cd /Users/tzu-chienhsu/Desktop/rockstock/.claude/worktrees/<name>
npm install --prefer-offline --no-audit --no-fund   # ~30s
ln -s /Users/tzu-chienhsu/Desktop/rockstock/.env .env
ln -s /Users/tzu-chienhsu/Desktop/rockstock/.env.local .env.local
rsync -a --link-dest=/Users/tzu-chienhsu/Desktop/rockstock/data/ \
  /Users/tzu-chienhsu/Desktop/rockstock/data/ ./data/   # ~5-10s
# 確認 launch.json autoPort: false
preview_start dev
```

## 測試

- tsc 全綠
- Jest **34 suites / 429 tests pass / 9 skipped**
- Dev server (port 3000) 訊號分頁渲染正常、L1-L4 全部接通、console 無 error

---

PR #49: https://github.com/tc19911029/rockstock/pull/49 — 11 commits / Ready to merge
