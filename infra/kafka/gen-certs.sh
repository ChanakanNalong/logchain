#!/usr/bin/env bash
# สร้าง CA + cert สำหรับ Kafka mTLS (dev)
# รัน: ./infra/kafka/gen-certs.sh   แล้ว docker compose up -d --force-recreate kafka-1 kafka-2 kafka-3
set -euo pipefail
CERT_DIR="$(cd "$(dirname "$0")" && pwd)/certs"
DAYS=825

rm -rf "$CERT_DIR"; mkdir -p "$CERT_DIR"; cd "$CERT_DIR"

# ---------- 1. CA ----------
# MSYS_NO_PATHCONV กัน Git-Bash แปลง /C=... ให้กลายเป็น path ของ Windows
MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:4096 -sha256 -days $((DAYS*2)) -nodes \
  -keyout ca.key -out ca.crt \
  -subj "/C=TH/O=LogChain/CN=LogChain-Kafka-CA"
echo "✅ CA"

# ---------- 2. broker certs ----------
for n in 1 2 3; do
  host="kafka-$n"
  mkdir -p "$host"
  MSYS_NO_PATHCONV=1 openssl req -newkey rsa:2048 -sha256 -nodes \
    -keyout "$host/kafka.keystore.key" -out "$host/req.csr" \
    -subj "/C=TH/O=LogChain/CN=$host"
  # SAN ต้องครอบทั้งชื่อใน docker network และ localhost จาก host
  # ใช้ temp file แทน process substitution <(...) — openssl.exe (Git for Windows)
  # เปิด /dev/fd/N ไม่ได้
  extfile="$(mktemp)"
  printf "subjectAltName=DNS:%s,DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth,clientAuth\n" "$host" > "$extfile"
  openssl x509 -req -in "$host/req.csr" -CA ca.crt -CAkey ca.key -CAcreateserial \
    -out "$host/kafka.keystore.pem" -days $DAYS -sha256 \
    -extfile "$extfile"
  rm -f "$extfile"
  cp ca.crt "$host/kafka.truststore.pem"
  rm "$host/req.csr"
  echo "✅ broker $host"
done

# ---------- 3. client certs (mTLS) ----------
mkdir -p clients
for c in nestjs detection; do
  MSYS_NO_PATHCONV=1 openssl req -newkey rsa:2048 -sha256 -nodes \
    -keyout "clients/$c.key" -out "clients/$c.csr" \
    -subj "/C=TH/O=LogChain/CN=$c"
  extfile="$(mktemp)"
  printf "extendedKeyUsage=clientAuth\n" > "$extfile"
  openssl x509 -req -in "clients/$c.csr" -CA ca.crt -CAkey ca.key -CAcreateserial \
    -out "clients/$c.crt" -days $DAYS -sha256 \
    -extfile "$extfile"
  rm -f "$extfile" "clients/$c.csr"
  echo "✅ client $c"
done
cp ca.crt clients/ca.crt

# native openssl.exe (Git for Windows) เขียน CRLF ลง PEM ที่ generate — Kafka
# (Java PEM parser) อ่านไม่ผ่าน: "No matching PRIVATE KEY entries in PEM file"
# บังคับ LF ทุกไฟล์ที่ inline เข้า server.properties
find . -type f \( -name "*.key" -o -name "*.pem" -o -name "*.crt" \) -exec sed -i 's/\r$//' {} +

chmod 644 */kafka.keystore.* */kafka.truststore.pem clients/* ca.crt
echo; echo "cert อยู่ที่ $CERT_DIR"
