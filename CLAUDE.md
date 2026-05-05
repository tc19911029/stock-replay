@AGENTS.md

## Fundamental Requirements（不可覆寫）

**必讀**: 任何修改前必須先閱讀 [docs/FUNDAMENTAL_REQUIREMENTS.md](docs/FUNDAMENTAL_REQUIREMENTS.md)

以下規則不可因任何新需求而違反：

1. **歷史日K封存後不可被盤中資料覆蓋** — Layer 1 與 Layer 2 完全分離
2. **掃描紀錄必須用複合主鍵** — `market + strategy + trade_date + session_type + scan_timestamp`，不同日期不互相覆蓋
3. **全市場掃描必須使用快照粗掃** — 不可逐檔讀取 Blob（會導致 Vercel 超時）
4. **走圖/持倉更新必須獨立於掃描資料流** — Layer 3 與 Layer 2 分開
5. **選股條件只用書本規則**（六條件+戒律+淘汰法），不加自創因子
6. **API 分工由底層設計** — 不可因新功能改變 Provider 路由策略
7. **任何修改必須先通過合約測試** — `npm run test:contracts`
8. **不可刪除或修改 `lib/contracts/` 下的檔案**
9. **開發順序**：資料來源 → 儲存方式 → 掃描鏈路 → 前端顯示，不可反過來
10. **選股邏輯單一事實**：六條件、戒律、淘汰法、MTF 過濾、排序因子、門檻值必須從 `lib/selection/applyPanelFilter.ts` + `lib/strategy/StrategyConfig.ts` 讀取，**不可 hard-code 於 UI、store、回測腳本**。改動時同時更新：
    - `lib/scanner/ScanPipeline.ts` / `MarketScanner.ts`（生產）
    - `store/backtestStore.ts`（前端 UI 過濾）
    - `scripts/backtest-*.ts`（回測腳本）
    - `__tests__/contracts/scan-parity.test.ts`（交叉驗證）
    並跑 `npm run test:contracts` 確認三方一致。

## 資料分層架構

```
Layer 1: 歷史日K主資料庫（封存後不可變）
Layer 2: 盤中即時快取層（全市場快照，單一檔案）
Layer 3: 個股高頻走圖層（走圖+持倉，最多20檔）
Layer 4: 掃描結果層（複合主鍵，intraday vs post_close）
```

## 兩級掃描

```
粗掃: 讀 Layer 2 全市場快照 → 幾十檔候選（< 3 秒）
精掃: 候選池讀 Blob 歷史K線 → 六條件+戒律+淘汰法（< 30 秒）
```

## 溝通慣例

- **時區永遠是台灣 (CST, UTC+8)**。對話、log、cron 排程討論一律用 CST，不寫 UTC。
  - 例：15:45 CST 而非 07:45 UTC。
  - 注意 `fetchedAt` 等 ISO 字串底層是 UTC，**讀取時務必 +8h** 才是台灣時間（曾因此誤判 0505 凌晨 01:14 抓到的 mislabel snapshot）。
  - `vercel.json` cron 表達式是 UTC（Vercel 平台規定），例如 `"0 10 * * 1-5"` = CST 18:00。
  - 本地 launchd plist 的 Hour 是機器 local time，台灣機器直接寫 CST 數字（18 = 18:00 CST）。

## ETF 持股資料規則（避免 mislabel）

主動式 ETF 揭露時間：盤後 17:00-21:00 CST。**禁止在揭露時間前抓資料寫成「當日」snapshot**：

- `disclosureDate` **必須**用資料源回傳的日期欄位（CMoney row[0]、MoneyDJ HTML 揭露日），不可直接用 cron 觸發當下的日期。
- 既存 snapshot 不可只看 `existing && !force` 就跳寫；應比對 holdings 內容 hash，不同就覆寫（盤後揭露完整版 wins）。
- 排查資料正確性時，**先打 CMoney API 對 ground truth**，不可只看本地 diff 結果就下「無變化」結論。CMoney 端點：
  ```
  https://www.cmoney.tw/MobileService/ashx/GetDtnoData.ashx
    ?action=getdtnodata&DtNo=59449513
    &ParamStr=AssignID={etfCode};MTPeriod=0;DTMode=0;DTRange=5;DTOrder=1;MajorTable=M722;
    &FilterNo=0
  ```
