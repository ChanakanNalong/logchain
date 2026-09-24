#!/usr/bin/env bash
# ตรวจว่าข้อมูลของ LogChain อยู่บนดิสก์ที่เข้ารหัส (dm-crypt / LUKS) — PCI 3.1 · review B1 · อ่านอย่างเดียว ไม่ต้อง sudo
# ขั้นตอนตั้งค่า: docs/runbooks/encryption-at-rest.md
#
# ตรวจ 3 ที่: Docker data-root (volume ของ Postgres / Vault / Kafka / Grafana / Prometheus) · โฟลเดอร์ repo (.env · key ·
# rclone.conf · Vault init.env) · backups/ (dump ของ Postgres) · + swap (หน้าหน่วยความจำที่มี secret ถูกเขียนลงดิสก์ได้)
set -uo pipefail
cd "$(dirname "$0")/.."
FAIL=0

# device ที่ path นี้อยู่ มีชั้น crypt อยู่ในสายพ่อ-ลูกหรือไม่ (lsblk -s ไล่จาก device ขึ้นไปหา disk)
on_crypt() {
  local src dev
  src=$(findmnt -n -o SOURCE --target "$1" 2>/dev/null) || return 1
  dev=$(realpath "$src" 2>/dev/null) || return 1
  lsblk -s -n -o TYPE "$dev" 2>/dev/null | grep -qx crypt
}

check() {
  local label="$1" path="$2"
  local real; real=$(realpath "$path" 2>/dev/null || echo "$path")
  if on_crypt "$real"; then
    echo "✅ $label — $real ($(findmnt -n -o SOURCE --target "$real"))"
  else
    echo "❌ $label — $real อยู่บน $(findmnt -n -o SOURCE --target "$real" 2>/dev/null || echo '?') (ไม่เข้ารหัส)"
    FAIL=1
  fi
}

root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)
check "Docker data-root (volume ทั้งหมด)" "$root"
check "repo (.env · key · secrets)" "$PWD"
check "backups/ (Postgres dump)" "backups"

swaps=$(swapon --noheadings --show=NAME 2>/dev/null || true)
if [ -z "$swaps" ]; then
  echo "✅ swap — ไม่มี"
else
  for s in $swaps; do
    if on_crypt "$s" || lsblk -s -n -o TYPE "$s" 2>/dev/null | grep -qx crypt; then
      echo "✅ swap — $s เข้ารหัส"
    else
      echo "⚠️  swap — $s ไม่เข้ารหัส (secret ในหน่วยความจำอาจถูกเขียนลงดิสก์ · ดู runbook ขั้น 9)"
    fi
  done
fi

[ "$FAIL" = 0 ] && echo "ผ่าน — ข้อมูลของ LogChain อยู่บนดิสก์ที่เข้ารหัส" || echo "ไม่ผ่าน — ดู docs/runbooks/encryption-at-rest.md"
exit "$FAIL"
