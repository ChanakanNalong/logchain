# เริ่มงานต่อที่นี่ — LogChain

> **ไฟล์นี้คือจุดเริ่มของ session ถัดไป** (คนหรือ Claude Code) อ่านจบแล้วลงมือได้เลย ไม่ต้องสืบใหม่
>
> **เขียนเมื่อ:** 2026-09-23 (อัปเดตท้ายวัน) · **HEAD:** `1bba91b` (push แล้ว · CI เขียวครบ 5 job + Security Scan)
> **บันทึกงานเต็ม:** `docs/worklog/2026-09-23.md` (หัวข้อ 1–33) · ของเมื่อวาน `docs/worklog/2026-09-22.md`

---

# สถานะระบบ ณ ตอนเขียน

- clone จาก GitHub แล้วรัน `./scripts/bootstrap.sh` รวดเดียวจบ — smoke test จาก GitHub จริงผ่าน 2 รอบ
- CI 5 job: Backend · Dashboard · **Detection (Python unittest)** · **Prometheus (promtool)** · Integration
  + `Security Scan` แยก workflow
- stack บนเครื่องต่อ **Polygon Amoy จริง** (contract `0x5dC86975…` — ตัวเก่า `0xE2502FC1…` เลิกใช้ตั้งแต่ 09-17)
  batch จึงเป็น `CONFIRMED` ไม่ใช่ `SEALED`
- Prometheus มี alert rule 13 ตัว (`infra/prometheus/alerts.yml` · worklog หัวข้อ 19, 25, 26 — รวม batch ค้าง UNVERIFIED/PENDING) → Alertmanager `:9093` → **email (Gmail) ใช้งานได้แล้ว** (ทดสอบเด้งจริงทั้งสาย worklog หัวข้อ 27)
- งานในแผนเดิมปิดครบ · backup ในเครื่อง + Google Drive (ทดสอบกู้คืนแล้ว) · **ข้อ 6 ใหม่: ช่องว่าง compliance จากการทบทวน**
- มี migration แล้ว 4 ตัว รันเองตอน backend boot:
  `AlertsRuleDedup` · `AlertsLastNotified` · `KafkaPendingLogs` · `ErasureLog`

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
# ฝั่ง detection (ต้องมี PyYAML — หรือรันใน image ของ detection)
docker run --rm -v $PWD/detection:/w -w /w --entrypoint python logchain-detection:dev \
  -m unittest discover -s tests -t . -v
# alert rule
docker run --rm -v $PWD/infra/prometheus:/p:ro -w /p --entrypoint promtool \
  prom/prometheus:v2.55.0 test rules alerts.test.yml

# e2e ทิ้ง batch ทดสอบไว้ใน DB — ลบทุกครั้ง ไม่งั้น integrity บน dashboard ตกจาก 100%
docker exec logchain-postgres psql -U logchain -d logchain \
  -c "delete from batches where status='UNVERIFIED' and tx_hash like '0xaaaaaaaa%'"
```

---

# งานค้าง เรียงตามลำดับที่ควรทำ

## 0. ✅ commit ทุกอย่างของ 2026-09-23 — push แล้ว CI เขียว

`d26fb44` Kafka outbox → … → `3d15107` Prometheus scrape ซ้ำ · git ในเครื่องสะอาด

## 1. ✅ ตรวจหน้าเว็บด้วยตา — ปิดแล้ว (2026-09-23)

ครบทั้ง 4 หน้า (worklog หัวข้อ 12) · ระหว่างตรวจเจอบั๊ก blockchain init ลองครั้งเดียว
(RPC สะดุดตอน boot = batch ค้าง SEALED จน restart) → แก้ให้ลองใหม่แบบ backoff แล้ว
รหัส `admin-user` ตอนนี้ตรงกับ `.env` แล้ว (ยังต้องใช้ OTP ของเจ้าของ)

## 2. ✅ `detection-consumer` — `Task is already done!` — ปิดแล้ว (2026-09-23)

บั๊กของ kafka-python 3.0.2 (ไม่ทำ message หาย) · pin **3.0.11** แล้ว (upstream แก้ใน 3.0.3 #3078)
หลักฐาน (worklog หัวข้อ 11 + 23): รันเงียบ 1 ชม. 42 นาที = 0 ครั้ง (เดิม ~1–2 ครั้ง/ชม.) · จำลองเหตุที่เคยทำให้เกิดบ่อย
(restart broker ที่เป็น coordinator — kafka-3 → kafka-1) = 0 ครั้ง · consumer กลับมา Stable ประมวลผลต่อ lag 0
ถ้าวันหลังเจออีก: `docker logs --since 24h logchain-detection-consumer 2>&1 | grep -c "Task is already done"`
แล้วดู traceback ว่ามาจาก `kafka/net/selector.py` แบบเดิมไหม

## 3. ✅ P3 — เสร็จครบทุกข้อ (2026-09-23)

### 3.1 ✅ กัน ethers หลุด unhandled rejection — เสร็จแล้ว (2026-09-23)
`src/common/process/unhandled-rejection.ts` ติดใน `main.ts` ก่อน `NestFactory.create` · error ของ ethers
(มี `code` + `shortMessage`) → log ERROR + `logchain_unhandled_ethers_rejections_total{code}` แล้วไม่ตาย ·
อย่างอื่นโยนต่อให้ Node ตายเหมือนเดิม · alert rule `UnhandledEthersRejection` ใน `infra/prometheus/alerts.yml` (worklog หัวข้อ 19 · ยังไม่มี Alertmanager ดูที่ :9090/alerts)

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
rule/DeepLog · metric `consumer_messages_total{status="duplicate"}` · restart แล้วลืม **โดยตั้งใจ**
(ลืมพร้อม state อื่นของ detection — ดู "ห้ามทำ") · เทสต์ Python รันใน CI job `detection` แล้ว

### 3.5 ✅ RPC error อื่นระหว่างรอ receipt → UNVERIFIED ไม่ใช่ FAILED (2026-09-23)
เดิมเฉพาะ TIMEOUT ที่นับเป็น "ยังไม่รู้ผล" · ตอนนี้ error ของ ethers ทุกตัวยกเว้น `CALL_EXCEPTION` /
`TRANSACTION_REPLACED` คืน `confirmed:false` · error ที่ไม่ใช่ของ ethers ยังโยนต่อ (worklog หัวข้อ 18)

## 4. ✅ งานต่อยอดจาก 2026-09-23 — ปิดครบ

### 4.1 ✅ Alertmanager — ส่ง email ได้จริงแล้ว (2026-09-23)
service `alertmanager` (`:9093`) · Prometheus ส่ง alert เข้าแล้ว · `infra/alertmanager/render.sh` สร้าง config
ตอน start: ยังไม่ตั้งอีเมล = receiver `none` (รับไว้ไม่ส่ง) · ตั้งครบ = email · รหัสอยู่ใน
`infra/alertmanager/.secrets/smtp_password` (gitignored) · วิธีตั้ง: README หัวข้อ "Alert แจ้งทาง email"
CI job `prometheus` ตรวจ config ทั้งสองแบบด้วย `amtool` (worklog หัวข้อ 22)
เจ้าของตั้ง Gmail app password แล้ว ทดสอบ alert → ได้ email จริง · `alertmanager_notifications_total{integration="email"}` = 1 ล้มเหลว 0 (หัวข้อ 24)

### 4.2 ⛔ detection จำ id ที่เห็นแล้วข้าม restart — ตัดสินใจไม่ทำ (2026-09-23)
เหตุผลอยู่ในหมวด "ห้ามทำ" ด้านล่าง · รายละเอียด worklog หัวข้อ 21

### 4.3 ✅ `INTEGRITY_AUTO_REANCHOR` คง `false` เป็นค่าเริ่มต้น — ตัดสินใจแล้ว (2026-09-23)
เจ้าของเลือกคงไว้ · เหตุผลเขียนใน `.env.example` + README Troubleshooting (batch ค้าง UNVERIFIED เป็นชั่วโมง)
เครื่องนี้ยังเป็น `true` ตามเดิม


## 5. ✅ backup อัตโนมัติของ Postgres — เสร็จ (2026-09-23)

service `postgres-backup` (`infra/postgres-backup/backup.sh`) · วันละครั้ง → `./backups/postgres/<UTC>/` (globals + logchain +
keycloak · 0600 · gitignored · เก็บ 7 ชุด) · alert `PostgresBackupStale` / `Failing` / `Missing` ผ่าน node-exporter textfile ·
**กู้จากไฟล์ที่ job สร้างจริงผ่านแล้ว** (worklog หัวข้อ 29) · สั่งเพิ่ม: `docker exec logchain-postgres-backup sh /backup.sh once`

### 5.1 ✅ สำเนา backup บน Google Drive — ใช้งานจริงแล้ว (2026-09-23)
service `backup-offsite` · rclone crypt → `gdrive:logchain-backups` ทุกชั่วโมง · cryptcheck · เก็บ 30 วัน · alert Offsite* ·
ตั้งด้วย `./scripts/setup-offsite-backup.sh` · **ทดสอบดึงกลับจาก Drive + restore ครบทั้งสายแล้ว** (worklog หัวข้อ 31)
config + token: `infra/rclone/.secrets/rclone.conf` (gitignored) · password ของ crypt อยู่กับเจ้าของ (password manager)
ถ้า token หมดอายุ / ถูกถอนสิทธิ์ → `OffsiteBackupFailing` → รัน script ใหม่ (reconnect เอง password crypt ไม่เปลี่ยน)


## 6. 🟡 ทำระบบให้ตรงเอกสาร compliance — จากการทบทวน 2026-09-23

รายงานเต็ม + หลักฐาน: `docs/compliance-review-2026-09-23.md` · เอกสารต้นฉบับแก้ให้ตรงความจริงแล้ว (PASS ที่ไม่จริง →
PARTIAL / FAIL / N/A) · บั๊ก PDPA erasure (A1) แก้แล้ว · ที่เหลือคือทำให้ระบบผ่าน เรียงตามความคุ้ม:

| # | เรื่อง | review | ขนาดงาน |
|---|---|---|---|
| 6.1 ✅ | port ทั้ง 19 ตัว bind `${PUBLISH_ADDR:-127.0.0.1}` — ทดสอบจาก IP LAN ปิดหมด · pipeline ทำงานปกติ (worklog หัวข้อ 33) | B15 | เสร็จ 2026-09-23 |
| 6.2 | ใส่ Gmail app password ลง Vault `secret/logchain/notification` เปิด email ของ security alert | B11 | เล็ก — เจ้าของใส่รหัสเอง |
| 6.3 | เปิด Kafka mTLS ใน compose (`KAFKA_SSL_ENABLED=true` + listener 39092) | B3 | กลาง — cert มีแล้ว |
| 6.4 | dashboard + kafka-exporter รันเป็น non-root | B8 | เล็ก–กลาง |
| 6.5 | pip audit ใน CI · ให้ npm audit / Trivy vuln block ที่ HIGH+ | B7 B6 | เล็ก แต่อาจเจอ vuln ค้างต้องไล่แก้ |
| 6.6 | HTTPS หน้า backend / dashboard / Keycloak (reverse proxy + cert) | B2 | ใหญ่ — กระทบ Keycloak issuer + `NEXT_PUBLIC_*` |
| 6.7 | encryption at rest (เข้ารหัสดิสก์ / volume) | B1 | ใหญ่ — ระดับเครื่อง ไม่ใช่โปรเจกต์ |
| 6.8 | erasure ลบ `audit_access` ขัด PCI 10.5.1 (เก็บ audit ≥ 12 เดือน)? — พิจารณา pseudonymize แทนลบ | B10 | ต้องตัดสินใจก่อน |

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
- **ห้ามเก็บ `SeenIds` (id ที่ detection เห็นแล้ว) ไว้ถาวรแยกจาก state อื่น** — state ของ rule engine
  (`_event_history`) และ buffer ของ DeepLog อยู่ในหน่วยความจำ restart แล้วหายพร้อมกัน ถ้า id รอดแต่ประวัติหาย
  message ที่ Kafka redeliver หลัง crash จะถูกข้าม → threshold นับขาด → **5710 ไม่เด้งทั้งที่ brute force จริง**
  ของเดิม (ลืมพร้อมกันหมด) นับถูก ผลเสียเหลือแค่ alert ซ้ำ 1 ครั้ง ซึ่ง backend รวมเป็น `occurrence_count` อยู่แล้ว
  · ถ้าจะทำต้องเก็บ **ครบชุด** (id + `_event_history` + `_prior_matches` + DeepLog buffers) และ detection ต้องได้
  สิทธิ์ DB (ตอนนี้ไม่มี — ขยาย PCI scope) · ตัดสินใจ 2026-09-23

---

# กับดักที่เสียเวลาที่สุด (อ่านก่อนเริ่ม debug)

| อาการ | ที่จริงคือ |
|---|---|
| lint ผ่านในเครื่องแต่ CI แดง | `npm run lint` มี `--fix` และไม่ดูเพดาน — ต้องรัน **`npm run lint:ci`** (`--max-warnings 667`) |
| เครื่องอื่นใน LAN เข้า service ไม่ได้ (log source ข้ามเครื่อง ฯลฯ) | ตั้งใจ — port bind `127.0.0.1` · ตั้ง `PUBLISH_ADDR=0.0.0.0` ใน `.env` แล้ว `docker compose up -d` (เปิดทุก port) |
| ยิง log ได้ 201 แต่ไม่มี alert แถวใหม่ | (1) `select count(*) from kafka_pending_logs` — ค้างคิวเพราะ Kafka ล่มไหม (2) มี alert OPEN ของ rule + host เดียวกันอยู่ไหม — ถูกนับเป็น `occurrence_count` ของตัวเดิม (ตั้งใจ) |
| rule แบบ threshold ไม่เด้งทั้งที่ยิง log ครบ | rule นับหน้าต่างเวลาจาก **`createdAt` ของ event** ไม่ใช่เวลาที่รับ — ยิงห่างกันเกิน 60 วิ ก็ไม่เข้าเกณฑ์ (ตั้งใจ ดู `detection/app/rules.py::_event_time`) |
| login `admin-user` ด้วยรหัสใน `.env` ไม่ผ่าน | 2026-09-23 ตั้งให้ตรงกันแล้ว · ถ้าไม่ผ่านอีก = มีคนเปลี่ยนรหัสผ่านหน้าเว็บ · realm policy ต้องมีตัวเลข + ห้ามซ้ำ 4 ตัวล่าสุด · ต้องใช้ OTP |
| approle login ตอบ `permission denied` | Vault user lockout — `./scripts/vault-unlock.sh` |
| `UPDATE logs ...` ใน psql ไม่มีผล | trigger `trg_logs_no_update` — ต้อง `ALTER TABLE logs DISABLE TRIGGER` ก่อน (ดู `scripts/demo-tamper.sh`) |
| rebuild consumer แล้วโค้ดไม่เปลี่ยน | `detection-consumer` ใช้ image ของ `detection-api` — build service นั้นแทน |
| batch ค้าง `SEALED` ไม่ขึ้น `CONFIRMED` | ปกติถ้าไม่ได้ตั้ง blockchain — `anchorSealedBatches()` ตามไป anchor เองเมื่อ config ครบ · ถ้าตั้งแล้ว ดู log `Blockchain init failed (attempt N)` — ลองใหม่เองทุก ≤5 นาที |
| เทสต์ ethers กับ RPC ปลอมแล้ว call ที่สองได้ error เดิมโดยไม่ยิงจริง | ethers cache ผลของ request ที่เหมือนกัน 250ms (รวม reject) — เว้นช่วงในเทสต์ |
| รัน e2e ในเครื่องแล้ว integrity ตกจาก 100% | e2e ทิ้ง batch UNVERIFIED (`tx_hash` ขึ้นต้น `0xaaaa…`) — ลบทิ้งหลังรัน · ลืมลบ 30 นาทีจะได้ email `BatchStuckUnverified` |
| รันแอปบน host (`npm run start:dev`) แล้ว Prometheus/Grafana ไม่มีข้อมูล | target ชี้ชื่อ service ใน compose อย่างเดียว — เปลี่ยน target ของ job นั้นเป็น `host.docker.internal:<port>` แล้ว `curl -X POST localhost:9090/-/reload` (อย่าใส่คู่กัน = scrape ซ้ำ worklog หัวข้อ 20) |
| `setup-offsite-backup.sh` ขึ้น `access_denied` / 403 insufficient scopes | หน้า Google hasn't verified → Advanced → Go to rclone · คำถาม Shared Drive ตอบ `n` (worklog หัวข้อ 31) |
| alert ขึ้นใน `:9090/alerts` แต่ไม่มีใครได้ email | `docker logs logchain-alertmanager | head -1` — ถ้าขึ้น "ยังไม่ได้ตั้งอีเมล" ดู README หัวข้อ Alert แจ้งทาง email · แก้ `.env`/ไฟล์รหัสแล้วต้อง `--force-recreate alertmanager` |

---

# ไฟล์อ้างอิง

| ไฟล์ | เกี่ยวตรงไหน |
|---|---|
| `docs/worklog/2026-09-23.md` | งานล่าสุด (หัวข้อ 1–20): alert dedup · Kafka outbox · kafka-python · blockchain retry/timeout · ethers guard · detection dedup · Prometheus alert · README contract |
| `docs/worklog/2026-09-22.md` | onboarding · seal/anchor · NonceManager crash · P3 |
| `src/kafka/kafka-producer.service.ts` | producer + outbox/replay (`enqueue` · `drainPending`) |
| `src/kafka/entities/pending-log.entity.ts` | ตาราง `kafka_pending_logs` |
| `src/alerts/alerts.service.ts` | dedup ตาม rule · นับซ้ำ · ขยับ severity · เตือนซ้ำ |
| `src/database/migrations/` | migration ของ schema ทั้งหมด (4 ตัว) |
| `docs/compliance-review-2026-09-23.md` | ผลทบทวนเอกสาร compliance + หลักฐาน (ข้อ 6) |
| `src/blockchain/blockchain.service.ts` | `sendStoreRoot()` จัดการ nonce เอง (ห้ามกลับไปใช้ NonceManager) |
| `src/logs/entities/batch.entity.ts` | `INTACT_STATUSES` — แหล่งเดียวของสูตร integrity |
| `detection/app/rules.py` | rule engine + `_event_time()` |
| `detection/app/dedup.py` | `SeenIds` กัน event ซ้ำ (เทสต์ `detection/tests/`) |
| `src/common/process/unhandled-rejection.ts` | guard ethers unhandled rejection + metric |
| `infra/postgres-backup/backup.sh` | backup อัตโนมัติ (service `postgres-backup`) |
| `infra/backup-offsite/offsite.sh` | สำเนา backup ขึ้น cloud (rclone crypt · service `backup-offsite`) |
| `infra/prometheus/alerts.yml` | alert rule 13 ตัว (เทสต์ `alerts.test.yml` — เพิ่ม rule ต้องเพิ่มเทสต์ CI รัน promtool) |
| `.github/workflows/ci.yml` | CI 5 job — ขั้น Seed Vault อ่าน AppRole จาก `infra/vault/.secrets/approle.env` |
| `scripts/vault-unlock.sh` | ปลด Vault lockout |
| `README.md` Troubleshooting + Vault user lockout | เคสที่เจอบ่อยพร้อมคำสั่งแก้ |
