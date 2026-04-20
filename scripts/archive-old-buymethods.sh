#!/bin/bash
# 歸檔舊命名的 B/C/E/F L4 scan 檔案（因策略改名 E→D、F→E）
set -e
cd "$(dirname "$0")/.."
mkdir -p data/ARCHIVE-old-buymethods-0420

for m in TW CN; do
  for sfx in B C E F; do
    mv data/scan-${m}-long-${sfx}-2026-*.json data/ARCHIVE-old-buymethods-0420/ 2>/dev/null || true
  done
done

echo "Archived: $(ls data/ARCHIVE-old-buymethods-0420 | wc -l) files"
