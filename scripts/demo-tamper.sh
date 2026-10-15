#!/usr/bin/env bash
# Demo: แก้ log ในฐานข้อมูล → ระบบจับได้เป็น TAMPERED + diff บอกตำแหน่ง/field ที่ถูกแก้
# ใช้:  ./demo-tamper.sh <TOKEN>          ← ทำลาย + ตรวจจับ
#       ./demo-tamper.sh <TOKEN> restore  ← กู้คืนหลัง demo
# env:  TAMPER=hash (ค่าเริ่มต้น: เขียนทับ raw_hash) | message (แก้ข้อความ log)
#       API=http://localhost:3000/api/v1  PG_CONTAINER=logchain-postgres  ← ชี้ไป stack อื่นได้ (เช่น hh)
set -uo pipefail
TOKEN="${1:?ต้องส่ง admin token}"; MODE="${2:-tamper}"
API="${API:-http://localhost:3000/api/v1}"
PG_CONTAINER="${PG_CONTAINER:-logchain-postgres}"
TAMPER="${TAMPER:-hash}"
PSQL(){ docker exec "$PG_CONTAINER" psql -U logchain -d logchain -tAc "$1"; }
# stack หลักใช้ path เดิม (docs/runbooks/exam-commands.md อ่านไฟล์นี้) · stack อื่นแยกไฟล์ไม่ให้ทับกัน
if [ "$PG_CONTAINER" = "logchain-postgres" ]; then BAK="/tmp/logchain-tamper-backup.txt"
else BAK="/tmp/logchain-tamper-backup-${PG_CONTAINER}.txt"; fi

# GET /batches/:id/diff → "position N · field · before → after" (ต้องมี snapshot — batch ที่ seal หลัง BatchLogSnapshot)
print_diff() {
  local body
  body=$(curl -s -H "Authorization: Bearer $TOKEN" "$API/batches/$1/diff")
  if ! echo "$body" | jq -e '.summary' >/dev/null 2>&1; then
    echo "  diff: อ่านไม่ได้ ($(echo "$body" | head -c 120))"; return
  fi
  echo "$body" | jq -r '
    "  verdict: \(.summary.verdict) · snapshotTrusted: \(.snapshotTrusted) · legacy: \(.legacy)",
    (if .legacy then "  (batch นี้ seal ก่อนมี snapshot — บอกได้แค่ระดับ batch)" else empty end),
    (.changes[] |
      if .type == "DELETED" then "  position \(.position) · DELETED (\(.reason)) · เนื้อเดิม: \(.snapshot.message)"
      elif .type == "UNMAPPED_OR_INSERTED" then "  position \(.position) · INSERTED · \(.current.message)"
      else (.position as $p | .fields[] | "  position \($p) · \(.field) · \(.before) → \(.after)")
      end)'
}

if [ "$MODE" = "restore" ]; then
  [ -f "$BAK" ] || { echo "ไม่มีไฟล์สำรอง"; exit 1; }
  read -r LOG_ID ORIG BATCH_ID STARTED_DATE STARTED_TIME ORIG_MSG_B64 < "$BAK"
  STARTED_AT="${STARTED_DATE:-}${STARTED_TIME:+ $STARTED_TIME}"
  # ไฟล์สำรองรูปแบบเก่า (ก่อนเก็บ batch id) มีแค่ 3 ช่อง — ช่องที่ 3 จะเป็นเวลา ไม่ใช่ uuid
  if ! [[ "$BATCH_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
    STARTED_AT="$BATCH_ID${STARTED_AT:+ $STARTED_AT}"
    BATCH_ID=$(PSQL "SELECT batch_id FROM log_batch_mapping WHERE log_id='$LOG_ID'")
  fi
  # ข้อความเดิมเก็บเป็น base64 (มีช่องว่าง/อัญประกาศได้) · ไฟล์สำรองรุ่นเก่าไม่มีช่องนี้ = ไม่ได้แก้ข้อความ
  RESTORE_MSG=""
  if [ -n "${ORIG_MSG_B64:-}" ]; then
    RESTORE_MSG=", message=convert_from(decode('$ORIG_MSG_B64','base64'),'UTF8')"
  fi
  PSQL "ALTER TABLE logs DISABLE TRIGGER trg_logs_no_update;
        UPDATE logs SET raw_hash='$ORIG'$RESTORE_MSG WHERE id='$LOG_ID';
        ALTER TABLE logs ENABLE TRIGGER trg_logs_no_update;" >/dev/null
  VCODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" "$API/logs/verify-now")
  [ "$VCODE" = 200 ] || echo "⚠ verify-now ตอบ HTTP $VCODE (token หมดอายุ/ไม่ใช่ admin?) — รอ cron verify แทน"
  sleep 2

  # ปิด INTEGRITY_TAMPERED ที่ demo นี้สร้าง — ไม่งั้น Dashboard จะโชว์ integrity 100%
  # คู่กับ alert CRITICAL ค้าง OPEN. จำกัดแค่ batch ที่ demo แตะ + สร้างหลังเริ่ม demo
  # alert อื่นในตารางไม่แตะ เพราะอาจเป็นเหตุการณ์จริงที่ยังต้องตามดู
  # backend ตัวใหม่ปิด alert ให้เองตอน verify-now ผ่าน — นับแยกไว้ สรุปจะได้ไม่โชว์ 0 ทั้งที่ปิดแล้ว
  DEMO_ALERTS="batch_id='$BATCH_ID' AND alert_type='INTEGRITY_TAMPERED'
               ${STARTED_AT:+AND created_at >= '$STARTED_AT'::timestamptz}"
  RESOLVED=0
  BATCH_STATUS=$(PSQL "SELECT status FROM batches WHERE id='$BATCH_ID'")
  # SEALED = ผ่านการตรวจแบบ local แล้ว (stack ที่ไม่ได้ต่อ blockchain) สะอาดเท่ากับ CONFIRMED
  # เดิมเช็คแค่ CONFIRMED → บน clone ใหม่ restore สำเร็จแต่ขึ้น ⚠ แล้ว exit 1 ทุกครั้ง
  if [ "$BATCH_STATUS" = "CONFIRMED" ] || [ "$BATCH_STATUS" = "SEALED" ]; then
    RESOLVED=$(PSQL "WITH r AS (
                       UPDATE alerts SET status='RESOLVED'
                        WHERE $DEMO_ALERTS AND status='OPEN'
                       RETURNING 1)
                     SELECT count(*) FROM r")
  else
    # verify ยังไม่ผ่าน (backend ล่ม / token ผิด ฯลฯ) → alert ยังจริงอยู่ ห้ามปิดทิ้ง
    # เก็บไฟล์สำรองไว้ให้รัน restore ซ้ำได้
    echo "⚠ batch $BATCH_ID ยังเป็น ${BATCH_STATUS:-?} (ไม่ใช่ CONFIRMED/SEALED) — ไม่ resolve alert"
    echo "  แก้สาเหตุแล้วรัน restore ซ้ำได้ (ไฟล์สำรองยังอยู่ที่ $BAK)"
    exit 1
  fi

  # เก็บกวาด batch FAILED ที่เกิดขึ้นระหว่าง demo เท่านั้น (sealed_at >= ตอนเริ่ม)
  # ของเดิมที่มีอยู่ก่อนหน้าไม่แตะ — เป็นหลักฐานของปัญหาจริง ไม่ใช่ขยะจาก demo
  if [ -n "${STARTED_AT:-}" ]; then
    DEAD=$(PSQL "SELECT count(*) FROM batches
                 WHERE status='FAILED' AND sealed_at >= '$STARTED_AT'::timestamptz")
    if [ "${DEAD:-0}" -gt 0 ]; then
      PSQL "DELETE FROM log_batch_mapping WHERE batch_id IN (
              SELECT id FROM batches WHERE status='FAILED' AND sealed_at >= '$STARTED_AT'::timestamptz);
            DELETE FROM alerts WHERE batch_id IN (
              SELECT id FROM batches WHERE status='FAILED' AND sealed_at >= '$STARTED_AT'::timestamptz);
            DELETE FROM batches
              WHERE status='FAILED' AND sealed_at >= '$STARTED_AT'::timestamptz;" >/dev/null
      echo "ลบ batch FAILED ที่เกิดระหว่าง demo: $DEAD รายการ"
    fi
  fi

  echo "diff หลังกู้คืน:"; print_diff "$BATCH_ID"
  echo "กู้คืนแล้ว — batches: $(PSQL "SELECT status||' x'||count(*) FROM batches GROUP BY status" | tr '\n' ' ')"
  BY_BACKEND=$(( $(PSQL "SELECT count(*) FROM alerts WHERE $DEMO_ALERTS AND status='RESOLVED'") - ${RESOLVED:-0} ))
  STILL_OPEN=$(PSQL "SELECT count(*) FROM alerts WHERE $DEMO_ALERTS AND status='OPEN'")
  echo "resolve alert INTEGRITY_TAMPERED ของ batch $BATCH_ID: ${RESOLVED:-0} รายการ" \
       "(backend ปิดเองตอน verify อีก $BY_BACKEND, ยังค้าง OPEN $STILL_OPEN)"
  rm -f "$BAK"; exit 0
fi

# เลือก log ตรงกลางของ batch ล่าสุดที่มี snapshot (diff ชี้ตำแหน่งได้) · ไม่มีเลย = log ไหนก็ได้ที่ seal แล้ว
LOG_ID=$(PSQL "SELECT s.log_id FROM batch_log_snapshot s JOIN batches b ON b.id = s.batch_id
               WHERE b.status IN ('CONFIRMED','SEALED')
                 AND s.position = (SELECT COUNT(*) / 2 FROM batch_log_snapshot x WHERE x.batch_id = b.id)
               ORDER BY b.sealed_at DESC LIMIT 1" 2>/dev/null)
[ -n "$LOG_ID" ] || LOG_ID=$(PSQL "SELECT l.id FROM logs l JOIN log_batch_mapping m ON m.log_id=l.id LIMIT 1")
BATCH_ID=$(PSQL "SELECT batch_id FROM log_batch_mapping WHERE log_id='$LOG_ID'")
ORIG=$(PSQL "SELECT raw_hash FROM logs WHERE id='$LOG_ID'")
ORIG_MSG_B64=$(PSQL "SELECT encode(convert_to(message,'UTF8'),'base64') FROM logs WHERE id='$LOG_ID'" | tr -d '\n')
# เวลาเริ่ม demo (นาฬิกาของ DB) — restore ใช้เป็นเส้นแบ่งว่า batch FAILED ไหนเกิดจาก demo นี้
STARTED_AT=$(PSQL "SELECT now()")
echo "$LOG_ID $ORIG $BATCH_ID $STARTED_AT $ORIG_MSG_B64" > "$BAK"

echo "═══ ก่อนแก้ ═══"
echo "  log   : $LOG_ID"
echo "  batch : $BATCH_ID  →  $(PSQL "SELECT status FROM batches WHERE id='$BATCH_ID'")"

echo; echo "═══ ลอง UPDATE ตรงๆ (ต้องโดนบล็อก) ═══"
PSQL "UPDATE logs SET message='hacked' WHERE id='$LOG_ID'" 2>&1 | head -2

echo; echo "═══ ปิด trigger แล้วแก้ (จำลองว่า DB ถูกยึด) ═══"
if [ "$TAMPER" = "message" ]; then
  PSQL "ALTER TABLE logs DISABLE TRIGGER trg_logs_no_update;
        UPDATE logs SET message='user jdoe opened the reports page' WHERE id='$LOG_ID';
        ALTER TABLE logs ENABLE TRIGGER trg_logs_no_update;" >/dev/null
  echo "  แก้ข้อความแล้ว"
else
  PSQL "ALTER TABLE logs DISABLE TRIGGER trg_logs_no_update;
        UPDATE logs SET raw_hash=repeat('f',64) WHERE id='$LOG_ID';
        ALTER TABLE logs ENABLE TRIGGER trg_logs_no_update;" >/dev/null
  echo "  แก้ hash แล้ว"
fi

echo; echo "═══ สั่งระบบตรวจสอบ ═══"
curl -s -X POST -H "Authorization: Bearer $TOKEN" "$API/logs/verify-now" | head -c 100; echo
sleep 2
echo "  batch → $(PSQL "SELECT status FROM batches WHERE id='$BATCH_ID'")"
# กรองเฉพาะ OPEN — ไม่งั้นจะไปหยิบ alert เก่าที่ RESOLVED แล้วจาก demo รอบก่อนมาโชว์
ALERT=$(PSQL "SELECT severity||' | '||title FROM alerts
              WHERE batch_id='$BATCH_ID' AND status='OPEN'
              ORDER BY created_at DESC LIMIT 1")
echo "  alert → ${ALERT:-(ยังไม่มี alert OPEN — ถ้า verify-now ไม่ผ่าน cron verify จะจับได้ภายใน 1 นาที)}"
echo; echo "═══ diff: ตำแหน่งไหนถูกแก้ ═══"
print_diff "$BATCH_ID"
echo; echo "กู้คืนด้วย: ./scripts/demo-tamper.sh \$TOKEN restore"
