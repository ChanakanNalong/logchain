#!/bin/sh
# สร้าง config ของ Alertmanager ตอน start แล้ว exec ตัวจริง (compose ใช้เป็น entrypoint)
#
# ตั้งอีเมลครบ (ไฟล์รหัส + ALERT_EMAIL_TO + ALERT_SMTP_USER) → ส่ง email
# ยังไม่ครบ → receiver "none": รับ alert จาก Prometheus ไว้ (ดูที่ :9093) แต่ไม่ส่งไปไหน
# ที่ต้อง render เอง: ถ้าใส่ email_configs ไว้ตลอด ค่าว่างจะทำให้ config ไม่ผ่านแล้ว Alertmanager ไม่ขึ้นเลย
#
# รหัส (Gmail app password) อยู่ในไฟล์ infra/alertmanager/.secrets/smtp_password (gitignored)
# ไม่ผ่าน env/.env — ไม่โผล่ใน `docker inspect` หรือ log
set -eu

OUT="${ALERTMANAGER_CONFIG_OUT:-/tmp/alertmanager.yml}"
PW=/etc/alertmanager/secrets/smtp_password

if [ -s "$PW" ] && [ -n "${ALERT_EMAIL_TO:-}" ] && [ -n "${ALERT_SMTP_USER:-}" ]; then
  cat > "$OUT" <<EOF
global:
  smtp_smarthost: '${ALERT_SMTP_SMARTHOST:-smtp.gmail.com:587}'
  smtp_from: '${ALERT_SMTP_FROM:-$ALERT_SMTP_USER}'
  smtp_auth_username: '${ALERT_SMTP_USER}'
  smtp_auth_password_file: '${PW}'
route:
  receiver: email
  group_by: [alertname, code]
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
receivers:
  - name: email
    email_configs:
      - to: '${ALERT_EMAIL_TO}'
        send_resolved: true
EOF
  echo "alertmanager: ส่ง email → ${ALERT_EMAIL_TO} ผ่าน ${ALERT_SMTP_SMARTHOST:-smtp.gmail.com:587}"
else
  cat > "$OUT" <<EOF
route:
  receiver: none
receivers:
  - name: none
EOF
  echo "alertmanager: ยังไม่ได้ตั้งอีเมล — รับ alert ไว้แต่ไม่ส่ง" \
    "(ต้องมี ALERT_EMAIL_TO + ALERT_SMTP_USER ใน .env และไฟล์ infra/alertmanager/.secrets/smtp_password)" >&2
fi

if [ "$#" -gt 0 ]; then exec "$@"; fi
