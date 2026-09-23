# Chain of Custody Form
## Logchain — Cyber Security Log Integrity System

**Version:** 1.0
**Date:** 2026-06-04

---

## Log Evidence Chain of Custody

> ทบทวน 2026-09-23: ลำดับเดิมวาง Kafka ก่อน Storage ซึ่งกลับกับโค้ด (`src/logs/logs.service.ts` insert ก่อน publish)

| # | Timestamp | Action | Actor | System | Hash/TxHash |
|---|-----------|--------|-------|--------|-------------|
| 1 | Collection | Log เข้าระบบผ่าน `POST /api/v1/logs` | Log source (client) | API Gateway (NestJS) | - |
| 2 | Storage | PII mask → คำนวณ `raw_hash` → insert ลง PostgreSQL (append-only) | NestJS Backend | Database | SHA-256 hash computed |
| 3 | Forwarding | publish ขึ้น Kafka `logs.raw` ให้ detection (Kafka ล่ม → เข้าคิว `kafka_pending_logs` แล้ว replay) | NestJS Backend (producer) | Kafka Broker | - |
| 4 | Anchoring | Hash batch anchored on blockchain | Smart Contract | Polygon Amoy testnet | txHash recorded |
| 5 | Verification | Integrity verified via API | Verifier | IntegrityService (NestJS) + smart contract | Verified/Tampered |
| 6 | Retention | `logs` ไม่ถูกลบ (append-only) · `alerts` / `audit_access` ลบเมื่อเกิน 365 วัน | RetentionService | Cron Job | - |
| 7 | Erasure | ลบ `audit_access` ของ user ตามคำขอ PDPA (`logs` ไม่ถูกแตะ — PII mask แล้ว) | ErasureService | API | Tombstone ลง `erasure_log` (append-only) ใน transaction เดียวกับการลบ |

Contract ที่ใช้ anchor: `0x5dC86975615d3bc713cdf9f25ad1cA25CE7949f5`
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
| T002 | NestJS Backend | Kafka → Detection Service | ______ | ______ | Backend publish `logs.raw` · detection consume แล้วส่ง alert กลับทาง `alerts.raw` / `alerts.cde` |
| T003 | NestJS Backend | Blockchain | ______ | ______ | Hash anchored บน Polygon Amoy testnet |

---

## Signatures

| Role | Name | Signature | Date |
|------|------|-----------|------|
| Person 1 (Backend/Blockchain) | ChanakanNalong | ______ | ______ |
| Person 2 (Detection/ML) | Cyn903 | ______ | ______ |
| Person 3 (Log Collection) | ______ | ______ | ______ |
| Supervisor | ______ | ______ | ______ |
