#!/bin/zsh
# EOD settlement wrapper for launchd
# 用法：./_eod-settle.sh TW   或   ./_eod-settle.sh CN

set -e

MARKET="${1:-TW}"
if [ "$MARKET" != "TW" ] && [ "$MARKET" != "CN" ]; then
  echo "[$(date '+%F %T')] [eod-settle] invalid market: $MARKET"
  exit 1
fi

# 用 lastTradingDay — 但盤後跑時 today 應該也是交易日
DATE=$(/bin/date +%Y-%m-%d)
LOG="/tmp/rockstock-eod-settle-${MARKET}.log"

echo "[$(date '+%F %T')] [eod-settle-${MARKET}] start date=${DATE}" >> "$LOG"
cd /Users/tzu-chienhsu/Desktop/rockstock
/usr/local/bin/npx tsx scripts/eod-settle.ts --market "$MARKET" --date "$DATE" --apply --concurrency 10 >> "$LOG" 2>&1
echo "[$(date '+%F %T')] [eod-settle-${MARKET}] done exit=$?" >> "$LOG"
