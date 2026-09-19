#!/usr/bin/env bash
# Demo: แก้ log ในฐานข้อมูล → ระบบจับได้เป็น TAMPERED
# ใช้:  ./demo-tamper.sh <TOKEN>          ← ทำลาย + ตรวจจับ
#       ./demo-tamper.sh <TOKEN> restore  ← กู้คืนหลัง demo
set -uo pipefail
TOKEN="${1:?ต้องส่ง admin token}"; MODE="${2:-tamper}"
API="http://localhost:3000/api/v1"
PSQL(){ docker exec logchain-postgres psql -U logchain -d logchain -tAc "$1"; }
BAK="/tmp/logchain-tamper-backup.txt"

if [ "$MODE" = "restore" ]; then
  [ -f "$BAK" ] || { echo "ไม่มีไฟล์สำรอง"; exit 1; }
  read -r LOG_ID ORIG BATCH_ID STARTED_AT < "$BAK"
  # ไฟล์สำรองรูปแบบเก่า (ก่อนเก็บ batch id) มีแค่ 3 ช่อง — ช่องที่ 3 จะเป็นเวลา ไม่ใช่ uuid
  if ! [[ "$BATCH_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
    STARTED_AT="$BATCH_ID${STARTED_AT:+ $STARTED_AT}"
    BATCH_ID=$(PSQL "SELECT batch_id FROM log_batch_mapping WHERE log_id='$LOG_ID'")
  fi
  PSQL "ALTER TABLE logs DISABLE TRIGGER trg_logs_no_update;
        UPDATE logs SET raw_hash='$ORIG' WHERE id='$LOG_ID';
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
  if [ "$BATCH_STATUS" = "CONFIRMED" ]; then
    RESOLVED=$(PSQL "WITH r AS (
                       UPDATE alerts SET status='RESOLVED'
                        WHERE $DEMO_ALERTS AND status='OPEN'
                       RETURNING 1)
                     SELECT count(*) FROM r")
  else
    # verify ยังไม่ผ่าน (backend ล่ม / token ผิด ฯลฯ) → alert ยังจริงอยู่ ห้ามปิดทิ้ง
    # เก็บไฟล์สำรองไว้ให้รัน restore ซ้ำได้
    echo "⚠ batch $BATCH_ID ยังเป็น ${BATCH_STATUS:-?} (ไม่ใช่ CONFIRMED) — ไม่ resolve alert"
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

  echo "กู้คืนแล้ว — batches: $(PSQL "SELECT status||' x'||count(*) FROM batches GROUP BY status" | tr '\n' ' ')"
  BY_BACKEND=$(( $(PSQL "SELECT count(*) FROM alerts WHERE $DEMO_ALERTS AND status='RESOLVED'") - ${RESOLVED:-0} ))
  STILL_OPEN=$(PSQL "SELECT count(*) FROM alerts WHERE $DEMO_ALERTS AND status='OPEN'")
  echo "resolve alert INTEGRITY_TAMPERED ของ batch $BATCH_ID: ${RESOLVED:-0} รายการ" \
       "(backend ปิดเองตอน verify อีก $BY_BACKEND, ยังค้าง OPEN $STILL_OPEN)"
  rm -f "$BAK"; exit 0
fi

LOG_ID=$(PSQL "SELECT l.id FROM logs l JOIN log_batch_mapping m ON m.log_id=l.id LIMIT 1")
BATCH_ID=$(PSQL "SELECT batch_id FROM log_batch_mapping WHERE log_id='$LOG_ID'")
ORIG=$(PSQL "SELECT raw_hash FROM logs WHERE id='$LOG_ID'")
# เวลาเริ่ม demo (นาฬิกาของ DB) — restore ใช้เป็นเส้นแบ่งว่า batch FAILED ไหนเกิดจาก demo นี้
STARTED_AT=$(PSQL "SELECT now()")
echo "$LOG_ID $ORIG $BATCH_ID $STARTED_AT" > "$BAK"

echo "═══ ก่อนแก้ ═══"
echo "  log   : $LOG_ID"
echo "  batch : $BATCH_ID  →  $(PSQL "SELECT status FROM batches WHERE id='$BATCH_ID'")"

echo; echo "═══ ลอง UPDATE ตรงๆ (ต้องโดนบล็อก) ═══"
PSQL "UPDATE logs SET message='hacked' WHERE id='$LOG_ID'" 2>&1 | head -2

echo; echo "═══ ปิด trigger แล้วแก้ (จำลองว่า DB ถูกยึด) ═══"
PSQL "ALTER TABLE logs DISABLE TRIGGER trg_logs_no_update;
      UPDATE logs SET raw_hash=repeat('f',64) WHERE id='$LOG_ID';
      ALTER TABLE logs ENABLE TRIGGER trg_logs_no_update;" >/dev/null
echo "  แก้ hash แล้ว"

echo; echo "═══ สั่งระบบตรวจสอบ ═══"
curl -s -X POST -H "Authorization: Bearer $TOKEN" "$API/logs/verify-now" | head -c 100; echo
sleep 2
echo "  batch → $(PSQL "SELECT status FROM batches WHERE id='$BATCH_ID'")"
# กรองเฉพาะ OPEN — ไม่งั้นจะไปหยิบ alert เก่าที่ RESOLVED แล้วจาก demo รอบก่อนมาโชว์
ALERT=$(PSQL "SELECT severity||' | '||title FROM alerts
              WHERE batch_id='$BATCH_ID' AND status='OPEN'
              ORDER BY created_at DESC LIMIT 1")
echo "  alert → ${ALERT:-(ยังไม่มี alert OPEN — ถ้า verify-now ไม่ผ่าน cron verify จะจับได้ภายใน 1 นาที)}"
echo; echo "กู้คืนด้วย: ./scripts/demo-tamper.sh \$TOKEN restore"
