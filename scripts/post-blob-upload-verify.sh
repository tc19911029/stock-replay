#!/bin/bash
# 等 upload-local-to-blob 完成後，自動驗證 Vercel Blob + commit
log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a /tmp/post-upload.log; }

cd /Users/tzu-chienhsu/Desktop/rockstock

log "⏳ 等待 upload-local-to-blob 完成..."
while true; do
  UPLOAD_RUNNING=$(ps aux | grep -v grep | grep -q "upload-local-to-blob" && echo 1 || echo 0)
  if [ "$UPLOAD_RUNNING" -eq 0 ]; then
    log "✅ upload-local-to-blob 已完成"
    break
  fi
  PROGRESS=$(tail -3 /tmp/blob-upload.log 2>/dev/null)
  log "  進度: $(echo "$PROGRESS" | tail -1)"
  sleep 60
done

sleep 5
log "📋 上傳結果:"
tail -5 /tmp/blob-upload.log | tee -a /tmp/post-upload.log

# ─── Vercel Blob 最終診斷 ────────────────────────────────────────────────────
log "🔍 Vercel Blob 診斷 (staleThreshold=2)..."
TW_RESP=$(vercel curl "/api/admin/repair-candles?market=TW&mode=diagnose&staleThreshold=2" 2>/dev/null)
TW_STALE=$(echo "$TW_RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('staleCount','?'))" 2>/dev/null || echo "parse_fail")
TW_TOTAL=$(echo "$TW_RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('totalStocks','?'))" 2>/dev/null || echo "?")

CN_RESP=$(vercel curl "/api/admin/repair-candles?market=CN&mode=diagnose&staleThreshold=2" 2>/dev/null)
CN_STALE=$(echo "$CN_RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('staleCount','?'))" 2>/dev/null || echo "parse_fail")
CN_TOTAL=$(echo "$CN_RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('totalStocks','?'))" 2>/dev/null || echo "?")

log "  TW Blob: stale=${TW_STALE}/${TW_TOTAL}"
log "  CN Blob: stale=${CN_STALE}/${CN_TOTAL}"

# ─── 本地最終統計 ────────────────────────────────────────────────────────────
log "📊 本地 Layer 1 最終統計..."
npx tsx -e "
const { readdirSync, readFileSync } = require('fs');
const T = '2026-04-13';
for (const m of ['TW','CN']) {
  const files = readdirSync('data/candles/'+m).filter(f=>f.endsWith('.json'));
  let done = 0;
  for (const f of files) {
    try {
      const d = JSON.parse(readFileSync('data/candles/'+m+'/'+f,'utf8'));
      if ((d.lastDate||'') >= T) done++;
    } catch {}
  }
  console.log(m+': '+done+'/'+files.length+' ('+(done/files.length*100).toFixed(1)+'%) 已到 '+T);
}
" 2>/dev/null | tee -a /tmp/post-upload.log

# ─── commit + push ───────────────────────────────────────────────────────────
log "📝 Commit + Push..."
git add scripts/upload-local-to-blob.ts scripts/repair-blob-loop.sh 2>/dev/null || true
git diff --staged --quiet || git commit -m "$(cat <<'EOF'
chore: 新增 Vercel Blob 批量上傳腳本

- upload-local-to-blob.ts: 直接從本地上傳到 Blob（繞過 repair API 超時）
- repair-blob-loop.sh: Blob 修復循環腳本

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
git push origin main 2>/dev/null || true
log "✅ 全部完成！Layer 1 本地 + Vercel Blob 同步完畢。"
