#!/usr/bin/env bash
#
# ตั้ง rclone สำหรับสำเนา backup บน Google Drive (เข้ารหัส) — แทนการตอบเมนู `rclone config` เอง
#
#   1. remote `gdrive` (Google Drive · scope drive.file = เห็นเฉพาะไฟล์ที่ rclone สร้าง) — เปิดลิงก์แล้วกดอนุญาต
#   2. remote `logchain-backup` (crypt ครอบ gdrive:logchain-backups) — สุ่ม password ให้ แสดงครั้งเดียว
#   3. ตรวจว่าไฟล์ config ถูกบันทึกจริง + ต่อ Drive ได้
#
# รันในเทอร์มินัลของเครื่องที่รัน stack (ต้องมีเบราว์เซอร์ในเครื่องเดียวกัน) — ไม่ใช่ผ่าน `!` ของ Claude Code
# (password จะไปอยู่ในประวัติการสนทนา) · รันซ้ำได้: remote ที่มีแล้วจะข้าม
set -euo pipefail

cd "$(dirname "$0")/.."
CONF_DIR="${RCLONE_CONF_DIR:-$PWD/infra/rclone/.secrets}"
IMAGE=rclone/rclone:1.68
mkdir -p "$CONF_DIR" && chmod 700 "$CONF_DIR"

rc() { docker run --rm "$@"; }
RC_BASE=(--user "$(id -u):$(id -g)" -e RCLONE_CACHE_DIR=/tmp -v "$CONF_DIR:/config/rclone")
has_remote() { rc "${RC_BASE[@]}" "$IMAGE" listremotes 2>/dev/null | grep -qx "$1:"; }

echo "config: $CONF_DIR/rclone.conf"

# ── 1. Google Drive ──────────────────────────────────────────────────────────
if has_remote gdrive; then
  echo "✓ remote gdrive มีแล้ว — ข้าม"
else
  echo
  echo "1/3  เชื่อม Google Drive — จะมีลิงก์ http://127.0.0.1:53682/... ขึ้นมา"
  echo "     เปิดในเบราว์เซอร์ของเครื่องนี้ → login → กด Allow → กลับมาที่นี่"
  echo
  # --network host: ให้หน้า callback ของ Google กลับมาถึง rclone ใน container ได้
  rc -it --network host "${RC_BASE[@]}" "$IMAGE" \
    config create gdrive drive scope=drive.file
  has_remote gdrive || { echo "✗ สร้าง gdrive ไม่สำเร็จ (ดู error ด้านบน)"; exit 1; }
  echo "✓ gdrive"
fi

# ── 2. crypt ─────────────────────────────────────────────────────────────────
if has_remote logchain-backup; then
  echo "✓ remote logchain-backup มีแล้ว — ข้าม (password เดิมไม่เปลี่ยน)"
else
  PW1=$(openssl rand -base64 32 | tr -d '/+=' | cut -c1-40)
  PW2=$(openssl rand -base64 32 | tr -d '/+=' | cut -c1-40)
  rc "${RC_BASE[@]}" "$IMAGE" config create logchain-backup crypt \
    remote=gdrive:logchain-backups filename_encryption=standard directory_name_encryption=true \
    password="$PW1" password2="$PW2" --obscure > /dev/null
  has_remote logchain-backup || { echo "✗ สร้าง logchain-backup ไม่สำเร็จ"; exit 1; }
  echo "✓ logchain-backup (crypt)"
  cat <<EOF

┌──────────────────────────────────────────────────────────────────────┐
│  เก็บ 2 ค่านี้ใน password manager เดี๋ยวนี้ — แสดงครั้งเดียว          │
│  เครื่องหาย + ไม่มีค่านี้ = ถอดสำเนาบน cloud ไม่ได้อีกเลย               │
└──────────────────────────────────────────────────────────────────────┘
  rclone crypt password : $PW1
  rclone crypt password2: $PW2
  (remote: gdrive:logchain-backups · filename_encryption=standard · directory_name_encryption=true)

EOF
  unset PW1 PW2
  read -rp "จดแล้ว กด Enter เพื่อไปต่อ " _
  clear 2>/dev/null || true
fi

# ── 3. ตรวจ ──────────────────────────────────────────────────────────────────
chmod 600 "$CONF_DIR/rclone.conf"
ls -la "$CONF_DIR/rclone.conf"
rc "${RC_BASE[@]}" "$IMAGE" listremotes --long
if rc "${RC_BASE[@]}" "$IMAGE" lsd gdrive: > /dev/null; then
  echo "✓ ต่อ Google Drive ได้"
else
  echo "✗ ต่อ Google Drive ไม่ได้ (ดู error ด้านบน)"; exit 1
fi
echo
echo "เสร็จ — บอก Claude ได้เลย หรือส่งทันที: docker exec logchain-backup-offsite sh /offsite.sh once"
