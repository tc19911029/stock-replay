# 夜班 Audit 報告（2026-05-10 02:00 - 03:55，~2 hr）

**用戶要求**：7 小時 overnight 全面檢查 L1/L4、六條件、所有策略結果合理性、LockWatch、形態偵測。

**結論**：跑了 7 phases 全完成。**找出 4 個 bug 全修並 commit + push**。tsc 全綠 / **34 suites 429 tests pass**。

---

## TL;DR — 3 件事你需要知道

### 1. L1/L4 沒消失，是本機 dev 環境問題

worktree 沒同步主 repo 的 4500 個 data 檔，所以 dev server 讀不到歷史資料。
**修法**：hardlink rsync 主 repo data → worktree data（不能 symlink，Turbopack 拒絕 out-of-root）。
**現況**：L1 正常 / L2 收盤 / L3 收盤 / L4 收盤 全部接通。

### 2. 找到 4 個 bug，全已修

| # | bug | 影響 | commit |
|---|---|---|---|
| 1 | **scanBuyMethod sixConditionsScore=0 hardcode** | 所有掃描結果顯示 0/6，UI 4 處嚴重誤導 | `5d8b242` |
| 2 | **detectDescendingWedge 永遠不觸發**（span 寫反了 + 1-day 假 wedge）| 兩市場 5000+ 股全部 0 命中 | `006dfa7` |
| 3 | **detectLetterN 已過 target 仍觸發** | 70% N 觸發是「過晚觸發」雜訊 | `5d8b242` |
| 4 | **detectTopPatterns 對稱問題**（已達 target 仍警示）| 頂部觸發 14 雜訊 | `7a920f4` |

修法後 5/8 TW pattern 觸發：底部 86 → 27、頂部 27 → 13（過濾 ~65% 雜訊）。

### 3. LockWatch 觀察天數 0 不是 bug

5/8 觸發、5/9-5/10 是週末，自上次觸發起**沒新交易日**，所以是 0 天正確。週一 5/11 收盤後 cron 跑會自動 +1。

---

## Phase 1：L1/L4 ✓

- TW: health=good / coverage 100% / L2 fresh 2080 quotes / L4 22 個歷史日期
- CN: health=good / coverage 96.7% / L2 fresh 3062 quotes
- CN 103 SS 主板下載失敗（17 永久停牌 + 86 暫時 fail）— 不影響核心

## Phase 2：v12 全字母掃描 ✓

最終 5/8 結果（修法後）：

| | TW | CN |
|---|---|---|
| B/C/D/G/J/K/L/O | 0 | 0 |
| E | 1 | 0 |
| F (V反轉) | 9 | 13 |
| H | 3 | 1 |
| I | 1 | 1 |
| M (軌道線) | 1 | 0 |
| **N (型態確認)** | **17** | **7** |
| P (高檔拉回) | 1 | 1 |
| Q (三均線戰法) | 3 | 7 |

多頭軌（J/K/L/M/P）大多 0 — Step 1 池子嚴格（TW 7 / CN 3 檔過六條件+戒律+淘汰法）。

## Phase 3：策略合理性 ✓

抽樣 5+ 檔逐字母驗證 detail：
- E (3702.TW)：跳空上漲缺口+1.44%、紅K 7.58%、量×4.0、runaway ✓
- F (2351.TW)：V反轉 4 要素齊全 ✓
- H (3374.TWO)：大量黑K + 2 日後紅K突破 + 量×3.85 ✓
- I (6190.TWO)：橫盤突破 + 中長紅K ✓
- M (3702.TW)：軌道值 108.27 ×3% + 紅K 7.58% + 量×4.0 ✓
- N (3026.TW)：跌菱形達成率 80%+突破頸線 271 ✓
- Q (6781.TW)：MA3 金叉 MA10 + 站上 + MA24 上揚 ✓

## Phase 4：LockWatch daysObserved=0 ✓ 不是 bug

詳見 TL;DR。週一 5/11 收盤 cron 跑會自動 +1。

## Phase 5：11 種型態 audit ✓

修法後最終命中（5/8 TW，27 底部 + 13 頂部）：

底部：head-shoulder 1, complex-h-s 3, triple-bottom 1, falling-diamond 2, rounding-bottom 6, descending-wedge 3, double-bottom 1, n-shape 10
頂部：head-shoulder-top 3, triple-top 4, double-top 6

**5 天歷史穩定性**（TW）：4/30 25/14、5/5 36/1、5/6 16/12、5/7 15/5、5/8 27/13。跨日波動正常反映市場結構。

## Phase 6：修補 ✓

4 commits 都 push 到 PR #49：
- `006dfa7` descending-wedge fix + audit 工具
- `5d8b242` sixConds + N target check
- `7a920f4` 頂部對稱 target check

LockWatch 5/8 snapshot 也清掉重跑：TW 26（9F+17N）、CN 20（13F+7N）— 全部 close 都還沒到 target。

## Phase 7：Follow-up（未做但記錄）

1. **LockWatch 沒「target-reached」自動升級停利通知**
2. **LockWatch storage append 不會撤銷舊雜訊紀錄**（已 workaround 手動清重跑）
3. **多頭軌 Step 1 池子嚴格**（TW 7 檔），可考慮放寬 indicator 條件
4. **新型態 happy-path 測試缺**（需構造 MA5 序列觸發 pivot 鏈）
5. **CN head-shoulder-top 0 命中** — 5/8 真實當日結構，下次有命中觀察

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
- Jest 34 suites / 429 tests pass / 9 skipped
- Dev server (port 3000) 訊號分頁渲染正常、L1-L4 全部接通、console 無 error

---

報告寫於 worktree 根目錄 `OVERNIGHT_AUDIT_REPORT.md`，PR 連結 https://github.com/tc19911029/rockstock/pull/49
