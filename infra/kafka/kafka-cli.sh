#!/bin/sh
# รัน kafka CLI ใน broker ผ่าน mTLS ด้วย cert ของ broker เอง — ไม่มี PLAINTEXT ในเน็ตเวิร์กแล้ว (2026-09-24)
#   docker exec logchain-kafka-1 sh /opt/logchain/kafka-cli.sh kafka-topics.sh --list
#   docker exec logchain-kafka-1 sh /opt/logchain/kafka-cli.sh kafka-consumer-groups.sh --describe --group detection-service
# ใส่ --bootstrap-server + --command-config ให้เอง (healthcheck ของ broker ก็ใช้ตัวนี้)
set -eu
tool="$1"; shift
c=/opt/bitnami/kafka/config/certs
exec "$tool" --bootstrap-server localhost:9094 \
  --command-config "$(sh /opt/logchain/client-ssl.sh "$c/kafka.keystore.pem" "$c/kafka.keystore.key" "$c/kafka.truststore.pem")" "$@"
