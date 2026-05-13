#!/bin/zsh
# 共用 cron 觸發腳本
# 用法：./_curl-cron.sh <label> <endpoint> [endpoint2 ...]
# 範例：./_curl-cron.sh tw-scan "/api/cron/scan-tw"
#       ./_curl-cron.sh cn-flow "/api/cron/fetch-cn-capital-flow" "/api/cron/fetch-cn-flow"

set -e

LABEL="${1:-unknown}"
shift

if [ $# -eq 0 ]; then
  echo "[$(date '+%F %T')] [$LABEL] no endpoints provided"
  exit 1
fi

# CRON_SECRET 由 launchd EnvironmentVariables 注入；本機 dev 不檢查也沒關係
SECRET="${CRON_SECRET:-CRON_SECRET}"

for endpoint in "$@"; do
  echo "[$(date '+%F %T')] [$LABEL] GET $endpoint"
  /usr/bin/curl -fsS \
    --max-time 600 \
    -H "Authorization: Bearer $SECRET" \
    -w "\n[$LABEL] HTTP %{http_code} time=%{time_total}s\n" \
    "http://localhost:3000${endpoint}" \
    || echo "[$(date '+%F %T')] [$LABEL] curl failed (exit $?) for $endpoint"
done
