#!/bin/bash
# สร้าง topic ที่ระบบต้องใช้ให้ครบตั้งแต่ตอน `docker compose up` — ห้ามพึ่ง auto-create
#
# ทำไมต้องมีไฟล์นี้:
#   auto.create.topics.enable=true สร้าง topic ให้ก็จริง แต่สร้างเฉพาะตอนมี client
#   ต่อติดแล้วขอ metadata เท่านั้น ซึ่งพึ่งไม่ได้กับ alerts.raw / alerts.cde:
#     - KafkaConsumerService (NestJS) retry ตอน boot แค่ 5 ครั้ง (~30 วิ) แล้วยอมแพ้ถาวร
#       หลัง `compose down -v` broker boot ช้ากว่านั้นได้ → backend ที่ค้างอยู่บน host
#       ไม่ได้ subscribe และไม่ได้ auto-create อะไรเลย
#     - ฝั่ง detection ใช้ producer.send() แบบ fire-and-forget ไม่มีใครเช็คผล
#       เลย log "🚨 ALERT" ออกมาปกติทั้งที่ message ไม่เคยถึง broker
#   ผลรวมคือ alert หายเงียบ ๆ ไม่มี error ให้ตามที่ฝั่งไหนเลย
#
#   ดู docs/runbooks/kafka-topics.md สำหรับเคสเต็ม
set -eu

BOOTSTRAP="${KAFKA_BOOTSTRAP:-kafka-1:9092}"

# 3 partition = 1 leader ต่อ broker กระจายโหลดเท่ากัน และเปิดทางให้ consumer group
# ขยายได้ถึง 3 ตัว   RF 3 + min.insync.replicas 2 = ทน broker ตาย 1 ตัวโดยยังเขียนได้
PARTITIONS="${KAFKA_TOPIC_PARTITIONS:-3}"
REPLICATION_FACTOR="${KAFKA_TOPIC_REPLICATION_FACTOR:-3}"
MIN_ISR="${KAFKA_TOPIC_MIN_ISR:-2}"

# depends_on: service_healthy การันตีแค่ kafka-1 ตอบ ไม่ได้แปลว่า quorum พร้อมรับ
# --replication-factor 3 แล้ว — ถ้ายิงเร็วไปจะเจอ INVALID_REPLICATION_FACTOR
echo "▶ Waiting for Kafka at $BOOTSTRAP ..."
until kafka-topics.sh --bootstrap-server "$BOOTSTRAP" --list >/dev/null 2>&1; do
    sleep 2
done
echo "✓ Kafka responding"

create_topic() {
    _topic="$1"
    # --if-not-exists = idempotent: รันซ้ำบน cluster เดิมไม่ error และไม่แตะ topic เก่า
    # (topic ที่มีอยู่แล้วจะคง partition count เดิมไว้ ไม่ถูกปรับตาม $PARTITIONS)
    kafka-topics.sh --bootstrap-server "$BOOTSTRAP" \
        --create --if-not-exists \
        --topic "$_topic" \
        --partitions "$PARTITIONS" \
        --replication-factor "$REPLICATION_FACTOR" \
        --config "min.insync.replicas=$MIN_ISR" \
        >/dev/null
    echo "✓ $_topic"
}

echo "▶ Creating topics (partitions=$PARTITIONS, RF=$REPLICATION_FACTOR, min.isr=$MIN_ISR)..."
create_topic logs.raw       # api-gateway → detection
create_topic logs.raw.dlq   # KafkaProducerService ทิ้ง log ที่ส่งไม่สำเร็จลงตัวนี้
create_topic alerts.raw     # detection → api-gateway (alert ทั่วไป)
create_topic alerts.cde     # detection → api-gateway (alert ใน CDE scope, PCI)

echo "▶ Topics ทั้งหมดตอนนี้:"
kafka-topics.sh --bootstrap-server "$BOOTSTRAP" --list | grep -v '^__' | sed 's/^/    /'
echo "✓ kafka-init เสร็จแล้ว"
