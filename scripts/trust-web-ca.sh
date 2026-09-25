#!/usr/bin/env bash
# ให้เบราว์เซอร์บนเครื่องนี้ trust CA ของ HTTPS (infra/tls/certs/ca.crt · LogChain-Web-CA) — รันครั้งเดียวต่อเครื่อง
#   Linux   → NSS DB: Chrome / Chromium / Edge (~/.pki/nssdb) + Firefox ทุก profile (รวมแบบ snap)
#             ต้องมี certutil: sudo apt install libnss3-tools
#   macOS   → login keychain (Chrome / Safari / Edge) — macOS ถามรหัสผ่านหรือ Touch ID
#   Windows → รันใน WSL: cert store ของ user ฝั่ง Windows (Chrome / Edge) — Windows เด้งหน้าต่างให้กด Yes
#   Firefox บน macOS / Windows ใช้ store ของตัวเอง: ถ้ายังเตือน ไปที่ about:config → security.enterprise_roots.enabled = true
# รันแล้ว restart เบราว์เซอร์ · ลบ trust: ./scripts/trust-web-ca.sh --remove
#
# curl / Node บนเครื่องนี้ไม่ได้ trust ตาม — ใช้ `curl --cacert infra/tls/certs/ca.crt` หรือ
#   sudo cp infra/tls/certs/ca.crt /usr/local/share/ca-certificates/logchain-web-ca.crt && sudo update-ca-certificates
set -euo pipefail
cd "$(dirname "$0")/.."
CA=infra/tls/certs/ca.crt
NAME="LogChain-Web-CA"
REMOVE=false; [ "${1:-}" = "--remove" ] && REMOVE=true

[ -f "$CA" ] || { echo "ไม่มี $CA — รัน ./infra/tls/gen-certs.sh ก่อน" >&2; exit 1; }
# OpenSSL พิมพ์ "CN = x" · LibreSSL (macOS) พิมพ์ "CN=x"
openssl x509 -in "$CA" -noout -subject | grep -qE "CN ?= ?$NAME" || { echo "$CA ไม่ใช่ $NAME" >&2; exit 1; }

case "$(uname -s)" in
  Darwin) os=macos ;;
  *) if grep -qi microsoft /proc/version 2>/dev/null; then os=wsl; else os=linux; fi ;;
esac

# ── macOS: login keychain ───────────────────────────────────────────────────
if [ "$os" = macos ]; then
  KC="$HOME/Library/Keychains/login.keychain-db"
  # ลบของเก่าก่อน (สร้าง CA ใหม่แล้วชื่อเดิมค้าง = เบราว์เซอร์ยังใช้ใบเก่า) — ชื่อซ้ำได้หลายใบ ลบจนหมด
  while security find-certificate -c "$NAME" "$KC" >/dev/null 2>&1; do
    security delete-certificate -c "$NAME" "$KC" >/dev/null
  done
  if $REMOVE; then echo "✓ ลบ $NAME จาก login keychain"; exit 0; fi
  security add-trusted-cert -r trustRoot -p ssl -k "$KC" "$CA"
  echo "✅ login keychain (Chrome / Safari / Edge)"
  echo "restart เบราว์เซอร์ แล้วเปิด https://localhost:3453"
  exit 0
fi

# ── Windows (WSL): cert store ของ user ฝั่ง Windows ─────────────────────────
if [ "$os" = wsl ]; then
  command -v certutil.exe >/dev/null || {
    echo "เรียก certutil.exe ของ Windows ไม่ได้ — WSL ต้องเปิด interop (ค่าเริ่มต้นเปิดอยู่)" >&2; exit 1; }
  certutil.exe -user -delstore Root "$NAME" >/dev/null 2>&1 || true
  if $REMOVE; then echo "✓ ลบ $NAME จาก cert store ของ Windows"; exit 0; fi
  # certutil.exe อ่านไฟล์ใน filesystem ของ WSL (\\wsl.localhost\…) ไม่ได้ทุกเครื่อง — copy ไป %TEMP% ของ Windows ก่อน
  wintemp="$(cmd.exe /c 'echo %TEMP%' 2>/dev/null | tr -d '\r')"
  [ -n "$wintemp" ] || { echo "หา %TEMP% ของ Windows ไม่เจอ" >&2; exit 1; }
  cp "$CA" "$(wslpath -u "$wintemp")/logchain-web-ca.crt"
  echo "Windows จะเด้งหน้าต่าง Security Warning — กด Yes เพื่อยืนยัน"
  certutil.exe -user -addstore Root "$wintemp\\logchain-web-ca.crt" >/dev/null
  rm -f "$(wslpath -u "$wintemp")/logchain-web-ca.crt"
  echo "✅ cert store ของ Windows (Chrome / Edge)"
  echo "ปิดเบราว์เซอร์ทุกหน้าต่างบน Windows แล้วเปิด https://localhost:3453"
  exit 0
fi

# ── Linux: NSS DB ──────────────────────────────────────────────────────────
command -v certutil >/dev/null || { echo "ต้องมี certutil ก่อน: sudo apt install libnss3-tools" >&2; exit 1; }

dbs=("$HOME/.pki/nssdb")
for p in "$HOME"/.mozilla/firefox/*/ "$HOME"/snap/firefox/common/.mozilla/firefox/*/; do
  [ -f "$p/cert9.db" ] && dbs+=("${p%/}")
done

for db in "${dbs[@]}"; do
  if $REMOVE; then
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
$REMOVE || echo "restart เบราว์เซอร์ แล้วเปิด https://localhost:3453"
