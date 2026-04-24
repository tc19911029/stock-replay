#!/bin/bash
# 完整 L4 刷新：每天獨立一個 node process，避免記憶體堆積 OOM
# 用法：bash scripts/full-l4-refresh.sh [天數=20]
set -e
cd "$(dirname "$0")/.."

DAYS=${1:-20}
HEAP=3072   # 3GB：單天資料用不到這麼多，保留一半給系統

# 列出最近 N 個交易日（利用 rescan-history 的 --date 參數逐天跑）
list_tw_days() {
  npx tsx -e "
import { isTradingDay } from './lib/utils/tradingDay';
const n = ${DAYS};
const days: string[] = [];
const cur = new Date();
while (days.length < n) {
  const iso = cur.toISOString().slice(0,10);
  if (isTradingDay(iso, 'TW')) days.push(iso);
  cur.setUTCDate(cur.getUTCDate()-1);
}
console.log(days.reverse().join(' '));
" 2>/dev/null
}

list_cn_days() {
  npx tsx -e "
import { isTradingDay } from './lib/utils/tradingDay';
const n = ${DAYS};
const days: string[] = [];
const cur = new Date();
while (days.length < n) {
  const iso = cur.toISOString().slice(0,10);
  if (isTradingDay(iso, 'CN')) days.push(iso);
  cur.setUTCDate(cur.getUTCDate()-1);
}
console.log(days.reverse().join(' '));
" 2>/dev/null
}

echo "=== Step 1: 歸檔舊 B/C/E/F 檔案（命名衝突）==="
mkdir -p data/ARCHIVE-old-buymethods-0420
for m in TW CN; do
  for sfx in B C E F; do
    mv data/scan-${m}-long-${sfx}-2026-*.json data/ARCHIVE-old-buymethods-0420/ 2>/dev/null || true
  done
done
echo "歸檔 $(ls data/ARCHIVE-old-buymethods-0420 | wc -l) 檔"

run_day() {
  local script="$1"
  local market="$2"
  local date="$3"
  echo "  ▶ [${market} ${date}] ${script}..."
  NODE_OPTIONS="--max-old-space-size=${HEAP}" \
    npx tsx "scripts/${script}" --market "$market" --date "$date" 2>&1 \
    | grep -v "^$" | grep -v "dotenv"
  sleep 2
}

echo ""
echo "=== Step 2: A 策略 TW（逐天）==="
TW_DAYS=$(list_tw_days)
for d in $TW_DAYS; do
  run_day rescan-history.ts TW "$d"
done

echo ""
echo "=== Step 3: A 策略 CN（逐天）==="
CN_DAYS=$(list_cn_days)
for d in $CN_DAYS; do
  run_day rescan-history.ts CN "$d"
done

echo ""
echo "=== Step 4: BCDEF TW（逐天）==="
for d in $TW_DAYS; do
  run_day scan-buy-methods-history.ts TW "$d"
done

echo ""
echo "=== Step 5: BCDEF CN（逐天）==="
for d in $CN_DAYS; do
  run_day scan-buy-methods-history.ts CN "$d"
done

echo ""
echo "=== 全部完成 ==="
