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
# เช็คว่า "ต่อได้จริง" ไม่ใช่แค่ "มีชื่อ remote" — auth ที่พังกลางทางยังทิ้ง remote ไม่มี token ไว้ใน config
# (เจอจริง: รอบแรก Auth Error แล้วรอบสองข้ามขั้นนี้ไปเพราะเห็นว่ามี gdrive แล้ว)
drive_ok() { rc "${RC_BASE[@]}" "$IMAGE" lsd gdrive: > /dev/null 2>&1; }
auth_hint() {
  echo
  echo "1/3  เชื่อม Google Drive — จะมีลิงก์ http://127.0.0.1:53682/... ขึ้นมา"
  echo "     เปิด **ครั้งเดียว** ในเบราว์เซอร์ของเครื่องนี้ → เลือกบัญชี → กด Continue / Allow ทุกหน้าจนขึ้น \"Success\""
  echo "     (กด Cancel / ปิดหน้า / เปิดลิงก์ซ้ำ = \"No code returned by remote server\")"
  echo "     หน้า \"Google hasn't verified this app\" → Advanced → Go to rclone (unsafe) → Continue"
  echo "       (ปุ่ม Back to safety = access_denied · client ที่ rclone แชร์ทั้งโลก · scope drive.file เห็นเฉพาะไฟล์ของ rclone)"
  echo "     rclone ถาม \"Configure this as a Shared Drive (Team Drive)?\" → ตอบ n"
  echo "       (Gmail ส่วนตัวไม่มี Shared Drive · ตอบ y = 403 insufficient authentication scopes)"
  echo
}

if drive_ok; then
  echo "✓ gdrive ต่อ Google Drive ได้แล้ว — ข้าม"
elif has_remote gdrive; then
  auth_hint
  # มี remote แต่ไม่มี/หมด token → ขอสิทธิ์ใหม่ ค่าอื่น (scope) คงเดิม
  rc -it --network host "${RC_BASE[@]}" "$IMAGE" config reconnect gdrive: \
    || { echo "✗ เชื่อม Google ไม่สำเร็จ — รัน script นี้ใหม่ได้เลย"; exit 1; }
  drive_ok || { echo "✗ ยังต่อ Google Drive ไม่ได้ — รัน script นี้ใหม่"; exit 1; }
  echo "✓ gdrive"
else
  auth_hint
  # --network host: ให้หน้า callback ของ Google กลับมาถึง rclone ใน container ได้
  if ! rc -it --network host "${RC_BASE[@]}" "$IMAGE" config create gdrive drive scope=drive.file; then
    rc "${RC_BASE[@]}" "$IMAGE" config delete gdrive > /dev/null 2>&1 || true   # ไม่ทิ้ง remote ครึ่ง ๆ
    echo "✗ เชื่อม Google ไม่สำเร็จ — รัน script นี้ใหม่ได้เลย"; exit 1
  fi
  drive_ok || { echo "✗ ยังต่อ Google Drive ไม่ได้ — รัน script นี้ใหม่"; exit 1; }
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
