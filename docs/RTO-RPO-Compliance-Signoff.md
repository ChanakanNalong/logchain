# RTO/RPO & Compliance Sign-off
## Logchain — Cyber Security Log Integrity System

**Version:** 1.0
**Date:** 2026-06-04

---

## 1. RTO/RPO Definitions

| Component | RTO | RPO | Recovery Strategy |
|-----------|-----|-----|-------------------|
| NestJS Backend | 30 min | 1 hour | Restart container, restore from backup |
| PostgreSQL | 1 hour | 24 hours ⚠️ | pg_restore from daily backup — **ยังไม่มี backup อัตโนมัติ** (ดูหัวข้อ 3.1) |
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
เครื่อง/ดิสก์ของ primary พัง → promote standby ตาม `docs/runbooks/postgres-failover.md` (ข้อมูลล่าสุด)
ข้อมูลถูกลบ/เสีย (standby replicate ความเสียหายตามไปด้วย) → restore จาก dump:

```bash
docker logs logchain-postgres --tail 50
# สร้าง dump (ต้องทำไว้ก่อนเกิดเหตุ — ยังไม่มี job อัตโนมัติ)
docker exec logchain-postgres pg_dumpall -U logchain --globals-only > globals.sql
docker exec logchain-postgres pg_dump -U logchain -Fc logchain > logchain.dump
docker exec logchain-postgres pg_dump -U logchain -Fc keycloak > keycloak.dump   # users + OTP
# restore ลง postgres ของ compose ที่ volume ใหม่ (superuser = `logchain` ไม่มี role `postgres`)
# ไฟล์ใน infra/postgres/init/ รันไปแล้วตอน volume ว่าง = มี role keycloak/replicator + DB keycloak + ตาราง logchain อยู่ก่อน
# → drop DB ทั้งสองแล้วสร้างใหม่ให้ว่าง · **คง owner เดิม** อย่าใส่ --no-owner (DB keycloak + ตารางเป็นของ role `keycloak`)
HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose stop backend keycloak   # ห้ามมีใครต่อ DB ระหว่าง drop/restore
docker exec -i logchain-postgres psql -U logchain -d postgres -q -f - < globals.sql   # "already exists" ไม่เป็นไร
docker exec logchain-postgres dropdb -U logchain --force logchain   # --force ตัด connection ที่ค้าง (exporter ฯลฯ)
docker exec logchain-postgres dropdb -U logchain --force keycloak
docker exec logchain-postgres createdb -U logchain -O logchain logchain
docker exec logchain-postgres createdb -U logchain -O keycloak keycloak
docker exec -i logchain-postgres pg_restore -U logchain -d logchain --exit-on-error < logchain.dump
docker exec -i logchain-postgres pg_restore -U logchain -d keycloak --exit-on-error < keycloak.dump
HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose start keycloak backend
# ⚠️ globals.sql ตั้งรหัสของ role กลับเป็นของตอน dump — ใช้ .env ชุดเดิม (KC_DB_PASSWORD / REPLICATION_PASSWORD)
#    ไม่งั้น keycloak / standby ต่อ DB ไม่ได้
```
ตรวจหลัง restore: `select status, count(*) from batches group by 1` ตรงกับก่อนเกิดเหตุ ·
`update logs set message='x'` ต้องได้ `IMMUTABLE_LOG` (trigger append-only กลับมาด้วย) ·
backend verify รอบถัดไป integrity 100%

### Blockchain Failure
1. ตรวจ RPC endpoint ของ Polygon Amoy testnet
2. Redeploy contract ถ้าจำเป็น
3. Verify contract `0x5dC86975615d3bc713cdf9f25ad1cA25CE7949f5` ที่ amoy.polygonscan.com

---

## 3. Disaster Recovery Test

ทดสอบด้วย `docker compose down -v` (ล้าง volume ทั้งหมด) แล้ว restore จากศูนย์ — **สำเร็จ**
(หมายเหตุ 2026-09-23: การทดสอบนี้คือ **สร้างระบบใหม่จากศูนย์** ด้วย bootstrap — ข้อมูลเดิมหายหมด
ไม่ใช่การกู้ข้อมูลจาก backup · การทดสอบกู้ข้อมูลจริงอยู่ในหัวข้อ 3.1)

ระหว่างทดสอบพบจุดที่ระบบล้มเหลวแบบเงียบ 3 จุด แก้แล้วทั้งหมด:

| # | อาการ | สาเหตุ | การแก้ |
|---|-------|--------|--------|
| 1 | init ล้มทั้งชุด | postgres init script เรียงผิดลำดับ | ใส่เลขนำหน้า `02-` `03-` `04-` |
| 2 | alert หายเงียบ | Kafka topic `alerts.raw` / `alerts.cde` ไม่ถูกสร้าง | เพิ่ม `kafka-init` container |
| 3 | ไม่มีใครรู้ว่าท่อขาด | Kafka consumer retry 5 ครั้งแล้วยอมแพ้ถาวร + producer ไม่เช็คผลส่ง | เปลี่ยนเป็น reconnect ไม่จำกัด + health indicator |

เพิ่ม health check + preflight gate เพื่อให้ระบบล้มเหลวแบบเห็นได้ แทนที่จะเงียบ

### 3.1 Restore Test — 2026-09-23 (กู้ข้อมูลจาก dump จริง)

dump จาก DB ที่ใช้งานอยู่ (อ่านอย่างเดียว) → restore ลง `postgres:16-alpine` ชั่วคราวที่แยกจาก stack
(`--network none` ไม่แตะ DB จริง) → เทียบทุกตาราง → ลบทิ้ง

| ตรวจ | ผล |
|---|---|
| ขอบเขต | role (globals) + DB `logchain` + DB `keycloak` (users / credential / OTP) · restore ลง container ที่ตั้ง `POSTGRES_USER=logchain` เหมือน compose |
| เวลา dump | 0.3 วินาที (ขนาด DB 8.9 MB) |
| เวลา restore (รวม init + เปิด container) | 2.3–4.1 วินาที — ต่ำกว่า RTO 1 ชม. มาก |
| ข้อมูล | จำนวนแถว + md5 ของทุกแถว **ตรงกันทุกตาราง**: logchain 7/7 · keycloak 92/92 (logs 101 · batches 21 · alerts 10 · audit 1,676 · users 4) |
| schema | trigger 2 · index 16 · constraint 9 · function 47 · extension (pgcrypto, plpgsql, uuid-ossp) ตรงกัน |
| การป้องกัน | `UPDATE` / `DELETE` บน `logs` ที่ restore แล้ว → `IMMUTABLE_LOG` (append-only ยังทำงาน) |
| owner | DB + ตารางตรงของเดิม (keycloak 92 ตารางเป็นของ `keycloak`) · role `keycloak` login + อ่าน/เขียนตารางตัวเองได้ |

ทดสอบ 3 รอบ — สองรอบแรกเจอขั้นตอนที่ใช้กู้จริงไม่ได้:
1. `--no-owner --role=logchain` ลง container ที่มี superuser `postgres` → ข้อมูลตรงครบ แต่ **owner ของ DB keycloak ผิด**
   (Keycloak จะใช้ตารางตัวเองไม่ได้) และ compose ไม่มี role `postgres`
2. คง owner + `-U logchain` → ผ่าน แต่ container นั้นไม่ได้รัน `infra/postgres/init/` · ของจริง init สร้างตาราง + DB keycloak
   ไว้ก่อน → `pg_restore --exit-on-error` จะชนตารางซ้ำ
3. **container ที่เหมือน compose ทุกอย่าง** (POSTGRES_USER/DB = logchain + mount `infra/postgres/init`) → drop/create DB
   แล้ว restore ตามคำสั่งข้างบน → ข้อมูลตรงทุกไบต์ · owner ถูก · role keycloak ใช้ได้ · append-only ทำงาน · 2.3 วินาที

**ข้อค้นพบ:** ขั้นตอน restore ใช้ได้จริง แต่ **ไม่มี backup อัตโนมัติ** (ไม่มี job / script / cron ใน repo)
RPO 24 ชม. ในตารางข้างบนจึง **ยังไม่เป็นจริง** — ถ้าข้อมูลเสียวันนี้ กู้ได้เฉพาะ dump ที่มีคนทำด้วยมือไว้
standby (streaming replication) กันเครื่องพังได้ แต่ **กันการลบ/ข้อมูลเสียไม่ได้** เพราะ replicate ตามไปด้วย

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
