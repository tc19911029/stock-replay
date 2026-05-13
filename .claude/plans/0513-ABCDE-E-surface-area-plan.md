# E — 砍 surface area

## 為什麼

surface area 失控（14 字母 × short/long/super-long/wave × TW/CN × 多時段 × 5 個資料源 = 數千 state 組合）導致：
- 沒法測完整矩陣
- 每天用戶發現某個 cell 沒覆蓋
- 死代碼跟活代碼混在一起

## 砍除清單

### 立即可砍

| 項目 | 原因 | 影響 |
|---|---|---|
| `operationMode='wave'` | UI 拿掉但 type/store/route 殘留；fall-through 跟 short 一樣 | 砍 wave type / store schema / route enum / HoldingV12Signals switchMode case |
| `operationMode='super-long'` | UI 無入口；getOperationMA 處理 MA60 但用戶看不到 | 砍 / 或補入口 |
| `app/api/cron/scan-bm-batch/route.ts` | 跟 scan-bm 重複；之前迭代殘留 | 確認沒 cron 在用後砍 |
| `lib/analysis/highWinPositions.ts.detectStrongPullbackResume` 等舊 6 位置 detector | 已被 letterSOP 14 字母取代 | 確認沒呼叫後砍 |
| `lib/scanner/lockWatchManager.ts.pending-breakout` stage | 書本沒此概念，0513 已砍寫入但 stage 還在 union type | 收尾砍 stage |
| `useReplayStore` 的 wave / super-long 相關 state | 同上 | 砍 |

### 待 audit 才能砍

| 項目 | 原因 |
|---|---|
| `lib/analysis/v12LetterG/H/I` 字母 detector？ | 確認 v11→v12 alias 後是否還在跑 |
| `scripts/backfill-prohibition-history.ts` 等舊 backfill | 一次性腳本，跑完應 archive |
| `data/ARCHIVE-old-buymethods-0420/` | 早 archive，可移到 /backup |
| `lib/analysis/sellSignals.ts` 25+ 種訊號 | 全部都還在用嗎？grep 後砍未引用 |

## 預估工作

- 立即砍：1 天（含確認 + 跑 tests）
- 待 audit：1 天（grep + 確認）

## 風險

砍掉死代碼前必須：
1. grep 確認無呼叫
2. 跑 tsc + tests
3. 跑 contracts test
4. **commit 一次砍一項**，方便 revert

## 完工標準

- `wc -l lib/**/*.ts` 減 20% 以上
- 沒新增任何 wave/super-long 邏輯（從 hardcode 拿掉）
- letterSOP 的 14 字母是「全部進場 entry path」唯一定義（不再有 6 位置 / 25 型態的散落 detector）
