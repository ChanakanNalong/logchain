# สิ่งที่ต้องทำต่อ

> **เอกสารนี้คืออะไร:** งานค้างของ LogChain เขียนให้ session หน้า (คนหรือ Claude Code)
> อ่านแล้วลงมือได้เลย ไม่ต้องสืบใหม่
>
> **อัปเดตล่าสุด:** 2026-09-23 · **ฐาน:** `main = aee939b`
> **รอบที่แล้วปิดไปแล้ว:** ทุกข้อของแผนเดิม — รายละเอียดอยู่ใน `docs/worklog/2026-09-22.md`
> หัวข้อ 11–13 (Reports/SEALED · Kafka producer retry · NonceManager crash · P3)
> ข้อในไฟล์นี้**มาจากสิ่งที่เจอระหว่างทำรอบที่แล้ว** แต่ยังไม่ได้แก้

---

## ลำดับที่แนะนำ

1. **1.1 alert dedup กลืน rule อื่น** — ช่องโหว่ในการตรวจจับจริง ทำก่อน
2. **2.2 ยืนยันงานรอบที่แล้วบนของจริง** — งานสั้น ปิดช่องที่ยังไม่ได้ตรวจ
3. **2.1 log ช่วง Kafka ล่มไม่ถึง detection** — ต้องออกแบบก่อนลงมือ
4. ที่เหลือทำเมื่อว่าง

---

# 🔴 P1

## 1.1 alert dedup ไม่ดู rule — rule อื่นบน host เดียวกันหายเงียบ

**ปัญหา** — `src/alerts/alerts.service.ts:17` (`createOrDedup`) และ
`infra/postgres/init/03-alerts-dedup-index.sql`

key ของ dedup คือ `(status='OPEN', alert_type, source, batch_id)` — `source` คือชื่อ host
(เช่น `web-server-01`) **ไม่มี rule_id** ผลคือตราบใดที่มี `RULE_MATCH` ของ host นั้นค้าง OPEN
อยู่หนึ่งตัว **ทุก rule หลังจากนั้นบน host เดียวกันจะถูกรวมเข้าตัวเดิมแล้วหายไป** ไม่เกิดแถวใหม่
ไม่ส่ง email แม้เป็น CRITICAL

ตัวอย่างที่อันตรายที่สุด: rule 5710 (brute force) ค้าง OPEN แล้ว rule **5715 "Successful login
after multiple failures"** — สัญญาณว่าเจาะเข้ามาได้แล้ว — ยิงตามมา → ถูกกลืนเข้า alert brute force
ตัวเดิม analyst ไม่มีวันเห็น เช่นเดียวกับ ML_ANOMALY ที่ dedup ด้วย key เดียวกัน

**หลักฐานที่มี:** บน stack นี้มี `RULE_MATCH / web-server-01` ค้าง OPEN ตั้งแต่ 2026-09-22 10:01
รอบทดสอบ demo-brute-force ตอน 15:57 detection ขึ้น `🚨 DETECTED` สองครั้ง backend ขึ้น
`Persisted alert` แต่ไม่มีแถวใหม่ · **ยังไม่ได้ทดสอบกับ rule ต่างตัว** (อ่านจากโค้ด)

**ตรวจก่อนแก้ (5 นาที):** ยิง log ที่เข้า 5715 (`"login success for user jdoe"` จาก host
`web-server-01`) ภายใน 5 นาทีหลัง `demo-brute-force.sh` แล้วดูว่ามีแถว alert ใหม่ไหม
คาดว่า**ไม่มี** = ยืนยันบั๊ก

**ทำอะไร**
1. เพิ่ม rule_id เข้า key — `detail->>'rule_id'` มีอยู่แล้วในทุก RULE_MATCH (ML ใช้ค่าอื่นหรือ
   ค่าคงที่ได้) จะเป็นคอลัมน์ใหม่หรือ expression index ก็ได้ แต่ **findOne ใน `createOrDedup`
   กับ unique index ต้องใช้ key เดียวกันเป๊ะ** ไม่งั้น insert ชน 23505 แล้ววนหาตัวเดิมไม่เจอ
2. เพิ่ม `occurrence_count` + `last_seen_at` แล้ว increment ตอน dedup — ตอนนี้ dedup ทิ้งเหตุการณ์
   ซ้ำไปเฉย ๆ ไม่รู้ว่าโดนซ้ำกี่ครั้ง ล่าสุดเมื่อไร (สำคัญต่อ PCI DSS Req 10 — audit trail)
3. พิจารณาให้ CRITICAL ที่ซ้ำหลังจาก alert เดิมเปิดไปนานแล้ว (เช่น > 1 ชม.) ส่ง email อีกรอบ

**ระวัง:** ไฟล์ใน `infra/postgres/init/` รันเฉพาะตอน volume ว่าง — DB ที่มีอยู่แล้ว (รวมเครื่องนี้)
**ไม่ได้ index ใหม่อัตโนมัติ** ต้องมี migration หรือสคริปต์ให้รันเอง และต้องทำให้ทั้งสองทางได้ผลเหมือนกัน

**เสร็จเมื่อ** — ทดสอบข้างบนได้ 2 แถว (5710 + 5715) · ยิง 5710 ซ้ำแล้ว `occurrence_count` ขึ้น
ไม่เกิดแถวใหม่ · เทสต์ใน `src/alerts/` คุมทั้งสามเคส

---

# 🟡 P2

## 2.1 log ที่เข้าระหว่าง Kafka ล่ม ไม่ถึง detection เลย

**ปัญหา** — `src/kafka/kafka-producer.service.ts:116`

รอบที่แล้วแก้ให้ producer ต่อใหม่เองไม่ยอมแพ้ แต่**ระหว่างที่ยังต่อไม่ติด** `publishLog()` แค่เตือน
ครั้งเดียวแล้ว `return` — log เข้า DB ครบ (integrity ปกติ) แต่ detection ไม่เคยเห็น log ช่วงนั้น
ไม่มี replay · DLQ (`logs.raw.dlq`) ช่วยไม่ได้เพราะใช้เฉพาะตอน send พังหลังต่อติดแล้ว

ช่วงที่เกิดจริง: ทุกครั้งที่ compose ยก backend ขึ้นก่อน broker (~10–60 วิ) และตอน Kafka ล่ม
ผู้โจมตีที่ยิงตรงช่วงนั้นจะไม่โดน rule ใดเลย

**ทำอะไร (ต้องเลือกแนวทางก่อน)**
- (ก) **replay จาก DB** — จำ `created_at` ของ log สุดท้ายที่ publish สำเร็จ พอต่อติดแล้วส่ง log
  ที่ใหม่กว่านั้นตามไป · ง่าย ใช้ `logs` เป็น outbox อยู่แล้ว · ระวัง rule แบบ threshold
  (5710 = 5 ครั้งใน 60 วิ) — detection ใช้ `time.time()` ตอนรับ ไม่ใช่เวลาของ log
  replay ทีเดียวทั้งก้อนจะนับเวลาเพี้ยน อาจต้องให้ `rules.py` ใช้ `createdAt` ของ event
- (ข) buffer ในหน่วยความจำ — ง่ายสุดแต่หายตอน restart ไม่แนะนำ

**เสร็จเมื่อ** — stop kafka → ยิง log 6 ตัวแบบ demo-brute-force → start kafka →
ได้ `RULE_MATCH` (ตอนนี้ได้แค่ warning `ไม่ถูกส่งไป detection`)

## 2.2 ยืนยันงานรอบที่แล้วที่ยังไม่ได้ตรวจบนของจริง

รอบที่แล้วตรวจด้วย unit test + SQL บน DB จริง แต่ยังค้างสองอย่าง:

1. **container ของ dashboard ยังเป็น image เก่า** (สร้าง 2026-09-22 11:39 UTC ก่อนแก้
   Reports/tiles) — rebuild แล้วเปิดดู Reports (คอลัมน์ Sealed, CSV มี `sealed`), tile
   "Sealed Batches" บน Dashboard และ "Anchored on chain" บน Verify
   ```bash
   HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose up -d --build --no-deps cylis-dashboard
   ```
2. **ยังไม่เคยเห็นเลขตรงกันบน stack ที่ไม่มี blockchain** — stack นี้ต่อ Amoy อยู่ batch เป็น
   CONFIRMED หมด ทำได้ตอน smoke test รอบหน้า (clone ใหม่ไม่มี `CONTRACT_ADDRESS`):
   `/api/v1/stats/overview` กับ `/api/v1/compliance/reports` ต้องได้ `integrityRate` เท่ากัน
   และ `confirmed+sealed+tampered+unverified+pending = total` · ต้องใช้ token ที่มี role
   `admin`/`auditor` (service account `log-ingestor` ไม่มี)

## 2.3 detection consumer ขึ้น `RuntimeError: Task is already done!` ~24 ครั้ง/วัน

`kafka-python==3.0.2` (`detection/requirements.txt:17`) โยน error นี้จาก `kafka/net/selector.py`
มักตามหลัง `NotCoordinatorError` / broker restart · detection ยังทำงาน (ทดสอบแล้วจับ RULE_MATCH ได้)
แต่**ยังไม่รู้ว่าทำ message หายหรือ commit offset ข้ามไหม**

**ทำอะไร** — เทียบ offset ที่ consumer commit กับจำนวนที่ `consumer_process_seconds_count`
นับได้ข้ามช่วงที่เกิด error · ถ้าหายจริง ลอง pin เวอร์ชันอื่นของ kafka-python หรือย้ายไป
`confluent-kafka` · ถ้าไม่หาย ลดระดับ log ไว้พอ

---

# 🟢 P3 — ทำเมื่อว่าง

## 3.1 กันพลาดเผื่อ ethers หลุด unhandled rejection อีก

ethers หลุดแบบนี้มาแล้ว **2 ครั้ง** (network detection ก่อนใส่ `staticNetwork` และ
`NonceManager` รอบที่แล้ว) ทั้งคู่ฆ่าทั้ง process · ตอนนี้ไม่มี `process.on('unhandledRejection')`
ใน `src/` เลย ถ้าจะใส่ ให้**จำกัดแค่ error ของ ethers** (มี `code` + `shortMessage`) log ระดับ
ERROR + เพิ่ม metric แล้วไม่ตาย · error อื่นยังต้องตายเหมือนเดิม (fail fast) · อย่าใส่แบบกลืนทุกอย่าง

## 3.2 `storeRoot` แยก "รอ confirm ไม่ทัน" กับ "RPC timeout ระหว่างรอ" ไม่ได้

`src/blockchain/blockchain.service.ts:207` เช็ค `err?.code !== 'TIMEOUT'` — ethers ใช้ code
`TIMEOUT` ทั้งกับ `wait()` ที่ครบเวลาและกับ HTTP request ที่ timeout · ผลตอนนี้ไม่เสียหาย
(ทั้งคู่ได้ UNVERIFIED แล้ว verify รอบถัดไปตามผลเอง) แต่ log บอกว่า "not confirmed within
120000ms" ทั้งที่จริงอาจเป็น RPC ล่ม · แก้ให้ log บอกตรงก็พอ

## 3.3 ลบ `~/Documents/logchain-detection`

remote ถูกลบแล้ว (ข้อ 2.1 เดิม) โฟลเดอร์ยังอยู่และตอนนี้ใหญ่ **11 GB** · ไฟล์ทั้ง 14 ตัวอยู่ใน
`detection/` ครบและตรวจแล้วว่าตรงกันทุกไบต์ (worklog 2026-09-22) — ลบได้เลยถ้าไม่ต้องการ
history ของ repo นั้น

---

# ⛔ ห้ามทำ (ตัดสินใจไปแล้ว อย่าถกใหม่)

- **ห้ามรวม `logchain-contracts` เข้ามา** — backend ใช้ inline ABI ที่
  `src/blockchain/blockchain.service.ts` ผูกกันผ่าน `CONTRACT_ADDRESS` สตริงเดียว
- **ห้ามเอา `SEALED` ไปนับรวมใน `batches.confirmed`** — `confirmed` = "anchor ขึ้น chain แล้ว" เท่านั้น
  (สูตร intact ใช้ `INTACT_STATUSES` ใน `src/logs/entities/batch.entity.ts` ที่เดียว)
- **ห้ามกลับไปใช้ `ethers.NonceManager`** — crash ตอน RPC timeout + ทิ้งช่องว่าง nonce
  (worklog หัวข้อ 12) · `src/blockchain/blockchain.nonce.spec.ts` จะพัง 3 เคส
- **ห้ามทำให้สอง compose stack อยู่พร้อมกัน** (ถอด `container_name`) — ชั่งแล้วไม่คุ้ม:
  ชื่อ container ในเอกสาร ~40 จุดใช้ไม่ได้ และยังชนพอร์ต 17 ตัว · กลับมาดูเมื่อต้องรัน CI ขนานเท่านั้น
- **ห้ามปิด Vault user lockout เป็น default** — control ตาม PCI DSS Req 8.3.4 ใช้
  `scripts/vault-unlock.sh` แทน
- **ห้าม override `KEYCLOAK_URL` เป็นชื่อ service ใน compose** — เป็น issuer ที่ต้องตรงกับ `iss`
  ที่อยู่ภายในใช้ `KEYCLOAK_INTERNAL_URL`
- **ห้ามเปลี่ยน `NEXT_PUBLIC_*` เป็นชื่อ service** — inline ตอน build รันบนเบราว์เซอร์นอก docker network
- **ห้ามใช้ `${VAR:?...}` ใน `docker-compose.yml`** — compose error ทั้งไฟล์
- **ห้าม `docker compose down -v`** ตอนทดสอบ ถ้ายังอยากได้ข้อมูล demo เดิม
- **ห้ามเดารหัส `admin-user` / ห้ามตั้ง TOTP แทนเจ้าของ** — รหัสใน `.env` ไม่ใช่ของจริงบน stack
  นี้แล้ว และ brute force ล็อกที่ 5 ครั้ง · ต้องการ token ที่มี role admin ให้ขอเจ้าของ

---

# กับดักที่เสียเวลาที่สุด (อ่านก่อนเริ่ม debug)

| อาการ | ที่จริงคือ |
|---|---|
| approle login ตอบ `permission denied` ทั้งที่ค่าใน `.env` ถูก | Vault user lockout — `./scripts/vault-unlock.sh` ดูและปลดได้ |
| ยิง log ได้ 201 แต่ไม่มี alert แถวใหม่ | ดูสองชั้น: (1) `docker logs logchain-backend \| grep KafkaProducer` ว่าต่อ Kafka ติดไหม (2) มี alert OPEN ของ `alert_type`+host เดียวกันค้างอยู่ไหม — ถูก dedup กลืน (ข้อ 1.1) |
| login `admin-user` ด้วยรหัสใน `.env` ไม่ผ่าน | realm import ครั้งเดียวตอน boot แรก และเจ้าของเปลี่ยนรหัส + ตั้ง OTP ไปแล้ว — ไม่ใช่ Keycloak พัง |
| `UPDATE logs ...` ใน psql ไม่มีผล | trigger `trg_logs_no_update` ต้อง `ALTER TABLE logs DISABLE TRIGGER` ก่อน (ดู `scripts/demo-tamper.sh`) |
| แก้ไฟล์ใน `infra/postgres/init/` แล้วไม่มีผล | รันเฉพาะตอน volume ว่าง — DB เดิมต้องรันเองหรือทำ migration |
| rebuild consumer แล้วโค้ดไม่เปลี่ยน | `detection-consumer` ใช้ image ของ `detection-api` — ต้อง `docker compose build detection-api` |
| batch ค้าง `SEALED` ไม่ขึ้น `CONFIRMED` | ปกติถ้าไม่ได้ตั้ง blockchain — `anchorSealedBatches()` ตามไป anchor เองเมื่อ config ครบ |
| เทสต์ ethers กับ RPC ปลอมแล้ว call ที่สองได้ error เดิมโดยไม่ยิงจริง | ethers cache ผลของ request ที่เหมือนกัน 250ms (รวม reject) — เว้นช่วงในเทสต์ |

---

# ไฟล์อ้างอิง

| ไฟล์ | เกี่ยวตรงไหน |
|---|---|
| `docs/worklog/2026-09-22.md` | บันทึกเต็ม หัวข้อ 1–13 (11–13 = รอบล่าสุด) |
| `src/alerts/alerts.service.ts:17` | `createOrDedup` — ข้อ 1.1 |
| `infra/postgres/init/03-alerts-dedup-index.sql` | unique index ของ dedup — ข้อ 1.1 |
| `detection/rules/security_rules.yaml` | rule 5710 / 5715 ที่ใช้ทดสอบข้อ 1.1 |
| `src/kafka/kafka-producer.service.ts:116` | จุดที่ log ถูกข้ามตอน Kafka ยังไม่พร้อม — ข้อ 2.1 |
| `detection/app/rules.py` | threshold ใช้ `time.time()` ตอนรับ — ต้องคิดถ้าทำ replay ข้อ 2.1 |
| `src/blockchain/blockchain.service.ts` | `sendStoreRoot()` จัดการ nonce เอง · บรรทัด 207 = ข้อ 3.2 |
| `src/logs/entities/batch.entity.ts` | `INTACT_STATUSES` — แหล่งเดียวของสูตร integrity |
| `scripts/vault-unlock.sh` | ปลด Vault lockout |
| `README.md` หัวข้อ Troubleshooting + Vault user lockout | เคสที่เจอบ่อยพร้อมคำสั่งแก้ |
