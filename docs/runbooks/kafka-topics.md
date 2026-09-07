# Kafka Topic Provisioning

## Topics ที่ระบบใช้

| Topic | Producer | Consumer | หน้าที่ |
|---|---|---|---|
| `logs.raw` | api-gateway (`KafkaProducerService`) | detection (`app/consumer.py`) | log ที่ ingest เข้ามา |
| `logs.raw.dlq` | api-gateway | — (ดูด้วยมือ) | log ที่ produce ไม่สำเร็จ |
| `alerts.raw` | detection (`push_alert`) | api-gateway (`KafkaConsumerService`) | alert ทั่วไป |
| `alerts.cde` | detection (`push_alert`) | api-gateway (`KafkaConsumerService`) | alert ใน CDE scope (PCI) |

ทั้งหมดถูกสร้างโดย service `kafka-init` ใน `docker-compose.yml` ซึ่งรัน
`infra/kafka/create-topics.sh` แบบ one-shot หลัง broker ทั้ง 3 ตัว healthy
(partitions 3, replication-factor 3, `min.insync.replicas=2`)

`kafka-init` ยิงผ่าน internal listener `kafka-1:9092` (PLAINTEXT) จากในเน็ตเวิร์ก
compose จึงไม่ต้อง mount cert หรือตั้ง ssl config ให้ `kafka-topics.sh` แบบที่ external
listener `:39092` (mTLS) ต้องทำ

## ทำไมไม่ปล่อยให้ auto-create

`KAFKA_CFG_AUTO_CREATE_TOPICS_ENABLE=true` ยังเปิดอยู่ และ client ก็ auto-create ให้จริง
(kafkajs ตั้ง `allowAutoTopicCreation` เป็น true โดย default ตอน subscribe) แต่พึ่งมัน
อย่างเดียวไม่ได้ เพราะ topic จะเกิดก็ต่อเมื่อ **มี client ต่อติดจริง** เท่านั้น:

1. **`KafkaConsumerService` เคยยอมแพ้ถาวรถ้า Kafka ยังไม่พร้อม** — retry แค่ 5 ครั้ง
   (~30 วินาที) แล้ว log `Kafka consumer unavailable — alert persistence disabled`
   และไม่ลองใหม่อีกเลยจนกว่าจะ restart backend หลัง `docker compose down -v` broker
   ใช้เวลา boot นานกว่านั้นได้สบาย — backend ที่รันค้างบน host จึงหมดสิทธิ์ทั้ง subscribe
   และ auto-create (**แก้แล้ว** — ดู "สองฝั่งที่เคย fail เงียบ" ข้างล่าง)
2. **ฝั่ง detection ไม่เช็คผล send** — `app/consumer.py` เรียก `producer.send(...)`
   แบบ fire-and-forget ไม่มี `.get()` / flush ตามหลัง บรรทัด log `🚨 ALERT` จึงขึ้นปกติ
   ไม่ว่า message จะถึง broker หรือไม่ (**แก้แล้ว** เช่นกัน)

ผลรวมคือ **alert หายเงียบ ๆ**: detection บอกว่าเจอ, backend ไม่เคยได้รับ, alert ไม่เข้า DB,
และไม่มี error โผล่ที่ฝั่งไหนเลย — `kafka-init` ตัดปัญหาโดยทำให้ topic มีอยู่ตั้งแต่ก่อนที่
client ตัวไหนจะขยับ

### เคสที่เจอจริง

หลัง `docker compose down -v` แล้ว `up` ใหม่ มีแต่ `logs.raw` ที่ถูกสร้าง ส่วน
`alerts.raw` / `alerts.cde` ไม่มี ทำให้ demo ที่ควรจะโชว์ alert เข้า DB เงียบสนิท
ทั้งที่ log ฝั่ง detection ขึ้น `🚨 ALERT` ครบ

### `num.partitions` = 3 บน broker

ต่อให้มี `kafka-init` แล้ว ก็ยัง **แข่งกับ client ที่ต่อมาก่อนได้** — client ที่รันบน host
ค้างอยู่ (เช่น backend ที่ยังไม่ได้ restart) อาจ auto-create topic ทันตอน broker เพิ่งขึ้น
ก่อนที่ `kafka-init` จะได้รัน แล้ว `--if-not-exists` ก็จะไม่ไปแก้ topic นั้นให้ทีหลัง

เจอเคสนี้จริงตอนทดสอบ: `alerts.raw` / `alerts.cde` ออกมาเป็น **1 partition** เพราะ
NestJS consumer ชิงสร้างก่อน จึงตั้ง `KAFKA_CFG_NUM_PARTITIONS: "3"` ไว้ที่ broker ทั้ง 3 ตัว
ให้ค่า default ของ auto-create ตรงกับที่ `create-topics.sh` ใช้ — ใครสร้างก่อนก็ได้ผลเหมือนกัน

## ตรวจสอบ

```bash
docker exec logchain-kafka-1 kafka-topics.sh \
  --bootstrap-server localhost:9092 --list

# ดูรายละเอียด partition / ISR ของ topic เดียว
docker exec logchain-kafka-1 kafka-topics.sh \
  --bootstrap-server localhost:9092 --describe --topic alerts.raw
```

`scripts/demo-preflight.sh` เช็ค `logs.raw`, `alerts.raw`, `alerts.cde` ให้อยู่แล้ว
และ fail ถ้าขาดตัวใดตัวหนึ่ง (มีเทสคุมที่ `scripts/demo-preflight.spec.ts`)

## ถ้า topic หาย

```bash
docker compose up -d kafka-init      # idempotent — รันซ้ำได้ ไม่แตะ topic เดิม
docker compose logs kafka-init
```

## ข้อควรรู้

- `--if-not-exists` **ไม่ปรับ** topic ที่มีอยู่แล้ว topic ที่เคยถูก auto-create ไว้ตอน
  ก่อนหน้าจะยังมี 1 partition ต่อไป ถ้าอยากได้ 3 partition ต้องเพิ่มเอง
  (`--alter --partitions 3`) หรือล้าง volume แล้วให้ `kafka-init` สร้างใหม่
- เพิ่ม partition ได้อย่างเดียว ลดไม่ได้ และการเพิ่มจะเปลี่ยน key→partition mapping
  ของ message ใหม่ (`push_alert` ใช้ `source` เป็น key)

## สองฝั่งที่เคย fail เงียบ (แก้แล้ว)

### api-gateway — `src/kafka/kafka-consumer.service.ts`

- reconnect ไม่มีวันยอมแพ้: exponential backoff 1s → 2s → 4s … ตันที่ 60s
  ปรับได้ด้วย `KAFKA_RECONNECT_BASE_MS` / `KAFKA_RECONNECT_MAX_MS`
- log ทุกครั้งที่ retry (`connect failed (attempt N) … ลองใหม่ใน Xs (ไม่ยอมแพ้)`)
  และทุกครั้งที่ kafkajs restart ให้เอง (`crashed (ครั้งที่ N) … (ไม่ยอมแพ้)`)
- ฟัง `GROUP_JOIN` / `DISCONNECT` เพื่อให้สถานะตรงกับความจริง — ตอน kafkajs restart
  ให้เองมันไม่ผ่าน connect loop ของเรา ถ้าไม่ดัก `connected` จะค้าง false ทั้งที่ consume ได้แล้ว
- `GET /health` คืนสถานะให้ตรวจได้:

```json
{ "status": "ok",
  "kafkaConsumer": { "connected": true, "lastError": null,
                     "lastConnectedAt": "…", "reconnectAttempts": 0 } }
```

`/health` คืน 200 เสมอถ้า process ยังอยู่ (ingest ยังทำงานได้แม้ consumer หลุด)
คนเรียกต้องดู `kafkaConsumer.connected` เอง — `demo-preflight.sh` gate ที่ field นี้

### detection — `app/consumer.py`

`push_alert()` แยก log เป็นสองเหตุการณ์ และ return `bool`:

```
🚨 DETECTED [RULE_MATCH]: host - Privilege escalation attempt          ← WARNING
✅ PUBLISHED → alerts.raw[0]@0 [RULE_MATCH]: host - …                  ← INFO
❌ PUBLISH FAILED → alerts.raw (KafkaError: …) — alert นี้ไม่ถึง backend  ← ERROR
```

`producer.send(...).get(timeout=KAFKA_PUBLISH_TIMEOUT)` (default 10 วิ) บล็อกจนกว่า
broker จะ ack จริง และเพิ่ม metric `consumer_alert_publish_failures_total{topic=...}`
ตอนล้มเหลว — ส่วนต่างระหว่าง "detect เจอ" กับ "ส่งสำเร็จ" จึงเห็นได้จาก Grafana
