#!/bin/zsh
# 一鍵停掉所有 rockstock launchd 排程（不含已存在的 etf-fetch / etf-track）
# 用法：bash scripts/launchd/uninstall-all.sh

set -e

TARGET="$HOME/Library/LaunchAgents"

echo "==> 卸載 rockstock launchd 排程"
for plist in "$TARGET"/com.rockstock.*.plist; do
  [ -f "$plist" ] || continue
  label=$(basename "$plist" .plist)

  # 保留 ETF 兩個原本就有的
  if [ "$label" = "com.rockstock.etf-fetch" ] || [ "$label" = "com.rockstock.etf-track" ]; then
    echo "  - $label (保留)"
    continue
  fi

  launchctl unload "$plist" 2>/dev/null || true
  rm -f "$plist"
  echo "  - $label ✓ 已停止並刪除"
done

echo ""
echo "==> 目前剩餘 rockstock 排程："
launchctl list | grep com.rockstock || echo "  (無)"
