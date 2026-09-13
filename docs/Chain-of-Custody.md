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

## Hash Coverage — ขอบเขตของหลักฐานที่ถูกป้องกัน

`raw_hash` ของแต่ละ log คำนวณด้วย SHA-256 ครอบ **ทุก field ที่เป็นหลักฐาน**:

| Field | เหตุผลที่ต้องอยู่ใน hash |
|---|---|
| `id` | แยก log แต่ละรายการออกจากกัน แม้เนื้อหาเหมือนกัน |
| `source` | ระบบต้นทางที่ส่ง log |
| `sourceIp` | IP ต้นทาง — ป้องกันการปกปิดผู้กระทำ |
| `eventType` | ประเภทเหตุการณ์ |
| `severity` | ระดับความรุนแรง — ป้องกันการลดระดับเพื่อซ่อนเหตุการณ์ |
| `message` | เนื้อหา log **หลังผ่าน PII masking แล้วเท่านั้น** |
| `classification` | ชั้นความลับของข้อมูล |
| `cdeScope` | อยู่ในขอบเขต Cardholder Data Environment หรือไม่ |
| `createdAt` | เวลาเกิดเหตุ — ป้องกันการบิดเบือน timeline |

**ผลของการครอบทุก field:** การแก้ไข metadata ใด ๆ ในฐานข้อมูล เช่น เปลี่ยน IP ต้นทาง ลดระดับ severity จาก CRITICAL เป็น INFO หรือแก้ timestamp จะทำให้ Merkle root ที่คำนวณใหม่ไม่ตรงกับที่บันทึกไว้บน blockchain และถูกตรวจพบเป็นสถานะ **TAMPERED** โดยอัตโนมัติ

**PCI-DSS:** หมายเลขบัตร (PAN) ถูก mask **ก่อน** เข้า hash function เสมอ — PAN จริงไม่เคยถูก hash และไม่เคยถูกบันทึกลงฐานข้อมูล (Req. 3.4)

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
