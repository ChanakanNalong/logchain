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
  read -r LOG_ID ORIG STARTED_AT < "$BAK"
  PSQL "ALTER TABLE logs DISABLE TRIGGER trg_logs_no_update;
        UPDATE logs SET raw_hash='$ORIG' WHERE id='$LOG_ID';
        ALTER TABLE logs ENABLE TRIGGER trg_logs_no_update;" >/dev/null
  curl -s -X POST -H "Authorization: Bearer $TOKEN" "$API/logs/verify-now" >/dev/null
  sleep 2

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
  rm -f "$BAK"; exit 0
fi

LOG_ID=$(PSQL "SELECT l.id FROM logs l JOIN log_batch_mapping m ON m.log_id=l.id LIMIT 1")
BATCH_ID=$(PSQL "SELECT batch_id FROM log_batch_mapping WHERE log_id='$LOG_ID'")
ORIG=$(PSQL "SELECT raw_hash FROM logs WHERE id='$LOG_ID'")
# เวลาเริ่ม demo (นาฬิกาของ DB) — restore ใช้เป็นเส้นแบ่งว่า batch FAILED ไหนเกิดจาก demo นี้
STARTED_AT=$(PSQL "SELECT now()")
echo "$LOG_ID $ORIG $STARTED_AT" > "$BAK"

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
echo "  alert → $(PSQL "SELECT severity||' | '||title FROM alerts WHERE batch_id='$BATCH_ID' ORDER BY created_at DESC LIMIT 1")"
echo; echo "กู้คืนด้วย: ./scripts/demo-tamper.sh \$TOKEN restore"
