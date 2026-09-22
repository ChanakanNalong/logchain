# สิ่งที่ต้องทำต่อ

> **เอกสารนี้คืออะไร:** งานค้างของ LogChain เขียนให้ session หน้า (คนหรือ Claude Code)
> อ่านแล้วลงมือได้เลย ไม่ต้องสืบใหม่
>
> **อัปเดตล่าสุด:** 2026-09-23 (หลังทำ 1.2) · **ฐาน:** `main` + งาน 1.2 ที่ยังไม่ commit
> **รอบที่แล้วปิดไปแล้ว:** ทุกข้อของแผนเดิม — รายละเอียดอยู่ใน `docs/worklog/2026-09-22.md`
> หัวข้อ 11–13 (Reports/SEALED · Kafka producer retry · NonceManager crash · P3)
> ข้อในไฟล์นี้**มาจากสิ่งที่เจอระหว่างทำรอบที่แล้ว** แต่ยังไม่ได้แก้

---

## ลำดับที่แนะนำ

1. ~~**1.1 alert dedup กลืน rule อื่น**~~ ✅ เสร็จ 2026-09-23 (worklog `2026-09-23.md`)
2. ~~**1.2 เตือนซ้ำ**~~ ✅ เสร็จ 2026-09-23 (worklog หัวข้อ 6)
3. **2.2 ยืนยันงานบนของจริง** — dashboard rebuild แล้ว เหลือเปิดดูด้วยตา (ต้อง login ของเจ้าของ)
4. **2.1 log ช่วง Kafka ล่มไม่ถึง detection** — ต้องออกแบบก่อนลงมือ
5. ที่เหลือทำเมื่อว่าง

---

# 🔴 P1

## 1.1 ✅ alert dedup ไม่ดู rule — แก้แล้ว (2026-09-23)

ยืนยันบั๊กบน stack จริงก่อนแก้: 5715 (login สำเร็จหลัง brute force) ถูกกลืนเข้า 5710 ที่ค้าง OPEN
หลังแก้ได้ 2 แถวแยกกัน และ 5710 ที่เกิดซ้ำนับ `occurrence_count` แทนการหาย · รายละเอียด
`docs/worklog/2026-09-23.md`

**สิ่งที่เปลี่ยนที่ session หน้าต้องรู้:** มี**ระบบ migration แล้ว** (`src/database/migrations/`
+ `migrationsRun: true`) — เปลี่ยน schema ต่อจากนี้ให้เพิ่ม migration ห้ามแก้ `infra/postgres/init/`

## 1.2 ✅ เตือนซ้ำเมื่อ alert ยังเกิดต่อเนื่อง — แก้แล้ว (2026-09-23)

HIGH/CRITICAL ที่ยัง OPEN แล้วเกิดซ้ำ ส่ง email อีกรอบได้ถี่สุดทุก `ALERT_RENOTIFY_MINUTES` (60)
· severity ขยับขึ้นเมื่อซ้ำด้วยตัวที่แรงกว่า (ML WARNING → CRITICAL ส่งทันที) · **email escape HTML แล้ว**
(เดิมผู้โจมตีฝัง HTML ผ่าน log message ลง email ได้) · รายละเอียด worklog 2026-09-23 หัวข้อ 6

**ยังไม่ได้เห็น email จริง** — SMTP ใน Vault ว่าง ถ้าจะยืนยันให้ครบ ตั้ง SMTP ทดสอบ (เช่น mailpit)
แล้วรัน `demo-brute-force.sh` ห่างกันเกิน 60 นาที

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

1. **dashboard rebuild แล้ว (2026-09-23) เหลือเปิดดูด้วยตา** — ต้อง login `admin-user` + OTP
   ของเจ้าของ · ดู Reports (คอลัมน์ Sealed, CSV มี `sealed`), tile "Sealed Batches" บน Dashboard,
   "Anchored on chain" บน Verify และหน้า **Alerts** (คอลัมน์ "Last seen" + badge `×3` ของ 5710)
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
| ยิง log ได้ 201 แต่ไม่มี alert แถวใหม่ | ดูสองชั้น: (1) `docker logs logchain-backend \| grep KafkaProducer` ว่าต่อ Kafka ติดไหม (2) มี alert OPEN ของ rule + host เดียวกันค้างอยู่ไหม — ถูกนับเป็น `occurrence_count` ของตัวเดิม (ตั้งใจ) |
| login `admin-user` ด้วยรหัสใน `.env` ไม่ผ่าน | realm import ครั้งเดียวตอน boot แรก และเจ้าของเปลี่ยนรหัส + ตั้ง OTP ไปแล้ว — ไม่ใช่ Keycloak พัง |
| `UPDATE logs ...` ใน psql ไม่มีผล | trigger `trg_logs_no_update` ต้อง `ALTER TABLE logs DISABLE TRIGGER` ก่อน (ดู `scripts/demo-tamper.sh`) |
| แก้ไฟล์ใน `infra/postgres/init/` แล้วไม่มีผล | รันเฉพาะตอน volume ว่าง — เปลี่ยน schema ให้เพิ่ม migration ใน `src/database/migrations/` (backend รันเองตอน boot) |
| rebuild consumer แล้วโค้ดไม่เปลี่ยน | `detection-consumer` ใช้ image ของ `detection-api` — ต้อง `docker compose build detection-api` |
| batch ค้าง `SEALED` ไม่ขึ้น `CONFIRMED` | ปกติถ้าไม่ได้ตั้ง blockchain — `anchorSealedBatches()` ตามไป anchor เองเมื่อ config ครบ |
| เทสต์ ethers กับ RPC ปลอมแล้ว call ที่สองได้ error เดิมโดยไม่ยิงจริง | ethers cache ผลของ request ที่เหมือนกัน 250ms (รวม reject) — เว้นช่วงในเทสต์ |

---

# ไฟล์อ้างอิง

| ไฟล์ | เกี่ยวตรงไหน |
|---|---|
| `docs/worklog/2026-09-22.md` | บันทึกเต็ม หัวข้อ 1–13 (11–13 = รอบล่าสุด) |
| `docs/worklog/2026-09-23.md` | งานข้อ 1.1 |
| `src/alerts/alerts.service.ts` | `createOrDedup` + `recordRepeat` (dedup · นับซ้ำ · ขยับ severity · เตือนซ้ำ) |
| `src/database/migrations/` | migration ของ schema (ตัวแรก = AlertsRuleDedup) |
| `detection/rules/security_rules.yaml` | rule 5710 / 5715 ที่ใช้ทดสอบข้อ 1.1 |
| `src/kafka/kafka-producer.service.ts:116` | จุดที่ log ถูกข้ามตอน Kafka ยังไม่พร้อม — ข้อ 2.1 |
| `detection/app/rules.py` | threshold ใช้ `time.time()` ตอนรับ — ต้องคิดถ้าทำ replay ข้อ 2.1 |
| `src/blockchain/blockchain.service.ts` | `sendStoreRoot()` จัดการ nonce เอง · บรรทัด 207 = ข้อ 3.2 |
| `src/logs/entities/batch.entity.ts` | `INTACT_STATUSES` — แหล่งเดียวของสูตร integrity |
| `scripts/vault-unlock.sh` | ปลด Vault lockout |
| `README.md` หัวข้อ Troubleshooting + Vault user lockout | เคสที่เจอบ่อยพร้อมคำสั่งแก้ |
