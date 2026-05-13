#!/bin/zsh
# T+1 fill gaps wrapper — 隔日早上跑、補昨天 settle 完仍 pending 的個案
# 用法：./_t1-fill.sh TW   或   ./_t1-fill.sh CN

set -e

MARKET="${1:-TW}"
if [ "$MARKET" != "TW" ] && [ "$MARKET" != "CN" ]; then
  echo "[$(date '+%F %T')] [t1-fill] invalid market: $MARKET"
  exit 1
fi

# 補昨日 settle 留下的 pending — 取昨天日期
YESTERDAY=$(/bin/date -v-1d +%Y-%m-%d)
LOG="/tmp/rockstock-t1-fill-${MARKET}.log"

echo "[$(date '+%F %T')] [t1-fill-${MARKET}] start yesterday=${YESTERDAY}" >> "$LOG"
cd /Users/tzu-chienhsu/Desktop/rockstock
/usr/local/bin/npx tsx scripts/t1-fill-gaps.ts --market "$MARKET" --date "$YESTERDAY" --apply --concurrency 4 >> "$LOG" 2>&1
echo "[$(date '+%F %T')] [t1-fill-${MARKET}] done exit=$?" >> "$LOG"
