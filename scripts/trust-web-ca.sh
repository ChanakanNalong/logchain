#!/usr/bin/env bash
# ให้เบราว์เซอร์บนเครื่องนี้ trust CA ของ HTTPS (infra/tls/certs/ca.crt · LogChain-Web-CA) — รันครั้งเดียวต่อเครื่อง
#   Chrome / Chromium / Edge บน Linux → NSS DB ของ user (~/.pki/nssdb)
#   Firefox → NSS DB ของแต่ละ profile (~/.mozilla/firefox/* และแบบ snap)
# ต้องมี certutil: sudo apt install libnss3-tools · รันแล้ว restart เบราว์เซอร์
# ลบ trust: ./scripts/trust-web-ca.sh --remove
#
# curl / Node บนเครื่องนี้ไม่ได้ trust ตาม — ใช้ `curl --cacert infra/tls/certs/ca.crt` หรือ
#   sudo cp infra/tls/certs/ca.crt /usr/local/share/ca-certificates/logchain-web-ca.crt && sudo update-ca-certificates
set -euo pipefail
cd "$(dirname "$0")/.."
CA=infra/tls/certs/ca.crt
NAME="LogChain-Web-CA"

command -v certutil >/dev/null || { echo "ต้องมี certutil ก่อน: sudo apt install libnss3-tools" >&2; exit 1; }
[ -f "$CA" ] || { echo "ไม่มี $CA — รัน ./infra/tls/gen-certs.sh ก่อน" >&2; exit 1; }
openssl x509 -in "$CA" -noout -subject | grep -q "CN = $NAME" || { echo "$CA ไม่ใช่ $NAME" >&2; exit 1; }

dbs=("$HOME/.pki/nssdb")
for p in "$HOME"/.mozilla/firefox/*/ "$HOME"/snap/firefox/common/.mozilla/firefox/*/; do
  [ -f "$p/cert9.db" ] && dbs+=("${p%/}")
done

for db in "${dbs[@]}"; do
  if [ "${1:-}" = "--remove" ]; then
    certutil -d "sql:$db" -D -n "$NAME" 2>/dev/null && echo "✓ ลบจาก $db" || true
    continue
  fi
  if [ ! -f "$db/cert9.db" ]; then
    mkdir -p "$db" && certutil -d "sql:$db" -N --empty-password
  fi
  # ลบของเก่าก่อน (สร้าง CA ใหม่แล้วชื่อเดิมค้าง = เบราว์เซอร์ยังใช้ใบเก่า) · C,, = trust ออก cert สำหรับเว็บ
  certutil -d "sql:$db" -D -n "$NAME" 2>/dev/null || true
  certutil -d "sql:$db" -A -t "C,," -n "$NAME" -i "$CA"
  echo "✅ $db"
done
[ "${1:-}" = "--remove" ] || echo "restart เบราว์เซอร์ แล้วเปิด https://localhost:3453"
