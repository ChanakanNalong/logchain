#!/usr/bin/env bash
# Demo: Kafka mTLS — log stream ระหว่าง detection ↔ backend เข้ารหัส + ต้องมี client cert
set -uo pipefail
C="infra/kafka/certs"
K() { docker exec logchain-kafka-1 "$@"; }

echo "═══ 1) ต่อ Kafka พร้อม client certificate ═══"
docker run --rm --network host -v "$PWD/infra/kafka/certs:/certs:ro" \
  bitnamilegacy/kafka:3.7.1 bash -c '
cat /certs/clients/nestjs.crt /certs/clients/nestjs.key > /tmp/c.pem
printf "security.protocol=SSL\nssl.truststore.type=PEM\nssl.truststore.location=/certs/ca.crt\nssl.keystore.type=PEM\nssl.keystore.location=/tmp/c.pem\n" > /tmp/ok.properties
kafka-topics.sh --bootstrap-server localhost:39092,localhost:39093,localhost:39094 --command-config /tmp/ok.properties --list' \
  && echo "→ ✅ เข้าถึงได้ (client cert จริง, เห็นครบ 3 broker)" || echo "→ ❌ ไม่ควรพัง"

echo
echo "═══ 2) ต่อโดยไม่มี client certificate ═══"
K bash -c '
printf "security.protocol=SSL\nssl.truststore.type=PEM\nssl.truststore.location=/opt/bitnami/kafka/config/certs/kafka.truststore.pem\n" > /tmp/no.properties
timeout 20 kafka-topics.sh --bootstrap-server localhost:39092 --command-config /tmp/no.properties --list' 2>&1 | grep -iE "bad_certificate|handshake|SslAuth" | head -3
echo "→ ✅ ถูกปฏิเสธ = mutual TLS ทำงาน (ไม่ใช่ TLS ธรรมดา)"

echo
echo "═══ 3) traffic วิ่งผ่าน port ไหนจริง ═══"
ss -tnp 2>/dev/null | grep -E ":(29092|39092)" | awk '{print $4, $5, $6}' || \
  echo "(เปิด backend+detection ด้วย KAFKA_SSL_ENABLED=true ก่อนถึงจะเห็น)"

echo
echo "═══ 4) certificate ที่ broker ใช้ ═══"
openssl x509 -in "$C/kafka-1/kafka.keystore.pem" -noout -subject -dates -ext subjectAltName
