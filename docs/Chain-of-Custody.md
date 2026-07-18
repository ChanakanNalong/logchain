# Chain of Custody Form
## Logchain — Cyber Security Log Integrity System

**Version:** 1.0
**Date:** 2026-06-04

---

## Log Evidence Chain of Custody

| # | Timestamp | Action | Actor | System | Hash/TxHash |
|---|-----------|--------|-------|--------|-------------|
| 1 | Collection | Log collected from source | Suricata/Wazuh | Log Collector | - |
| 2 | Ingestion | Log forwarded via Kafka | Kafka Producer | Kafka Broker | - |
| 3 | Storage | Log stored in PostgreSQL + Elasticsearch | NestJS Backend | Database | SHA-256 hash computed |
| 4 | Anchoring | Hash batch anchored on blockchain | Smart Contract | Polygon PoS | txHash recorded |
| 5 | Verification | Integrity verified via API | Verifier | FastAPI ML | Verified/Tampered |
| 6 | Retention | Log retained for 90 days | RetentionService | Cron Job | - |
| 7 | Erasure | Log erased on PDPA request | ErasureService | API | Tombstone hash recorded |

---

## Custody Transfer Record

| Transfer # | From | To | Date | Authorized By | Notes |
|------------|------|----|------|---------------|-------|
| T001 | Log Source | Kafka | ______ | ______ | Initial collection |
| T002 | Kafka | NestJS Backend | ______ | ______ | Message consumed |
| T003 | NestJS Backend | Blockchain | ______ | ______ | Hash anchored |

---

## Signatures

| Role | Name | Signature | Date |
|------|------|-----------|------|
| Person 1 (Backend/Blockchain) | ChanakanNalong | ______ | ______ |
| Person 2 (Detection/ML) | Cyn903 | ______ | ______ |
| Person 3 (Log Collection) | ______ | ______ | ______ |
| Supervisor | ______ | ______ | ______ |
