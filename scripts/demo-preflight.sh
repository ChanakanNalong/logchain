#!/usr/bin/env bash
# เช็คว่าระบบพร้อม demo — รันก่อนขึ้นเวที 30 นาที
TOKEN="${1:-}"
ok(){ echo "  ✅ $1"; }; bad(){ echo "  ❌ $1"; FAIL=1; }
warn(){ echo "  ⚠️  $1"; }
FAIL=0

echo "── services ──"
for c in postgres keycloak vault kafka-1; do
  docker compose ps "$c" 2>/dev/null | grep -q "healthy\|Up" && ok "$c" || bad "$c ไม่ขึ้น"
done
HEALTH=$(curl -sf localhost:3000/health) && ok "backend :3000" || bad "backend ไม่ตอบ"
# /health คืน 200 เสมอถ้า process ยังอยู่ — สถานะ Kafka consumer อยู่ในเนื้อ JSON
# ต้องเช็คแยก ไม่งั้น backend ที่ขึ้นแต่ไม่ได้ฟัง alert จะผ่าน preflight ไปเฉย ๆ
case "$HEALTH" in
  *'"connected":true'*)  ok "alert consumer เชื่อมต่อ Kafka อยู่" ;;
  *'"connected":false'*) bad "alert consumer ไม่ได้ต่อ Kafka — alert จะไม่เข้า DB" ;;
  *)                     bad "อ่านสถานะ kafkaConsumer จาก /health ไม่ได้" ;;
esac
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

echo "── kafka topics ──"
# เคสที่บล็อกนี้จับ: หลัง `docker compose down -v` แล้ว alerts.raw/alerts.cde ไม่ถูกสร้าง
# detection ยิง alert ออกมาได้ (log ขึ้น 🚨 ALERT) แต่ไม่มี topic ให้ backend subscribe
# → alert ไม่เคยเข้า DB และไม่มี error โผล่ทั้งสองฝั่ง เหตุผลเต็มอยู่ใน
# infra/kafka/create-topics.sh
TOPICS=$(docker exec logchain-kafka-1 kafka-topics.sh \
  --bootstrap-server localhost:9092 --list 2>/dev/null)
for t in logs.raw alerts.raw alerts.cde; do
  if echo "$TOPICS" | grep -qx "$t"; then
    ok "topic $t"
  else
    bad "topic $t หาย — รัน: docker compose up -d kafka-init"
  fi
done

echo "── integrity ──"
# NOTE: ห้ามใช้ `psql ... | while read` — pipeline รัน while ใน subshell
# FAIL=1 ที่ bad() ตั้งจะหายไปพร้อม subshell แล้วสรุปผลขึ้น "🎉 พร้อม demo"
# ทั้งที่มี ❌ ใช้ process substitution ให้ while รันใน shell ตัวเดิมแทน
#
# batch FAILED ที่ไม่มีแถวใน log_batch_mapping = anchor ล้มก่อนถึงขั้นผูก log
# (integrity.service.ts ตั้ง status แล้ว return ก่อนใส่ mapping) log ในใบนั้นจึงยัง
# นับเป็น pending อยู่ และ seal cron รอบถัดไป (ทุก 1 นาที) รับไปทำต่อแล้ว
# ใบที่ล้มกลายเป็นซากเปล่า ไม่ได้กั้น log ไว้ที่ไหน → ⚠️ ไม่ใช่ ❌ ไม่งั้น preflight
# ติดถาวรเพราะ batch ที่ล้มไปเมื่อไหร่ก็ไม่รู้ ส่วน FAILED ที่ยังมี log ผูกอยู่
# แปลว่า log ค้างกับ batch ที่ไม่ได้ขึ้น chain จริง — อันนั้นยังต้อง ❌ เหมือนเดิม
BATCH_ROWS=$(docker exec logchain-postgres psql -U logchain -d logchain -tAc \
  "SELECT k||':'||count(*) FROM (
     SELECT CASE WHEN b.status = 'FAILED' AND NOT EXISTS (
                   SELECT 1 FROM log_batch_mapping m WHERE m.batch_id = b.id)
                 THEN 'FAILED_EMPTY' ELSE b.status END AS k
     FROM batches b) t GROUP BY k")
if [ -z "$(echo "$BATCH_ROWS" | tr -d '[:space:]')" ]; then
  bad "ไม่มี batch เลย — ยังไม่เคย seal สักรอบ"
else
  CONFIRMED_SEEN=0
  while read -r r; do
    [ -z "$r" ] && continue
    case "$r" in
      CONFIRMED:*)    CONFIRMED_SEEN=1; ok "batches $r";;
      FAILED_EMPTY:*) warn "batches FAILED:${r#FAILED_EMPTY:} — ไม่มี log ผูกอยู่ ใบถัดไป seal ไปแล้ว";;
      *)              bad "batches $r ← ต้องเป็น CONFIRMED";;
    esac
  done < <(echo "$BATCH_ROWS")
  # เหลือแต่ซาก FAILED_EMPTY = ยังไม่เคย anchor ติดเลย ไม่มีของให้ demo
  [ "$CONFIRMED_SEEN" = 1 ] || bad "ไม่มี batch CONFIRMED สักใบ — ยังไม่เคย anchor สำเร็จ"
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
