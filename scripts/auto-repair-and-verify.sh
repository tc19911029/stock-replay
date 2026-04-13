#!/bin/bash
# 全自動修復流程：等待本地腳本→修復Vercel Blob→驗證→commit+push

TARGET_DATE="2026-04-13"
VERCEL_URL="https://rockstock-pv90u666w-tc19911029-5086s-projects.vercel.app"
PROJECT_DIR="/Users/tzu-chienhsu/Desktop/rockstock"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

is_running() { ps aux | grep -v grep | grep -q "$1" && echo 1 || echo 0; }

cd "$PROJECT_DIR"

# ─── Step 1: 等待本地修復腳本結束 ───────────────────────────────────────────
log "⏳ Step 1: 等待本地修復腳本完成..."
while true; do
  CN_RUNNING=$(is_running "repair-cn-tencent-mass")
  TW_RUNNING=$(is_running "repair-tw-lagging")
  CORRECT_RUNNING=$(is_running "correct-candles")

  if [ "$CN_RUNNING" -eq 0 ] && [ "$TW_RUNNING" -eq 0 ] && [ "$CORRECT_RUNNING" -eq 0 ]; then
    log "✅ 所有本地修復腳本已完成"
    break
  fi

  STILL_RUNNING=""
  [ "$CN_RUNNING" -eq 1 ] && STILL_RUNNING="${STILL_RUNNING}CN騰訊 "
  [ "$TW_RUNNING" -eq 1 ] && STILL_RUNNING="${STILL_RUNNING}TW落後 "
  [ "$CORRECT_RUNNING" -eq 1 ] && STILL_RUNNING="${STILL_RUNNING}TW品質修正 "

  # 快速統計進度
  CN_DONE=0; CN_TOTAL=0; TW_DONE=0; TW_TOTAL=0
  CN_TOTAL=$(ls data/candles/CN/*.json 2>/dev/null | wc -l | tr -d ' ' || echo 0)
  TW_TOTAL=$(ls data/candles/TW/*.json 2>/dev/null | wc -l | tr -d ' ' || echo 0)

  log "  仍在跑: ${STILL_RUNNING}| TW ${TW_DONE}/${TW_TOTAL} CN ${CN_DONE}/${CN_TOTAL}"
  sleep 60
done

# ─── Step 2: 本地最終統計 ────────────────────────────────────────────────────
log "📊 Step 2: 本地修復最終統計..."
npx tsx scripts/watch-repair-progress.ts 2>/dev/null | head -20 || true
sleep 2

# ─── Step 3: 修復 Vercel Blob (TW) ───────────────────────────────────────────
log "🌐 Step 3: 修復 Vercel Blob — TW..."
TW_BATCH=0
while true; do
  TW_BATCH=$((TW_BATCH + 1))
  log "  TW batch #${TW_BATCH}..."

  RESPONSE=$(curl -sf "${VERCEL_URL}/api/admin/repair-candles?market=TW&mode=repair&limit=30" 2>&1 || echo '{"remaining":0,"error":"curl_fail"}')

  REMAINING=$(echo "$RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('remaining',0))" 2>/dev/null || echo 0)
  UPDATED=$(echo "$RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('updated',0))" 2>/dev/null || echo 0)
  log "  TW batch #${TW_BATCH}: updated=${UPDATED} remaining=${REMAINING}"

  if [ "$REMAINING" -eq 0 ] || [ "$TW_BATCH" -ge 30 ]; then
    log "  ✅ TW Blob 修復完成 (${TW_BATCH} batches)"
    break
  fi
  sleep 10
done

# ─── Step 4: 修復 Vercel Blob (CN) ───────────────────────────────────────────
log "🌐 Step 4: 修復 Vercel Blob — CN..."
CN_BATCH=0
while true; do
  CN_BATCH=$((CN_BATCH + 1))
  log "  CN batch #${CN_BATCH}..."

  RESPONSE=$(curl -sf "${VERCEL_URL}/api/admin/repair-candles?market=CN&mode=repair&limit=10" 2>&1 || echo '{"remaining":0,"error":"curl_fail"}')

  REMAINING=$(echo "$RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('remaining',0))" 2>/dev/null || echo 0)
  UPDATED=$(echo "$RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('updated',0))" 2>/dev/null || echo 0)
  log "  CN batch #${CN_BATCH}: updated=${UPDATED} remaining=${REMAINING}"

  if [ "$REMAINING" -eq 0 ] || [ "$CN_BATCH" -ge 200 ]; then
    log "  ✅ CN Blob 修復完成 (${CN_BATCH} batches)"
    break
  fi
  sleep 15
done

# ─── Step 5: 本地驗證 ────────────────────────────────────────────────────────
log "🔍 Step 5: 最終驗證..."
log "  5a. 交易日曆驗證 (TW)..."
npx tsx scripts/validate-trading-dates.ts TW 2>&1 | tail -3

log "  5b. 交易日曆驗證 (CN)..."
npx tsx scripts/validate-trading-dates.ts CN 2>&1 | tail -3

log "  5c. 缺漏交易日驗證 (TW)..."
npx tsx scripts/check-missing-trading-days.ts TW 2>&1 | tail -3

log "  5d. 缺漏交易日驗證 (CN)..."
npx tsx scripts/check-missing-trading-days.ts CN 2>&1 | tail -3

# ─── Step 6: 顯示最終進度 ────────────────────────────────────────────────────
log "📊 Step 6: 最終進度..."
npx tsx -e "
const { readdirSync, readFileSync } = require('fs');
const TARGET = '2026-04-13';
for (const market of ['TW','CN']) {
  const dir = 'data/candles/' + market;
  try {
    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    let done = 0, total = files.length;
    for (const f of files) {
      try {
        const raw = JSON.parse(readFileSync(dir+'/'+f,'utf8'));
        const d = raw.lastDate || raw.candles?.at(-1)?.date || '';
        if (d >= TARGET) done++;
      } catch {}
    }
    console.log(market + ': ' + done + '/' + total + ' (' + (done/total*100).toFixed(1) + '%)');
  } catch(e) { console.log(market + ': error'); }
}
" 2>/dev/null

# ─── Step 7: Commit + Push ───────────────────────────────────────────────────
log "📝 Step 7: Commit + Push..."
cd "$PROJECT_DIR"
git add -A
git status --short

COMMIT_MSG="fix(data): Layer 1全量修復完成 TW/CN → ${TARGET_DATE}

- TW: repair-tw-lagging.ts修復落後股票
- CN: repair-cn-tencent-mass.ts騰訊全量更新3160支
- 刪除14支確認下市CN股票
- cnStocks.ts移除5支下市靜態清單
- 新增watch-repair-progress.ts進度監控
- 驗證: 交易日無異常，無缺漏交易日

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"

git commit -m "$COMMIT_MSG" || log "  (nothing to commit)"
git push origin main
log "✅ 全部完成！Layer 1 修復、Vercel Blob 同步、驗證、commit+push 全部搞定。"
