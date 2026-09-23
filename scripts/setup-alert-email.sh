#!/usr/bin/env bash
#
# เปิด email ของ security alert (backend → HIGH/CRITICAL เช่น brute force ที่ detection จับได้)
# คนละชุดกับ Alertmanager (infra alert) แต่ใช้บัญชี Gmail เดียวกันได้
#
# ค่า SMTP ต้องอยู่ใน .env (MAIL_*) ไม่ใช่เขียนลง Vault ตรง ๆ — vault-init รันซ้ำทุกครั้งที่ `docker compose up`
# แล้ว seed secret/logchain/notification จาก .env ใหม่ เขียน Vault เองจะถูกทับด้วยค่าว่างรอบหน้า
#
#   1. ถาม user / ผู้รับ / รหัส (ใช้ชุดเดียวกับ Alertmanager ได้ — ไม่ต้องพิมพ์รหัสใหม่)
#   2. เขียน MAIL_USER / MAIL_TO / MAIL_PASS ลง .env (+ chmod 600)
#   3. รัน vault-init → restart backend → ตรวจ log "NotificationService ready"
#
# รันในเทอร์มินัลของคุณ ไม่ใช่ผ่าน `!` ของ Claude Code (รหัสจะไปอยู่ในประวัติการสนทนา)
set -euo pipefail
cd "$(dirname "$0")/.."

ENV=.env
AM_PW=infra/alertmanager/.secrets/smtp_password
COMPOSE=(env HOST_UID="$(id -u)" HOST_GID="$(id -g)" docker compose)

get() { grep -E "^$1=" "$ENV" | tail -1 | cut -d= -f2- || true; }
set_env() { # key value — แทนบรรทัดเดิม หรือต่อท้าย (ไม่ใช้ sed เพราะค่าอาจมีอักขระพิเศษ)
  local tmp; tmp=$(mktemp)
  grep -vE "^$1=" "$ENV" > "$tmp" || true
  printf '%s=%s\n' "$1" "$2" >> "$tmp"
  cat "$tmp" > "$ENV"; rm -f "$tmp"
}

[ -f "$ENV" ] || { echo "✗ ไม่มี $ENV — รัน ./scripts/bootstrap.sh ก่อน"; exit 1; }
chmod 600 "$ENV"   # มี password หลายตัว — เดิม 664 ใครในเครื่องก็อ่านได้

# ── 1. ค่า ───────────────────────────────────────────────────────────────────
def_user=$(get MAIL_USER); def_user=${def_user:-$(get ALERT_SMTP_USER)}
def_to=$(get MAIL_TO); def_to=${def_to:-$(get ALERT_EMAIL_TO)}

read -rp "Gmail ที่ใช้ส่ง (SMTP user) [${def_user}]: " user; user=${user:-$def_user}
read -rp "ส่ง security alert ถึง [${def_to:-$user}]: " to; to=${to:-${def_to:-$user}}
[ -n "$user" ] || { echo "✗ ต้องมี SMTP user"; exit 1; }

pw=""
if [ -s "$AM_PW" ] && [ "$user" = "$(get ALERT_SMTP_USER)" ]; then
  read -rp "ใช้ app password ชุดเดียวกับ Alertmanager? [Y/n]: " reuse
  case "${reuse:-y}" in [Yy]*) pw=$(cat "$AM_PW") ;; esac
fi
if [ -z "$pw" ]; then
  read -rsp "Gmail app password (ไม่แสดงบนจอ): " pw; echo
  pw=${pw// /}
fi
[ -n "$pw" ] || { echo "✗ ต้องมีรหัส"; exit 1; }

# ── 2. .env ──────────────────────────────────────────────────────────────────
set_env MAIL_USER "$user"
set_env MAIL_TO "$to"
set_env MAIL_PASS "$pw"
unset pw
chmod 600 "$ENV"
echo "✓ .env (MAIL_USER / MAIL_TO / MAIL_PASS · 0600)"

# ── 3. Vault + backend ───────────────────────────────────────────────────────
"${COMPOSE[@]}" up vault-init > /dev/null 2>&1 \
  || { echo "✗ vault-init ล้ม — ดู: docker logs logchain-vault-init"; exit 1; }
echo "✓ seed secret/logchain/notification"
"${COMPOSE[@]}" restart backend > /dev/null
for _ in $(seq 1 40); do
  curl -sf localhost:3000/health > /dev/null 2>&1 && break
  sleep 3
done
if docker logs --since 3m logchain-backend 2>&1 | grep -q "NotificationService ready"; then
  echo "✓ backend: NotificationService ready — HIGH/CRITICAL alert จะส่ง email ถึง $to"
else
  echo "✗ backend ยังไม่เปิด email — docker logs logchain-backend 2>&1 | grep -i notification"; exit 1
fi
