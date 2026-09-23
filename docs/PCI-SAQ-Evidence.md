# PCI DSS SAQ-A Evidence Package
## Logchain — Cyber Security Log Integrity System

**Version:** 1.0
**Date:** 2026-06-04
**Prepared by:** Logchain Team
**Reviewed:** 2026-09-23 — สถานะปรับให้ตรงกับระบบที่รันจริง รายละเอียด + หลักฐานใน `docs/compliance-review-2026-09-23.md`

---

## SAQ-A Checklist

| Req | Description | Status | Evidence |
|-----|-------------|--------|----------|
| 1.1 | Firewall configuration | PASS | service คุยกันใน Docker network · port ที่ publish ทั้ง 19 ตัว bind `127.0.0.1` (`PUBLISH_ADDR`) — ทดสอบจาก IP LAN ของเครื่องแล้วปิดทุกตัว · แก้ 2026-09-23 (เดิม `0.0.0.0` · review B15) |
| 2.1 | No vendor-supplied defaults | PASS | Keycloak ออก JWT แบบ RS256 ตรวจด้วย JWKS (ไม่มี shared secret) · `bootstrap.sh` สุ่ม password / secret ทุกตัว |
| 3.1 | Protect stored data | **PARTIAL** | PAN ถูก mask ก่อนเก็บ (ไม่มี PAN เต็มใน DB · Req 3.4) · **ไม่มี encryption at rest** — Postgres ไม่มี TDE และดิสก์ไม่ได้เข้ารหัส (review B1) |
| 4.1 | Encrypt transmission | **FAIL** | **ไม่มี HTTPS** — backend / dashboard / Keycloak เป็น HTTP · Kafka mTLS ทำได้แต่ **ปิดอยู่** (`KAFKA_SSL_ENABLED=false`) (review B2, B3 · ดู E08) |
| 5.1 | Anti-malware | **N/A — ไม่มี** | ไม่มี anti-malware · Trivy เป็น vulnerability/secret scanner (review B6) |
| 6.1 | Secure development | PASS | GitHub Actions security workflow |
| 6.2 | Vulnerability scan | **PARTIAL** | Trivy vuln scan (`exit-code: 0` ไม่ block) + npm audit (`continue-on-error`) · **ไม่มี pip audit** (review B7) |
| 7.1 | Restrict access by need | PASS | JWT RBAC 5 roles (admin / operator / ingestor / analyst / auditor) |
| 8.1 | Identify and authenticate | PASS | JWT ทุก endpoint ใต้ `/api/v1` · `/`, `/health`, `/metrics` เปิดสาธารณะโดยตั้งใจ (review B5) |
| 9.1 | Restrict physical access | N/A | Cloud/local deployment |
| 10.1 | Track and monitor access | PASS | AuditAccess entity logs all requests |
| 10.2 | Audit log retention | PASS | `audit_access` + `alerts` เก็บ 365 วันแล้วลบ · ตาราง `logs` ไม่ถูกลบ (append-only) |
| 11.1 | Vulnerability testing | PASS | Trivy CI scan on every push |
| 12.1 | Security policy | PASS | ISO 27001 ISMS document |

---

## Evidence Items

### E01 — JWT Authentication
- File: src/auth/strategies/jwt.strategy.ts — Keycloak RS256 + JWKS
- ทุก controller ใต้ `/api/v1` มี `AuthGuard('jwt')` + `RolesGuard` · `/`, `/health`, `/metrics` เปิดสาธารณะ
  (`/metrics` เปิดเผยจำนวน batch ตามสถานะ)

### E02 — Audit Logging
- File: src/common/interceptors/audit.interceptor.ts
- All API requests logged to audit_access table

### E03 — Blockchain Integrity
- Smart contract stores SHA-256 hash per log batch
- Immutable record on Polygon Amoy testnet
- Contract: `0x5dC86975615d3bc713cdf9f25ad1cA25CE7949f5` (ตรวจสอบได้ที่ amoy.polygonscan.com)
- Verification ทำโดย IntegrityService (NestJS) + smart contract

### E04 — Vulnerability Scanning
- File: .github/workflows/security.yml — ทุก push
- block: gitleaks · Trivy secret scan · `check-tracked-secrets.sh`
- ไม่ block: Trivy vulnerability scan (`exit-code: 0`) · npm audit (`continue-on-error`) · **ไม่มี pip audit**

### E05 — Data Retention
- File: src/retention/retention.service.ts — cron ทุกเที่ยงคืน
- ลบ `alerts` และ `audit_access` ที่เก่ากว่า 365 วัน
- ตาราง `logs` **ไม่ถูกลบ** (append-only trigger) · คอลัมน์ `retention_days` มีอยู่แต่ job ไม่ได้ใช้ · หน้า Reports แสดงจำนวนที่เกินกำหนด

### E06 — PDPA Erasure
- File: src/erasure/erasure.service.ts — `DELETE /api/v1/erasure/user/:userId` (admin)
- ลบ `audit_access` ของ user + บันทึก tombstone ลงตาราง `erasure_log` **ใน transaction เดียวกัน** (บันทึกไม่ได้ = ไม่ลบ)
- `erasure_log` append-only (trigger) · `requested_by` มาจากตัวตนใน JWT · อยู่ใน backup รายวัน
- ขอบเขต: `audit_access` เท่านั้น — `logs` ไม่ถูกแตะ (PII ถูก mask ตั้งแต่ ingest)
- แก้ 2026-09-23: เดิมเขียน tombstone ลงไฟล์ใน container ซึ่งเขียนไม่ได้ → ข้อมูลถูกลบแต่ไม่มีหลักฐาน (review A1)

### E07 — Alert Monitoring
- File: src/alerts/alerts.service.ts — HIGH/CRITICAL alerts trigger email notification
- เปิดแล้ว 2026-09-23 (`scripts/setup-alert-email.sh` · ค่าอยู่ใน `.env` `MAIL_*` → `vault-init` seed เข้า Vault) ·
  ทดสอบ: brute force จาก host ทดสอบ → alert CRITICAL → `Alert email sent` · ได้รับจริง (review B11 ✅)
- alert ของระบบ (service ล่ม, backup, consumer ค้าง ฯลฯ) ส่ง email ผ่าน Alertmanager แล้ว — คนละชุดกับ security alert

### E08 — Encryption in Transit (Kafka mTLS) — Req. 4
- การส่ง log ระหว่าง Detection Service กับ API Gateway ผ่าน Kafka ใช้ mutual TLS
  (เข้ารหัสสองทาง + บังคับ client certificate)
- Certificate ออกโดย internal CA แยกใบต่อ service; private key ไม่อยู่ใน git
- ผลทดสอบ: client ที่มี certificate เข้าถึง topic ได้ / client ที่ไม่มี ถูกปฏิเสธ
  ที่ TLS handshake (`bad_certificate`)
- ตรวจซ้ำได้ด้วย `scripts/demo-mtls.sh`
- **สถานะจริง (2026-09-23): ปิดอยู่** — `KAFKA_SSL_ENABLED=false` ทั้ง `.env` และ compose (backend hard-code `"false"`)
  backend / detection ใช้ listener plaintext `:9092` · SSL listener `:39092-39094` มีอยู่แต่ไม่มีใครใช้

### E09 — Access Control / User Management — Req. 7
- admin จัดการสิทธิ์ผ่าน Keycloak ได้ โดยมี guard 3 ชั้น:
  1. role allowlist — จำกัดแค่ 5 roles ของระบบ กันการยัด Keycloak management role
  2. last-admin protection — ลบ admin คนสุดท้ายไม่ได้
  3. self-lockout protection — แก้สิทธิ์หรือปิดบัญชีตัวเองไม่ได้
- ทุกการเปลี่ยนสิทธิ์บันทึกลง `audit_access` ระบุว่าใครแก้สิทธิ์ใคร
- หน้า Reports ผูกกับ role `auditor`

---

## Attestation

ข้าพเจ้าขอรับรองว่าระบบ Logchain ได้ดำเนินการตามมาตรการความปลอดภัยที่ระบุไว้ในเอกสารนี้

**ยกเว้น** รายการที่ระบุสถานะ PARTIAL / FAIL / N/A ในตารางข้างบน (ทบทวน 2026-09-23 — แผนแก้: `docs/plan/next-steps.md` ข้อ 6)

**Signed:** ______________________
**Date:** 2026-06-04
