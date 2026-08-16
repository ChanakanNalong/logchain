# ISO 27001 ISMS Document
## Logchain — Cyber Security Log Integrity System on Blockchain

**Version:** 2.0
**Date:** 2026-08-14
**Prepared by:** Logchain Team

---

## 1. Scope

ระบบนี้ครอบคลุมการจัดเก็บ ตรวจสอบ และรับรองความสมบูรณ์ของ security log โดยใช้ blockchain technology
ประกอบด้วย NestJS Backend, PostgreSQL (primary + streaming-replication standby), Elasticsearch, Kafka,
Python FastAPI ML Detection, HashiCorp Vault (secret management), Blockchain anchoring layer,
Next.js Dashboard, Suricata และ Wazuh SIEM

> **Blockchain environment — current vs target**
> ระบบตอนนี้รันบน **Local Hardhat node** (dev chain, `http://127.0.0.1:8545`) ตามที่ตั้งค่าใน
> `.env.example` (`BLOCKCHAIN_RPC_URL`) และ `src/blockchain/blockchain.service.ts` เชื่อมต่อผ่าน
> `ethers.JsonRpcProvider` แบบ RPC URL เดียวไม่ผูกกับ network ใดโดยเฉพาะ — รองรับทั้ง Hardhat local
> และ Polygon Amoy โดยไม่ต้องแก้โค้ด
> **Target สำหรับ production คือ Polygon Amoy testnet** (ก่อนขึ้น mainnet) — ยังไม่ deploy จริง
> ห้ามอ้างว่าระบบ anchor บน Polygon Amoy อยู่แล้วในเอกสารชุดนี้หรือชุดอื่น จนกว่าจะ deploy และ
> อัปเดต `BLOCKCHAIN_RPC_URL` + `CONTRACT_ADDRESS` จริง

---

## 2. Information Security Policy

องค์กรมุ่งมั่นในการรักษาความลับ (Confidentiality) ความสมบูรณ์ (Integrity) ด้วย blockchain hash และความพร้อมใช้งาน (Availability) ของระบบ

---

## 3. Risk Register

| ID | Asset | Threat | Likelihood | Impact | Risk Level | Control |
|----|-------|--------|------------|--------|------------|---------|
| R01 | Log data | Unauthorized modification | Medium | High | HIGH | Blockchain hash verification |
| R02 | API endpoints | Unauthorized access | Medium | High | HIGH | JWT authentication |
| R03 | Database | Data breach | Low | Critical | HIGH | Encryption at rest, access control |
| R04 | Private keys | Key theft | Low | Critical | HIGH | HashiCorp Vault (AppRole auth), key rotation policy |
| R05 | Personal data (audit trail) | PDPA violation | Low | High | MEDIUM | Right-to-erasure endpoint (audit_access records) |
| R06 | Alert/audit over-retention | Data over-retention | Low | Medium | LOW | RetentionService cron, 90-day default |
| R07 | Container | Privilege escalation | Low | High | MEDIUM | Non-root container enforcement |
| R08 | Dependencies | Supply chain attack | Medium | High | HIGH | Trivy scan + npm audit CI (backend & frontend) |
| R09 | Vault unseal material (dev) | Master key on same disk as data | Medium | High | MEDIUM | Flagged dev-only compromise; production requires cloud KMS auto-unseal |

> **R06 correction:** `RetentionService` (`src/retention/retention.service.ts`) purges expired
> **`alerts`** and **`audit_access`** rows only. The `logs` table has no automated deletion — it is
> protected by a database-level write-only trigger (see A.10/A.18 below), so "90-day retention" does
> **not** apply to log content itself, only to derived alert/audit records. `retention_days` on each
> log row is currently reported (via `ComplianceService.getRetentionSnapshot`), not enforced.
>
> **R08 correction:** CI (`.github/workflows/security.yml`) currently runs `npm audit` for backend
> and frontend plus a Trivy filesystem scan. There is no `pip audit` step wired in yet for the Python
> detection service — treat that as a gap, not an implemented control.
>
> **R09** is new versus the previous revision of this document — see Key Rotation Policy §"Production
> hardening gaps" for the corresponding remediation plan.

---

## 4. Annex A Control Mapping

| Control | Description | Implementation |
|---------|-------------|----------------|
| A.8.1 | Asset Management | Log entries tracked with UUID, timestamp, source (`logs` table) |
| A.9.1 | Access Control Policy | JWT authentication (Keycloak-issued) required on every API endpoint |
| A.9.2 | User Access Management | 5 app roles provisioned/revoked via `AdminController` → Keycloak, allowlist-gated |
| A.9.4 | System Access Control | Role-based access (`RolesGuard` + `@Roles()`), `AuditInterceptor` logs all access |
| A.10.1 | Cryptographic Controls | SHA-256 leaf/root hashing (Merkle tree) anchored on-chain per log batch |
| A.12.4 | Logging and Monitoring | Elasticsearch + Wazuh + ML anomaly detection + `audit_access` DB trail |
| A.12.6 | Vulnerability Management | Trivy filesystem scan + `npm audit` (backend & frontend) in CI |
| A.16.1 | Incident Management | Alert system with severity routing + email notify (HIGH/CRITICAL) |
| A.17.1 | Business Continuity | RTO/RPO defined in continuity plan; Postgres streaming replica standby |
| A.18.1 | Legal Compliance | PDPA right-to-erasure (audit trail), retention policy for alerts/audit records |

### 4.1 A.9 Access Control — detail

**Roles (source of truth: `src/admin/admin.constants.ts` `APP_ROLES`):**

| Role | Purpose |
|------|---------|
| `admin` | Full system administration, user/role management, PDPA erasure |
| `operator` | Operational access — batch sealing/verification, alert handling |
| `ingestor` | Log ingestion only |
| `analyst` | Read access for investigation (e.g. Merkle proof lookup) |
| `auditor` | Read-only compliance/audit review — **added most recently**, not present in v1.0 of this document |

Enforcement mechanism:
- Endpoint-level: `AuthGuard('jwt')` + `RolesGuard` + `@Roles(...)` decorator (e.g.
  `IntegrityController.getProof` → `analyst`, `operator`, `admin`; `AdminController` and
  `ErasureController` → `admin` only).
- Role assignment goes through a fixed allowlist (`APP_ROLES`), not the raw Keycloak role list —
  this specifically blocks an admin from self-granting `realm-management` roles (privilege
  escalation out of app scope). `AdminController` additionally guards against removing the last
  active admin and against an admin locking themselves out (self-guard), see
  `src/admin/admin.controller.ts`.

> **Open item — not yet closed:** there is an unresolved mismatch between the **4 original system
> roles** this ISMS was designed around (admin/operator/ingestor/analyst) and internal discussion of
> **6 clinical/domain roles** for a future healthcare-log use case. `auditor` (role #5) has been added
> to close part of the gap, but the full 6-role clinical model is not implemented. Do not represent
> the role model as finalized in audit evidence until this is resolved.

### 4.2 A.12.4 Logging and Monitoring — detail

- Every HTTP request is captured by the global `AuditInterceptor` (`src/common/interceptors/audit.interceptor.ts`)
  and written to `audit_access` (fire-and-forget — audit failure never blocks the request) —
  captures `user_id`, `action` (`METHOD path`), `resource`, `status_code`, `ip_address`, `duration_ms`.
- `AdminController` writes a **second**, more specific audit entry for privilege changes
  (`ROLE_ASSIGN` / `ROLE_REVOKE` / `USER_ENABLE` / `USER_DISABLE`) so "who changed whose role" is
  answerable directly, not just "someone called this endpoint".
- `/health` and `/metrics` are excluded from the audit trail (noise reduction).
- Elasticsearch + Wazuh SIEM + Python FastAPI ML detection provide network/host-level monitoring in
  parallel to the application-level audit trail above.

### 4.3 A.10 Cryptographic Controls — detail

- Each log's `raw_hash` (SHA-256, `char(64)`) is computed at ingestion time and stored immutably in
  `logs.raw_hash`.
- `IntegrityService.sealBatch()` groups up to 100 unmapped logs, builds a Merkle tree over their
  `raw_hash` leaves (`MerkleService`, `sha256` leaf hashing, `sortPairs: true`), and records the
  resulting root in `batches.merkle_root`.
- The Merkle root is anchored on-chain via `BlockchainService.storeRoot()` (current chain = Local
  Hardhat, target = Polygon Amoy — see Scope above); the returned `txHash`/`blockNumber` are stored
  on the `batches` row and the batch transitions `PENDING → CONFIRMED`.
- `IntegrityService.verifyAllBatches()` re-derives the Merkle root from current DB rows and compares
  against the on-chain root (`MATCH` / `MISSING` / `MISMATCH`) — a `MISMATCH` raises a `CRITICAL`
  `INTEGRITY_TAMPERED` alert.
- Private key material for signing anchor transactions is never read from `.env` — it is fetched
  from HashiCorp Vault at `secret/logchain/blockchain` (see Key Rotation Policy).

---

## 5. Statement of Applicability (SoA)

| Control | Applicable | Justification |
|---------|:----------:|----------------|
| A.8 Asset Management | Yes | Log/batch/alert entities are the primary information assets |
| A.9 Access Control | Yes | JWT + Keycloak RBAC across 5 roles; enforced at every controller |
| A.10 Cryptography | Yes | SHA-256 + Merkle anchoring is the core integrity mechanism of the product |
| A.11 Physical Security | No | No owned datacenter/physical facility — cloud/local dev deployment |
| A.12 Operations Security | Yes | Logging/monitoring (A.12.4), vulnerability mgmt (A.12.6) implemented |
| A.13 Communications Security | Partial | TLS/HTTPS assumed at ingress; Vault currently runs `tls_disable=1` in dev (see Key Rotation Policy — production gap) |
| A.14 System Acquisition/Development | Partial | CI security scan exists; no formal SDLC/secure-coding standard documented yet |
| A.15 Supplier Relationships | No | No third-party processor handles regulated data in current scope |
| A.16 Incident Management | Yes | Alert severity routing + email notification on HIGH/CRITICAL |
| A.17 Business Continuity | Yes | RTO/RPO targets defined, Postgres standby, Vault unseal recovery documented |
| A.18 Compliance | Yes | PDPA erasure endpoint, PCI SAQ-A evidence package, this ISMS |

---

## 6. Internal Audit Plan

| Audit Item | Frequency | Responsible |
|------------|-----------|-------------|
| Access log review | Monthly | Person 2 |
| Blockchain hash verification | Weekly | Person 1 |
| Vulnerability scan (Trivy) | Every push | GitHub Actions |
| Retention policy enforcement | Daily cron | Person 2 |
| Alert review | Daily | Person 2 |
