# RTO/RPO & Compliance Sign-off
## Logchain — Cyber Security Log Integrity System

**Version:** 2.0
**Date:** 2026-08-14

---

## 1. RTO/RPO Definitions

| Component | RTO | RPO | Recovery Strategy |
|-----------|-----|-----|-------------------|
| NestJS Backend | 30 min | 1 hour | Restart container, restore from backup |
| PostgreSQL | **~5 min** | **~0–1 sec** | Promote streaming-replication standby (`docs/runbooks/postgres-failover.md`); `pg_restore` from backup only if both primary **and** standby are lost |
| Vault (secrets) | **Minutes** (auto) / **total loss** if `init.env` lost | N/A (secrets are static, not a data stream) | `vault-unseal` sidecar auto-unseals with 3-of-5 Shamir shares on restart; if `infra/vault/.secrets/init.env` is lost there is **no recovery** — wipe `vault_data`, re-init, and reseed from `.env` (dev only, see §2 below) |
| Elasticsearch | 2 hours | 24 hours | Snapshot restore |
| Kafka | 30 min | 1 hour | Restart broker, replay from offset |
| Blockchain Node | **Current (Local Hardhat): minutes, but in-memory state is lost on restart unless the node is run with persistent storage — treat every restart as a fresh chain requiring redeploy.** **Target (Polygon Amoy): N/A for us — chain persistence is the network's responsibility, not ours.** | N/A | Local Hardhat: restart node + redeploy contract + reseed `CONTRACT_ADDRESS`. Amoy (target): resync via public RPC, no local state to lose |
| ML Detection (FastAPI) | 30 min | N/A | Restart container |
| Frontend (Next.js) | 15 min | N/A | Redeploy static build |

---

## 2. Recovery Procedures

### Backend Failure
1. Check logs: `docker logs logchain-backend`
2. Restart: `docker-compose restart backend`
3. Verify health: `curl http://localhost:3000/health`

### Database Failure (PostgreSQL)
**Primary path — promote standby** (full steps: `docs/runbooks/postgres-failover.md`):
1. Confirm primary down: `docker exec logchain-postgres pg_isready -U logchain`
2. Confirm standby healthy: `docker exec logchain-postgres-standby pg_isready -U logchain`
3. Promote: `docker exec logchain-postgres-standby psql -U logchain -c "SELECT pg_promote();"`
4. Point app at the promoted instance (port 5434) and restart NestJS
5. Verify with a test write (`POST /api/v1/logs`, expect `201`)
6. Provision a fresh standby afterward via `pg_basebackup` from the new primary

**Fallback — both primary and standby lost:**
1. `pg_restore -d logchain backup.dump`
2. Verify data integrity — note this path has a real RPO gap (since-last-backup), unlike the
   near-zero RPO of standby promotion

### Vault Sealed / Unavailable
1. Under normal restart, `vault-unseal` sidecar auto-unseals — no manual step needed
   (`docker compose up` is sufficient; see `docs/runbooks/vault-key-rotation.md`)
2. If Vault stays sealed after restart: check whether `infra/vault/.secrets/init.env` exists and
   matches the current `vault_data` volume
3. If `init.env` is genuinely lost: **no unseal is possible** (Shamir shares are the only key to
   the data). Dev recovery: `docker compose down` → `docker volume rm logchain_vault_data` →
   `docker compose up -d vault vault-unseal` → `docker compose run --rm vault-init` (reseeds from
   `.env`). This is a **dev-only** recovery path — it works only because dev keeps a second copy of
   every secret in `.env`; production must not rely on this.

### Blockchain Node Failure
1. **Current (Local Hardhat):** restart node (`npx hardhat node`); because Hardhat's default state is
   in-memory, redeploy the contract and update `CONTRACT_ADDRESS` — verify `BlockchainService`
   reconnects (`this.logger.log('Blockchain connected: ...')`) and `txHash` lookups (`getRoot`) work
   again
2. **Target (Polygon Amoy, not yet in use):** no local node to restart — verify RPC connectivity to
   the public endpoint and that `CONTRACT_ADDRESS` still resolves on-chain

---

## 3. Compliance Sign-off Checklist

### From v1.0 (2026-06-04) — original scope

| Item | Status | Verified By | Date |
|------|--------|-------------|------|
| Alert dedup + severity routing | DONE | Cyn903 | 2026-06-04 |
| Email notification (HIGH/CRITICAL) | DONE | Cyn903 | 2026-06-04 |
| RetentionService cron 90 days (see correction below) | DONE | Cyn903 | 2026-06-04 |
| Next.js dashboard 3 pages | DONE | Cyn903 | 2026-06-04 |
| PDPA right-to-erasure endpoint (see correction below) | DONE | Cyn903 | 2026-06-04 |
| Trivy CI + GitHub Actions | DONE | Cyn903 | 2026-06-04 |
| ISO 27001 ISMS document | DONE | Cyn903 | 2026-06-04 |
| PCI SAQ evidence package | DONE | Cyn903 | 2026-06-04 |
| Integration tests | DONE | Cyn903 | 2026-06-04 |
| Chain of custody form | DONE | Cyn903 | 2026-06-04 |
| Key rotation runbook | DONE | Cyn903 | 2026-06-04 |
| RTO/RPO defined | DONE | Cyn903 | 2026-06-04 |

> **Corrections carried forward from the M6 compliance-doc review (2026-08-14):**
> - **RetentionService** only purges `alerts`/`audit_access`; the `logs` table is never deleted
>   (immutable by DB trigger). See PCI-SAQ-Evidence.md E05.
> - **PDPA erasure** deletes a user's `audit_access` rows + writes a tombstone; it does not — and
>   cannot — touch `logs` content (no `userId` column there, and the table is immutable regardless).
>   See PCI-SAQ-Evidence.md E06.

### Added since v1.0 — M4/M6 scope (2026-07-15 → 2026-08-14)

| Item | Status | Verified By | Date |
|------|--------|-------------|------|
| Vault secrets management (AppRole auth, all secrets moved out of `.env`) | DONE | — | 2026-07-15 |
| PostgreSQL streaming replication + standby (`postgres-standby`, port 5434) | DONE | — | 2026-07-15 |
| Kafka expanded to 3 brokers (KRaft) | DONE | — | 2026-07-15 |
| Prometheus exporters (kafka-exporter, postgres-exporter) | DONE | — | 2026-07-15 |
| `auditor` role added (5th RBAC role) | DONE | — | pre-2026-08-14 |
| `cde_scope` flag + `alerts.cde`/`alerts.raw` topic split | DONE (routing logic in separate `logchain-detection` repo, not verified here) | — | pre-2026-08-14 |
| Write-only DB trigger on `logs` (immutability) | DONE | — | pre-2026-08-14 |
| Compliance docs updated to match current system (this pass) | DONE | — | 2026-08-14 |
| Detection service Vault integration (Pattern A, AppRole) | **NOT DONE** — still reads `ABUSEIPDB_API_KEY` from env, no Vault client | — | open (`docs/worklog/2026-07-15.md` TODO) |
| Vault production hardening (KMS auto-unseal, TLS, raft storage) | **NOT DONE** | — | open (Key-Rotation-Policy.md §5) |
| Polygon Amoy deployment (currently Local Hardhat only) | **NOT DONE** | — | open |
| Unify "4 system roles vs 6 clinical roles" role model | **NOT DONE** | — | open (ISO27001-ISMS.md §4.1) |

---

## 4. Final Sign-off

| Role | Name | Signature | Date |
|------|------|-----------|------|
| Person 2 (Detection/ML/Frontend) | Cyn903 | ______ | ______ |
| Person 1 (Backend/Blockchain) | ChanakanNalong | ______ | ______ |
| Person 3 (Log Collection) | ______ | ______ | ______ |
| Supervisor/Professor | ______ | ______ | ______ |
