# เริ่มงานต่อที่นี่ — LogChain

> **รายการงานที่เหลือแบบย่อ:** [`todo.md`](todo.md) · **สรุปงานที่ทำ:** [`../summary-2026-09-17-to-09-25.md`](../summary-2026-09-17-to-09-25.md)
>
> **ไฟล์นี้คือจุดเริ่มของ session ถัดไป** (คนหรือ Claude Code) อ่านจบแล้วลงมือได้เลย ไม่ต้องสืบใหม่
>
> **เขียนเมื่อ:** 2026-09-29 (หลังเที่ยงคืน) · **HEAD:** `9d96376` · งานล่าสุด: `docs/worklog/2026-09-29.md`
> (กรณีทดสอบ "รอผล" ในเล่มครบ · แก้บั๊ก seal พร้อมกัน · เอา Isolation Forest ออกจากเล่ม · DeepLog หลาย seed + เลือก g)
>
> **▶ งานถัดไป (เรียงตามนี้):**
> 1. ข้อ 3–5 ของแผนส่งเล่ม: **(3) ✅ ทดสอบเจาะจาก LAN เสร็จ** (worklog 09-29 หัวข้อ 7 · เหลือกรอกผลลงเล่ม/ตาราง 5-10 · เจอ host เปิด MySQL :3306 ให้ LAN) · **(4)** ตรวจเล่มทั้งเล่มเทียบกับระบบจริง · **(5)** อัปเดตภาคผนวก `~/Documents/thesis-appendix/` (ล่าสุด 09-13)
>    — แก้เล่มที่ `~/Documents/final_volume/…-ฉบับสะอาด.docx` และทำ `…-ไฮไลต์จุดแก้.docx` คู่กัน (ไฮไลต์เขียว) · แก้ XML ตรง (สคริปต์ตัวอย่าง `~/Documents/logchain-data/tools/edit_book2.py`)
>    · **ห้าม save / export เล่มจาก LibreOffice** (caption ทั้งเล่มพัง)
> 2. เติม POL ให้ `0x8cBCfC04…4C55` — gas Amoy 155 gwei = 0.012 POL/batch · เหลือ 0.0949
> 3. ตัดสินใจเปิด rate limit (`ThrottlerGuard` ไม่ได้ลงทะเบียน — worklog 09-29 หัวข้อ 3)
> 4. **จะทำ Isolation Forest** (เจ้าของตัดสินใจ 2026-09-29) → กลับเป็นตรวจจับ 3 ระดับ · ขอบเขต + ผลกระทบต่อเล่ม → [`isolation-forest-option.md`](isolation-forest-option.md)
>
> **บันทึกงานเต็ม:** `docs/worklog/2026-09-29.md` (กรณีทดสอบ · IM-12 · PT-07 · เล่ม) · `docs/worklog/2026-09-28.md` (clone · CA · DeepLog) · `docs/worklog/2026-09-25.md` (LUKS2) · `docs/worklog/2026-09-24.md` (6.8 pseudonymize) · `docs/worklog/2026-09-23.md` (หัวข้อ 1–39) · `docs/worklog/2026-09-22.md`

---

# สถานะระบบ ณ ตอนเขียน

- clone จาก GitHub แล้วรัน `./scripts/bootstrap.sh` รวดเดียวจบ — smoke test จาก GitHub จริงผ่าน 2 รอบ
- CI 5 job: Backend · Dashboard · **Detection (Python unittest)** · **Prometheus (promtool)** · Integration
  + `Security Scan` แยก workflow
- stack บนเครื่องต่อ **Polygon Amoy จริง** (contract `0x5dC86975…` — ตัวเก่า `0xE2502FC1…` เลิกใช้ตั้งแต่ 09-17)
  batch จึงเป็น `CONFIRMED` ไม่ใช่ `SEALED`
- Prometheus มี alert rule 13 ตัว (`infra/prometheus/alerts.yml` · worklog หัวข้อ 19, 25, 26 — รวม batch ค้าง UNVERIFIED/PENDING) → Alertmanager `:9093` → **email (Gmail) ใช้งานได้แล้ว** (ทดสอบเด้งจริงทั้งสาย worklog หัวข้อ 27)
- งานในแผนเดิมปิดครบ · backup ในเครื่อง + Google Drive (ทดสอบกู้คืนแล้ว) · **ข้อ 6 (ช่องว่าง compliance) ปิดครบ 6.1–6.8**
- **ข้อมูลทั้งหมดอยู่บนดิสก์เข้ารหัส** (2026-09-25): repo จริงอยู่ `/srv/lcsecure/home/logchain` (`~/Documents/logchain` = symlink) ·
  Docker data-root `/srv/lcsecure/docker` · boot แล้วต้องใส่ PIN ของ `lcsecure` ไม่งั้น Docker ไม่ขึ้น
- **DeepLog = 45 log key** (`NUM_CLASSES = 46` ใน `deeplog.py` · `detect.py` · `app/model.py`) · F1 ที่ g=8 **0.7252 ± 0.0181** (5 seed · 47 key เดิม 0.7185 ± 0.0201 — ไม่ต่างอย่างมีนัยสำคัญ)
  · **ตัวเลขนี้รวมกฎ "block สั้นกว่า 11 = anomaly"** (36.8% ของ anomaly · ไม่มี normal สั้น) — เฉพาะโมเดล **0.4900 ± 0.0397** (worklog 09-28 หัวข้อ 11)
  · consumer แปลง log → key ด้วย template ใน `detection/data/drain_state.json` ชุดเดียวกับตอน train (`app/log_keys.py` — ไม่สร้าง Drain ตอนรัน)
  · log ที่ไม่ตรง template (ไม่ใช่ HDFS) ข้าม ML ไป rule engine อย่างเดียว (`consumer_messages_total{status="ml_skipped_unknown"}`)
- **CA ของ HTTPS ต่อชื่อ compose project** (`LogChain-Web-CA (<project>)` · 2026-09-28) — clone คนละ project trust พร้อมกันได้
  · CA ของชุดจริงสร้างก่อนนั้นจึงยังชื่อ `LogChain-Web-CA` เฉย ๆ (ไม่ต้องทำอะไร)
- มี migration แล้ว 7 ตัว รันเองตอน backend boot:
  `AlertsRuleDedup` · `AlertsLastNotified` · `KafkaPendingLogs` · `ErasureLog` · `ErasurePseudonymize` · `AlertsSourceLength` · `BatchIsoForest`

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


## 6. ✅ ทำระบบให้ตรงเอกสาร compliance — จากการทบทวน 2026-09-23

รายงานเต็ม + หลักฐาน: `docs/compliance-review-2026-09-23.md` · เอกสารต้นฉบับแก้ให้ตรงความจริงแล้ว (PASS ที่ไม่จริง →
PARTIAL / FAIL / N/A) · บั๊ก PDPA erasure (A1) แก้แล้ว · ที่เหลือคือทำให้ระบบผ่าน เรียงตามความคุ้ม:

| # | เรื่อง | review | ขนาดงาน |
|---|---|---|---|
| 6.1 ✅ | port ทั้ง 19 ตัว bind `${PUBLISH_ADDR:-127.0.0.1}` — ทดสอบจาก IP LAN ปิดหมด · pipeline ทำงานปกติ (worklog หัวข้อ 33) | B15 | เสร็จ 2026-09-23 |
| 6.2 ✅ | email ของ security alert เปิดแล้ว (`scripts/setup-alert-email.sh` → `.env` `MAIL_*` → vault-init) · ทดสอบส่งจริง (worklog หัวข้อ 34) | B11 | เสร็จ 2026-09-23 |
| 6.3 ✅ | Kafka mTLS เปิดแล้ว — listener `DOCKER_SSL` `kafka-N:9094` · backend + detection ใช้ client cert · ทดสอบครบทั้งสาย + ปฏิเสธ client ไม่มี cert (worklog หัวข้อ 35) | B3 | เสร็จ 2026-09-23 |
| 6.4 ✅ | dashboard (`USER node` + `COPY --chown`) · kafka-exporter (`user: 65534`) · ทุก service รัน process หลักเป็น non-root ยกเว้น vault-unseal/init (ตั้งใจ — worklog หัวข้อ 36) | B8 | เสร็จ 2026-09-24 |
| 6.5 ✅ | npm audit + Trivy vuln + pip-audit block ที่ HIGH+ · torch 2.12 → 2.13 (CVE-2025-3000) · pip/setuptools ใน image (worklog หัวข้อ 37) | B7 | เสร็จ 2026-09-24 |
| 6.6 ✅ | HTTPS ผ่าน Caddy — dashboard `https://localhost:3453` · backend `:3443` · Keycloak `:8443` (= issuer) · HTTP เดิม bind 127.0.0.1 เสมอ (worklog 2026-09-24 หัวข้อ 11) · เจ้าของ trust CA + login + OTP ผ่านเบราว์เซอร์แล้ว | B2 | เสร็จ 2026-09-24 |
| 6.7 ✅ | encryption at rest — LUKS2 + TPM2/PIN ที่ `/srv/lcsecure` (Docker data-root + repo) · reboot ผ่าน · `./scripts/check-encryption-at-rest.sh` ผ่าน · PCI 3.1 → PASS (E12) · ลบ `docker.old` + ปิด swap แล้ว (worklog 2026-09-25) | B1 | เสร็จ 2026-09-25 |
| 6.8 ✅ | erasure **pseudonymize** แทนลบ (เจ้าของเลือกทาง B) — HMAC key ใน Vault `secret/logchain/erasure` · + retention บังคับเก็บ audit ≥ 365 วัน (เดิมลบที่ 90) (worklog 2026-09-24 หัวข้อ 1) | B10 | เสร็จ 2026-09-24 |

## 7. งานค้างจาก 2026-09-28 (worklog `2026-09-28.md`)

### 7.1 ✅ commit detection ที่ระบบรันอยู่แล้ว — `979aa3d`

`detection/app/consumer.py` · `detection/app/log_keys.py` · `detection/tests/test_log_keys.py` — ข้าม ML เมื่อ key 0 (หัวข้อ 7)
+ `mask()` รับรูปที่ backend PII-mask แล้ว (`.xxx` · `blk_-[PAN]` — หัวข้อ 8) · image บนเครื่อง rebuild แล้ว · ทดสอบบนระบบจริงผ่าน (หัวข้อ 9)
· image บนเครื่องตรงกับ git แล้ว

### 7.2 ⬜ ตัวเลขสำหรับรายงาน

- log key: **45** (โค้ดปัจจุบัน `parse_logs.py`) เทียบ Loghub **29** (`HDFS_v1.zip` preprocessed · สำเนาที่ `~/Documents/logchain-data/HDFS.log_templates.csv`)
  — ไฟล์บน GitHub ของ Loghub มี 30 (E30 ไม่มีใน trace) · 45 = 29 + 17 (Drain แยก exception) − 1 (E8 + E11 รวม)
- ✅ train 5 seed แล้ว (worklog หัวข้อ 10): g=8 F1 45 key **0.7252 ± 0.0181** · 47 key 0.7185 ± 0.0201 · Welch p ≈ 0.6
  → **ไม่ต่างกันอย่างมีนัยสำคัญ** · 0.7339 เดิมเป็น seed 42 รอบเดียวที่ฟลุค · รายงานเขียนว่า "ประสิทธิภาพไม่ลดลง" ห้ามเขียนว่าแม่นขึ้น
- ✅ block สั้น (worklog หัวข้อ 11): `detect.py` นับ sequence < 11 key เป็น anomaly โดยไม่ผ่านโมเดล · test abnormal 6,191 / 16,838 สั้น · normal 0
  → 0.725 **รวมกฎความยาว** · ตัด block สั้นออก (เฉพาะโมเดล) F1 **0.4900 ± 0.0397** (P 0.9230 · R 0.3344) · consumer ตอนรันจริงไม่มีกฎนี้
  · **รายงานต้องใส่ทั้งสองตัวเลข** · recall ต่ำกว่า DeepLog ต้นฉบับ (~0.96) มาก — สงสัย input เป็น `float` แทน embedding (ยังไม่ทดสอบ)
  · embedding **ไม่ช่วย** (worklog หัวข้อ 13) — recall ต่ำเพราะ **g=8 ใหญ่เกิน** (`detect.py` ลองแค่ 8–10)
- ✅ เลือก g จาก validation 20% · รายงานบน 80% (worklog หัวข้อ 13 · `select_g.py`): g=4 เกือบทุก seed ·
  model-only F1 **0.7746 ± 0.0575** · with-short **0.8587 ± 0.0328** · FP 0.50% ของ block ปกติ (g=8 = 0.07%)
  · **ระบบจริงคง `TOP_K_G = 8`** (เจ้าของตัดสินใจ 2026-09-28 — FP ต่ำสำคัญกว่า recall) · รายงานต้องบอกว่าระบบใช้ g=8 ไม่ใช่ g ที่เลือกจาก validation
  · ผล + `multiseed.py`: `~/Documents/logchain-data/multiseed/` (ไม่อยู่ใน git)

### 7.3 ⬜ clone ทดสอบ `~/clone_logchain/logchain` (project `logchain-smoke`)

- CA ของ clone ยังชื่อเก่า (สร้างก่อน `2afc52e`) — จะ trust ทั้งสองชุดพร้อมกัน: ใน clone `rm -rf infra/tls/certs` →
  `COMPOSE_PROJECT_NAME=logchain-smoke ./infra/tls/gen-certs.sh` → `docker restart logchain-https-proxy` → `./scripts/trust-web-ca.sh`
- volume `logchain-smoke_*` 9 ตัวยังอยู่ — เลิกใช้แล้ว `docker compose -p logchain-smoke down -v` (เช็ค label แล้ว ไม่โดน `logchain_*`)
- clone ไม่ต่อ blockchain (ตั้งใจ — key ไม่อยู่ใน git) · ✅ อาจารย์ตอบ "ใส่แค่ขั้นตอน" → README หัวข้อ "ตั้ง blockchain เอง"
  (ยังไม่ได้ทดสอบทั้งสายบน clone · **ห้ามรัน `npm run deploy:contract` ในโฟลเดอร์ชุดจริง** — deploy contract ใหม่ด้วย key จริงแล้วทับ `CONTRACT_ADDRESS`
  · เกิดแล้ว 2026-09-28 16:44 ได้ `0xC149…` — คืน `.env` เป็น `0x5dC86975…` แล้ว worklog หัวข้อ 12)
- wallet ที่ anchor = `0x8cBCfC04…4C55` · เติมแล้ว 2026-09-28 ยอด 0.1192 POL (~30–50 batch · ครั้งละ ~0.0023–0.0039 POL)
  · หมดแล้ว batch ค้าง UNVERIFIED + email `BatchStuckUnverified` · ห้ามเติม wallet เดิม `0xfb10EfD7…0695` (key หลุด)

### 7.4 ⬜ `trust-web-ca.sh` บน macOS / Windows ยังไม่ได้ทดสอบหลังเปลี่ยนชื่อ CA

ค้นชื่อแบบ substring — ถ้ารันกับ CA **ชื่อเก่า** จะลบ CA ของ clone อื่นที่ trust ไว้ด้วย (Linux เทียบชื่อตรงตัว ไม่เป็น)

---

### 7.5 ✅ กรณีทดสอบ "รอผล" ในเล่ม — worklog 2026-09-29

ผ่าน 18 · FT-14 บางส่วน · DR-09/10 เอาออก · กรอกลงเล่มแล้ว · `test/report-cases.integration.spec.ts` (**หยุด `logchain-backend` ก่อนรัน**)
· แก้บั๊ก seal พร้อมกัน (`sealQueue`) · เจอ rate limit ไม่ทำงาน + คอขวด seal 100 log/นาที · gas Amoy 155 gwei

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
- **ห้าม override `KEYCLOAK_URL` เป็นชื่อ service** (เป็น issuer ต้องตรงกับ `iss` ในโทเคน · ตั้งแต่ 2026-09-24 = `https://localhost:8443` และ Keycloak ใช้เป็น `KC_HOSTNAME_URL`) ·
  **ห้ามเปลี่ยน `NEXT_PUBLIC_*` เป็นชื่อ service** (inline ตอน build และรันบนเบราว์เซอร์นอก docker network)
- **ห้ามใช้ `${VAR:?...}` ใน `docker-compose.yml`** — compose error ทั้งไฟล์
- **ห้าม `docker compose down -v`** ตอนทดสอบ ถ้ายังอยากได้ข้อมูล demo เดิม
- **ห้ามเก็บ `SeenIds` (id ที่ detection เห็นแล้ว) ไว้ถาวรแยกจาก state อื่น** — state ของ rule engine
  (`_event_history`) และ buffer ของ DeepLog อยู่ในหน่วยความจำ restart แล้วหายพร้อมกัน ถ้า id รอดแต่ประวัติหาย
  message ที่ Kafka redeliver หลัง crash จะถูกข้าม → threshold นับขาด → **5710 ไม่เด้งทั้งที่ brute force จริง**
  ของเดิม (ลืมพร้อมกันหมด) นับถูก ผลเสียเหลือแค่ alert ซ้ำ 1 ครั้ง ซึ่ง backend รวมเป็น `occurrence_count` อยู่แล้ว
  · ถ้าจะทำต้องเก็บ **ครบชุด** (id + `_event_history` + `_prior_matches` + DeepLog buffers) และ detection ต้องได้
  สิทธิ์ DB (ตอนนี้ไม่มี — ขยาย PCI scope) · ตัดสินใจ 2026-09-23
- **ห้ามให้ consumer สร้าง/เรียน Drain เองตอนรัน** — cluster id แจกตามลำดับที่เจอ ไม่ตรงกับ id ตอน train (โมเดลทำนายบน key ผิดชุด)
  และเรียนต่อได้ key เกิน `NUM_CLASSES - 1` → API 422 · ใช้ `LogKeyMatcher` กับ `drain_state.json` ชุดที่ train เท่านั้น
- **ห้ามแยก `mask()` ของ `parse_logs.py` กับ consumer ออกจากกันอีก** — ทั้งคู่ import จาก `detection/app/log_keys.py`
  · และ `mask()` ต้องรับทั้ง IP ดิบ (ตอน train) และ `a.b.c.xxx` / `blk_-[PAN]` ที่ backend PII-mask แล้ว (ตอนรัน)
  ไม่งั้น ~66% ของบรรทัด HDFS เป็น key 0 แล้วถูกข้าม ML เงียบ ๆ · ตัดสินใจ 2026-09-28

---

# กับดักที่เสียเวลาที่สุด (อ่านก่อนเริ่ม debug)

| อาการ | ที่จริงคือ |
|---|---|
| Docker ไม่ขึ้นหลัง boot · `docker ps` ต่อ daemon ไม่ได้ · `/srv/lcsecure` ว่าง | ยังไม่ได้ปลดล็อกไฟล์ LUKS (พลาดช่องใส่ PIN ตอน boot) — Docker รอ mount โดยตั้งใจ · `sudo systemctl start systemd-cryptsetup@lcsecure.service` → `sudo mount /srv/lcsecure` → `sudo systemctl start docker` (runbook "ใช้งานประจำวัน") |
| lint ผ่านในเครื่องแต่ CI แดง | `npm run lint` มี `--fix` และไม่ดูเพดาน — ต้องรัน **`npm run lint:ci`** (`--max-warnings 667`) |
| เครื่องอื่นใน LAN เข้า service ไม่ได้ (log source ข้ามเครื่อง ฯลฯ) | ตั้งใจ — port bind `127.0.0.1` · ตั้ง `PUBLISH_ADDR=0.0.0.0` ใน `.env` แล้ว `docker compose up -d` (เปิดทุก port) |
| ยิง log ได้ 201 แต่ไม่มี alert แถวใหม่ | (1) `select count(*) from kafka_pending_logs` — ค้างคิวเพราะ Kafka ล่มไหม (2) มี alert OPEN ของ rule + host เดียวกันอยู่ไหม — ถูกนับเป็น `occurrence_count` ของตัวเดิม (ตั้งใจ) |
| rule แบบ threshold ไม่เด้งทั้งที่ยิง log ครบ | rule นับหน้าต่างเวลาจาก **`createdAt` ของ event** ไม่ใช่เวลาที่รับ — ยิงห่างกันเกิน 60 วิ ก็ไม่เข้าเกณฑ์ (ตั้งใจ ดู `detection/app/rules.py::_event_time`) |
| login `admin-user` ด้วยรหัสใน `.env` ไม่ผ่าน | 2026-09-23 ตั้งให้ตรงกันแล้ว · ถ้าไม่ผ่านอีก = มีคนเปลี่ยนรหัสผ่านหน้าเว็บ · realm policy ต้องมีตัวเลข + ห้ามซ้ำ 4 ตัวล่าสุด · ต้องใช้ OTP |
| approle login ตอบ `permission denied` | Vault user lockout — `./scripts/vault-unlock.sh` |
| `UPDATE logs ...` ใน psql ไม่มีผล | trigger `trg_logs_no_update` — ต้อง `ALTER TABLE logs DISABLE TRIGGER` ก่อน (ดู `scripts/demo-tamper.sh`) |
| container ต่อ Kafka SSL `:39092` ไม่ได้ / ค้าง | listener `SSL` advertise `localhost` ใช้ได้จาก host เท่านั้น — ใน docker network ใช้ `DOCKER_SSL` `kafka-N:9094` |
| `kafka-topics.sh --bootstrap-server localhost:9092` ต่อไม่ได้ | ไม่มี PLAINTEXT ในเน็ตเวิร์กแล้ว (2026-09-24) — `docker exec logchain-kafka-1 sh /opt/logchain/kafka-cli.sh kafka-topics.sh --list` (ใส่ bootstrap + mTLS ให้) |
| kafka-init / kafka-exporter ขึ้นไม่ได้ `No such file` ที่ `admin.*` / `exporter.*` | cert สร้างก่อน 2026-09-24 — `./infra/kafka/gen-certs.sh client admin` + `client exporter` (bootstrap.sh ทำให้เอง) |
| Trivy / pip-audit บน image ไม่เจอช่องโหว่ของ torch | torch ใน image เป็น `X+cpu` scanner จับคู่ไม่ได้ — CI audit `detection/requirements.lock` แทน (อัป torch ต้องแก้ทั้ง `requirements.txt` และ `Dockerfile` แล้วรัน `./scripts/detection-lock.sh`) |
| build detection พัง `requirements.lock ไม่ตรงกับที่ลงจริง` | แก้ `detection/requirements.txt` แล้วยังไม่ได้สร้าง lock ใหม่ — `./scripts/detection-lock.sh` (สร้าง + pip-audit) แล้ว build ใหม่ · diff ใน log บอกตัวที่ต่าง |
| container `logchain-*` มาจากสองโฟลเดอร์ปนกัน / Vault sealed ทั้งที่มี `init.env` / `vault-unseal` บอก "unseal key หาย" | เคยยก stack จากโฟลเดอร์ clone (เช่น `~/Documents/clone_logchain/logchain`) — ชื่อ project + volume เดียวกัน compose จึงทับ container กันไปมา · ดู `docker ps --format '{{.Names}} {{.Label "com.docker.compose.project.working_dir"}}'` · แก้: `docker compose up -d` จากโฟลเดอร์หลัก (volume เดิม ข้อมูลไม่หาย) · ทดสอบ clone ให้ `COMPOSE_PROJECT_NAME` อื่น + ปิด stack หลักก่อน (พอร์ต/`container_name` ชน) |
| `curl localhost:3000/metrics` ได้ 404 | ตั้งใจ (review B5) — metrics ของ backend อยู่ `:9464` ใน docker network · `docker exec logchain-backend wget -qO- 127.0.0.1:9464/metrics` |
| Kafka / backend / detection-consumer ต่อ SSL ไม่ได้ `Permission denied` ที่ไฟล์ `.key` | key เป็น 0640 อ่านผ่านกลุ่ม (`group_add: HOST_GID`) — ลืม `HOST_GID=$(id -g)` ตอน `docker compose up` แล้ว gid เครื่องไม่ใช่ 1000 · หรือ key เป็นของ user อื่น (`stat infra/kafka/certs/clients/*.key`) |
| `bootstrap.sh` ของ clone ที่สองหยุดตั้งแต่ต้น (`project 'logchain' เป็นของ …` / `มี volume logchain_vault_data อยู่แล้ว`) | ตัวกันของ `b5a98d6` ทำงานถูก — clone บนเครื่องที่มีชุดจริงใช้ `COMPOSE_PROJECT_NAME=logchain-smoke ./scripts/bootstrap.sh` · ถ้า container ของ smoke รอบก่อนค้าง (โฟลเดอร์ถูกลบแล้ว key ของ Vault หาย) → `docker compose -p logchain-smoke down -v` ก่อน (worklog 2026-09-28 หัวข้อ 1) |
| `NET::ERR_CERT_AUTHORITY_INVALID` ทั้งที่ `curl --cacert infra/tls/certs/ca.crt` ได้ 200 · มีสองชุดในเครื่อง | CA ชื่อซ้ำใน NSS (CA ที่สร้างก่อน 2026-09-28 ชื่อ `LogChain-Web-CA` ทุกชุด) — เทียบ `certutil -L -d sql:$HOME/.pki/nssdb -n 'LogChain-Web-CA' -a \| openssl x509 -noout -fingerprint -sha256` กับ `ca.crt` · แล้ว **ปิด Chrome จริง** (`pkill -f /opt/google/chrome/chrome` — ปิดหน้าต่างแล้วยังรันเบื้องหลัง) |
| ML alert ไม่เด้งเลยทั้งที่ยิง log HDFS · `ml_skipped_unknown` ขึ้น | ข้อความไม่ตรง template ใน `drain_state.json` — ลอง `python -c "from app.log_keys import *; m=LogKeyMatcher.from_file(); print(m.match(mask('<ข้อความใน DB>')))"` ใน `detection/` · ได้ 0 = mask ไม่รองรับรูปที่ backend ส่งมา (ดูหัวข้อ "ห้ามทำ") |
| รัน `parse_logs.py` ใหม่แล้ว `detect.py` / API โหลดโมเดลไม่ขึ้น (size mismatch `fc`) | จำนวน log key เปลี่ยน — `NUM_CLASSES` = key + 1 ต้องแก้ครบ 3 ไฟล์แล้ว train ใหม่ · `tests/test_log_keys.py` เช็คให้ |
| เบราว์เซอร์เตือน cert ที่ `:3453` / `:8443` · login ขึ้น `Invalid parameter: redirect_uri` | ยังไม่ trust CA → `./scripts/trust-web-ca.sh` (ต้องมี `libnss3-tools`) · realm เดิมไม่มี URL https → `./scripts/sync-keycloak-urls.sh` |
| backend บน host (`start:dev`) ตอบ 401 ทุก request หลังเปลี่ยนเป็น HTTPS | `KEYCLOAK_INTERNAL_URL` ว่าง → ดึง JWKS จาก `https://localhost:8443` ที่ Node ไม่ trust — ตั้ง `KEYCLOAK_INTERNAL_URL=http://localhost:8080` |
| รัน `report-cases.integration.spec.ts` แล้ว batch ที่มี log `e2e-report-cases` ขึ้น chain จริง | ลืมหยุด `logchain-backend` — cron ของตัวจริงหยิบ log ของเทสต์ไปก่อน · `docker stop logchain-backend` → รันเทสต์ → `docker start` |
| ยิง POST /logs เกิน 500/นาทีแล้วไม่โดน 429 | rate limit ไม่ได้เปิด — ไม่มี `ThrottlerGuard` (worklog 2026-09-29 หัวข้อ 3) |
| rebuild consumer แล้วโค้ดไม่เปลี่ยน | `detection-consumer` ใช้ image ของ `detection-api` — build service นั้นแทน |
| batch ค้าง `SEALED` ไม่ขึ้น `CONFIRMED` | ปกติถ้าไม่ได้ตั้ง blockchain — `anchorSealedBatches()` ตามไป anchor เองเมื่อ config ครบ · ถ้าตั้งแล้ว ดู log `Blockchain init failed (attempt N)` — ลองใหม่เองทุก ≤5 นาที |
| เทสต์ ethers กับ RPC ปลอมแล้ว call ที่สองได้ error เดิมโดยไม่ยิงจริง | ethers cache ผลของ request ที่เหมือนกัน 250ms (รวม reject) — เว้นช่วงในเทสต์ |
| รัน e2e ในเครื่องแล้ว integrity ตกจาก 100% | e2e ทิ้ง batch UNVERIFIED (`tx_hash` ขึ้นต้น `0xaaaa…`) — ลบทิ้งหลังรัน · ลืมลบ 30 นาทีจะได้ email `BatchStuckUnverified` |
| รันแอปบน host (`npm run start:dev`) แล้ว Prometheus/Grafana ไม่มีข้อมูล | target ชี้ชื่อ service ใน compose อย่างเดียว — เปลี่ยน target ของ job นั้นเป็น `host.docker.internal:<port>` (backend = **9464** ไม่ใช่ 3000) แล้ว `curl -X POST localhost:9090/-/reload` (อย่าใส่คู่กัน = scrape ซ้ำ worklog หัวข้อ 20) |
| `setup-offsite-backup.sh` ขึ้น `access_denied` / 403 insufficient scopes | หน้า Google hasn't verified → Advanced → Go to rclone · คำถาม Shared Drive ตอบ `n` (worklog หัวข้อ 31) |
| เขียน `secret/logchain/notification` ใน Vault เองแล้วหายหลัง `docker compose up` | `vault-init` seed จาก `.env` ทุกรอบ — แก้ที่ `.env` (`MAIL_*`) หรือ `scripts/setup-alert-email.sh` |
| alert ขึ้นใน `:9090/alerts` แต่ไม่มีใครได้ email | `docker logs logchain-alertmanager | head -1` — ถ้าขึ้น "ยังไม่ได้ตั้งอีเมล" ดู README หัวข้อ Alert แจ้งทาง email · แก้ `.env`/ไฟล์รหัสแล้วต้อง `--force-recreate alertmanager` |

---

# ไฟล์อ้างอิง

| ไฟล์ | เกี่ยวตรงไหน |
|---|---|
| `docs/worklog/2026-09-28.md` | งานล่าสุด: clone แยก · CA ต่อชื่อ project · log key 45 vs Loghub 29 · train ใหม่ · consumer ใช้ template ที่ train · ทดสอบบนระบบจริง |
| `detection/app/log_keys.py` | `mask()` (ใช้ทั้ง train และ runtime) + `LogKeyMatcher` แปลง log → key ด้วย `data/drain_state.json` |
| `detection/parse_logs.py` → `prepare_data.py` → `deeplog.py` → `detect.py` | ขั้นตอนสร้างโมเดล (HDFS.log อยู่ `~/Documents/logchain-data/` · รันใน image detection ได้ ไม่ต้องลง drain3/torch ในเครื่อง) |
| `docs/worklog/2026-09-23.md` | (หัวข้อ 1–20): alert dedup · Kafka outbox · kafka-python · blockchain retry/timeout · ethers guard · detection dedup · Prometheus alert · README contract |
| `docs/worklog/2026-09-22.md` | onboarding · seal/anchor · NonceManager crash · P3 |
| `src/kafka/kafka-producer.service.ts` | producer + outbox/replay (`enqueue` · `drainPending`) |
| `src/kafka/entities/pending-log.entity.ts` | ตาราง `kafka_pending_logs` |
| `src/alerts/alerts.service.ts` | dedup ตาม rule · นับซ้ำ · ขยับ severity · เตือนซ้ำ |
| `src/database/migrations/` | migration ของ schema ทั้งหมด (7 ตัว) |
| `src/erasure/erasure.service.ts` | PDPA erasure = pseudonymize (`pseudonymize()` · `resourcePattern()`) · key จาก `VaultService.get().erasure` |
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
