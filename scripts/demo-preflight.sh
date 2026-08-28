#!/usr/bin/env bash
# เช็คว่าระบบพร้อม demo — รันก่อนขึ้นเวที 30 นาที
TOKEN="${1:-}"
ok(){ echo "  ✅ $1"; }; bad(){ echo "  ❌ $1"; FAIL=1; }
FAIL=0

echo "── services ──"
for c in postgres keycloak vault kafka-1; do
  docker compose ps "$c" 2>/dev/null | grep -q "healthy\|Up" && ok "$c" || bad "$c ไม่ขึ้น"
done
curl -sf localhost:3000/health >/dev/null && ok "backend :3000" || bad "backend ไม่ตอบ"
curl -sf localhost:3003 >/dev/null && ok "frontend :3003" || bad "frontend ไม่ตอบ"
RPC=$(grep -E '^BLOCKCHAIN_RPC_URL=' .env | cut -d= -f2- | tr -d '\r')
if [ -z "$RPC" ]; then
  bad "ไม่เจอ BLOCKCHAIN_RPC_URL ใน .env"
else
  curl -sf -X POST -H "Content-Type: application/json" \
    --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
    "$RPC" >/dev/null && ok "RPC $RPC" || bad "RPC ไม่ตอบ ($RPC)"
fi
pgrep -f "app.consumer" >/dev/null && ok "detection consumer" || bad "detection ไม่รัน"

echo "── integrity ──"
# NOTE: ห้ามใช้ `psql ... | while read` — pipeline รัน while ใน subshell
# FAIL=1 ที่ bad() ตั้งจะหายไปพร้อม subshell แล้วสรุปผลขึ้น "🎉 พร้อม demo"
# ทั้งที่มี ❌ ใช้ process substitution ให้ while รันใน shell ตัวเดิมแทน
BATCH_ROWS=$(docker exec logchain-postgres psql -U logchain -d logchain -tAc \
  "SELECT status||':'||count(*) FROM batches GROUP BY status")
if [ -z "$(echo "$BATCH_ROWS" | tr -d '[:space:]')" ]; then
  bad "ไม่มี batch เลย — ยังไม่เคย seal สักรอบ"
else
  while read -r r; do
    [ -z "$r" ] && continue
    case "$r" in CONFIRMED:*) ok "batches $r";; *) bad "batches $r ← ต้องเป็น CONFIRMED";; esac
  done < <(echo "$BATCH_ROWS")
fi

if [ -n "$TOKEN" ]; then
  echo "── token ──"
  EXP=$(echo "$TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null | grep -o '"exp":[0-9]*' | cut -d: -f2)
  NOW=$(date +%s)
  [ -n "$EXP" ] && [ "$EXP" -gt "$NOW" ] \
    && ok "token เหลืออีก $(( (EXP-NOW)/60 )) นาที" \
    || bad "token หมดอายุแล้ว — เอาใหม่จาก DevTools"
else
  echo "  ⚠️  ไม่ได้ส่ง token มาเช็ค: ./demo-preflight.sh \$TOKEN"
fi

echo
if [ "$FAIL" = 1 ]; then
  echo "⛔ ยังไม่พร้อม — แก้ตามด้านบนก่อน"
  # PENDING มักเป็นแค่ชั่วคราว: seal ใช้เวลา ~6 วิบน Amoy (sealed_at → confirmed_at)
  # เจอ PENDING ให้รอสักครู่แล้วรันซ้ำ ก่อนไปไล่หาสาเหตุอื่น
  exit 1
fi
echo "🎉 พร้อม demo"
exit 0
