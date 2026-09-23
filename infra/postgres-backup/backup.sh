#!/bin/sh
# backup Postgres อัตโนมัติ — entrypoint ของ service `postgres-backup` ใน compose
#
# ทุก 5 นาทีเช็คว่าถึงรอบหรือยัง (backup สำเร็จล่าสุดเก่ากว่า BACKUP_INTERVAL_SECONDS) → dump
#   globals.sql    role + hash รหัส (logchain / keycloak / replicator)
#   logchain.dump  DB ของแอป (pg_dump -Fc)
#   keycloak.dump  users + credential + OTP — หายแล้วทุกคน login ไม่ได้
# ลง ./backups/postgres/<UTC timestamp>/ · เก็บ BACKUP_KEEP ชุดล่าสุด · พังแล้วรอบถัดไป (5 นาที) ลองใหม่เอง
# กู้คืน: docs/RTO-RPO-Compliance-Signoff.md หัวข้อ Database Failure (ทดสอบแล้ว)
#
# สถานะเขียนเป็น textfile ให้ node-exporter → Prometheus → alert PostgresBackup* (infra/prometheus/alerts.yml)
#
# สั่งรอบพิเศษทันที: docker exec logchain-postgres-backup sh /backup.sh once
set -eu
umask 077   # dump มี hash รหัส role + ข้อมูล log → 0600 / 0700 เสมอ

OUT=/backups/postgres
METRICS=/backups/metrics
INTERVAL="${BACKUP_INTERVAL_SECONDS:-86400}"
KEEP="${BACKUP_KEEP:-7}"
CHECK_EVERY=300
export PGHOST="${PGHOST:-postgres}" PGUSER="${PGUSER:-logchain}"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) postgres-backup: $*"; }

last_success() { cat "$OUT/.last_success" 2>/dev/null || echo 0; }

# node-exporter อ่านไฟล์นี้ (textfile collector) — ไม่มีความลับ จึงเปิดให้อ่านได้
# เขียนไฟล์ชั่วคราวแล้ว mv กัน node-exporter อ่านเจอไฟล์ครึ่ง ๆ
write_metrics() { # $1 = 1 สำเร็จ / 0 พัง · $2 = ขนาด bytes · $3 = วินาทีที่ใช้
  tmp="$METRICS/.backup.prom.tmp"
  cat > "$tmp" <<EOF
# HELP logchain_backup_last_success_timestamp_seconds Unix time of the last successful Postgres backup.
# TYPE logchain_backup_last_success_timestamp_seconds gauge
logchain_backup_last_success_timestamp_seconds $(last_success)
# HELP logchain_backup_last_run_success 1 if the most recent backup attempt succeeded, 0 if it failed.
# TYPE logchain_backup_last_run_success gauge
logchain_backup_last_run_success $1
# HELP logchain_backup_last_size_bytes Size of the most recent successful backup set.
# TYPE logchain_backup_last_size_bytes gauge
logchain_backup_last_size_bytes $2
# HELP logchain_backup_last_duration_seconds Duration of the most recent backup attempt.
# TYPE logchain_backup_last_duration_seconds gauge
logchain_backup_last_duration_seconds $3
EOF
  chmod 644 "$tmp"
  mv "$tmp" "$METRICS/backup.prom"
}

run_backup() {
  start=$(date +%s)
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  tmpdir="$OUT/.tmp-$ts"
  mkdir -p "$tmpdir"
  if pg_dumpall --globals-only -f "$tmpdir/globals.sql" \
     && pg_dump -Fc -d logchain -f "$tmpdir/logchain.dump" \
     && pg_dump -Fc -d keycloak -f "$tmpdir/keycloak.dump" \
     && pg_restore --list "$tmpdir/logchain.dump" > /dev/null \
     && pg_restore --list "$tmpdir/keycloak.dump" > /dev/null; then
    mv "$tmpdir" "$OUT/$ts"
    date +%s > "$OUT/.last_success"
    size=$(cat "$OUT/$ts"/* | wc -c)
    prune
    write_metrics 1 "$size" $(( $(date +%s) - start ))
    log "OK $OUT/$ts ($size bytes)"
  else
    rm -rf "$tmpdir"
    write_metrics 0 0 $(( $(date +%s) - start ))
    log "FAILED — ลองใหม่ใน ${CHECK_EVERY}s (ดู error ด้านบน)"
    return 1
  fi
}

# เก็บ KEEP ชุดล่าสุด (ชื่อโฟลเดอร์เป็น UTC timestamp เรียงตามตัวอักษร = เรียงตามเวลา)
prune() {
  n=$(find "$OUT" -mindepth 1 -maxdepth 1 -type d -name '2*' | wc -l)
  if [ "$n" -gt "$KEEP" ]; then
    find "$OUT" -mindepth 1 -maxdepth 1 -type d -name '2*' | sort | head -n $(( n - KEEP )) | xargs rm -rf
  fi
}

mkdir -p "$OUT" "$METRICS"
chmod 755 "$METRICS"
rm -rf "$OUT"/.tmp-*   # ชุดที่ค้างจากรอบที่ process ตายกลางทาง

if [ "${1:-}" = once ]; then run_backup; exit; fi

log "start (interval ${INTERVAL}s, keep ${KEEP}, host ${PGHOST})"
while true; do
  if [ $(( $(date +%s) - $(last_success) )) -ge "$INTERVAL" ]; then
    run_backup || true
  fi
  sleep "$CHECK_EVERY"
done
