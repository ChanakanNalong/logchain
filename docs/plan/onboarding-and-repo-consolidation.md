# แผนงาน — ทำให้ clone แล้วรันได้ + รวม repo

> **เอกสารนี้คืออะไร:** รายการสิ่งที่ต้องแก้ เขียนไว้ให้ session หน้า (คนหรือ Claude Code) อ่านแล้วลงมือได้เลย
> ไม่ต้องไปสืบใหม่ — ข้อเท็จจริงที่ตรวจสอบแล้วอยู่ในส่วน "ข้อมูลที่ยืนยันแล้ว" ด้านล่าง
>
> **สำรวจเมื่อ:** 2026-09-21 · **repo หลัก ณ ตอนเขียน:** `main` = `04cb56d`
>
> ## สถานะ — อัปเดต 2026-09-22
>
> | งาน | สถานะ |
> |---|---|
> | D — rotate Vault AppRole | ✅ ทำลาย secret_id เก่าทิ้ง 10 ใบ ออกใหม่ใบเดียว |
> | E — เคลียร์ repo detection เก่า | ✅ 33,341 → 14 ไฟล์ |
> | F — ย้ายไฟล์เข้า `detection/` | ✅ 17 ไฟล์ 332 KB |
> | G1 `requirements.txt` · G2 `Dockerfile` · G3 `README.md` | ✅ |
> | G4 — ลบ/archive repo เก่า | ✅ repo ถูกลบจาก GitHub แล้ว (404) |
> | A1 `Dockerfile` ของ backend | ✅ |
> | A2 service `backend` | ✅ |
> | A3 dashboard เข้า compose หลัก | ✅ |
> | A4 `detection-api` + `detection-consumer` | ✅ |
> | A5 healthcheck | ✅ |
> | B `scripts/bootstrap.sh` | ✅ |
> | C README | ✅ |
>
> ## ✅ แผนนี้จบครบทุกข้อแล้ว (A–G) — 2026-09-22
>
> ทดสอบตาม "เกณฑ์ว่าเสร็จแล้ว" ท้ายเอกสารด้วยการ **clone จาก GitHub จริงลงโฟลเดอร์เปล่า**
> แล้วรัน `./scripts/bootstrap.sh` รวดเดียว — ผ่านทุกข้อ (ดู worklog หัวข้อ 10)
>
> เหลือข้อเดียวที่ยังไม่ได้ยืนยัน: **login ผ่านเบราว์เซอร์ด้วยคนจริง**
> (ตรวจแล้วว่า client + redirect_uri ถูกตั้งถูกและบังคับ PKCE แต่ไม่ได้กรอกฟอร์มจริง)
> รายละเอียดสิ่งที่ทำไป + เรื่องที่แผนไม่ได้คาดไว้: `docs/worklog/2026-09-22.md`
>
> **ข้อที่เคย "ยังไม่ได้ตัดสินใจ" — ตัดสินแล้วทั้ง 4:**
> 1. `.env` 2 โหมด → override ใน `environment:` ของ compose (ตามที่แนะนำ)
> 2. detection → แยก 2 service จาก image เดียว (ตามที่แนะนำ)
> 3. `anomaly_label.csv` → **ไม่ commit** ใส่ `.gitignore` + เขียนวิธีโหลดใน `detection/README.md`
> 4. `cylis-dashboard/docker-compose.yml` → **เก็บไว้** สำหรับ dev เดี่ยว ๆ พร้อมหัวไฟล์เตือน

**โจทย์ 2 เรื่องที่ต้องแก้**

1. เพื่อน clone repo แล้วรัน `docker compose up` **ไม่ได้** — compose มีแต่ infra และของที่ต้องใช้บางอย่างถูก gitignore
2. โปรเจกต์กระจายอยู่ 3 โฟลเดอร์ — ตัดสินใจแล้วว่า **รวม `logchain-detection` เข้ามา / ปล่อย `logchain-contracts` แยกไว้** (เหตุผลอยู่ในส่วน 2.0)

---

# ข้อมูลที่ยืนยันแล้ว (ไม่ต้องไปตรวจซ้ำ)

## สถานะ repo ทั้ง 3

| repo | remote | branch บน remote | `.git` | commits | แก้ล่าสุด |
|---|---|---|---|---|---|
| `logchain` | `github.com/ChanakanNalong/logchain` | 13 branch, `main` ตรงกับ local | 23 MB | 101 | 2026-09-21 |
| `logchain-contracts` | `github.com/ChanakanNalong/logchain-contracts` | `main` ตรงกับ local (`e8dd3d0`) | 540 KB | 2 | 2026-09-08 |
| `logchain-detection` | `github.com/ChanakanNalong/logchain-detection` | **0 ref — ยังไม่ได้ push อะไรเลย** | **4.2 GB** | 2 | 2026-09-07 |

repo ทั้ง 3 เป็น **public** (ยืนยันด้วย HTTP 200 บนหน้า GitHub)

## docker-compose.yml มีอะไรบ้าง

16 service — **ทั้งหมดเป็น infra ไม่มีตัวแอปสักตัว**

```
postgres  postgres-standby  postgres-exporter
keycloak  keycloak-config
kafka-1  kafka-2  kafka-3  kafka-init  kafka-exporter
vault  vault-init  vault-unseal
prometheus  grafana  node-exporter
```

ที่**ไม่ได้**อยู่ใน compose: backend NestJS, dashboard, detection service

## port ที่ใช้อยู่

| service | port |
|---|---|
| backend (NestJS) | 3000 |
| grafana | 3002 |
| dashboard (Next.js) | 3003 |
| postgres | 5433 |
| postgres-standby | 5434 |
| detection (FastAPI) | 8000 |
| keycloak | 8080 |
| vault | 8200 |
| prometheus | 9090 |
| kafka EXTERNAL | 29092, 29093, 29094 |
| kafka SSL | 39092, 39093, 39094 |

## 3 อย่างที่ทำให้ `docker compose up` พังถ้าไม่เตรียมก่อน

| ขาด | ใครใช้ | ผล |
|---|---|---|
| `.env` (gitignored) | compose ใช้ `${VAR}` หลายที่ — `keycloak-config` render realm ด้วย `envsubst` จาก 4 ตัวแปร | realm import พัง, postgres password ว่าง |
| `infra/kafka/certs/` (gitignored) | `kafka-1/2/3` mount `./infra/kafka/certs/kafka-N:/opt/bitnami/kafka/config/certs:ro` และมี listener `SSL://:39092` | SSL listener ขึ้นไม่ได้ |
| `infra/vault/.secrets/` (gitignored) | `vault-init` mount `:ro`, `vault-unseal` mount rw | vault ไม่ถูก unseal |

`.env.example` มี 27 ตัวแปร ในนั้น **10 ตัวเป็น `CHANGE_ME` ที่ต้องเติมเอง**

```
DATABASE_URL                  (password ในสตริง)
POSTGRES_PASSWORD
KC_DB_PASSWORD
KEYCLOAK_ADMIN_PASSWORD       (>=12 ตัวอักษร)
KEYCLOAK_ADMIN_USER_PASSWORD  (>=12 ตัวอักษร)
MASTER_AUTOMATION_SECRET
LOGCHAIN_CLIENT_SECRET
LOGCHAIN_INGESTOR_SECRET
LOGCHAIN_ADMIN_CLIENT_SECRET
BLOCKCHAIN_PRIVATE_KEY
```

## logchain-detection มีอะไรจริง ๆ

**source จริงแค่ 15 ไฟล์ รวม 100 KB** — ที่เหลือคือ `venv/` กับ `data/` ที่ไม่ควร track

```
app/__init__.py  app/consumer.py  app/enrichment.py  app/main.py
app/model.py  app/rules.py  app/schemas.py  app/vault.py
deeplog.py  detect.py  parse_logs.py  prepare_data.py
rules/security_rules.yaml  FIXES-2026-07-15.md  .env
```

- `app/main.py` = **FastAPI** service, endpoint `/api/v1/detect` + `/metrics`, โหลดโมเดลตอน startup (lifespan)
- `app/consumer.py` = Kafka consumer/producer (`kafka-python`) อ่าน log แล้ว push alert
- ตัวแปรใน `.env` ของ detection: `KAFKA_BROKERS`, `DETECT_URL`, `VAULT_ADDR`, `VAULT_DETECTION_ROLE_ID`, `VAULT_DETECTION_SECRET_ID`

### dependency (อ่านจาก venv ที่ใช้งานอยู่จริง)

```
torch==2.12.0
fastapi==0.137.2
uvicorn==0.49.0
pydantic==2.13.4
kafka-python==3.0.2
drain3==0.9.11
geoip2==5.2.0
hvac==2.4.0
numpy==2.4.6
PyYAML==6.0.3
requests==2.34.2
python-dotenv==1.2.2
tqdm==4.68.2
prometheus-fastapi-instrumentator==8.0.2
```

(`prometheus-client` เป็น transitive dep ของ instrumentator ไม่ต้อง pin เอง)

> `torch` ที่ติดตั้งอยู่เป็นตัว CUDA (ลาก nvidia libs มา ~3 GB) — ตอนทำ `requirements.txt`
> ควรชี้ไป **CPU wheel** (`--index-url https://download.pytorch.org/whl/cpu`) เพราะ inference
> บน HDFS sequence ไม่ต้องใช้ GPU และมันทำให้ image เล็กลงมหาศาล

### ปัญหาที่ต้องแก้ก่อน push ได้

1. **`.env` ถูก track** — ข้างในมี `VAULT_DETECTION_ROLE_ID` / `VAULT_DETECTION_SECRET_ID` ยาว 36 ตัวอักษรทั้งคู่ (AppRole credential จริง ไม่ใช่ placeholder)
   **ยังไม่หลุด** เพราะยังไม่ได้ push — แต่ push เมื่อไหร่คือหลุดทันทีบน repo public
2. **`venv/` ถูก track 33,304 ไฟล์** และ `data/` ถูก track
3. **16 ไฟล์เกิน 100 MB** ซึ่งเป็นเพดานแข็งของ GitHub (repo ไม่ได้ใช้ LFS — ไม่มี `.gitattributes`)
   ```
   1505 MB  data/HDFS.log
    449 MB  venv/.../libtriton.so
    441 MB  venv/.../libtorch_cuda.so
    427 MB  venv/.../libtorch_cpu.so
    274 MB  venv/.../libcufft.so.12
    ... อีก 11 ไฟล์
   ```
4. **ไม่มี `requirements.txt` / `Dockerfile` / `pyproject.toml`**

> **สาเหตุร่วมของข้อ 1–3:** `.gitignore` มี `venv/`, `data/`, `.env` ครบแล้ว แต่ไฟล์ถูก commit
> **ก่อน** เพิ่ม rule — gitignore ไม่มีผลย้อนหลังกับไฟล์ที่ track ไปแล้ว ต้อง `git rm --cached`

## logchain-contracts ผูกกับ backend แค่ไหน

**แทบไม่ผูกเลย** — backend ไม่ได้ import ABI จาก repo นั้น มันฝัง minimal human-readable ABI
3 function ไว้เองที่ `src/blockchain/blockchain.service.ts:8`

เชื่อมกันผ่าน **string เดียว** คือ `CONTRACT_ADDRESS` ใน `.env`
contract ที่ deploy ไว้แล้วบน Polygon Amoy: `0xE2502FC14B55a6bA0925C53bC4FFd2744CeA15CD`

blockchain เป็น optional — `blockchain.service.ts:77` ถ้าไม่มี key หรือ address จะ log
`"Blockchain config missing - integrity disabled"` แล้วไปต่อ ไม่ crash
(private key มาจาก **Vault** ไม่ใช่ `.env` โดยตรง)

## ไฟล์ใน detection/data/ — เอาอันไหนเข้า repo

| ไฟล์ | ขนาด | ทำยังไง | เหตุผล |
|---|---|---|---|
| `drain_state.json` | 4 KB | **commit** | state ที่ train แล้ว 47 template สร้างใหม่ยาก |
| `deeplog_model.pt` | 217 KB | **commit** | โมเดลที่ train แล้ว ขาดไม่ได้ |
| `HDFS.log` | 1.5 GB | ดาวน์โหลด | public dataset (logpai/loghub) |
| `anomaly_label.csv` | 18 MB | ดาวน์โหลด | มากับ dataset เดียวกัน |
| `hdfs_sequences.csv` | 48 MB | regenerate | derive ได้จาก `prepare_data.py` |
| `train.txt` / `test_*.txt` | 30 MB | regenerate | เหมือนกัน |
| `GeoLite2-City.mmdb` | 66 MB | ดาวน์โหลด | ของ MaxMind ต้องสมัครบัญชี — **เช็ค license ก่อนแจกจ่ายซ้ำ** |

> **สำคัญ:** ระบบหลัก (ingest → seal → anchor → verify → dashboard) **ไม่ต้องใช้ `data/` เลย**
> ต้องใช้ตอนจะ train ใหม่เท่านั้น เพื่อนรัน demo ได้โดยมีแค่ `drain_state.json` + `deeplog_model.pt`
> รวมกัน **221 KB**

---

# ส่วนที่ 1 — ทำให้ `docker compose up` รันได้จริง

## งาน A — เพิ่ม backend / dashboard / detection เข้า compose

**ตอนนี้:** compose ยกแต่ infra แล้ว README บอกให้ `npm run start:dev` เอง ส่วน dashboard
มี compose แยกที่ `cylis-dashboard/docker-compose.yml` และ detection ไม่มีที่ไหนเลย

**เป้าหมาย:** `docker compose up -d` ครั้งเดียวได้ทั้งระบบ

### A1. สร้าง `Dockerfile` ของ backend (ยังไม่มี)

- multi-stage: `node:22-alpine` build → `npm ci` → `npm run build` → runtime stage เอาแค่ `dist/` + `node_modules` (prod)
- ดู `.nvmrc` ของ repo หลักเพื่อ pin เวอร์ชัน node ให้ตรง
- `package.json` มี `engines.node: ^20.19.0 || ^22.12.0 || >=23.0.0`
- entrypoint `node dist/main`
- expose 3000

### A2. เพิ่ม service `backend` เข้า `docker-compose.yml`

- `depends_on`: postgres (healthy), keycloak, kafka-1/2/3 (healthy), vault-unseal
- env อ่านจาก `.env` เดิมได้เลย **แต่ต้องแก้ host** — ตอนรันใน compose network
  `localhost` ใช้ไม่ได้แล้ว ต้องเป็นชื่อ service:
  | ตัวแปร | ค่าเมื่อรันนอก docker | ค่าเมื่อรันใน compose |
  |---|---|---|
  | `DATABASE_URL` | `localhost:5433` | `postgres:5432` |
  | `KEYCLOAK_URL` | `localhost:8080` | `keycloak:8080` |
  | `KAFKA_BROKERS` | `localhost:29092,...` | `kafka-1:9092,kafka-2:9092,kafka-3:9092` |
  | `VAULT_ADDR` | `localhost:8200` | `vault:8200` |

  > **จุดที่ต้องตัดสินใจ:** จะทำยังไงให้ `.env` เดียวใช้ได้ทั้ง 2 โหมด
  > ทางเลือก: (ก) ใส่ค่า override ตรง ๆ ในบล็อก `environment:` ของ compose ทับ `.env`
  > — แนะนำทางนี้ ง่ายและเห็นชัด · (ข) แยก `.env.docker` · (ค) profile
- port `3000:3000`

### A3. ย้าย dashboard จาก compose แยกเข้ามารวม

`cylis-dashboard/Dockerfile` กับ `cylis-dashboard/docker-compose.yml` มีอยู่แล้ว ใช้ของเดิมได้

- ย้าย service `cylis-dashboard` เข้า compose หลัก โดย `build.context: ./cylis-dashboard`
- build args เดิมใช้ได้เลย (`NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_KEYCLOAK_URL`, `NEXT_PUBLIC_KEYCLOAK_REALM`, `NEXT_PUBLIC_KEYCLOAK_CLIENT_ID`)
- port `3003:3000`
- ⚠️ `NEXT_PUBLIC_*` เป็น **build-time** และรันบน**เบราว์เซอร์** → ต้องเป็น `localhost:3000` / `localhost:8080` เสมอ **ห้าม**เปลี่ยนเป็นชื่อ service เพราะเบราว์เซอร์อยู่นอก docker network
- ลบ `cylis-dashboard/docker-compose.yml` ทิ้งหลังย้ายเสร็จ (หรือเก็บไว้สำหรับ dev เดี่ยว ๆ แล้วเขียนหมายเหตุ)

### A4. เพิ่ม service `detection` (ทำหลังส่วนที่ 2 เสร็จ)

- `build.context: ./detection`
- รัน 2 process: FastAPI (`uvicorn app.main:app --port 8000`) + Kafka consumer (`app/consumer.py`)
  → **ตัดสินใจ:** จะแยกเป็น 2 service (`detection-api`, `detection-consumer`) หรือรวมใน container เดียว
  แนะนำ **แยก 2 service** จาก image เดียวกัน คนละ `command` — debug ง่ายกว่าและ restart แยกได้
- `depends_on`: kafka healthy, vault-unseal
- mount โมเดล: `./detection/data/deeplog_model.pt` + `drain_state.json` (221 KB commit ไว้ใน repo แล้ว)
- `environment`: `KAFKA_BROKERS=kafka-1:9092,...`, `DETECT_URL=http://detection-api:8000/api/v1/detect`, `VAULT_ADDR=http://vault:8200`
- port `8000:8000` (ถ้าอยากเรียกจาก host)
- ✅ ไม่มี `GeoLite2-City.mmdb` ก็ไม่พัง — `app/enrichment.py:25` เช็ค `GEOLITE_PATH.exists()`
  ถ้าไม่เจอจะ log warning `"GeoLite2 not found - geo enrichment disabled"` แล้วไปต่อ
  (alert ยังออก แค่ไม่มีข้อมูล geo) **ไม่ต้องแก้โค้ด**

### A5. เพิ่ม healthcheck ให้ครบ

service ที่ `depends_on` ควรใช้ `condition: service_healthy` ไม่ใช่แค่ `service_started`
— postgres/kafka มี healthcheck แล้ว ส่วน backend/detection ต้องเพิ่มเอง
(backend มี `/health` จาก `@nestjs/terminus` อยู่แล้ว — `main.ts` exclude ออกจาก global prefix)

## งาน B — จัดการของที่ถูก gitignore

ทางเลือก 2 แบบ **เลือกแบบใดแบบหนึ่ง**

### แบบที่ 1 (แนะนำ) — สคริปต์ bootstrap ตัวเดียวจบ

สร้าง `scripts/bootstrap.sh` ที่ทำตามลำดับ:

```
1. ถ้าไม่มี .env  -> cp .env.example .env แล้วสุ่มค่าให้ทุกตัวที่เป็น CHANGE_ME
                     (openssl rand -base64 32) ยกเว้น BLOCKCHAIN_PRIVATE_KEY
                     ที่ต้องให้คนใส่เอง หรือปล่อยว่างแล้ว integrity ปิดไปเอง
2. ถ้าไม่มี infra/kafka/certs -> ./infra/kafka/gen-certs.sh
3. docker compose up -d
4. รอ vault healthy -> ./infra/vault/unseal.sh (idempotent อยู่แล้ว: init ครั้งเดียว
                       แล้ววนเฝ้า unseal ให้เอง)
5. ./scripts/harden-master-admin.sh
6. บอก URL ที่เปิดได้ + บัญชีที่ใช้ login
```

ให้ `bootstrap.sh` **idempotent** — รันซ้ำได้ไม่พัง ข้ามขั้นที่ทำไปแล้ว

> `gen-certs.sh` มีอยู่แล้ว (`infra/kafka/gen-certs.sh`) สร้าง CA + cert ของ broker ทั้ง 3
> อายุ 825 วัน มี SAN ครอบทั้งชื่อใน docker network และ localhost
> `unseal.sh` มีอยู่แล้ว (`infra/vault/unseal.sh`) — init ครั้งแรกครั้งเดียว เก็บ unseal key
> ลง `init.env` แล้ววนเฝ้า (มีคอมเมนต์เตือนว่า DEV ONLY เพราะเก็บ key เป็น plaintext)

### แบบที่ 2 — ใส่ certs/dev secrets ลง repo ตรง ๆ

**ไม่แนะนำ** สำหรับ repo public แม้จะเป็น dev cert ก็ตาม — ทำให้คนแยกไม่ออกว่าอันไหน dev อันไหนจริง
และขัดกับที่ `.gitignore` ตั้งใจกันไว้ (มีคอมเมนต์ระบุว่าเคยมี `.env` หลุดขึ้น public repo มาแล้ว)

## งาน C — อัปเดต README

ตอนนี้ README ข้อ 1–5 **ตกไป 3 อย่าง**

| ตก | ต้องเพิ่ม |
|---|---|
| `gen-certs.sh` | ระหว่างข้อ 2 กับ 3 |
| `unseal.sh` | หลัง `docker compose up -d` |
| dashboard | ไม่ได้พูดถึงเลยว่าต้องรันยังไง |

เพิ่มด้วย:
- ตาราง **port ทั้งหมด** (ก็อปจากส่วนบนของเอกสารนี้)
- หัวข้อ **Troubleshooting** — เคสที่เจอบ่อย: kafka ขึ้นไม่ได้เพราะไม่มี cert, keycloak realm ไม่ถูก import เพราะ `.env` ว่าง, `verify-now` ตอบ 403 เพราะ token ไม่ใช่ admin
- ระบุชัดว่า **ไม่ต้อง clone `logchain-contracts`** ถ้าใช้ contract ที่ deploy ไว้แล้ว
- ระบุว่าถ้าไม่มี detection service ระบบยังใช้ได้ **แค่ไม่มี alert** (backend เป็นฝั่ง consume `alerts.raw` / `alerts.cde`)

---

# ส่วนที่ 2 — รวม repo

## 2.0 ข้อสรุปและเหตุผล (ตัดสินใจไปแล้ว — ไม่ต้องถกใหม่)

**รวม `logchain-detection` เข้า `logchain` · ปล่อย `logchain-contracts` แยกไว้**

| | detection → รวม | contracts → แยก |
|---|---|---|
| coupling | Kafka topic + schema ต้อง version ตรงกัน แก้ข้างเดียวพังเงียบ | string เดียวใน `.env` — backend ไม่ได้ import ABI จาก repo นั้น |
| ขนาด source | 15 ไฟล์ 100 KB | Hardhat + artifacts + ignition ที่ไม่มีใครใช้ตอนรัน |
| วงจรชีวิต | deploy พร้อมกับ backend เสมอ | deploy ครั้งเดียวจบ นิ่งตั้งแต่ 8 ก.ย. |
| toolchain | Python (ใกล้กัน) | Solidity/Hardhat (คนละโลก) |
| เพื่อนต้อง clone ไหม | ต้อง ถ้าอยากได้ alert | ไม่ต้อง |

## ⛔ ห้ามทำ

- **ห้าม** `git subtree add` / `git remote add` + merge history ของ detection เข้ามา
  → จะลาก `.git` 4.2 GB (venv + torch + HDFS.log) เข้ามาอยู่ใน logchain **ตลอดกาล**
  ลบทีหลังไม่ได้นอกจาก rewrite history ทั้ง repo
- **ห้าม** รวม contracts เข้ามา
- **ห้าม** commit `data/HDFS.log`, `venv/`, `GeoLite2-City.mmdb`

## งาน D — rotate Vault AppRole ก่อนอย่างอื่น 🔴

**ทำข้อนี้ก่อนเสมอ** เพราะ credential อยู่ใน git history ของ detection (ยังไม่ push แต่ทำไว้ก่อนปลอดภัยกว่า)

1. สร้าง `secret-id` ใหม่ให้ AppRole `detection` ใน Vault
   ```
   vault write -f auth/approle/role/detection/secret-id
   ```
   (ดู `infra/vault/policies/detection-policy.hcl` และ `infra/vault/init.sh` ว่า role ชื่ออะไรแน่)
2. เพิกถอนตัวเก่า (`vault write auth/approle/role/detection/secret-id-accessor/destroy ...`)
3. อัปเดตค่าใหม่ลง `.env` ของ detection (ไฟล์ที่ไม่ถูก track แล้ว)
4. ยืนยันว่า detection ยัง auth เข้า Vault ได้

## งาน E — เคลียร์ repo detection

```bash
cd ~/Documents/logchain-detection
git rm -r --cached venv data __pycache__ app/__pycache__ .env
git commit -m "chore: untrack venv, data, __pycache__ and .env"
```

> ⚠️ `git rm --cached` **ไม่ได้ลบออกจาก history** — blob ยังอยู่ใน `.git` 4.2 GB เท่าเดิม
> และไฟล์ >100 MB ยังทำให้ push ไม่ขึ้น
> **แต่ไม่ต้องไปแก้** เพราะเราจะไม่ push repo นี้อยู่แล้ว (งาน F คือ copy ไฟล์ไป repo ใหม่)
> repo เก่าเก็บไว้เฉย ๆ บนเครื่อง หรือ archive ทิ้ง

ถ้าอยากเก็บ repo นี้ไว้ใช้ต่อจริง ๆ ต้อง `git filter-repo` ล้าง history ซึ่งเสียเวลากว่ามาก
— **ไม่คุ้ม** เพราะ history มีแค่ 2 commit ที่เนื้อหาเป็นขยะ

## งาน F — ย้ายเข้า logchain

```bash
cd ~/Documents/logchain
mkdir -p detection
cp -r ~/Documents/logchain-detection/app              detection/
cp -r ~/Documents/logchain-detection/rules            detection/
cp ~/Documents/logchain-detection/{deeplog,detect,parse_logs,prepare_data}.py  detection/
cp ~/Documents/logchain-detection/FIXES-2026-07-15.md detection/
mkdir -p detection/data
cp ~/Documents/logchain-detection/data/drain_state.json    detection/data/
cp ~/Documents/logchain-detection/data/deeplog_model.pt    detection/data/
```

**ห้ามลอก `.env` มา** — สร้าง `detection/.env.example` แทน:

```
KAFKA_BROKERS=localhost:29092,localhost:29093,localhost:29094
DETECT_URL=http://localhost:8000/api/v1/detect
VAULT_ADDR=http://localhost:8200
VAULT_DETECTION_ROLE_ID=CHANGE_ME
VAULT_DETECTION_SECRET_ID=CHANGE_ME
```

เพิ่มใน `.gitignore` ของ repo หลัก:

```
# detection — dataset ใหญ่, โหลดเอง (ดู detection/README.md)
detection/data/HDFS.log
detection/data/HDFS_1.tar.gz
detection/data/anomaly_label.csv
detection/data/hdfs_sequences.csv
detection/data/train.txt
detection/data/test_*.txt
detection/data/GeoLite2-City.mmdb
detection/venv/
detection/__pycache__/
```

> สังเกตว่า **ไม่**ใส่ `detection/data/` ทั้งก้อน เพราะต้องให้ `drain_state.json`
> กับ `deeplog_model.pt` commit เข้าไปได้

**หลังย้ายเสร็จ ต้องรัน `scripts/check-tracked-secrets.sh` ยืนยันว่าไม่มี secret ติดไป**
(ตอนนี้สคริปต์บอก `✓ ไม่มีไฟล์ .env / key / cert ถูก track` — ต้องยังเป็นแบบนี้)

## งาน G — ทำให้ detection ติดตั้งได้

### G1. `detection/requirements.txt`

ใช้เวอร์ชันจากส่วน "ข้อมูลที่ยืนยันแล้ว" ด้านบน + ชี้ torch ไป CPU wheel

```
--extra-index-url https://download.pytorch.org/whl/cpu
torch==2.12.0
fastapi==0.137.2
uvicorn==0.49.0
pydantic==2.13.4
kafka-python==3.0.2
drain3==0.9.11
geoip2==5.2.0
hvac==2.4.0
numpy==2.4.6
PyYAML==6.0.3
requests==2.34.2
python-dotenv==1.2.2
tqdm==4.68.2
prometheus-fastapi-instrumentator==8.0.2
```

ทุกเวอร์ชันอ่านจาก venv ที่ใช้งานจริงแล้ว ไม่ต้องไปเช็คซ้ำ

### G2. `detection/Dockerfile`

- base `python:3.12-slim` (venv เดิมเป็น python3.12)
- `pip install --no-cache-dir -r requirements.txt`
- copy `app/`, `rules/`, `data/drain_state.json`, `data/deeplog_model.pt`
- default `CMD` = uvicorn; consumer ใช้ `command:` override ใน compose

### G3. `detection/README.md`

- วิธีโหลด dataset (ลิงก์ logpai/loghub) + คำสั่ง regenerate `prepare_data.py`
- วิธีโหลด GeoLite2 + หมายเหตุ license
- วิธี train ใหม่ (`deeplog.py`, `detect.py`)
- อธิบายว่ารัน demo ไม่ต้องใช้ dataset

### G4. ลบ / archive repo เก่า

หลังยืนยันว่าทุกอย่างในโครงใหม่ทำงานได้แล้วค่อยทำ — และ**ควรลบ repo `logchain-detection`
บน GitHub ทิ้ง** (ตอนนี้ว่างเปล่าอยู่แล้ว) จะได้ไม่มีใครเผลอ push ของเก่าขึ้นไป

---

# ลำดับที่แนะนำ

```
D (rotate secret)  ← ทำก่อนเสมอ
│
├─ E (เคลียร์ repo detection)
│  └─ F (ย้ายไฟล์เข้า logchain)
│     └─ G1,G2,G3 (requirements / Dockerfile / README)
│        └─ A4 (เพิ่ม detection เข้า compose)
│
├─ A1,A2 (Dockerfile + service ของ backend)
├─ A3 (ย้าย dashboard เข้า compose หลัก)
├─ A5 (healthcheck)
│
└─ B (bootstrap.sh)
   └─ C (README)   ← ทำท้ายสุด จะได้เขียนตามของจริงที่ทำเสร็จแล้ว
```

ทำ **D → E → F → G** ให้จบก่อนค่อยแตะ compose ก็ได้ หรือจะทำ **A1–A3 + B + C**
(ฝั่ง onboarding) ให้จบก่อนแล้วค่อยรวม repo ก็ได้ — สองสายนี้แยกกันได้ ไม่ชนกัน
ยกเว้น A4 ที่ต้องรอ F/G

---

# เกณฑ์ว่าเสร็จแล้ว

ทดสอบด้วยการ **clone ใหม่ลงโฟลเดอร์เปล่า** (ห้ามทดสอบบนโฟลเดอร์เดิมที่มี `.env` อยู่แล้ว
— จะไม่เจอปัญหาที่เพื่อนเจอ)

```bash
cd /tmp && rm -rf smoke && git clone https://github.com/ChanakanNalong/logchain.git smoke && cd smoke
./scripts/bootstrap.sh
```

ต้องได้ทั้งหมดนี้โดยไม่ต้องแก้อะไรเพิ่ม:

- [ ] `docker compose ps` — ทุก service เป็น `healthy` หรือ `running` ไม่มี `restarting`
- [ ] `curl -s localhost:3000/health` → 200
- [ ] `curl -s -o /dev/null -w '%{http_code}' localhost:3000/api/v1/stats/traffic` → **401** (ไม่ใช่ 404 — แปลว่า route ต่อแล้วแค่ยังไม่ได้ auth)
- [ ] `curl -s localhost:8000/api/v1/detect` ตอบได้ (detection ขึ้น)
- [ ] เปิด `localhost:3003` แล้ว login ผ่าน Keycloak ได้
- [ ] `./scripts/ingest-log.sh` ยิง log เข้าได้
- [ ] รอ cron seal 1 นาที แล้ว batch ขึ้น `CONFIRMED` (ถ้าใส่ `CONTRACT_ADDRESS` + key ไว้)
- [ ] `./scripts/demo-brute-force.sh` แล้วมี alert โผล่ที่หน้า Alerts (พิสูจน์ว่า detection ต่อกับ Kafka จริง)
- [ ] `./scripts/check-tracked-secrets.sh` → `✓ ไม่มีไฟล์ .env / key / cert ถูก track`
- [ ] `git ls-files | wc -l` ของ repo หลัก **ไม่ควรเพิ่มขึ้นเป็นหมื่น** (ถ้าเพิ่ม = เผลอ commit venv/data)

---

# เรื่องที่ยังไม่ได้ตัดสินใจ

1. **`.env` เดียวใช้ทั้งโหมด docker และโหมดรันเองยังไง** (งาน A2) — แนะนำ override ใน `environment:` ของ compose
2. **detection แยก 2 service หรือรวม container เดียว** (งาน A4) — แนะนำแยก
3. **จะ commit `anomaly_label.csv` (18 MB) ไหม** — ต่ำกว่าเพดาน 100 MB แต่ทำให้ clone ช้าลง
4. **จะเก็บ `cylis-dashboard/docker-compose.yml` ไว้ไหม** หลังย้ายเข้า compose หลัก

---

# อ้างอิงไฟล์ที่เกี่ยวข้อง

| ไฟล์ | เกี่ยวตรงไหน |
|---|---|
| `docker-compose.yml` | งาน A ทั้งหมด |
| `.env.example` | งาน A2, B |
| `infra/kafka/gen-certs.sh` | งาน B — มีอยู่แล้ว ใช้ได้เลย |
| `infra/vault/unseal.sh` | งาน B — มีอยู่แล้ว idempotent |
| `infra/vault/init.sh`, `infra/vault/policies/detection-policy.hcl` | งาน D — หาชื่อ AppRole |
| `scripts/harden-master-admin.sh` | งาน B ขั้นสุดท้าย |
| `scripts/check-tracked-secrets.sh` | งาน F — ยืนยันว่าไม่มี secret หลุด |
| `cylis-dashboard/Dockerfile` | งาน A3 — มีอยู่แล้ว |
| `src/blockchain/blockchain.service.ts:8,77` | ABI inline + จุดที่ blockchain เป็น optional |
| `src/kafka/kafka-consumer.service.ts:209` | topic ที่ backend ฟัง (`alerts.raw`, `alerts.cde`) |
| `README.md` | งาน C |
