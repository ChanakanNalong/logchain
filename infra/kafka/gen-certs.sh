#!/usr/bin/env bash
# สร้าง CA + cert สำหรับ Kafka mTLS (dev)
# รัน: ./infra/kafka/gen-certs.sh   แล้ว docker compose up -d --force-recreate kafka-1 kafka-2 kafka-3
#
# ./infra/kafka/gen-certs.sh client <ชื่อ> — ออก client cert เพิ่มด้วย CA เดิม (มีอยู่แล้ว = ข้าม)
#   ไม่ลบอะไร · bootstrap.sh ใช้เติม cert ที่เพิ่มทีหลังให้เครื่องที่ generate ไว้ก่อน (admin / exporter)
set -euo pipefail
CERT_DIR="$(cd "$(dirname "$0")" && pwd)/certs"
DAYS=825
# client ทั้งหมดที่ระบบใช้ — nestjs = backend · detection = detection-consumer
# admin = kafka-init (สร้าง topic) · exporter = kafka-exporter (อ่าน metadata / lag ให้ Prometheus)
CLIENTS="nestjs detection admin exporter"

# CRLF → LF (ดูคอมเมนต์ท้ายไฟล์) + สิทธิ์ของ client cert หนึ่งใบ
issue_client() {
  c="$1"
  MSYS_NO_PATHCONV=1 openssl req -newkey rsa:2048 -sha256 -nodes \
    -keyout "clients/$c.key" -out "clients/$c.csr" \
    -subj "/C=TH/O=LogChain/CN=$c" 2>/dev/null
  extfile="$(mktemp)"
  printf "extendedKeyUsage=clientAuth\n" > "$extfile"
  openssl x509 -req -in "clients/$c.csr" -CA ca.crt -CAkey ca.key -CAcreateserial \
    -out "clients/$c.crt" -days $DAYS -sha256 \
    -extfile "$extfile" 2>/dev/null
  rm -f "$extfile" "clients/$c.csr"
  sed -i 's/\r$//' "clients/$c.key" "clients/$c.crt"
  chmod 644 "clients/$c.crt"
  chmod 640 "clients/$c.key"
  echo "✅ client $c"
}

if [ "${1:-}" = "client" ]; then
  name="${2:?ใช้: gen-certs.sh client <ชื่อ>}"
  cd "$CERT_DIR"
  [ -f ca.key ] || { echo "ไม่มี $CERT_DIR/ca.key — รัน gen-certs.sh แบบไม่มี argument ก่อน" >&2; exit 1; }
  if [ -f "clients/$name.crt" ] && [ -f "clients/$name.key" ]; then
    echo "✓ client $name มีอยู่แล้ว — ข้าม"
  else
    issue_client "$name"
  fi
  exit 0
fi

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
for c in $CLIENTS; do issue_client "$c"; done
cp ca.crt clients/ca.crt

# native openssl.exe (Git for Windows) เขียน CRLF ลง PEM ที่ generate — Kafka
# (Java PEM parser) อ่านไม่ผ่าน: "No matching PRIVATE KEY entries in PEM file"
# บังคับ LF ทุกไฟล์ที่ inline เข้า server.properties
find . -type f \( -name "*.key" -o -name "*.pem" -o -name "*.crt" \) -exec sed -i 's/\r$//' {} +

# cert เปิดอ่านได้ · private key อ่านได้เฉพาะเจ้าของ + กลุ่ม (container ได้กลุ่มผ่าน group_add ใน compose)
# · ca.key เฉพาะเจ้าของ — ไม่มี container ไหนต้องใช้
chmod 644 */kafka.keystore.pem */kafka.truststore.pem clients/*.crt ca.crt
chmod 640 */kafka.keystore.key clients/*.key
chmod 600 ca.key
echo; echo "cert อยู่ที่ $CERT_DIR"
