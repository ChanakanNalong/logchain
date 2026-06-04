# RTO/RPO & Compliance Sign-off
## Logchain — Cyber Security Log Integrity System

**Version:** 1.0
**Date:** 2026-06-04

---

## 1. RTO/RPO Definitions

| Component | RTO | RPO | Recovery Strategy |
|-----------|-----|-----|-------------------|
| NestJS Backend | 30 min | 1 hour | Restart container, restore from backup |
| PostgreSQL | 1 hour | 24 hours | pg_restore from daily backup |
| Elasticsearch | 2 hours | 24 hours | Snapshot restore |
| Kafka | 30 min | 1 hour | Restart broker, replay from offset |
| Blockchain Node | 4 hours | N/A | Resync from network |
| ML Detection (FastAPI) | 30 min | N/A | Restart container |
| Frontend (Next.js) | 15 min | N/A | Redeploy static build |

---

## 2. Recovery Procedures

### Backend Failure
1. Check logs: `docker logs logchain-backend`
2. Restart: `docker-compose restart backend`
3. Verify health: `curl http://localhost:3000/health`

### Database Failure
1. Check status: `docker logs logchain-db`
2. Restore: `pg_restore -d logchain backup.dump`
3. Verify data integrity

### Blockchain Node Failure
1. Restart Hardhat node: `npx hardhat node`
2. Redeploy contracts if needed
3. Verify txHash lookups still work

---

## 3. Compliance Sign-off Checklist

| Item | Status | Verified By | Date |
|------|--------|-------------|------|
| Alert dedup + severity routing | DONE | Cyn903 | 2026-06-04 |
| Email notification (HIGH/CRITICAL) | DONE | Cyn903 | 2026-06-04 |
| RetentionService cron 90 days | DONE | Cyn903 | 2026-06-04 |
| Next.js dashboard 3 pages | DONE | Cyn903 | 2026-06-04 |
| PDPA right-to-erasure endpoint | DONE | Cyn903 | 2026-06-04 |
| Trivy CI + GitHub Actions | DONE | Cyn903 | 2026-06-04 |
| ISO 27001 ISMS document | DONE | Cyn903 | 2026-06-04 |
| PCI SAQ evidence package | DONE | Cyn903 | 2026-06-04 |
| Integration tests | DONE | Cyn903 | 2026-06-04 |
| Chain of custody form | DONE | Cyn903 | 2026-06-04 |
| Key rotation runbook | DONE | Cyn903 | 2026-06-04 |
| RTO/RPO defined | DONE | Cyn903 | 2026-06-04 |

---

## 4. Final Sign-off

| Role | Name | Signature | Date |
|------|------|-----------|------|
| Person 2 (Detection/ML/Frontend) | Cyn903 | ______ | ______ |
| Person 1 (Backend/Blockchain) | ChanakanNalong | ______ | ______ |
| Person 3 (Log Collection) | ______ | ______ | ______ |
| Supervisor/Professor | ______ | ______ | ______ |
