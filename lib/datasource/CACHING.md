# 快取策略 (Caching Strategy)

## 三級快取架構

### Level 1: 即時資料 (Realtime) — 15-30s TTL
| 來源 | TTL | 說明 |
|------|-----|------|
| TWSE 即時報價 | 15s | `Cache-Control: max-age=15` |
| EastMoney 即時報價 | 30s | `MemoryCache` per quote |
| Tencent 個股報價 | 30s | `MemoryCache` per quote |
| Portfolio quotes polling | 15s | `Cache-Control: max-age=15` |

### Level 2: 日內資料 (Intraday) — 1-5min TTL
| 來源 | TTL | 說明 |
|------|-----|------|
| K線歷史（盤中） | 60s | `Cache-Control: max-age=60, stale-while-revalidate=120` |
| K線歷史（收盤後） | 300s | `Cache-Control: max-age=300, stale-while-revalidate=600` |
| MemoryCache (全域) | 5min | LRU 500 entries, 1min 清理週期 |
| Chip data (籌碼) | 10min | Per-date LRU, max 10 dates |

### Level 3: 歷史/基本面 (Historical) — 1-24h TTL
| 來源 | TTL | 說明 |
|------|-----|------|
| FinMind 三大法人 | 24h | Per-ticker cache |
| FinMind 融資融券 | 24h | Per-ticker cache |
| FinMind 月營收 | 24h | Per-ticker cache |
| FinMind 財務報表 | 24h | Per-ticker cache |
| Trading date resolution | 1h | 交易日判斷 |

## Client-side 快取 (useFetch hook)

| Hook | Cache Key | TTL |
|------|-----------|-----|
| `useFundamentals(ticker)` | `fundamentals:{ticker}` | 24h |
| `useChipData(symbol, date)` | `chip:{symbol}:{date}` | 10min |
| `useNews(ticker)` | `news:{ticker}` | 15min |

## 去重機制

- **Inflight deduplication**: `MultiMarketProvider` 同一 key 的並發請求共用 Promise
- **Client useFetch**: 同一 key 的 inflight 請求共用 Promise
- **Scanner candle cache**: 單次掃描期間暫存，防止關聯過濾重複拉取

## 注意事項

- `MemoryCache` 是 in-memory only，serverless cold start 會清空
- Rate limiter 也是 in-memory，多實例不共享（考慮 Upstash Redis 升級）
- `zustand/persist` 使用 localStorage，跨 tab 不同步
