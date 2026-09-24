# ISO 27001 ISMS Document
## Logchain — Cyber Security Log Integrity System on Blockchain

**Version:** 1.0
**Date:** 2026-06-04
**Prepared by:** Logchain Team
**Reviewed:** 2026-09-23 — ปรับให้ตรงกับระบบจริง (`docs/compliance-review-2026-09-23.md`)

---

## 1. Scope

ระบบนี้ครอบคลุมการจัดเก็บ ตรวจสอบ และรับรองความสมบูรณ์ของ security log โดยใช้ blockchain technology ประกอบด้วย NestJS Backend, PostgreSQL, Kafka, Python FastAPI anomaly detection, Polygon Amoy testnet, Next.js Dashboard และ rule engine แบบ YAML ที่เขียนเอง (แนว Wazuh)

Data store ของระบบใช้ PostgreSQL อย่างเดียว

---

## 2. Information Security Policy

องค์กรมุ่งมั่นในการรักษาความลับ (Confidentiality) ความสมบูรณ์ (Integrity) ด้วย blockchain hash และความพร้อมใช้งาน (Availability) ของระบบ

---

## 3. Risk Register

| ID | Asset | Threat | Likelihood | Impact | Risk Level | Control |
|----|-------|--------|------------|--------|------------|---------|
| R01 | Log data | Unauthorized modification | Medium | High | HIGH | Blockchain hash verification |
| R02 | API endpoints | Unauthorized access | Medium | High | HIGH | JWT authentication |
| R03 | Database | Data breach | Low | Critical | HIGH | access control (password auth) · Postgres bind `127.0.0.1` เท่านั้น · PAN mask ก่อนเก็บ · ⚠️ ไม่มี encryption at rest |
| R04 | Private keys | Key theft | Low | Critical | HIGH | Vault service, key rotation |
| R05 | Personal data | PDPA violation | Low | High | MEDIUM | Right-to-erasure endpoint — pseudonymize `audit_access` ด้วย HMAC (key ใน Vault) แทนการลบ ให้ audit trail ยังครบตาม PCI 10.5.1 · tombstone ใน `erasure_log` |
| R06 | Log retention | Data over-retention | Low | Medium | LOW | RetentionService cron 365 days |
| R07 | Container | Privilege escalation | Low | High | MEDIUM | service ทุกตัวรัน process หลักเป็น non-root (ตรวจด้วย `docker top` 2026-09-23) · postgres / vault เริ่มด้วย root แล้วลดสิทธิ์เอง (มาตรฐานของ image) · ยกเว้น `vault-unseal` / `vault-init` (ต้อง chown ไฟล์ secret ให้ user บน host ตอน clone ใหม่) |
| R08 | Dependencies | Supply chain attack | Medium | High | HIGH | npm audit + Trivy + pip-audit (lock file ครบ dependency ทางอ้อม) ใน CI — block ที่ HIGH/CRITICAL |
| R09 | Host / containers | Malware | Low | High | MEDIUM | ClamAV สแกนไฟล์ใน repo ทุก push (block) · ไม่มี runtime anti-malware — ยอมรับความเสี่ยง มาตรการชดเชยใน PCI E10 |

---

## 4. Annex A Control Mapping

| Control | Description | Implementation |
|---------|-------------|----------------|
| A.8.1 | Asset Management | Log entries tracked with UUID, timestamp, source |
| A.9.1 | Access Control Policy | JWT (Keycloak RS256) ทุก endpoint ใต้ `/api/v1` · `/health` เปิดสาธารณะ · `/metrics` แยกไป port `:9464` ที่เข้าได้เฉพาะใน docker network (Prometheus) |
| A.9.2 | User Access Management | admin จัดการสิทธิ์ผ่าน Keycloak + guard 3 ชั้น (ดูหัวข้อ 6) |
| A.9.4 | System Access Control | RBAC 5 roles (admin / operator / ingestor / analyst / auditor), audit interceptor logs all access |
| A.10.1 | Cryptographic Controls | SHA-256 hash stored on blockchain per log batch |
| A.12.4 | Logging and Monitoring | PostgreSQL + YAML rule engine (แนว Wazuh) + ML anomaly detection · Prometheus alert 13 rule → email (Alertmanager) |
| A.12.6 | Vulnerability Management | npm audit + Trivy + pip-audit ทุก push · block ที่ HIGH/CRITICAL (Trivy เฉพาะที่มี fix) |
| A.13.2.1 | Information Transfer | HTTPS (Caddy · TLS 1.2+) หน้า dashboard / backend / Keycloak · Kafka mTLS ทั้งเน็ตเวิร์ก (ดูหัวข้อ 5 · PCI E08 / E11) |
| A.16.1 | Incident Management | Alert system with severity routing · security alert HIGH/CRITICAL → email (backend) · infra alert → email (Alertmanager) · ทดสอบส่งจริงทั้งคู่แล้ว |
| A.17.1 | Business Continuity | RTO/RPO + backup รายวัน + สำเนาเข้ารหัสบน Google Drive · ทดสอบกู้คืนแล้ว (RTO-RPO หัวข้อ 3.1–3.2) |
| A.18.1 | Legal Compliance | PDPA right-to-erasure (pseudonymize), audit trail เก็บขั้นต่ำ 365 วัน (บังคับในโค้ด) |

---

## 5. Encryption in transit — Kafka mTLS

**Control:** ISO 27001 A.13.2.1 / PCI DSS Req. 4

การส่ง log ระหว่าง Detection Service กับ API Gateway ผ่าน Kafka ใช้ **mutual TLS**
คือเข้ารหัสสองทาง และบังคับ client certificate

- Certificate ออกโดย internal CA แยกใบต่อ service
- Private key ไม่อยู่ใน git

**ผลทดสอบ**

| กรณี | ผล |
|------|-----|
| Client มี certificate | เข้าถึง topic ได้ |
| Client ไม่มี certificate | ถูกปฏิเสธที่ TLS handshake (`bad_certificate`) |

ตรวจซ้ำได้ด้วย `scripts/demo-mtls.sh`

**สถานะจริง (2026-09-23):** เปิดใช้แล้ว — backend / detection ต่อ listener `DOCKER_SSL` (`kafka-N:9094`) ด้วย client cert
แยกต่อ service · broker ปฏิเสธ client ที่ไม่มี cert (ทดสอบบน stack) · **2026-09-24:** ในเน็ตเวิร์กเป็น mTLS ทั้งหมด —
inter-broker + KRaft controller + kafka-init (`admin`) + kafka-exporter (`exporter`) · PLAINTEXT เหลือแค่ EXTERNAL `:29092` จาก host (bind 127.0.0.1)

---

## 6. Access control / User management

**Control:** ISO 27001 A.9

admin จัดการสิทธิ์ผู้ใช้ผ่าน Keycloak ได้ โดยมี guard 3 ชั้น:

1. **Role allowlist** — จำกัดแค่ 5 roles ของระบบ (admin / operator / ingestor / analyst / auditor)
   กันการยัด Keycloak management role
2. **Last-admin protection** — ลบ admin คนสุดท้ายไม่ได้
3. **Self-lockout protection** — แก้สิทธิ์หรือปิดบัญชีตัวเองไม่ได้

ทุกการเปลี่ยนสิทธิ์บันทึกลง `audit_access` โดยระบุว่าใครแก้สิทธิ์ใคร

ระบบมี 5 roles: `admin` / `operator` / `ingestor` / `analyst` / `auditor`
โดยหน้า Reports ผูกกับ role `auditor`

---

## 7. Internal Audit Plan

| Audit Item | Frequency | Responsible |
|------------|-----------|-------------|
| Access log review | Monthly | Person 2 |
| Blockchain hash verification | ทุก 1 นาที อัตโนมัติ (+ alert batch ค้าง) · ทบทวน Weekly | Person 1 |
| Vulnerability scan (Trivy) | Every push | GitHub Actions |
| Retention policy enforcement | Daily cron | Person 2 |
| Alert review | Daily | Person 2 |
