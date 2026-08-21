#!/usr/bin/env bash
# สร้าง CA + cert สำหรับ Kafka mTLS (dev)
# รัน: ./infra/kafka/gen-certs.sh   แล้ว docker compose up -d --force-recreate kafka-1 kafka-2 kafka-3
set -euo pipefail
CERT_DIR="$(cd "$(dirname "$0")" && pwd)/certs"
DAYS=825

rm -rf "$CERT_DIR"; mkdir -p "$CERT_DIR"; cd "$CERT_DIR"

# ---------- 1. CA ----------
openssl req -x509 -newkey rsa:4096 -sha256 -days $((DAYS*2)) -nodes \
  -keyout ca.key -out ca.crt \
  -subj "/C=TH/O=LogChain/CN=LogChain-Kafka-CA"
echo "✅ CA"

# ---------- 2. broker certs ----------
for n in 1 2 3; do
  host="kafka-$n"
  mkdir -p "$host"
  openssl req -newkey rsa:2048 -sha256 -nodes \
    -keyout "$host/kafka.keystore.key" -out "$host/req.csr" \
    -subj "/C=TH/O=LogChain/CN=$host"
  # SAN ต้องครอบทั้งชื่อใน docker network และ localhost จาก host
  openssl x509 -req -in "$host/req.csr" -CA ca.crt -CAkey ca.key -CAcreateserial \
    -out "$host/kafka.keystore.pem" -days $DAYS -sha256 \
    -extfile <(printf "subjectAltName=DNS:%s,DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth,clientAuth\n" "$host")
  cp ca.crt "$host/kafka.truststore.pem"
  rm "$host/req.csr"
  echo "✅ broker $host"
done

# ---------- 3. client certs (mTLS) ----------
mkdir -p clients
for c in nestjs detection; do
  openssl req -newkey rsa:2048 -sha256 -nodes \
    -keyout "clients/$c.key" -out "clients/$c.csr" \
    -subj "/C=TH/O=LogChain/CN=$c"
  openssl x509 -req -in "clients/$c.csr" -CA ca.crt -CAkey ca.key -CAcreateserial \
    -out "clients/$c.crt" -days $DAYS -sha256 \
    -extfile <(printf "extendedKeyUsage=clientAuth\n")
  rm "clients/$c.csr"
  echo "✅ client $c"
done
cp ca.crt clients/ca.crt

chmod 644 */kafka.keystore.* */kafka.truststore.pem clients/* ca.crt
echo; echo "cert อยู่ที่ $CERT_DIR"
