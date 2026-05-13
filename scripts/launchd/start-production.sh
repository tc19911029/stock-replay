#!/bin/zsh
# 切到 production mode 啟動 server（省一半 RAM、頁面更快）
# 使用前先確認沒有 npm run dev 跑著。
#
# 用法：bash scripts/launchd/start-production.sh
#       或加到 ~/.zshrc 取個 alias：alias rs-start='bash ~/Desktop/rockstock/scripts/launchd/start-production.sh'

set -e

cd "$(dirname "$0")/../.."

# 確認 port 3000 沒有被占用
if lsof -i :3000 >/dev/null 2>&1; then
  echo "❌ port 3000 已被占用，請先關掉現有的 dev/start server"
  echo "   提示：lsof -i :3000 看是哪個 process，再 kill 掉"
  exit 1
fi

echo "==> 1. 編譯 production build（首次約 1-3 分鐘）"
npm run build

echo ""
echo "==> 2. 啟動 production server（port 3000）"
echo "    instrumentation.ts 會自動跑：盤中 L2 / 掃描 / L1 下載 / ETF / TDCC"
echo "    停止：Ctrl+C"
echo ""

PORT=3000 npm run start
