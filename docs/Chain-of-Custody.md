# Chain of Custody Form
## Logchain — Cyber Security Log Integrity System

**Version:** 1.0
**Date:** 2026-06-04

---

## Log Evidence Chain of Custody

| # | Timestamp | Action | Actor | System | Hash/TxHash |
|---|-----------|--------|-------|--------|-------------|
| 1 | Collection | Log เข้าระบบผ่าน `POST /api/v1/logs` | Log source (client) | API Gateway (NestJS) | - |
| 2 | Ingestion | Log forwarded via Kafka | Kafka Producer | Kafka Broker | - |
| 3 | Storage | Log stored in PostgreSQL | NestJS Backend | Database | SHA-256 hash computed |
| 4 | Anchoring | Hash batch anchored on blockchain | Smart Contract | Polygon Amoy testnet | txHash recorded |
| 5 | Verification | Integrity verified via API | Verifier | IntegrityService (NestJS) + smart contract | Verified/Tampered |
| 6 | Retention | Log retained for 365 days | RetentionService | Cron Job | - |
| 7 | Erasure | Log erased on PDPA request | ErasureService | API | Tombstone hash recorded |

Contract ที่ใช้ anchor: `0xE2502FC14B55a6bA0925C53bC4FFd2744CeA15CD`
(ตรวจสอบได้ที่ amoy.polygonscan.com)

---

## Custody Transfer Record

| Transfer # | From | To | Date | Authorized By | Notes |
|------------|------|----|------|---------------|-------|
| T001 | Log Source | API Gateway | ______ | ______ | Initial collection via `POST /api/v1/logs` |
| T002 | Kafka | NestJS Backend | ______ | ______ | Message consumed |
| T003 | NestJS Backend | Blockchain | ______ | ______ | Hash anchored บน Polygon Amoy testnet |

---

## Signatures

| Role | Name | Signature | Date |
|------|------|-----------|------|
| Person 1 (Backend/Blockchain) | ChanakanNalong | ______ | ______ |
| Person 2 (Detection/ML) | Cyn903 | ______ | ______ |
| Person 3 (Log Collection) | ______ | ______ | ______ |
| Supervisor | ______ | ______ | ______ |
