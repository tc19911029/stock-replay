#!/bin/zsh
# 每日跑 L1 OHLC invariant audit，寫進 health snapshot 目錄
# 用法：./_audit-l1-invariant.sh

set -e

cd /Users/tzu-chienhsu/Desktop/rockstock
DATE=$(/bin/date +%Y-%m-%d)
LOG="/tmp/rockstock-audit-l1-invariant.log"

echo "[$(date '+%F %T')] [audit-l1-invariant] start" >> "$LOG"
/usr/local/bin/npx tsx scripts/audit-l1-invariant.ts --json --write "data/health-snapshot/l1-invariant-${DATE}.json" >> "$LOG" 2>&1
echo "[$(date '+%F %T')] [audit-l1-invariant] done exit=$?" >> "$LOG"
