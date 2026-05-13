# 本地 launchd 排程（補 instrumentation.ts 沒做的）

## 為什麼只有 4 個（不是 60 個）

你的系統有兩層自動化：

### 第一層：`instrumentation.ts`（Next.js 啟動 hook）

只要你跑 `npm run dev` 或 `npm run start`，這個檔案會自動啟動以下排程：

- 盤中 L2 快照（每 5 分鐘）
- 盤中六條件掃描（每 10 分鐘）
- 盤中買法掃描 B-I（每分鐘輪流）
- 盤後 scan-tw / scan-cn（一次）
- 盤後買法 16 個並行（一次）
- L1 歷史日K 下載（每 10 分鐘檢查）
- append-from-snapshot 補當日K（每 5 分鐘檢查）
- auto-repair-watchdog（每 30 分鐘）
- daily-health-snapshot（盤後固化健康報告）
- ETF 18:00 fetch
- TDCC 週四 18:30

**這 11 件事 instrumentation.ts 全包了。** 不需要 launchd。

### 第二層：launchd（補 instrumentation.ts 沒做的）

只有 4 件事 instrumentation.ts 沒做，需要 launchd：

| Plist 檔 | 觸發時機（CST） | 做什麼 |
|---|---|---|
| `com.rockstock.tw-institutional.plist` | 平日 15:45 | TW 三大法人籌碼 |
| `com.rockstock.cn-flow.plist` | 平日 16:15 | CN 北上資金（capital + flow） |
| `com.rockstock.tw-lockwatch.plist` | 平日 18:50 | TW 鎖股名單刷新 |
| `com.rockstock.cn-lockwatch.plist` | 平日 19:00 | CN 鎖股名單刷新 |

加上你**已經在跑**的：
- `com.rockstock.etf-fetch.plist` — ETF 持股 18:00 / 22:00 / 隔日 09:00（補晚揭露）
- `com.rockstock.etf-track.plist` — ETF 變化追蹤每天 23:00

**總共 6 個 launchd 排程。**

## 安裝

```bash
cd ~/Desktop/rockstock

# 第一步：先讓 dev / production server 跑起來（另一個 terminal）
npm run dev    # 開發用（hot reload，吃 RAM 較多）
# 或
bash scripts/launchd/start-production.sh   # 正式用（省一半 RAM）

# 第二步：載入所有 launchd
bash scripts/launchd/install-all.sh
```

## 前提

1. **Mac 24/7 開機 + 接電源 + 不睡眠**
   - 系統設定 → 顯示器 → 進階 → 「電池接上電源時防止自動進入睡眠」打勾
2. **`npm run dev` 或 `npm run start` 必須在 port 3000 跑著**（launchd 打 localhost:3000）

## dev mode vs production mode

| | `npm run dev` | `npm run build && npm run start` |
|---|---|---|
| 用途 | 寫程式時 | 你只是用系統時 |
| RAM | 800MB–1.5GB | 300–500MB（省一半） |
| 第一次開頁面 | 慢（要編譯） | 快 |
| 改程式碼 | 自動 reload | 要重 build |
| **適合你嗎** | ❌ | ✅ |

兩者**都會啟動 instrumentation.ts**，所以排程都會跑。

## 確認

```bash
# 看哪些 launchd 已載入
launchctl list | grep com.rockstock

# 應該看到 6 個：
# com.rockstock.cn-flow
# com.rockstock.cn-lockwatch
# com.rockstock.etf-fetch       ← 你已有
# com.rockstock.etf-track       ← 你已有
# com.rockstock.tw-institutional
# com.rockstock.tw-lockwatch

# 看 log（明天平日 15:45 後）
tail -f /tmp/rockstock-tw-inst.log
```

## 手動立即測試

```bash
# 觸發一次（不等到時間到）
launchctl start com.rockstock.tw-institutional
cat /tmp/rockstock-tw-inst.log
```

## 暫停 / 移除

```bash
# 暫停某一個（保留檔案）
launchctl unload ~/Library/LaunchAgents/com.rockstock.tw-institutional.plist

# 全部停掉並刪掉（保留 etf-fetch / etf-track）
bash scripts/launchd/uninstall-all.sh
```

## 切回 Vercel

`vercel.json` 還在，所有 cron 設定都保留。要切回 Vercel：
1. `bash scripts/launchd/uninstall-all.sh` 停本地排程
2. 推一個 commit 到 main → Vercel 自動部署 → cron 復活

## 常見問題

**Q：launchd 觸發但 API 沒收到請求？**
- 檢查 `npm run dev` 是不是還在跑
- `lsof -i :3000` 看 port 有沒有占用
- `cat /tmp/rockstock-tw-inst.err.log` 看錯誤

**Q：盤中 Mac 會不會變慢？**
- instrumentation.ts 5 分鐘刷一次 L2，CPU 短暫飆高 5-10 秒
- 改 production mode（`npm run start`）會明顯比較順

**Q：Mac 蓋蓋子或睡覺，launchd 還會跑嗎？**
- 不會。一定要保持清醒。

## 變動歷史

- 2026-05-10：建立。從 vercel.json 60 cron → 11 個 launchd 計畫，後查 instrumentation.ts 發現大量重複，砍剩 4 個必要。
