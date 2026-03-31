---
version: v3.0
name: Stock-Replay v3 — 世界級台股研究平台
status: active
created: 2026-03-29
---

# Stock-Replay v3 — 世界級台股研究平台

## Core Value

打造一個世界級水準的台股研究平台，讓散戶投資者獲得接近機構級的研究體驗。從個人工具升級為公開產品，全面優化 UI/UX、分析深度、數據品質、當沖系統和測試覆蓋率。

## Project Context

現有 rockstock 是成熟的台股研究平台（130+ TypeScript 檔案、60+ API 端點），已有：
- 完整的六大條件選股系統（朱老師方法）
- 嚴謹回測引擎
- 6 角色 AI 深度分析（技術/基本面/新聞/辯論/綜合）
- SSE 串流分析
- TWSE/Yahoo 雙數據源
- 新聞情緒分析（RSS）

## Goals

1. **UI/UX 世界級**: shadcn/ui 設計系統，dark/light 主題，響應式佈局
2. **真實數據**: Fugle API（即時）+ FinMind API（歷史/財報/法人）
3. **AI 升級**: 籌碼分析師 + 基本面分析師用真實數據，同業比較
4. **當沖正式化**: 盤中 tick + 倉位計算 + 交易日誌
5. **公開產品品質**: 80% 測試覆蓋、WCAG 2.1 AA、Lighthouse > 90

## Constraints

- Next.js + TypeScript + Vercel 架構不變
- Claude API 成本可控（prompt caching）
- 維持現有選股核心邏輯

## Key Decisions

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-29 | 8-phase plan | 按依賴順序：設計系統→拆分→數據→AI→UI→當沖→PDF→測試 |
| 2026-03-29 | shadcn/ui + @tanstack/react-table | 最成熟的 React 組件庫組合 |
| 2026-03-29 | FinMind 優先（免費），Fugle 備用（付費） | 成本控制，FinMind 有歷史財報/法人 |
