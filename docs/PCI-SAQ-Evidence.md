# PCI DSS SAQ-A Evidence Package
## Logchain — Cyber Security Log Integrity System

**Version:** 2.0
**Date:** 2026-08-14
**Prepared by:** Logchain Team

---

## CDE Scope

Logchain itself does not store cardholder data — it stores **security logs**, some of which
originate from systems inside the merchant's Cardholder Data Environment (CDE). Scope is tracked
per log entry, not per deployment:

- `logs.cde_scope` (`BOOLEAN NOT NULL DEFAULT FALSE`, indexed — `infra/postgres/init/schema.sql`)
  marks whether an individual log row originated from a CDE-adjacent source.
- The flag is caller-supplied at ingestion: `CreateLogDto.cdeScope` (`src/logs/dto/create-log.dto.ts`),
  defaults to `false`, persisted as `Log.cdeScope` (`src/logs/entities/log.entity.ts`).
- `KafkaProducerService.publishLog` (`src/kafka/kafka-producer.service.ts`) publishes every log to
  topic `logs.raw` with a message header `cde: "<true|false>"` carrying this flag downstream.
- The **detection service** (separate repo, `logchain-detection` — not in this repository) consumes
  `logs.raw` and is expected to publish CDE-scoped alerts to Kafka topic **`alerts.cde`** and
  everything else to **`alerts.raw`**. `KafkaConsumerService` in this repo (`src/kafka/kafka-consumer.service.ts`)
  subscribes to both topics and persists alerts via `AlertsService.createOrDedup` — the split exists
  so CDE-scoped alerts can be filtered/audited separately.
  > The exact rule that decides `alerts.cde` vs `alerts.raw` lives in the detection-service repo and
  > was **not** verified against source in this review — do not cite it as confirmed evidence without
  > checking that repo.
- `ComplianceService.getRetentionSnapshot` (`src/compliance/compliance.service.ts`) reports a
  `cdeScoped` count (`COUNT(*) FILTER (WHERE log.cde_scope)`) as part of the compliance report API,
  giving an auditable count of in-scope log volume.

---

## SAQ-A Checklist

| Req | Description | Status | Evidence |
|-----|-------------|--------|----------|
| 1.1 | Firewall configuration | PASS | Docker network isolation |
| 2.1 | No vendor-supplied defaults | PASS | Custom JWT secret, no default passwords |
| 3.1 | Protect stored data | PASS | PostgreSQL encryption at rest |
| 4.1 | Encrypt transmission | PASS | HTTPS enforced, TLS on Kafka |
| 5.1 | Anti-malware | PASS | Trivy scan in CI/CD |
| 6.1 | Secure development | PASS | GitHub Actions security workflow |
| 6.2 | Vulnerability scan | PASS | Trivy + npm audit (backend & frontend); pip audit not yet wired (E04) |
| 7.1 | Restrict access by need | PASS | JWT + Keycloak RBAC, 5 app roles (see ISO27001-ISMS §4.1) |
| 8.1 | Identify and authenticate | PASS | JWT authentication on all endpoints |
| 9.1 | Restrict physical access | N/A | Cloud/local deployment |
| 10.1 | Track and monitor access | PASS | AuditAccess entity logs all requests |
| 10.2 | Audit log retention | PASS | `alerts`/`audit_access` purged after 90 days (default); `logs` retained indefinitely by design (immutable) — see E05 |
| 11.1 | Vulnerability testing | PASS | Trivy CI scan on every push |
| 12.1 | Security policy | PASS | ISO 27001 ISMS document |

---

## Evidence Items

### E01 — JWT Authentication
- File: src/auth/auth.module.ts
- All endpoints protected by JWT guard

### E02 — Audit Logging
- File: src/common/interceptors/audit.interceptor.ts
- All API requests logged to audit_access table

### E03 — Blockchain Integrity
- Smart contract stores a Merkle root (SHA-256 leaves) per sealed log batch (`src/integrity/integrity.service.ts`, `src/integrity/service/merkle.service.ts`)
- Anchored via `src/blockchain/blockchain.service.ts` — **current chain: Local Hardhat** (`BLOCKCHAIN_RPC_URL=http://127.0.0.1:8545` in `.env.example`); **target for production: Polygon Amoy testnet**. Not yet deployed to Amoy — do not claim Polygon PoS/Amoy as the live anchor in attestations until redeployed.
- Signing key read from Vault (`secret/logchain/blockchain`), not `.env`

### E04 — Vulnerability Scanning
- File: `.github/workflows/security.yml`
- Runs `npm audit --audit-level=moderate` for backend and for `frontend/`, plus a Trivy filesystem scan (CRITICAL/HIGH, non-blocking)
- **Gap:** no `pip audit` step is wired into this workflow — the Python detection service lives in a separate repo (`logchain-detection`) and is out of scope for this CI file. Do not claim `pip audit` coverage from this repo's CI.

### E05 — Data Retention
- File: `src/retention/retention.service.ts`
- Daily cron (`RETENTION_DAYS`, default 90) deletes rows from `alerts` and `audit_access` older than the cutoff.
- **Correction from v1.0:** this does **not** delete rows from `logs`. The `logs` table is immutable
  by design (see Chain-of-Custody §Immutability / `infra/postgres/init/write_only_trigger.sql`) —
  attempting `DELETE`/`UPDATE` on `logs` raises `IMMUTABLE_LOG` at the database level. Per-log
  `retention_days` is only *reported* via `ComplianceService.getRetentionSnapshot`, not enforced by
  deletion. If regulatory retention limits ever require log deletion, that requires a separate,
  deliberate design decision (conflicts with immutability) — currently out of scope.

### E06 — PDPA Erasure
- File: `src/erasure/erasure.service.ts`, `src/erasure/erasure.controller.ts`
- `DELETE /api/v1/erasure/user/:userId` (admin-only, `@Roles('admin')`)
- **Correction from v1.0:** this deletes **`audit_access`** rows keyed by `userId` — it does **not**
  touch the `logs` table (the `Log` entity has no `userId` column, and `logs` is immutable by
  trigger regardless). A SHA-256 tombstone (`hash(userId + deletedAt)`) is appended to
  `erasure-log.json` as erasure proof. Scope this evidence item as "erasure of a user's audit/access
  trail", not "erasure of all personal data across the system".

### E07 — Alert Monitoring
- File: `src/alerts/alerts.service.ts`
- HIGH/CRITICAL severity alerts trigger email via `NotificationService.sendAlertEmail`; dedup is enforced at the DB level (`idx_alerts_open_dedup` unique index, race-safe via 23505 handling)

### E08 — CDE Scope Tracking
- Files: `src/logs/entities/log.entity.ts`, `src/kafka/kafka-producer.service.ts`, `src/kafka/kafka-consumer.service.ts`
- Per-log `cde_scope` flag, propagated via Kafka header, alerts split across `alerts.raw` / `alerts.cde` topics — see "CDE Scope" section above

---

## Attestation

ข้าพเจ้าขอรับรองว่าระบบ Logchain ได้ดำเนินการตามมาตรการความปลอดภัยที่ระบุไว้ในเอกสารนี้

**Signed:** ______________________
**Date:** __________________ (v2.0 evidence current as of 2026-08-14)
