# สิ่งที่ต้องทำต่อ

> **เอกสารนี้คืออะไร:** งานค้างที่เหลือหลังปิดแผน `onboarding-and-repo-consolidation.md`
> เขียนให้ session หน้า (คนหรือ Claude Code) อ่านแล้วลงมือได้เลย ไม่ต้องสืบใหม่
>
> **อัปเดตล่าสุด:** 2026-09-22 (รอบ 2) · **ฐาน:** `main = 88c119a` + งานรอบ 2 ที่ยังไม่ commit
>
> **ความคืบหน้ารอบ 2:** ✅ P3 (3.1 ตรวจแล้ว · 3.2 ชั่งแล้วไม่ทำ · 3.3 มีสคริปต์) · ✅ P1 ทั้งหมด · ✅ 2.2 · ✅ 2.3 · ✅ บั๊ก producer (ข้อ 0) · ⏳ 2.1 รอเจ้าของรันเอง
> · ✅ ข้อ 0.1 (backend crash ตอน RPC timeout) — worklog หัวข้อ 12
> **ที่มา:** `docs/worklog/2026-09-22.md` (10 หัวข้อ — อ่านหัวข้อ 9 ก่อนถ้าจะแตะ integrity)

---

## สถานะระบบ ณ ตอนเขียน

`git clone https://github.com/ChanakanNalong/logchain.git && ./scripts/bootstrap.sh`
รวดเดียวจบ ยก 20 service · ทดสอบจาก GitHub จริงแล้วผ่านทุกเกณฑ์ (worklog หัวข้อ 10)

แผน onboarding + รวม repo **จบครบทุกข้อ (A–G)** — `detection/` รวมเข้ามาแล้ว
repo `logchain-detection` ถูกลบจาก GitHub · `logchain-contracts` แยกไว้ตามแผน

---

# 🆕 เจอรอบ 2

## 0. ✅ `KafkaProducerService` ยอมแพ้ถาวรถ้า Kafka ขึ้นช้ากว่า backend — แก้แล้ว
connect ครั้งเดียวตอน boot → `log publishing disabled` ทั้ง run · log เข้า DB แต่ไม่ถึง
`logs.raw` → detection ตายเงียบ · แก้เป็น retry ไม่ยอมแพ้แบบ consumer แล้ว (worklog หัวข้อ 11)

## 0.1 ✅ backend crash ทั้ง process เมื่อ blockchain RPC timeout — แก้แล้ว
ต้นเหตุคือ `ethers.NonceManager` (ไม่ใช่ `tx.wait()` อย่างที่เดาไว้) — เลิกใช้แล้ว จัดการ nonce เอง
ใน `BlockchainService.sendStoreRoot()` · เจอบั๊ก nonce พ่วงอีก 2 ตัว · รายละเอียด worklog หัวข้อ 12
**ห้ามกลับไปใช้ NonceManager** (เทสต์ `src/blockchain/blockchain.nonce.spec.ts` จะพัง 3 เคส)

---

# ✅ P1 — ปมที่ค้างจากงาน "แยก seal ออกจาก anchor" (เสร็จรอบ 2)

> **เสร็จแล้ว** — ทำครบ 1.1–1.3 (ทาง ก สำหรับ 1.3) + เจอพ่วงว่า `total` ของ compliance นับ
> `FAILED` ด้วย แก้ให้ตรงกับ stats แล้ว · ยังไม่ได้ยิง endpoint จริงบน stack **ที่ไม่มี** chain
> (stack บนเครื่องต่อ chain อยู่) ตรวจด้วย unit test + รัน SQL บน DB จริง

> งานรอบที่แล้วเพิ่มสถานะ `SEALED` (batch ที่ปิดแล้วแต่ยังไม่ anchor) และแก้
> `stats.service.ts` ให้นับ `SEALED` เป็น intact **แต่แก้ไม่ครบทุกที่ที่อ่านสถานะ batch**
> ผลคือหน้าเว็บ 2 หน้ารายงานเลขไม่ตรงกันบน deployment ที่ไม่ได้ต่อ blockchain
>
> **ทำ 1.1 ก่อนเสมอ** (แก้ backend ให้เป็นแหล่งความจริงเดียว) แล้วค่อย 1.2/1.3

## 1.1 `compliance.service.ts` — `sealed` ถูก query มาแล้วทิ้ง + สูตรไม่ตรงกับ stats

**ปัญหา** — `src/compliance/compliance.service.ts`

- บรรทัด **85** `SELECT COUNT(*) FILTER (WHERE batch.status='SEALED') AS sealed`
  ถูกเพิ่มไว้ **แต่ object ที่ return (บรรทัด 105–113) ไม่มี field `sealed`** → query ทิ้งเปล่า
- บรรทัด **112** `integrityRate: confirmed / total` ขณะที่ `stats.service.ts:104`
  ใช้ `intact / total` โดย `intact = CONFIRMED + SEALED` (`stats.service.ts:148`)
  → **สองหน้าคิดคนละสูตร**

**ผลที่เห็นจริง** บน deployment ที่ไม่มี blockchain (batch ทั้งหมดเป็น `SEALED`):

| หน้า | ค่าที่โชว์ |
|---|---|
| Dashboard (`/api/v1/stats/overview`) | Chain Integrity **100%** |
| Reports (`/api/v1/compliance/...`) | integrityRate **0%** |

และคอลัมน์รายวัน `confirmed + tampered + unverified + pending` จะ **ไม่เท่ากับ `total`**
เพราะ `total` เป็น `COUNT(*)` ที่รวม `SEALED` ไว้ด้วย

**ทำอะไร**

1. เพิ่ม `sealed` เข้า object ที่ return
2. เปลี่ยนสูตรให้ตรงกับ stats: `integrityRate = (confirmed + sealed) / total`
3. ทางที่สะอาดกว่า — ย้าย `INTACT_STATUSES` จาก `stats.service.ts` ไปไว้ที่ที่ใช้ร่วมกันได้
   (เช่น `src/logs/entities/batch.entity.ts` หรือไฟล์ constant ใหม่) แล้วให้ทั้งสอง service
   import ตัวเดียวกัน — กันไม่ให้หลุดจากกันอีกรอบตอนเพิ่มสถานะใหม่ครั้งหน้า

**เสร็จเมื่อ** — ยิง `/api/v1/stats/overview` กับ `/api/v1/compliance/...` บน stack
ที่ไม่มี blockchain แล้ว `integrityRate` ตรงกัน และ `confirmed+sealed+tampered+unverified+pending = total`

## 1.2 `Reports.tsx` — คิด % เองฝั่ง client ด้วยสูตรเก่า

**ปัญหา** — `cylis-dashboard/src/views/Reports.tsx`

- บรรทัด **321–323** `confirmedSum / totalBatchSum` — คิดซ้ำฝั่ง client ไม่ได้ใช้
  `integrityRate` ที่ backend ส่งมา จึงพลาดเหมือนข้อ 1.1
- บรรทัด **316–317** default row ไม่มี key `sealed`
- บรรทัด **79–81** `toCsv()` export แค่ `confirmed, tampered, unverified, pending, total, integrityRate`
  → CSV ที่ auditor ได้จะขาด `sealed` ไปเลย (สำคัญ เพราะเป็นไฟล์ที่เอาไปใช้อ้างอิง)

**ทำอะไร** — เพิ่ม `sealed` ทั้ง 3 จุด และให้ `chainIntegrityPct` นับ `sealed` เป็น intact
หรือดีกว่านั้นคือใช้ค่าจาก backend ตรง ๆ หลังแก้ 1.1 แล้ว

## 1.3 tile "Confirmed Batches" อ่านแล้วขัดกันเอง

**ปัญหา** — `cylis-dashboard/src/views/Dashboard.tsx:123-125` และ `Verify.tsx:123`
โชว์ `batches.confirmed` ตรง ๆ บน deployment ที่ไม่มี blockchain จะได้

```
Chain Integrity  100%          Confirmed Batches  0
```

ซึ่งดูเหมือนบั๊กทั้งที่ทั้งคู่ถูกตามนิยามของมัน

**ทำอะไร** — เลือกทางใดทางหนึ่ง (อย่าทำทั้งคู่)
- (ก) เปลี่ยน tile เป็น "Sealed Batches" ใช้ `confirmed + sealed` แล้วใส่ `delta`
  บอกว่า anchor ไปแล้วกี่ใบ — **แนะนำทางนี้** สื่อความจริงได้ครบโดยไม่ต้องเพิ่ม tile
- (ข) เพิ่ม tile "Sealed (not anchored)" แยกอีกอัน

> อย่าแก้ด้วยการเอา `SEALED` ไปนับรวมใน `batches.confirmed` ฝั่ง backend —
> `confirmed` ต้องแปลว่า "anchor แล้ว" เท่านั้น ไม่งั้นความหมายเพี้ยนทั้งระบบ

---

# 🟡 P2 — เก็บกวาดจาก session ที่แล้ว

## 2.1 ⏳ repo detection เก่าบนเครื่อง (รอเจ้าของรันเอง)

`~/Documents/logchain-detection` ยังมี `origin` ชี้ไป
`https://github.com/ChanakanNalong/logchain-detection.git` ซึ่ง **ถูกลบไปแล้ว (404)**

ตอนนี้ push ไม่ขึ้น แต่ถ้าวันหลังมีใครสร้าง repo ชื่อเดิมขึ้นมา `git push` จะยิง
history **4.2 GB** (venv + HDFS.log) เข้าไปทันที

```bash
cd ~/Documents/logchain-detection && git remote remove origin
```

หรือลบโฟลเดอร์ทิ้งเลย — ไฟล์ทั้ง 14 ตัวถูกคัดลอกเข้า `detection/` ครบแล้ว
และตรวจแล้วว่า**ตรงกันทุกไบต์** ลบแล้วได้ที่คืน 4.2 GB

## 2.2 ✅ `demo-brute-force.sh` จบด้วย error เสมอ (แก้แล้ว รอบ 2)

`scripts/demo-brute-force.sh` รับ token มาแล้วขั้นสุดท้ายยิง `GET /api/v1/alerts`
ซึ่งต้องมี role `analyst`/`operator`/`admin` แต่ token ที่คนส่วนใหญ่มีในมือคือของ
`log-ingestor` (จาก `ingest-log.sh`) → ได้ **403** แล้ว `jq` พัง:

```
jq: error (at <stdin>:0): Cannot index string with string "alertType"
```

alert ถูกบันทึกเรียบร้อยแล้วจริง ๆ แค่สคริปต์อ่านกลับไม่ได้ — คนรัน demo ครั้งแรก
จะนึกว่าพัง

**ทำอะไร** — ดัก HTTP code ก่อน `jq` แล้วขึ้นข้อความว่า "alert ถูกบันทึกแล้ว แต่ token
นี้ไม่มีสิทธิ์อ่าน /alerts — เปิดดูที่หน้า Alerts หรือใช้ token ที่มี role analyst"

## 2.3 ✅ `Vault login OK` ไม่มีวันโผล่ใน log ของ consumer (แก้แล้ว รอบ 2)

`detection/app/consumer.py` เรียก `get_vault()` ที่ **บรรทัด 26** แต่
`logging.basicConfig()` อยู่ **บรรทัด 90** → ตอน login สำเร็จมันยิง `log.info` ออกไป
ตอนที่ยังไม่มี handler บรรทัดนั้นจึงหายเงียบ (ส่วนที่พลาดเป็น `log.warning`
ซึ่ง lastResort handler ของ Python ปล่อยผ่าน)

**เงียบ = ผ่าน** ซึ่งสับสนมากเวลา debug (เขียนเตือนไว้ใน `detection/README.md` แล้ว)

**ทำอะไร** — ย้าย `logging.basicConfig()` ขึ้นไปก่อน `get_vault()`
ระวัง: `start_http_server(9101)` (บรรทัด 54) ก็อยู่ระหว่างกลาง ย้ายแล้วรันจริงดูสักรอบ

---

# 🟢 P3 — ปรับปรุงที่ยังไม่จำเป็นตอนนี้

## 3.1 ✅ login ผ่านเบราว์เซอร์ (ตรวจแล้ว รอบ 2 — ไม่ต้องทำอะไรต่อ)

> **ผลตรวจ:** บน stack ของเครื่องนี้ `admin-user` **ลงทะเบียน OTP ไว้แล้วตั้งแต่ 2026-09-06**
> และ**เปลี่ยนรหัสผ่านเมื่อ 2026-09-17** (อ่านจาก admin API) = มีคน login ผ่านเบราว์เซอร์
> จนผ่าน MFA มาแล้วจริง · ไล่ PKCE flow ด้วย curl: หน้า login ขึ้นถูก client/redirect แต่รหัสใน
> `.env` ถูกปฏิเสธ — ปกติ เพราะ Keycloak import realm ครั้งเดียวตอน boot แรก (เพิ่มแถวใน README
> Troubleshooting แล้ว) · ไม่ได้ลองซ้ำเพราะ brute force ล็อกที่ 5 ครั้ง
> **ข้อควรรู้:** login ครั้งแรกบน clone ใหม่จะโดนบังคับตั้ง TOTP (`CONFIGURE_TOTP`) ต้องมีแอป authenticator

ข้อความเดิม:

เป็นข้อเดียวในเกณฑ์ท้ายแผนเดิมที่ยังเปิดอยู่ ที่ตรวจไปแล้ว:
client `logchain-frontend` + `redirect_uri=http://localhost:3003` ตั้งถูก และบังคับ PKCE
(authorize endpoint ตอบ `Missing parameter: code_challenge_method` = ผ่าน client แล้ว)

เหลือแค่เปิด `http://localhost:3003` แล้วกรอก username/password จริง
(บัญชีอยู่ใน realm `logchain` password = `KEYCLOAK_ADMIN_USER_PASSWORD` ใน `.env`)

## 3.2 ⛔ สอง compose project อยู่พร้อมกันไม่ได้ (ชั่งแล้ว รอบ 2 — ไม่ทำ)

> **ตัดสินใจไม่ทำ** — ถอด `container_name` แล้วชื่อจะกลายเป็น `logchain-backend-1` ทำให้คำสั่ง
> `docker logs logchain-backend` / `docker exec logchain-postgres` ใน README, runbooks และเอกสาร
> ~40 จุดใช้ไม่ได้ · และถึงถอดแล้ว stack ที่สองก็ยังชนพอร์ต 17 ตัวอยู่ดี ต้องตั้ง env 17 ตัวหรือมี
> override file แยก — แลกกับการประหยัด `down`/`up` ~2 นาทีตอน smoke test ซึ่งนาน ๆ ทำที ไม่คุ้ม
> ถ้าวันหนึ่งต้องรัน CI แบบขนาน ค่อยกลับมาดู (ใช้ `docker compose exec -T <service>` แทนชื่อ container ในสคริปต์ก่อน)

ข้อความเดิม:

`docker-compose.yml` ตั้ง `container_name:` ตายตัวทุก service (เช่น `logchain-postgres`)
และพอร์ต 18 ตัวก็ hardcode → ยก 2 stack พร้อมกันไม่ได้แม้ตั้ง `COMPOSE_PROJECT_NAME`
ต่างกัน ทำให้ smoke test ต้อง `docker compose down` ของเดิมก่อนทุกครั้ง

**วิธีรัน smoke test ตอนนี้** (ถ้าจำเป็น):

```bash
cd ~/Documents/logchain
docker compose down                      # ⚠️ ห้ามใส่ -v ไม่งั้นข้อมูลหาย
cd /tmp && git clone https://github.com/ChanakanNalong/logchain.git smoke && cd smoke
COMPOSE_PROJECT_NAME=logchain-smoke ./scripts/bootstrap.sh
# ...ทดสอบ...
COMPOSE_PROJECT_NAME=logchain-smoke docker compose down -v
cd ~/Documents/logchain && HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose up -d
```

**ถ้าจะแก้** — ถอด `container_name` ออกให้ compose ตั้งชื่อเอง (`<project>-<service>-1`)
แล้วย้ายพอร์ตไปเป็น `${X_PORT:-3000}:3000` แต่ต้องไล่แก้ทุกที่ที่อ้างชื่อ container
ตรง ๆ ด้วย — `scripts/demo-tamper.sh:8`, `scripts/demo-mtls.sh`, runbooks และ
`docker exec logchain-postgres ...` ที่กระจายอยู่ในเอกสาร **งานนี้ใหญ่กว่าที่เห็น**
ชั่งดูก่อนว่าคุ้มไหม

## 3.3 ✅ Vault user lockout — มี `scripts/vault-unlock.sh` แล้ว (รอบ 2)

> ทดสอบจริง: login ผิด 5 ครั้งจน role detection โดนล็อก (รหัสถูกก็ได้ `permission denied`)
> → `./scripts/vault-unlock.sh detection` → consumer ขึ้น `Vault login OK` · ไม่ใส่ argument = ดูอย่างเดียว

ข้อความเดิม:

Vault 1.13+ เปิด lockout เป็น default (`threshold=5`, `duration=15m`) และแอปทั้งสองตัว
retry login **5 ครั้ง** ตอน start พอดีเป๊ะ → ใส่ secret ผิดครั้งเดียวก็โดนแบน
แล้ว `restart: unless-stopped` จะวน retry ต่ออายุ lockout **ไม่มีวันหลุดเอง**

วิธีแก้เขียนไว้ครบใน README หัวข้อ **Vault user lockout** แล้ว (ต้องหยุด container
ก่อน unlock ไม่งั้นโดนล็อกซ้ำทันที)

**ยังไม่ได้ทำ (ตั้งใจ):** ไม่ปิด lockout เป็น default เพราะ account lockout เป็น
control ตาม PCI DSS Req 8.3.4 ซึ่งเป็นแก่นของโปรเจกต์ — แต่ถ้าเจอซ้ำบ่อยจนเสียเวลา
อาจทำ `scripts/vault-unlock.sh` ห่อคำสั่ง 3 บรรทัดนั้นไว้ให้เรียกง่าย

---

# ⛔ ห้ามทำ (ตัดสินใจไปแล้ว อย่าถกใหม่)

- **ห้ามรวม `logchain-contracts` เข้ามา** — backend ใช้ inline ABI ที่
  `src/blockchain/blockchain.service.ts` ไม่ได้ import artifact จาก repo นั้น
  ผูกกันผ่าน `CONTRACT_ADDRESS` สตริงเดียว
- **ห้ามเอา `SEALED` ไปนับรวมใน `batches.confirmed`** — `confirmed` ต้องแปลว่า
  "anchor ขึ้น chain แล้ว" เท่านั้น
- **ห้าม override `KEYCLOAK_URL` เป็นชื่อ service ใน compose** — เป็น issuer ที่ต้อง
  ตรงกับ `iss` ในโทเคน ที่อยู่ภายในใช้ `KEYCLOAK_INTERNAL_URL` แยกไว้แล้ว
- **ห้ามเปลี่ยน `NEXT_PUBLIC_*` เป็นชื่อ service** — inline ตอน build และรันบน
  เบราว์เซอร์ซึ่งอยู่นอก docker network
- **ห้ามใช้ `${VAR:?...}` ใน `docker-compose.yml`** — compose จะ error ทั้งไฟล์
  ทำให้ `up -d` ของ service อื่นพังตาม
- **ห้าม `docker compose down -v`** ตอนทดสอบ ถ้ายังอยากได้ข้อมูล demo เดิม

---

# กับดักที่เสียเวลาที่สุด (อ่านก่อนเริ่ม debug)

| อาการ | ที่จริงคือ |
|---|---|
| approle login ตอบ `permission denied` ทั้งที่ค่าใน `.env` ถูก | Vault user lockout — ดู `docker logs logchain-vault \| grep -i lockout` ไม่ใช่ log ของแอป |
| `UPDATE logs ...` ใน psql ไม่มีผล | trigger `trg_logs_no_update` กันไว้ ต้อง `ALTER TABLE logs DISABLE TRIGGER` ก่อน (ดู `scripts/demo-tamper.sh`) |
| consumer ไม่ขึ้น `Vault login OK` | image เก่าก่อนแก้ข้อ 2.3 — rebuild `detection-api` (consumer ใช้ image เดียวกัน) |
| ยิง log ได้ 201 แต่ detection เงียบ | ดู `docker logs logchain-backend \| grep KafkaProducer` — image ก่อนแก้ข้อ 0 จะขึ้น `log publishing disabled` ถาวร |
| `rm -rf infra/vault/.secrets` permission denied | โฟลเดอร์เป็นของ root — แก้แล้วด้วย `HOST_UID` chown ใน `unseal.sh` ถ้ายังเจอแปลว่า vault-unseal รันโดยไม่มี `HOST_UID` |
| batch ค้าง `SEALED` ไม่ขึ้น `CONFIRMED` | ปกติถ้าไม่ได้ตั้ง blockchain — `anchorSealedBatches()` จะตามไป anchor ให้เองเมื่อ config ครบ |

---

# ไฟล์อ้างอิง

| ไฟล์ | เกี่ยวตรงไหน |
|---|---|
| `docs/worklog/2026-09-22.md` | บันทึกเต็มของงานรอบที่แล้ว 10 หัวข้อ |
| `docs/plan/onboarding-and-repo-consolidation.md` | แผนเดิม (ปิดแล้ว) — เก็บไว้ดูเหตุผลการตัดสินใจ |
| `src/integrity/integrity.service.ts` | สถานะ batch + seal/anchor (คอมเมนต์หัวไฟล์อธิบายครบ) |
| `src/integrity/integrity.seal-without-anchor.spec.ts` | 7 เคสที่กัน regression ของงาน seal/anchor |
| `src/stats/stats.service.ts:148` | `INTACT_STATUSES` — ตัวที่ข้อ 1.1 ต้องไป sync ด้วย |
| `src/compliance/compliance.service.ts:85,112` | จุดที่ต้องแก้ในข้อ 1.1 |
| `cylis-dashboard/src/views/Reports.tsx:79,316,321` | จุดที่ต้องแก้ในข้อ 1.2 |
| `README.md` หัวข้อ Troubleshooting + Vault user lockout | เคสที่เจอบ่อยพร้อมคำสั่งแก้ |
