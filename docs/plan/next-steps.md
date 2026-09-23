# เริ่มงานต่อที่นี่ — LogChain

> **ไฟล์นี้คือจุดเริ่มของ session ถัดไป** (คนหรือ Claude Code) อ่านจบแล้วลงมือได้เลย ไม่ต้องสืบใหม่
>
> **เขียนเมื่อ:** 2026-09-23 · **HEAD:** `f66922b` (push แล้ว · CI เขียวครบทุก job)
> **บันทึกงานเต็ม:** `docs/worklog/2026-09-23.md` (หัวข้อ 1–10) · ของเมื่อวาน `docs/worklog/2026-09-22.md`

---

# สถานะระบบ ณ ตอนเขียน

- clone จาก GitHub แล้วรัน `./scripts/bootstrap.sh` รวดเดียวจบ — smoke test จาก GitHub จริงผ่าน 2 รอบ
- CI เขียวครบ 4 job (`CI` 3 job + `Security Scan`)
- stack บนเครื่องต่อ **Polygon Amoy จริง** batch จึงเป็น `CONFIRMED` ไม่ใช่ `SEALED`
- มี migration แล้ว 3 ตัว รันเองตอน backend boot:
  `AlertsRuleDedup` · `AlertsLastNotified` · `KafkaPendingLogs`

### คำสั่งที่ใช้บ่อย

```bash
# ยก stack (ต้องมี HOST_UID เสมอ ไม่งั้นไฟล์ของ vault เป็นของ root)
cd ~/Documents/logchain && HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose up -d

# rebuild ทีละตัวหลังแก้โค้ด
HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose build backend && \
  docker compose up -d --no-deps backend
#   detection-consumer ใช้ image ของ detection-api → build `detection-api` แทน
#   dashboard ชื่อ service คือ `cylis-dashboard`

# token ของ service account (ยิง /logs ได้ แต่อ่าน /alerts ไม่ได้ ต้องมี role analyst ขึ้นไป)
set -a; . ./.env; set +a
T=$(curl -sf -X POST "http://localhost:8080/realms/logchain/protocol/openid-connect/token" \
  -d grant_type=client_credentials -d client_id=log-ingestor \
  -d "client_secret=$LOGCHAIN_INGESTOR_SECRET" | jq -r .access_token)

docker exec logchain-postgres psql -U logchain -d logchain -c "select ..."

./scripts/demo-brute-force.sh "$T"     # ยิง 6 AUTH_FAILURE → rule 5710
./scripts/demo-tamper.sh "$ADMIN_TOK"  # แก้ข้อมูล → TAMPERED (กู้คืนด้วย arg `restore`)
./scripts/vault-unlock.sh              # ดู/ปลด Vault user lockout
```

### ชุดตรวจก่อน commit (ตรงกับที่ CI รัน)

```bash
npm run lint:ci   # ← สำคัญ: มีเพดาน warning 667 · `npm run lint` ไม่เช็คเพดาน
npm test
npm run build
npx jest --config test/jest-e2e.json    # ต้องมี stack รันอยู่

# e2e ทิ้ง batch ทดสอบไว้ใน DB — ลบทุกครั้ง ไม่งั้น integrity บน dashboard ตกจาก 100%
docker exec logchain-postgres psql -U logchain -d logchain \
  -c "delete from batches where status='UNVERIFIED' and tx_hash like '0xaaaaaaaa%'"
```

---

# งานค้าง เรียงตามลำดับที่ควรทำ

## 0. ✅ commit งาน 2.1 + kafka-python + blockchain retry — push แล้ว CI เขียว (2026-09-23)

`d26fb44` Kafka outbox · `5a8b184` kafka-python 3.0.11 · `f66922b` blockchain init retry

## 1. ✅ ตรวจหน้าเว็บด้วยตา — ปิดแล้ว (2026-09-23)

ครบทั้ง 4 หน้า (worklog หัวข้อ 12) · ระหว่างตรวจเจอบั๊ก blockchain init ลองครั้งเดียว
(RPC สะดุดตอน boot = batch ค้าง SEALED จน restart) → แก้ให้ลองใหม่แบบ backoff แล้ว
รหัส `admin-user` ตอนนี้ตรงกับ `.env` แล้ว (ยังต้องใช้ OTP ของเจ้าของ)

## 2. 🟢 `detection-consumer` — `Task is already done!` (แก้แล้ว รอยืนยันข้ามคืน)

เป็นบั๊กของ kafka-python 3.0.2 (task ที่จบแล้วถูกปลุกซ้ำ · library จับ exception เองก่อนรันโค้ดใด ๆ
= **ไม่ทำ message หาย/ไม่ commit ข้าม**) · upstream แก้ใน 3.0.3 (#3078) → pin เป็น **3.0.11** แล้ว
ทดสอบ brute-force ผ่าน (worklog หัวข้อ 11) · **เหลือแค่เช็คว่า error หายจริง** หลังรันไปสักพัก:

```bash
docker logs --since 12h logchain-detection-consumer 2>&1 | grep -c "Task is already done"   # ควรได้ 0
```

## 3. 🟢 P3 — ทำเมื่อว่าง

### 3.1 ✅ กัน ethers หลุด unhandled rejection — เสร็จแล้ว (2026-09-23)
`src/common/process/unhandled-rejection.ts` ติดใน `main.ts` ก่อน `NestFactory.create` · error ของ ethers
(มี `code` + `shortMessage`) → log ERROR + `logchain_unhandled_ethers_rejections_total{code}` แล้วไม่ตาย ·
อย่างอื่นโยนต่อให้ Node ตายเหมือนเดิม · ยังไม่มี Prometheus alert rule ในโปรเจกต์ — ถ้าจะทำ ให้เตือนเมื่อค่านี้ > 0

### 3.2 ✅ `storeRoot` แยก "รอ confirm ไม่ทัน" กับ "RPC timeout ระหว่างรอ" — เสร็จแล้ว (2026-09-23)
`isWaitDeadline()` ดู `shortMessage === 'wait for transaction timeout'` (ethers 6.17 `provider.js`) · log บอก
`not confirmed within Nms` หรือ `RPC timed out while waiting for the receipt (...)` · พฤติกรรมเหมือนเดิม
(คืน `confirmed:false` ให้ verify รอบถัดไปตาม) · **ถ้าอัปเกรด ethers ให้เช็คข้อความนี้** — เทสต์ใน
`blockchain.nonce.spec.ts` ใช้ ethers จริงจะแดงถ้าข้อความเปลี่ยน

### 3.3 ✅ ลบ `~/Documents/logchain-detection` แล้ว (2026-09-23)
ก่อนลบตรวจซ้ำ: โค้ดทุกไฟล์มีใน `detection/` หรือใน git history แล้ว · `data/` (1.8 GB ไม่อยู่ใน git)
ย้ายไปเก็บที่ **`~/Documents/logchain-data/`** — มี `GeoLite2-City.mmdb` (โหลดใหม่ต้องมีบัญชี MaxMind ·
mount ไป `/app/data/GeoLite2-City.mmdb` ถ้าอยากเปิด geo enrichment) + ชุดข้อมูล HDFS สำหรับ train DeepLog

### 3.4 ✅ detection กัน event ซ้ำด้วย `log_id` — เสร็จแล้ว (2026-09-23)
`detection/app/dedup.py` (`SeenIds` จำ 10,000 id ล่าสุดในหน่วยความจำ) · consumer ข้าม id ที่เคยเห็นก่อนเข้า
rule/DeepLog · metric `consumer_messages_total{status="duplicate"}` · **ข้อจำกัด:** restart consumer แล้วลืม
(ซ้ำจาก Kafka redeliver หลัง restart ยังหลุดได้) · เทสต์ Python รันใน CI job `detection` แล้ว

---

# ⛔ ห้ามทำ (ตัดสินใจไปแล้ว อย่าถกใหม่)

- **ห้ามรวม `logchain-contracts` เข้ามา** — backend ใช้ inline ABI ผูกกันผ่าน `CONTRACT_ADDRESS` สตริงเดียว
- **ห้ามเอา `SEALED` ไปนับรวมใน `batches.confirmed`** — `confirmed` = "anchor ขึ้น chain แล้ว" เท่านั้น
  (สูตร intact อยู่ที่ `INTACT_STATUSES` ใน `src/logs/entities/batch.entity.ts` ที่เดียว)
- **ห้ามกลับไปใช้ `ethers.NonceManager`** — crash ตอน RPC timeout + ทิ้งช่องว่าง nonce
  (`src/blockchain/blockchain.nonce.spec.ts` จะพัง 3 เคส)
- **ห้ามแก้ `infra/postgres/init/` เพื่อเปลี่ยน schema** — ไฟล์พวกนั้นรันเฉพาะตอน volume ว่าง
  DB ที่มีอยู่แล้วไม่ได้รับ → เพิ่ม migration ใน `src/database/migrations/` แล้วใส่ใน array
  `migrations` ของ `app.module.ts` (backend รันเองตอน boot)
- **ห้ามทำให้สอง compose stack อยู่พร้อมกัน** (ถอด `container_name`) — ชั่งแล้วไม่คุ้ม: ชื่อ container
  ในเอกสาร ~40 จุดใช้ไม่ได้ และยังชนพอร์ต 17 ตัว · กลับมาดูเมื่อต้องรัน CI ขนานเท่านั้น
- **ห้ามปิด Vault user lockout เป็น default** — control ตาม PCI DSS Req 8.3.4 · ใช้ `scripts/vault-unlock.sh`
- **ห้ามเดารหัส `admin-user` / ห้ามตั้ง TOTP แทนเจ้าของ** — brute force ล็อกที่ 5 ครั้ง
- **ห้าม override `KEYCLOAK_URL` เป็นชื่อ service** (เป็น issuer ต้องตรงกับ `iss` ในโทเคน) ·
  **ห้ามเปลี่ยน `NEXT_PUBLIC_*` เป็นชื่อ service** (inline ตอน build และรันบนเบราว์เซอร์นอก docker network)
- **ห้ามใช้ `${VAR:?...}` ใน `docker-compose.yml`** — compose error ทั้งไฟล์
- **ห้าม `docker compose down -v`** ตอนทดสอบ ถ้ายังอยากได้ข้อมูล demo เดิม

---

# กับดักที่เสียเวลาที่สุด (อ่านก่อนเริ่ม debug)

| อาการ | ที่จริงคือ |
|---|---|
| lint ผ่านในเครื่องแต่ CI แดง | `npm run lint` มี `--fix` และไม่ดูเพดาน — ต้องรัน **`npm run lint:ci`** (`--max-warnings 667`) |
| ยิง log ได้ 201 แต่ไม่มี alert แถวใหม่ | (1) `select count(*) from kafka_pending_logs` — ค้างคิวเพราะ Kafka ล่มไหม (2) มี alert OPEN ของ rule + host เดียวกันอยู่ไหม — ถูกนับเป็น `occurrence_count` ของตัวเดิม (ตั้งใจ) |
| rule แบบ threshold ไม่เด้งทั้งที่ยิง log ครบ | rule นับหน้าต่างเวลาจาก **`createdAt` ของ event** ไม่ใช่เวลาที่รับ — ยิงห่างกันเกิน 60 วิ ก็ไม่เข้าเกณฑ์ (ตั้งใจ ดู `detection/app/rules.py::_event_time`) |
| login `admin-user` ด้วยรหัสใน `.env` ไม่ผ่าน | 2026-09-23 ตั้งให้ตรงกันแล้ว · ถ้าไม่ผ่านอีก = มีคนเปลี่ยนรหัสผ่านหน้าเว็บ · realm policy ต้องมีตัวเลข + ห้ามซ้ำ 4 ตัวล่าสุด · ต้องใช้ OTP |
| approle login ตอบ `permission denied` | Vault user lockout — `./scripts/vault-unlock.sh` |
| `UPDATE logs ...` ใน psql ไม่มีผล | trigger `trg_logs_no_update` — ต้อง `ALTER TABLE logs DISABLE TRIGGER` ก่อน (ดู `scripts/demo-tamper.sh`) |
| rebuild consumer แล้วโค้ดไม่เปลี่ยน | `detection-consumer` ใช้ image ของ `detection-api` — build service นั้นแทน |
| batch ค้าง `SEALED` ไม่ขึ้น `CONFIRMED` | ปกติถ้าไม่ได้ตั้ง blockchain — `anchorSealedBatches()` ตามไป anchor เองเมื่อ config ครบ · ถ้าตั้งแล้ว ดู log `Blockchain init failed (attempt N)` — ลองใหม่เองทุก ≤5 นาที |
| เทสต์ ethers กับ RPC ปลอมแล้ว call ที่สองได้ error เดิมโดยไม่ยิงจริง | ethers cache ผลของ request ที่เหมือนกัน 250ms (รวม reject) — เว้นช่วงในเทสต์ |
| รัน e2e ในเครื่องแล้ว integrity ตกจาก 100% | e2e ทิ้ง batch UNVERIFIED (`tx_hash` ขึ้นต้น `0xaaaa…`) — ลบทิ้งหลังรัน |

---

# ไฟล์อ้างอิง

| ไฟล์ | เกี่ยวตรงไหน |
|---|---|
| `docs/worklog/2026-09-23.md` | งานล่าสุด: alert dedup · เตือนซ้ำ · smoke test 2 รอบ · CI · Kafka outbox |
| `docs/worklog/2026-09-22.md` | onboarding · seal/anchor · NonceManager crash · P3 |
| `src/kafka/kafka-producer.service.ts` | producer + outbox/replay (`enqueue` · `drainPending`) |
| `src/kafka/entities/pending-log.entity.ts` | ตาราง `kafka_pending_logs` |
| `src/alerts/alerts.service.ts` | dedup ตาม rule · นับซ้ำ · ขยับ severity · เตือนซ้ำ |
| `src/database/migrations/` | migration ของ schema ทั้งหมด (3 ตัว) |
| `src/blockchain/blockchain.service.ts` | `sendStoreRoot()` จัดการ nonce เอง (ห้ามกลับไปใช้ NonceManager) |
| `src/logs/entities/batch.entity.ts` | `INTACT_STATUSES` — แหล่งเดียวของสูตร integrity |
| `detection/app/rules.py` | rule engine + `_event_time()` |
| `.github/workflows/ci.yml` | CI 3 job — ขั้น Seed Vault อ่าน AppRole จาก `infra/vault/.secrets/approle.env` |
| `scripts/vault-unlock.sh` | ปลด Vault lockout |
| `README.md` Troubleshooting + Vault user lockout | เคสที่เจอบ่อยพร้อมคำสั่งแก้ |
