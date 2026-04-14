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

- **時間一律用台灣時間（CST, UTC+8）**，不寫 UTC。例如：15:45 CST 而非 7:45 UTC。
