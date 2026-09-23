#!/bin/sh
# ส่งสำเนา backup ของ Postgres ขึ้น cloud (เข้ารหัส) — entrypoint ของ service `backup-offsite` ใน compose
#
# ./backups/ อยู่ดิสก์เดียวกับ DB · ดิสก์พัง/เครื่องหาย = หายพร้อมกัน → ต้องมีสำเนานอกเครื่อง
# ใช้ rclone remote ชื่อ $OFFSITE_REMOTE (ค่าเริ่มต้น `logchain-backup:`) ซึ่งต้องเป็น **crypt** ครอบ cloud จริง
# — cloud เห็นแต่ข้อมูลเข้ารหัส (dump มี hash รหัส role + ข้อมูล log) · วิธีตั้ง: README หัวข้อ "Backup ฐานข้อมูล"
#
# ทุก OFFSITE_INTERVAL_SECONDS: rclone copy ชุดใน ./backups/postgres → cryptcheck ยืนยันว่าตรง →
# ลบชุดบน cloud ที่เก่ากว่า OFFSITE_KEEP_DAYS (เก็บนานกว่าในเครื่องที่เก็บ 7 ชุด)
# ยังไม่ตั้ง remote → รอเฉย ๆ ไม่เขียน metric (เครื่องที่ clone ใหม่ไม่โดน alert)
#
# สั่งรอบพิเศษ: docker exec logchain-backup-offsite sh /offsite.sh once
set -eu
umask 077

SRC=/backups/postgres
METRICS=/backups/metrics
REMOTE="${OFFSITE_REMOTE:-logchain-backup:}"
INTERVAL="${OFFSITE_INTERVAL_SECONDS:-3600}"
KEEP_DAYS="${OFFSITE_KEEP_DAYS:-30}"
# ชุด backup ชื่อขึ้นต้นด้วยปี · ไม่ส่ง .tmp-* (ชุดที่ยังเขียนไม่เสร็จ) และ .last_success
FILTER="--include /2*/**"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) backup-offsite: $*"; }

configured() {
  rclone listremotes 2>/dev/null | grep -qx "${REMOTE%%:*}:"
}

last_success() { cat "$SRC/.offsite_last_success" 2>/dev/null || echo 0; }

write_metrics() { # $1 = 1 สำเร็จ / 0 พัง
  tmp="$METRICS/.offsite.prom.tmp"
  cat > "$tmp" <<EOF
# HELP logchain_backup_offsite_last_success_timestamp_seconds Unix time of the last verified off-site upload.
# TYPE logchain_backup_offsite_last_success_timestamp_seconds gauge
logchain_backup_offsite_last_success_timestamp_seconds $(last_success)
# HELP logchain_backup_offsite_last_run_success 1 if the most recent off-site upload succeeded, 0 if it failed.
# TYPE logchain_backup_offsite_last_run_success gauge
logchain_backup_offsite_last_run_success $1
EOF
  chmod 644 "$tmp"
  mv "$tmp" "$METRICS/offsite.prom"
}

run_offsite() {
  # shellcheck disable=SC2086
  if rclone copy "$SRC" "$REMOTE" $FILTER \
     && rclone cryptcheck "$SRC" "$REMOTE" $FILTER --one-way \
     && rclone delete "$REMOTE" --min-age "${KEEP_DAYS}d" \
     && rclone rmdirs "$REMOTE" --leave-root; then
    date +%s > "$SRC/.offsite_last_success"
    write_metrics 1
    log "OK → $REMOTE ($(rclone lsf "$REMOTE" --dirs-only | wc -l) ชุดบน cloud)"
  else
    write_metrics 0
    log "FAILED — ลองใหม่ใน ${INTERVAL}s (ดู error ด้านบน)"
    return 1
  fi
}

if [ "${1:-}" = once ]; then
  configured || { log "ยังไม่ได้ตั้ง remote $REMOTE"; exit 1; }
  run_offsite; exit
fi

log "start (remote $REMOTE, interval ${INTERVAL}s, keep ${KEEP_DAYS}d)"
warned=0
while true; do
  if configured; then
    warned=0
    run_offsite || true
  elif [ "$warned" = 0 ]; then
    log "ยังไม่ได้ตั้ง remote $REMOTE — ไม่ส่งขึ้น cloud (README หัวข้อ Backup ฐานข้อมูล)"
    warned=1
  fi
  sleep "$INTERVAL"
done
