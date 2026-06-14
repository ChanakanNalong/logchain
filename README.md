# LogChain

NestJS API gateway สำหรับ **log ingestion** ที่ออกแบบตามแนวทาง **PCI DSS** — มี PII masking,
ความสมบูรณ์ของ log แบบ Merkle batch + anchoring บน blockchain, การส่งต่อไป Kafka เพื่อ detection,
authentication/RBAC ผ่าน Keycloak (OIDC/JWT) และ Prometheus metrics.

---

## คุณสมบัติหลัก

- **Ingestion + PII masking** — mask PII ก่อน hash เสมอ (PCI DSS Req 3); PAN ไม่เคยเข้า hash function
- **Integrity (M2)** — Merkle batch + per-log proof + tamper detection, anchor `merkleRoot` ลง blockchain
- **Streaming** — ส่ง log ไป Kafka (KRaft mode) ให้ detection service วิเคราะห์
- **AuthN/AuthZ** — Keycloak OIDC/JWT (RS256 + JWKS), RBAC ผ่าน realm roles + `RolesGuard`
- **Observability** — Prometheus metrics, health checks, Swagger (`@ApiTags`)
- **PCI Req 8 hardening** — ดูหัวข้อ [Authentication & PCI DSS Req 8](#authentication--pci-dss-req-8) ด้านล่าง

## Stack

| ส่วน | เทคโนโลยี |
|---|---|
| Framework | NestJS 11 (TypeScript) |
| Database | PostgreSQL 16 + TypeORM |
| Messaging | Kafka 3.7 (KRaft, ไม่มี Zookeeper) |
| Identity | Keycloak 24 (OIDC/JWT) |
| Blockchain | ethers v6 (Hardhat local node) |
| Metrics/Docs | Prometheus, Swagger |

---

## Prerequisites

- Node.js + npm
- Docker + Docker Compose
- (สำหรับ blockchain) Hardhat local node

## Setup & Run

```bash
# 1. ติดตั้ง dependencies
npm install

# 2. เตรียม environment — คัดลอกแล้วเติมค่า secret (ดู .env.example)
cp .env.example .env
#    .env ถูก gitignore แล้ว — ห้าม commit secret จริง

# 3. ยก infrastructure (postgres + keycloak + kafka)
docker compose up -d

# 4. harden master realm ของ Keycloak (รันครั้งเดียวหลัง stack ขึ้น)
./scripts/harden-master-admin.sh

# 5. รันแอป
npm run start:dev
```

> **หมายเหตุ:** Keycloak realm `logchain` ถูก import อัตโนมัติตอน startup โดยไม่มี secret hardcode —
> init container `keycloak-config` จะ render `infra/keycloak/realm-logchain.json.template`
> (แทนค่า `${...}` จาก `.env`) ลง shared volume ก่อน Keycloak เริ่มทำงาน.

### Scripts

| Script | หน้าที่ |
|---|---|
| `scripts/ingest-log.sh` | ingestion path — ขอ token ด้วย `client_credentials` แล้ว POST log |
| `scripts/harden-master-admin.sh` | harden master realm (strong cred + MFA + automation service account, idempotent) |
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
src/
 ├─ logs/         ingestion, PII masking, entities
 ├─ integrity/    Merkle batch + per-log proof (M2)
 ├─ blockchain/   anchoring (ethers)
 ├─ kafka/        producer
 ├─ auth/         JwtStrategy, RolesGuard (Keycloak OIDC)
 ├─ audit/ alerts/ metrics/ health/ vault/
infra/
 ├─ keycloak/     realm-logchain.json.template
 └─ postgres/init/ 00-keycloak-db.sh
scripts/          ingest-log.sh, harden-master-admin.sh, deploy-contract.mjs
docs/             pci-req8-hardening-summary.html
```
