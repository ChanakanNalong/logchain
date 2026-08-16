# Chain of Custody Form
## Logchain — Cyber Security Log Integrity System

**Version:** 2.0
**Date:** 2026-08-14

---

## Blockchain Anchor — Current vs Target

> **Current: Local Hardhat node** (dev chain, `BLOCKCHAIN_RPC_URL=http://127.0.0.1:8545` per
> `.env.example`). `src/blockchain/blockchain.service.ts` connects via a single configurable
> `ethers.JsonRpcProvider` URL, so the anchor target is an environment setting, not a code change.
> **Target for production: Polygon Amoy testnet** (pre-mainnet). Anchoring is **not** currently
> deployed to Amoy — every "Anchoring" step below happens on the local Hardhat chain until that
> migration happens. Do not represent this document as evidence of a Polygon Amoy anchor.

---

## Immutability & Write-Only Enforcement

Custody of a log record is protected at two independent layers:

1. **Database trigger** (`infra/postgres/init/write_only_trigger.sql`) — `trg_logs_no_delete` and
   `trg_logs_no_update` fire `BEFORE DELETE`/`BEFORE UPDATE` on the `logs` table and raise
   `IMMUTABLE_LOG: <op> not permitted on logs table` unconditionally. This applies to **every**
   database role, including the application's own Postgres user — there is no application-layer
   bypass, because the enforcement is not in the application layer.
2. **Schema design** — the batch a log belongs to is recorded in a separate `log_batch_mapping`
   table (`log_id` → `batch_id`), not by `UPDATE`-ing a `batch_id` column on `logs` itself
   (`infra/postgres/init/schema.sql`). Sealing a batch is therefore an `INSERT` into
   `log_batch_mapping`, never a mutation of the log row (`IntegrityService.sealBatch`,
   `src/integrity/integrity.service.ts`).

Consequence for custody: once a log row is written, its content, hash, and ingestion metadata are
fixed for the life of the system. The only downstream state that changes is *which batch a log has
been sealed into* and *whether that batch's on-chain anchor currently verifies* — both tracked in
`batches`/`log_batch_mapping`, never by touching `logs`.

---

## Log Evidence Chain of Custody

| # | Stage | What happens | Actor / Component | Evidence |
|---|-------|---------------|--------------------|----------|
| 1 | Ingestion | `POST /api/v1/logs` (JWT + role `ingestor` or `admin`, rate-limited 500/min) | `LogsController` → `LogService.ingest` | HTTP 201, `log.id` |
| 2 | PII masking | Message is masked **before** hashing — PAN/PII must never enter the hash function (PCI DSS Req 3) | `PiiMaskingService` | `PiiMaskingService.mask()` output used for hash input |
| 3 | Hashing | SHA-256 of `{source, eventType, message}` (masked) computed and stored | `LogService.ingest` → `logs.raw_hash` | `raw_hash` (char 64) |
| 4 | Storage | Row inserted into `logs` (Postgres); insert-only, immutable (see above) | `LogService.ingest` | `logs` row, `created_at` |
| 5 | Async fan-out | Log published to Kafka `logs.raw` (with `cde` header) for detection analysis — does not affect custody of the stored row | `KafkaProducerService.publishLog` | Kafka message |
| 6 | Batching | Up to 100 unmapped logs grouped; Merkle tree built over `raw_hash` leaves (SHA-256, `sortPairs: true`) | `IntegrityService.sealBatch` + `MerkleService` | `batches.merkle_root`, `log_batch_mapping` rows |
| 7 | Anchoring | Merkle root sent to smart contract `storeRoot()`; batch status `PENDING → CONFIRMED` on success | `BlockchainService.storeRoot` (Local Hardhat now, Polygon Amoy target) | `batches.tx_hash`, `batches.block_number` |
| 8 | Verification (continuous) | Root re-derived from current DB state and compared to on-chain root: `MATCH` / `MISSING` / `MISMATCH` | `IntegrityService.verifyAllBatches` | `batches.status`; `MISMATCH` raises `INTEGRITY_TAMPERED` CRITICAL alert |
| 9 | Verification (on demand) | Merkle proof for a single log, verified against the sealed root | `GET /api/v1/logs/:id/proof` (`analyst`/`operator`/`admin`) | `proof[]`, `verify: true/false` |
| 10 | Retention (alerts/audit only) | `alerts` and `audit_access` rows older than `RETENTION_DAYS` (default 90) are deleted. **`logs` rows are never deleted** — blocked by the DB trigger above regardless of age | `RetentionService` cron | Row counts in service logs |
| 11 | Erasure (PDPA, audit trail only) | `DELETE /api/v1/erasure/user/:userId` (admin-only) deletes that user's `audit_access` rows and appends a tombstone. **Does not touch `logs`** — `Log` has no `userId` column, and deletion would be rejected by the trigger anyway | `ErasureService` | Tombstone `{userId, requestedBy, deletedAt, recordsDeleted, hash}` in `erasure-log.json` |

---

## Who Can Access / Modify What

| Role | Ingest logs | Read logs / proof | Seal / verify batches | Admin (users, roles, erasure) |
|------|:-----------:|:------------------:|:----------------------:|:-------------------------------:|
| `admin` | Yes | Yes | Yes (operational endpoints allow `admin`) | Yes |
| `operator` | No | Yes | Yes | No |
| `ingestor` | Yes | No | No | No |
| `analyst` | No | Yes | No | No |
| `auditor` | No | — (read-only compliance/audit review; see ISO27001-ISMS §4.1 open item) | No | No |

Enforced by `AuthGuard('jwt')` + `RolesGuard` + `@Roles(...)` at every controller
(`src/logs/logs.controller.ts`, `src/integrity/integrity.controller.ts`, `src/admin/admin.controller.ts`,
`src/erasure/erasure.controller.ts`). **No role — including `admin` — can `DELETE` or `UPDATE` a row
in `logs`**; that guarantee lives in Postgres, not in the application's role checks, so it holds even
against a compromised or misconfigured backend.

Every request (success or failure) is recorded in `audit_access` via the global `AuditInterceptor`;
privilege changes (`ROLE_ASSIGN`/`ROLE_REVOKE`/`USER_ENABLE`/`USER_DISABLE`) get an additional,
more specific audit entry from `AdminController` naming the actor (from JWT `sub`, never trusted
from the request body) and the target.

---

## Custody Transfer Record

| Transfer # | From | To | Mechanism | Notes |
|------------|------|----|-----------|-------|
| T001 | Client / log source | `LogsController` (NestJS) | `POST /api/v1/logs`, JWT auth | Ingestion; PII masked before hash |
| T002 | `logs` row | Kafka `logs.raw` | `KafkaProducerService.publishLog` | Fan-out for detection; original row untouched |
| T003 | Unmapped `logs` rows | `batches` + `log_batch_mapping` | `IntegrityService.sealBatch` | Grouping into a Merkle tree, up to 100/batch |
| T004 | `batches.merkle_root` | Blockchain (Local Hardhat / target Polygon Amoy) | `BlockchainService.storeRoot` | On-chain anchor; `tx_hash` recorded on success |

---

## Signatures

| Role | Name | Signature | Date |
|------|------|-----------|------|
| Person 1 (Backend/Blockchain) | ChanakanNalong | ______ | ______ |
| Person 2 (Detection/ML) | Cyn903 | ______ | ______ |
| Person 3 (Log Collection) | ______ | ______ | ______ |
| Supervisor | ______ | ______ | ______ |
