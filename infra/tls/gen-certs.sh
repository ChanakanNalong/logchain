#!/usr/bin/env bash
# CA + server cert สำหรับ HTTPS หน้า Keycloak / backend / dashboard (Caddy · compliance review B2 · PCI 4.1)
# แยก CA จาก Kafka (infra/kafka/certs) — เบราว์เซอร์ trust CA นี้แล้วไม่ควรได้ trust cert ของ Kafka ไปด้วย
#
#   ./infra/tls/gen-certs.sh            สร้างใหม่ถ้ายังไม่มี (มีแล้ว = ข้าม · CA เดิมอยู่ต่อ เบราว์เซอร์ไม่ต้อง trust ใหม่)
#   ./infra/tls/gen-certs.sh --renew    ออก server cert ใหม่ด้วย CA เดิม — ใช้ตอนเพิ่มชื่อใน TLS_EXTRA_SANS
#
# TLS_EXTRA_SANS (ใน .env) = ชื่อ/IP เพิ่มเติมที่เครื่องอื่นใช้เรียก เช่น "DNS:logchain.lan,IP:10.5.50.253"
# (ต้องตรงกับ KEYCLOAK_URL / NEXT_PUBLIC_* ที่ตั้งไว้ ไม่งั้นเบราว์เซอร์เตือนชื่อไม่ตรง)
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)/certs"
mkdir -p "$DIR"; cd "$DIR"
umask 077

if [ ! -f ca.key ]; then
  MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:4096 -sha256 -days 1650 -nodes \
    -keyout ca.key -out ca.crt -subj "/C=TH/O=LogChain/CN=LogChain-Web-CA" 2>/dev/null
  echo "✅ CA (LogChain-Web-CA)"
fi

if [ -f server.crt ] && [ "${1:-}" != "--renew" ]; then
  echo "✓ server cert มีอยู่แล้ว — ข้าม (เพิ่มชื่อ: ตั้ง TLS_EXTRA_SANS แล้วรันด้วย --renew)"
else
  san="DNS:localhost,IP:127.0.0.1${TLS_EXTRA_SANS:+,$TLS_EXTRA_SANS}"
  MSYS_NO_PATHCONV=1 openssl req -newkey rsa:2048 -sha256 -nodes \
    -keyout server.key -out server.csr -subj "/C=TH/O=LogChain/CN=localhost" 2>/dev/null
  ext="$(mktemp)"
  # เบราว์เซอร์ยอมรับ cert อายุไม่เกิน 398 วัน
  printf "subjectAltName=%s\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n" "$san" > "$ext"
  openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
    -out server.crt -days 397 -sha256 -extfile "$ext" 2>/dev/null
  rm -f "$ext" server.csr
  echo "✅ server cert ($san)"
fi

sed -i 's/\r$//' ./*.crt ./*.key
# cert เปิดอ่านได้ · server.key อ่านผ่านกลุ่ม (Caddy รันเป็น nobody + group_add) · ca.key เฉพาะเจ้าของ
chmod 644 ca.crt server.crt
chmod 640 server.key
chmod 600 ca.key
