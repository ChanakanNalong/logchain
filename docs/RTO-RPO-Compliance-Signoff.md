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
| Kafka | 30 min | 1 hour | Restart broker, replay from offset |
| Blockchain (Polygon Amoy testnet) | 4 hours | N/A | ต่อ RPC ใหม่ / redeploy contract |
| Anomaly Detection (FastAPI) | 30 min | N/A | Restart container |
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

### Blockchain Failure
1. ตรวจ RPC endpoint ของ Polygon Amoy testnet
2. Redeploy contract ถ้าจำเป็น
3. Verify contract `0xE2502FC14B55a6bA0925C53bC4FFd2744CeA15CD` ที่ amoy.polygonscan.com

---

## 3. Disaster Recovery Test

ทดสอบด้วย `docker compose down -v` (ล้าง volume ทั้งหมด) แล้ว restore จากศูนย์ — **สำเร็จ**

ระหว่างทดสอบพบจุดที่ระบบล้มเหลวแบบเงียบ 3 จุด แก้แล้วทั้งหมด:

| # | อาการ | สาเหตุ | การแก้ |
|---|-------|--------|--------|
| 1 | init ล้มทั้งชุด | postgres init script เรียงผิดลำดับ | ใส่เลขนำหน้า `02-` `03-` `04-` |
| 2 | alert หายเงียบ | Kafka topic `alerts.raw` / `alerts.cde` ไม่ถูกสร้าง | เพิ่ม `kafka-init` container |
| 3 | ไม่มีใครรู้ว่าท่อขาด | Kafka consumer retry 5 ครั้งแล้วยอมแพ้ถาวร + producer ไม่เช็คผลส่ง | เปลี่ยนเป็น reconnect ไม่จำกัด + health indicator |

เพิ่ม health check + preflight gate เพื่อให้ระบบล้มเหลวแบบเห็นได้ แทนที่จะเงียบ

---

## 4. Compliance Sign-off Checklist

| Item | Status | Verified By | Date |
|------|--------|-------------|------|
| Alert dedup + severity routing | DONE | Cyn903 | 2026-06-04 |
| Email notification (HIGH/CRITICAL) | DONE | Cyn903 | 2026-06-04 |
| RetentionService cron 365 days | DONE | Cyn903 | 2026-06-04 |
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

## 5. Final Sign-off

| Role | Name | Signature | Date |
|------|------|-----------|------|
| Person 2 (Detection/ML/Frontend) | Cyn903 | ______ | ______ |
| Person 1 (Backend/Blockchain) | ChanakanNalong | ______ | ______ |
| Person 3 (Log Collection) | ______ | ______ | ______ |
| Supervisor/Professor | ______ | ______ | ______ |
