# LogChain

NestJS API gateway สำหรับ **log ingestion** ที่ออกแบบตามแนวทาง **PCI DSS** — มี PII masking,
ความสมบูรณ์ของ log แบบ Merkle batch + anchoring บน blockchain, การส่งต่อไป Kafka เพื่อ detection,
authentication/RBAC ผ่าน Keycloak (OIDC/JWT) และ Prometheus metrics.

---

## คุณสมบัติหลัก

- **Ingestion + PII masking** — mask PII ก่อน hash เสมอ (PCI DSS Req 3); PAN ไม่เคยเข้า hash function
- **Integrity (M2)** — Merkle batch + per-log proof + tamper detection, anchor `merkleRoot` ลง blockchain
- **Streaming** — ส่ง log ไป Kafka (KRaft mode) ให้ detection service วิเคราะห์
- **AuthN/AuthZ** — Keycloak OIDC/JWT (RS256 + JWKS), RBAC 5 roles (`admin` / `operator` / `ingestor` / `analyst` / `auditor`) ผ่าน realm roles + `RolesGuard`
- **Observability** — Prometheus metrics, health checks, Swagger (`@ApiTags`)
- **PCI Req 8 hardening** — ดูหัวข้อ [Authentication & PCI DSS Req 8](#authentication--pci-dss-req-8) ด้านล่าง

## Stack

| ส่วน | เทคโนโลยี |
|---|---|
| Framework | NestJS 11 (TypeScript) |
| Database | PostgreSQL 16 + TypeORM |
| Messaging | Kafka 3.7 (KRaft, ไม่มี Zookeeper) |
| Identity | Keycloak 24 (OIDC/JWT) |
| Blockchain | ethers v6 (Polygon Amoy testnet) |
| Metrics/Docs | Prometheus, Swagger |

---

## Prerequisites

- **Docker + Docker Compose v2** — จำเป็นอย่างเดียวถ้ารันผ่าน `bootstrap.sh`
- `openssl` (มากับ Linux/macOS อยู่แล้ว) — ใช้สุ่ม secret + สร้าง Kafka cert
- **Node.js 22** — เฉพาะตอนจะรัน backend บน host เอง (ดู `.nvmrc`)
  `package.json` engines = `^20.19.0 || ^22.12.0 || >=23.0.0` — node 18 พังตอน boot
  ด้วย `ERR_REQUIRE_ESM` เพราะ `jwks-rsa@4` ลาก `jose@6` ที่เป็น ESM-only
- (optional) Polygon Amoy testnet — contract `0xE2502FC14B55a6bA0925C53bC4FFd2744CeA15CD`
  (ตรวจสอบได้ที่ amoy.polygonscan.com)

> **ไม่ต้อง clone `logchain-contracts`** ถ้าใช้ contract ที่ deploy ไว้แล้วข้างบน —
> backend ฝัง minimal ABI 3 function ไว้เองที่ `src/blockchain/blockchain.service.ts`
> ไม่ได้ import artifact จาก repo นั้น เชื่อมกันผ่าน `CONTRACT_ADDRESS` ใน `.env` อย่างเดียว

---

## Setup & Run

### ทางลัด — คำสั่งเดียวจบ

```bash
git clone https://github.com/ChanakanNalong/logchain.git && cd logchain
./scripts/bootstrap.sh
```

จบแล้วเปิด **http://localhost:3003**

`bootstrap.sh` idempotent — รันซ้ำได้ ข้ามขั้นที่ทำไปแล้วเอง มันทำ 6 อย่าง:

| # | ขั้น | หมายเหตุ |
|---|---|---|
| 1 | `cp .env.example .env` + สุ่มค่าที่เป็น `CHANGE_ME` | ข้าม `BLOCKCHAIN_PRIVATE_KEY` ให้ใส่เอง |
| 2 | `infra/kafka/gen-certs.sh` | CA + broker cert 3 ใบ + client cert (nestjs, detection) |
| 3 | `docker compose up -d` เฉพาะ infra | postgres, keycloak, kafka×3, vault, prometheus, grafana |
| 4 | รอ `vault-init` แล้ว merge AppRole เข้า `.env` | `infra/vault/.secrets/approle.env` |
| 5 | `docker compose up -d --build` ฝั่งแอป | backend, dashboard, detection×2 |
| 6 | `scripts/harden-master-admin.sh` | master realm: strong cred + MFA + automation SA |

> ขั้นที่ 4 มีอยู่เพราะ backend กับ detection-consumer **ปฏิเสธที่จะ start** ถ้าไม่มี
> Vault AppRole — แต่ AppRole เพิ่งถูกสร้างหลัง Vault ขึ้น จึงต้องยกเป็น 2 รอบ

### ทำมือ

```bash
cp .env.example .env            # แล้วเติมค่า CHANGE_ME ทุกตัว
./infra/kafka/gen-certs.sh      # ขาดขั้นนี้ kafka SSL listener ขึ้นไม่ได้
docker compose up -d            # vault-unseal init + unseal ให้เองอัตโนมัติ
                                # AppRole โผล่ที่ infra/vault/.secrets/approle.env
                                # -> ก๊อป VAULT_* 4 ตัวลง .env แล้ว up ซ้ำ
docker compose up -d backend detection-consumer
./scripts/harden-master-admin.sh
```

### โหมด dev — รัน backend บน host

```bash
docker compose up -d                        # infra ทั้งหมด
docker compose stop backend                 # กันชนพอร์ต 3000
nvm use                                     # อ่าน .nvmrc -> node 22.19.0
npm install && npm run start:dev
```

`.env` เขียนค่าไว้สำหรับโหมดนี้ (`localhost:5433`, `localhost:29092`, …)
โหมด compose ใช้ `environment:` ใน `docker-compose.yml` override เป็นชื่อ service ให้เอง

> **หมายเหตุ:** Keycloak realm `logchain` ถูก import อัตโนมัติตอน startup โดยไม่มี secret hardcode —
> init container `keycloak-config` จะ render `infra/keycloak/realm-logchain.json.template`
> (แทนค่า `${...}` จาก `.env`) ลง shared volume ก่อน Keycloak เริ่มทำงาน.

> **หมายเหตุ:** Kafka topic (`logs.raw`, `logs.raw.dlq`, `alerts.raw`, `alerts.cde`) ถูกสร้าง
> โดย init container `kafka-init` หลัง broker ทั้ง 3 ตัว healthy — ไม่ต้องสร้างเองหลัง
> `docker compose down -v` ไม่ควรพึ่ง auto-create เพราะ alert จะหายเงียบ ๆ ถ้า topic ไม่มี
> ดู [docs/runbooks/kafka-topics.md](docs/runbooks/kafka-topics.md)

> **ไม่มี detection service ก็ใช้งานได้** — ingest / masking / Merkle seal / anchoring /
> verify / dashboard ทำงานครบ **แค่ไม่มี alert** เพราะ backend เป็นฝั่ง *consume*
> `alerts.raw` / `alerts.cde` ซึ่ง detection-consumer เป็นคน publish

> ⚠️ **แต่ถ้าไม่ตั้ง blockchain จะไม่มี Merkle integrity เลย** — `sealBatch()`
> ตรวจ `blockchain.ready` เป็นอย่างแรกแล้ว return ทันทีถ้าไม่พร้อม
> (`src/integrity/integrity.service.ts:35`) ผลคือ**ไม่มี batch สักก้อน** จึงไม่มี
> Merkle root / per-log proof / tamper detection ให้ดูด้วย
> ต้องมีครบทั้ง `CONTRACT_ADDRESS` (0x + 40 hex) และ private key ใน Vault
> ถึงจะได้ฟีเจอร์ M2 ทั้งชุด

---

## Ports

| Service | URL | หมายเหตุ |
|---|---|---|
| dashboard (Next.js) | http://localhost:3003 | เริ่มที่นี่ — login ผ่าน Keycloak |
| backend (NestJS) | http://localhost:3000 | `/health`, `/metrics`, `/api`, `/api/v1/*` |
| detection (FastAPI) | http://localhost:8000 | `/health`, `/metrics`, `/api/v1/detect` |
| keycloak | http://localhost:8080 | admin console |
| grafana | http://localhost:3002 | user `admin` |
| prometheus | http://localhost:9090 | |
| vault | http://localhost:8200 | |
| postgres | `localhost:5433` | 5432 ถูก native postgres จองไว้บนเครื่อง dev |
| postgres-standby | `localhost:5434` | hot standby (pg_basebackup) |
| kafka EXTERNAL (PLAINTEXT) | `localhost:29092-29094` | |
| kafka SSL (mTLS) | `localhost:39092-39094` | |
| detection-consumer metrics | `localhost:9101` | ไม่ได้ publish ออก host |

`/health` กับ `/metrics` อยู่**นอก** global prefix `api/v1` โดยตั้งใจ —
คือ `/health` ไม่ใช่ `/api/v1/health`

---

## Troubleshooting

| อาการ | สาเหตุ | แก้ |
|---|---|---|
| `kafka-1/2/3` วน restart, log ว่า *No matching PRIVATE KEY entries in PEM file* | ไม่มี `infra/kafka/certs/` (gitignored) | `./infra/kafka/gen-certs.sh` แล้ว `docker compose up -d --force-recreate kafka-1 kafka-2 kafka-3` |
| Keycloak ขึ้นแต่ไม่มี realm `logchain` / client secret ว่าง | `.env` ยังเป็น `CHANGE_ME` ตอน `keycloak-config` render template | เติม `.env` → `docker compose up -d --force-recreate keycloak-config keycloak` |
| `backend` วน restart: *Vault config missing* หรือ *Vault login failed* | `VAULT_NESTJS_ROLE_ID` / `_SECRET_ID` ยังไม่อยู่ใน `.env` | `./scripts/bootstrap.sh` (ข้ามขั้นที่ทำแล้วเอง) หรือก๊อปจาก `infra/vault/.secrets/approle.env` |
| `detection-consumer` วน restart: *Vault config missing* | เหมือนข้างบน แต่เป็นคู่ `VAULT_DETECTION_*` | เหมือนข้างบน |
| `backend` / `detection-consumer` ขึ้น ***permission denied*** ตอน approle login ทั้งที่ค่าใน `.env` ถูกแล้ว | **Vault User Lockout** — login พลาดครบ 5 ครั้งแล้วโดนแบน alias 15 นาที หลังจากนั้นตอบ `permission denied` กับทุก request แม้รหัสถูก และ `restart: unless-stopped` จะวน retry ต่ออายุ lockout ไปเรื่อย ๆ ไม่หลุดเอง | ดูหัวข้อ [Vault user lockout](#vault-user-lockout) ด้านล่าง |
| `vault` healthy แต่ `vault-init` exit 1 *ไม่พบ /vault/secrets/init.env* | `vault-unseal` ยัง init ไม่เสร็จ | รอแล้ว `docker compose up -d vault-init` ซ้ำ |
| `postgres-standby` ขึ้นไม่ได้ | `REPLICATION_PASSWORD` ว่าง | เติมใน `.env` แล้ว `docker compose down -v` + bootstrap ใหม่ |
| ยิง `/api/v1/*` แล้วได้ **404** | global prefix / route ไม่ต่อ | ไม่ใช่เรื่อง auth — ดู log backend |
| ยิง `/api/v1/*` แล้วได้ **401** | ปกติ — แปลว่า route ต่อแล้ว แค่ยังไม่ได้แนบ token | `./scripts/ingest-log.sh` ขอ token ให้เอง |
| `verify-now` ตอบ **403** | token ไม่มี realm role `admin` | login ด้วยบัญชี admin หรือใช้ service account ที่มี role ครบ |
| `401 invalid issuer` ตอน backend อยู่ใน docker | `KEYCLOAK_URL` ถูก override เป็น `keycloak:8080` | `KEYCLOAK_URL` ต้องเป็น **public URL** (`localhost:8080`) เสมอ — ที่อยู่ภายในใช้ `KEYCLOAK_INTERNAL_URL` |
| dashboard login แล้ว redirect กลับมาเปล่า ๆ | `NEXT_PUBLIC_*` ถูกตั้งเป็นชื่อ service | ต้องเป็น `localhost` เสมอ (inline ตอน build + รันบนเบราว์เซอร์ซึ่งอยู่นอก docker network) — แก้แล้วต้อง `--build` ใหม่ |
| **ไม่มี batch เกิดขึ้นเลย** + log ขึ้น `Blockchain not ready - skip sealing` ทุกนาที | ไม่มี `CONTRACT_ADDRESS` / private key ใน Vault | `sealBatch()` return ทันทีถ้า blockchain ไม่พร้อม (`src/integrity/integrity.service.ts:35`) → **Merkle integrity ทั้งชุดไม่ทำงาน** ไม่ใช่แค่ไม่ anchor · ต้องตั้ง `CONTRACT_ADDRESS` + private key ถึงจะได้ batch/proof/tamper detection |
| batch ค้างที่ `UNVERIFIED` ไม่ขึ้น `CONFIRMED` | anchor ไปแล้วแต่ tx ยังไม่ confirm ใน `BLOCKCHAIN_TX_TIMEOUT_MS` | รอบ verify ถัดไปตามผลให้เอง — ไม่ใช่ `FAILED` |

### Vault user lockout

Vault 1.13+ เปิด user lockout มาโดย default — `lockout_threshold=5`, `lockout_duration=15m`
แอปทั้งสองตัว retry login 5 ครั้งตอน start พอดี **ใส่ secret ผิดครั้งเดียวก็ครบโควตาทันที**

อาการที่หลอกมากคือ error เปลี่ยนจาก `invalid role or secret ID` เป็น **`permission denied`**
ซึ่งทำให้เข้าใจผิดว่าเป็นเรื่อง policy — จริง ๆ คือโดนแบน และจะแบนต่อไปเรื่อย ๆ ตราบใดที่
container ยังวน retry อยู่ (ทุกครั้งที่พลาดคือรีเซ็ตนาฬิกา 15 นาทีใหม่)

**วิธีดูว่าใช่เคสนี้ไหม** — ดู log ของตัว Vault เอง ไม่ใช่ log ของแอป:

```bash
docker logs --tail=20 logchain-vault | grep -i lockout
# core: login attempts exceeded, user is locked out: request_path=auth/approle/login
```

**วิธีแก้** — ต้องหยุด container ที่วน retry ก่อน ไม่งั้น unlock ไปก็โดนล็อกซ้ำทันที:

```bash
docker compose stop detection-consumer          # หรือ backend แล้วแต่ตัวไหนพัง

# หา mount accessor ของ approle
ACC=$(docker exec logchain-vault-unseal sh -c '. /vault/secrets/init.env
  VAULT_TOKEN=$VAULT_ROOT_TOKEN VAULT_ADDR=http://vault:8200 \
  vault auth list -detailed -format=json' | grep -o '"auth_approle_[a-z0-9]*"' | head -1 | tr -d '"')

# alias ที่ถูกล็อกคือ role_id
RID=$(grep '^VAULT_DETECTION_ROLE_ID=' .env | cut -d= -f2-)

docker exec -e ACC="$ACC" -e RID="$RID" logchain-vault-unseal sh -c '. /vault/secrets/init.env
  VAULT_TOKEN=$VAULT_ROOT_TOKEN VAULT_ADDR=http://vault:8200 \
  vault write -f "sys/locked-users/$ACC/unlock/$RID"'

docker compose up -d detection-consumer
```

หรือถ้าไม่รีบ — **หยุด container ทิ้งไว้เฉย ๆ 15 นาที** lockout จะหมดอายุเอง

> ไม่ได้ปิด lockout ให้เป็น default เพราะ account lockout เป็น control ตาม PCI DSS Req 8.3.4
> ซึ่งเป็นแก่นของโปรเจกต์นี้ ถ้าอยากปิดเฉพาะตอน dev เพิ่ม block นี้ใน `infra/vault/config/vault.hcl`
> แล้ว `docker compose restart vault`:
> ```hcl
> user_lockout "approle" {
>   disable_lockout = true
> }
> ```

เริ่มใหม่หมดจด (ลบ data ทั้งหมด):

```bash
docker compose down -v
rm -rf infra/vault/.secrets infra/kafka/certs .env detection/.env
./scripts/bootstrap.sh
```

### Scripts

| Script | หน้าที่ |
|---|---|
| `scripts/bootstrap.sh` | onboarding ครบวงจร (idempotent) — ใช้ตัวนี้ตัวเดียวก็พอ |
| `scripts/ingest-log.sh` | ingestion path — ขอ token ด้วย `client_credentials` แล้ว POST log |
| `scripts/harden-master-admin.sh` | harden master realm (strong cred + MFA + automation service account, idempotent) |
| `scripts/check-tracked-secrets.sh` | ตรวจว่าไม่มี `.env` / key / cert หลุดเข้า git |
| `scripts/demo-brute-force.sh` | ยิง log รัว ๆ ให้ detection จับได้ → alert โผล่ที่หน้า Alerts (ต้องใช้ token ที่มี role `analyst`/`operator`/`admin` ไม่งั้นขั้นสุดท้ายที่ไปอ่าน `/alerts` ได้ 403 ทั้งที่ alert ถูกบันทึกแล้ว) |
| `scripts/demo-tamper.sh` | แก้ log ในฐานข้อมูลตรง ๆ → Merkle verify จับได้ |
| `scripts/demo-mtls.sh` | ต่อ Kafka ผ่าน SSL listener (39092-39094) |
| `infra/kafka/gen-certs.sh` | สร้าง CA + cert ของ broker/client (อายุ 825 วัน) |
| `npm run deploy:contract` | deploy smart contract สำหรับ anchoring |

---

## API Endpoints

| Method | Path | Roles | คำอธิบาย |
|---|---|---|---|
| `POST` | `/api/v1/logs` | `ingestor`, `admin` | Ingest log (mask → hash) |
| `GET` | `/api/v1/logs` | `analyst`, `operator`, `admin` | รายการ log ล่าสุด |
| `GET` | `/api/v1/logs/:id` | `analyst`, `operator`, `admin` | log ตาม ID |
| `GET` | `/api/v1/logs/:id/proof` | `analyst`, `operator`, `admin` | Merkle proof ของ log |
| `GET` | `/health` | — | Health check |

ทุก endpoint ของ logs/integrity ป้องกันด้วย `AuthGuard('jwt')` + `RolesGuard` (Bearer token).
ระบบมี 5 roles: `admin` / `operator` / `ingestor` / `analyst` / `auditor` — หน้า Reports ผูกกับ role `auditor`.

---

## Authentication & PCI DSS Req 8

ระบบ auth ทำตาม PCI DSS Requirement 8 (*Identify Users & Authenticate Access*) แบ่งเป็น 2 ส่วน:
(A) `logchain` realm และ (B) `master` realm. **โค้ด M1 auth (RolesGuard/JwtStrategy) และ M2 (Merkle integrity) ไม่ถูกแตะต้อง.**

> เอกสารฉบับเต็มแบบ HTML: [`docs/pci-req8-hardening-summary.html`](docs/pci-req8-hardening-summary.html)

### ส่วน A — `logchain` realm

| Item | Req | สิ่งที่ทำ |
|---|---|---|
| 3 | 8.6 | Service account สำหรับ ingestion — client `log-ingestor` (confidential, client_credentials); ปิด ROPC ของ `api-gateway`; ลบ user `ingestor-service` |
| 1 | 8.3.6 | Password policy: `length(12)` + digit + upper + lower + notUsername + `passwordHistory(4)` |
| 2 | 8.4 | MFA conditional OTP — browser flow บังคับ TOTP เฉพาะ role `admin` |
| 4 | 2.2.2 | Externalize secrets ไป `.env`; render realm จาก template; compose ใช้ `${VAR}` |

**MFA flow (logchain realm):**

```
logchain-browser (top-level)
 ├─ auth-cookie                      ALTERNATIVE
 ├─ identity-provider-redirector     ALTERNATIVE
 └─ logchain-browser-forms           ALTERNATIVE
     ├─ auth-username-password-form  REQUIRED
     └─ logchain-conditional-otp     CONDITIONAL
         ├─ conditional-user-role    REQUIRED   (condition.user.role = admin)
         └─ auth-otp-form            REQUIRED
```

**ผลทดสอบ (รันจริง):**

- ✅ `log-ingestor` client_credentials → token มี `roles:[ingestor]`; ingest สำเร็จ (PII masked → `card [PAN]`)
- ✅ admin ROPC ถูกปฏิเสธ: `unauthorized_client – Client not allowed for direct access grants`
- ✅ weak password ถูกปฏิเสธ: `HTTP 400 – must contain at least 1 upper case`
- ✅ ไม่มี secret จริงใน git-tracked file; realm import สำเร็จ

### ส่วน B — `master` realm

master realm ควบคุมทุก realm จึงเป็น identity ที่มีค่าสูงสุด — hardening ผ่าน `scripts/harden-master-admin.sh`
(idempotent, รันรวดเดียวบน fresh state ได้):

| การเปลี่ยนแปลง | รายละเอียด |
|---|---|
| Strong non-default admin | `admin/admin` → `kc-admin` + password แข็งแรงจาก `.env`; ลบ user `admin` |
| Password policy | เหมือน logchain realm |
| MFA | `CONFIGURE_TOTP` required action บน `kc-admin` + conditional-OTP browser flow |
| Automation SA | client `master-automation` (client_credentials) — **least-privilege**: `manage-realm, manage-users, manage-clients, view-realm` (ไม่ใช่ blanket `admin`) |

**ผลทดสอบ (รันจริงบน fresh state):**

- ✅ single clean run บน fresh state → hardened ครบ ไม่ต้องแก้มือ
- ✅ idempotent re-run = clean no-op (auth ผ่าน service account)
- ✅ default `admin/admin` ล้มเหลว: `invalid_grant – Invalid user credentials`
- ✅ `kc-admin` + password ถูกต้อง → gate ด้วย MFA: `Account is not fully set up`
- ✅ automation SA ได้ token โดยไม่โดน MFA; least-privilege confirmed (ไม่มี realm role `admin`)
- ✅ logchain realm + app log data preserved (logs rows ไม่ถูกลบ)

### การ automate Keycloak หลังเปิด MFA (CI/CD)

ใช้ **service-account client + `grant_type=client_credentials`** — token แบบนี้ไม่ผ่าน browser flow จึงไม่ติด MFA:

- authenticate เป็น service account แล้วเรียก Admin REST API (หรือ `kcadm.sh --client master-automation --secret …`)
- **least-privilege:** ให้เฉพาะ `realm-management` client roles ที่จำเป็น ไม่ให้ `admin` รวม
- เก็บ secret ใน CI secret store, rotate สม่ำเสมอ; assurance สูงขึ้นใช้ signed-JWT (`private_key_jwt`) หรือ mTLS
- หนึ่ง service account ต่อหนึ่ง consumer เพื่อ audit/revoke แยกกันได้

---

## Security notes

- `.env` ถูก gitignore — secret จริงทั้งหมดอยู่ในนั้น ไม่ถูก track. ใช้ `.env.example` เป็น reference (ค่า placeholder)
- ค่า secret ใน setup เป็น **DEV-ONLY** — ห้ามใช้ใน production; ต้อง generate/rotate ใหม่
- master admin TOTP ลงทะเบียนแบบ interactive ตอน login console ครั้งแรก (ไม่มี seed OTP secret โดยตั้งใจ)

## Project structure (ย่อ)

```
src/                    NestJS API gateway (Dockerfile ที่ root)
 ├─ logs/               ingestion, PII masking, entities
 ├─ integrity/          Merkle batch + per-log proof (M2)
 ├─ blockchain/         anchoring (ethers, inline ABI)
 ├─ kafka/              producer + consumer (alerts.raw / alerts.cde)
 ├─ auth/               JwtStrategy, RolesGuard (Keycloak OIDC)
 ├─ admin/              Keycloak Admin REST proxy
 └─ audit/ alerts/ metrics/ health/ vault/ stats/ compliance/ retention/ erasure/
cylis-dashboard/        Next.js 16 + React 19 dashboard (พอร์ต 3003) — ไม่ใช่ submodule
detection/              FastAPI + Kafka consumer (DeepLog) — ดู detection/README.md
infra/
 ├─ keycloak/           realm-logchain.json.template
 ├─ kafka/              create-topics.sh, gen-certs.sh, certs/ (gitignored)
 ├─ vault/              init.sh, unseal.sh, policies/, .secrets/ (gitignored)
 ├─ prometheus/ grafana/
 └─ postgres/init/      00-keycloak-db.sh, 01-replication-user.sh
scripts/                bootstrap.sh, ingest-log.sh, harden-master-admin.sh, demo-*.sh
docs/                   runbooks/, worklog/, plan/, pci-req8-hardening-summary.html
docker-compose.yml      20 service — infra + backend + dashboard + detection
```

**repo ที่เกี่ยวข้อง:** [`logchain-contracts`](https://github.com/ChanakanNalong/logchain-contracts)
(Solidity/Hardhat) แยกไว้ต่างหากโดยตั้งใจ — deploy ครั้งเดียวจบ และ backend ไม่ได้ import
อะไรจากมัน ผูกกันผ่าน `CONTRACT_ADDRESS` อย่างเดียว **ไม่ต้อง clone**
