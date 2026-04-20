#!/bin/bash
# 完整 L4 刷新：歸檔舊 B/C/E/F → 跑 A 策略 20 天 + B/C/D/E 新命名 20 天
set -e
cd "$(dirname "$0")/.."

echo "=== Step 1: 歸檔舊 B/C/E/F 檔案（命名衝突）==="
mkdir -p data/ARCHIVE-old-buymethods-0420
for m in TW CN; do
  for sfx in B C E F; do
    mv data/scan-${m}-long-${sfx}-2026-*.json data/ARCHIVE-old-buymethods-0420/ 2>/dev/null || true
  done
done
echo "歸檔 $(ls data/ARCHIVE-old-buymethods-0420 | wc -l) 檔"

echo ""
echo "=== Step 2: A 策略 20 天 rescan（8G heap）==="
export NODE_OPTIONS="--max-old-space-size=8192"
npx tsx scripts/rescan-history.ts --days 20

echo ""
echo "=== Step 3: B/C/D/E 新命名歷史 20 天 ==="
npx tsx scripts/scan-buy-methods-history.ts --days 20

echo ""
echo "=== 完成 ==="
