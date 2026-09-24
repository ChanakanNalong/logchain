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
| 4.1 | Encrypt transmission | **PARTIAL** | Kafka ระหว่าง API Gateway ↔ Detection เป็น **mTLS แล้ว** (listener `DOCKER_SSL :9094` · บังคับ client cert · เปิด 2026-09-23 · ดู E08) · **ยังไม่มี HTTPS** — backend / dashboard / Keycloak เป็น HTTP (review B2) |
| 5.1 | Anti-malware | **PARTIAL** | ClamAV สแกนทุกไฟล์ใน repo ทุก push (block ถ้าเจอ · 2026-09-24 · ดู E10) · **ไม่มี anti-malware ตอน runtime** บน host / ใน container — ยอมรับความเสี่ยงพร้อมมาตรการชดเชย (E10 · review B6) |
| 6.1 | Secure development | PASS | GitHub Actions security workflow |
| 6.2 | Vulnerability scan | PASS | ทุก push **block** เมื่อเจอ HIGH/CRITICAL: npm audit (backend + dashboard) · Trivy (มี fix แล้ว) · pip-audit (detection) — 2026-09-24 (review B7) |
| 7.1 | Restrict access by need | PASS | JWT RBAC 5 roles (admin / operator / ingestor / analyst / auditor) |
| 8.1 | Identify and authenticate | PASS | JWT ทุก endpoint ใต้ `/api/v1` · `/`, `/health` เปิดสาธารณะโดยตั้งใจ · `/metrics` ย้ายไป `:9464` ไม่ publish ออก host (review B5 แก้ 2026-09-24) |
| 9.1 | Restrict physical access | N/A | Cloud/local deployment |
| 10.1 | Track and monitor access | PASS | AuditAccess entity logs all requests |
| 10.2 | Audit log retention | PASS | `audit_access` เก็บ **อย่างน้อย 365 วันเสมอ** (โค้ดบังคับขั้นต่ำ · 10.5.1) · `alerts` ตาม `RETENTION_DAYS` (default 365) · ตาราง `logs` ไม่ถูกลบ (append-only) · PDPA erasure pseudonymize แทนลบ (E06) |
| 11.1 | Vulnerability testing | PASS | Trivy CI scan on every push |
| 12.1 | Security policy | PASS | ISO 27001 ISMS document |

---

## Evidence Items

### E01 — JWT Authentication
- File: src/auth/strategies/jwt.strategy.ts — Keycloak RS256 + JWKS
- ทุก controller ใต้ `/api/v1` มี `AuthGuard('jwt')` + `RolesGuard` · `/`, `/health` เปิดสาธารณะ
  · `/metrics` (จำนวน batch ตามสถานะ) อยู่ port แยก `:9464` เข้าได้เฉพาะใน docker network — `:3000/metrics` ตอบ 404 (2026-09-24)

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
- block (HIGH/CRITICAL, 2026-09-24): npm audit backend + dashboard (`--audit-level=high`) · Trivy vuln (`ignore-unfixed`) ·
  pip-audit `detection/requirements.lock` — ครบทุกแพ็กเกจใน image รวม dependency ทางอ้อม (48 ตัว · เดิม 15 ตัวที่ pin ใน requirements.txt) ·
  Dockerfile ลงด้วย `-c requirements.lock` และ build พังถ้าของที่ลงไม่ตรง lock (2026-09-24)
- ตอนเปิด block: npm 0 ทุกระดับ · Trivy 0 · pip-audit เจอ **torch 2.12.0 CVE-2025-3000** (ไม่กระทบ — ไม่ได้ใช้ `torch.jit.script`)
  → อัปเป็น 2.13.0 · image อัป pip / setuptools ที่มีช่องโหว่
- ⚠️ ใน image torch เป็น `2.13.0+cpu` scanner จับคู่ advisory ไม่ได้ (เคยทำให้ CVE ข้างบนหลุด) → audit จาก requirements.lock (torch เขียนเป็น `2.13.0`)

### E05 — Data Retention
- File: src/retention/retention.service.ts — cron ทุกเที่ยงคืน
- ลบ `alerts` ที่เก่ากว่า `RETENTION_DAYS` (default 365) และ `audit_access` ที่เก่ากว่า max(`RETENTION_DAYS`, 365) — audit ไม่มีทางถูกลบก่อน 12 เดือน (PCI 10.5.1 · `retentionDays()` + เทสต์)
- แก้ 2026-09-24: เดิม default ในโค้ด 90 วัน และ compose ไม่ส่ง `RETENTION_DAYS` เข้า container → audit ถูกลบตั้งแต่วันที่ 90 ขัดกับเอกสารที่เขียนว่า 365
- ตาราง `logs` **ไม่ถูกลบ** (append-only trigger) · คอลัมน์ `retention_days` มีอยู่แต่ job ไม่ได้ใช้ · หน้า Reports แสดงจำนวนที่เกินกำหนด

### E06 — PDPA Erasure
- File: src/erasure/erasure.service.ts — `DELETE /api/v1/erasure/user/:userId` (admin)
- **pseudonymize แทนการลบ** (2026-09-24 · review B10) — แถวใน `audit_access` ยังอยู่ครบตาม PCI 10.5.1 แต่ระบุตัวคนไม่ได้:
  `user_id` → `anon-<HMAC-SHA256>` · `username` / `ip_address` → NULL · userId ที่อยู่ใน `resource` ของแถวอื่น
  (เช่น admin แก้ role ของ user นี้ · URL ของคำขอลบเอง) → HMAC ตัวเดียวกัน
- key ของ HMAC สุ่มครั้งเดียวด้วย RNG ของ Vault (`secret/logchain/erasure` · `infra/vault/init.sh`) ไม่อยู่ใน DB/backup/.env
  → คนที่อ่าน DB หรือ backup อย่างเดียวย้อนกลับไม่ได้ · ผู้ถือ key คำนวณ HMAC ของ userId ที่สงสัยเพื่อสืบสวนตาม PCI 10 ได้
  · ไม่มี key = ตอบ 503 (ไม่ถอยไปลบจริง)
- แก้ + บันทึก tombstone ลงตาราง `erasure_log` **ใน transaction เดียวกัน** (บันทึกไม่ได้ = ไม่แก้) · tombstone มี `method`
  (`DELETE` = คำขอก่อน 2026-09-24 · `PSEUDONYMIZE`) และ `pseudonym` ไว้ผูกกับแถว audit
- `erasure_log` append-only (trigger) · `requested_by` มาจากตัวตนใน JWT · อยู่ใน backup รายวัน
- ขอบเขต: `audit_access` เท่านั้น — `logs` ไม่ถูกแตะ (PII ถูก mask ตั้งแต่ ingest) · `erasure_log` เก็บ userId ตัวจริงไว้เป็นหลักฐานว่าคำขอของใครถูกดำเนินการ
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
- **เปิดใช้แล้ว 2026-09-23** — backend (producer + consumer) และ detection-consumer ต่อ listener `DOCKER_SSL`
  (`kafka-N:9094`, advertise ชื่อใน docker network) ด้วย cert `nestjs` / `detection` · `ssl.client.auth=required`
- ทดสอบบน stack: log → Kafka → detection → `alerts.raw` → backend → DB ครบทั้งสายผ่าน mTLS (rule 60001) ·
  kafka client ไม่มี cert → broker `Failed authentication (SSL handshake failed)` · มี cert → เห็น topic ครบ
- 2026-09-24: เอา listener PLAINTEXT `:9092` ออก — inter-broker ใช้ `DOCKER_SSL` · KRaft controller `:9093` เป็น SSL ·
  kafka-init / kafka-exporter ใช้ client cert ของตัวเอง (`admin` / `exporter`) · healthcheck + คำสั่งดูแลใช้ `infra/kafka/kafka-cli.sh`
  ทดสอบ: broker ไม่ listen :9092 แล้ว · controller ตอบ TLS 1.3 · quorum 3 เสียง · ไม่มี partition ขาด replica ·
  offset ของ consumer group ต่อเนื่อง · log → detection → alert ครบสาย · restart broker ทีละตัวผ่าน
- ยังเหลือ: EXTERNAL `:29092` (plaintext · bind 127.0.0.1 · ใช้ตอนรันแอปบน host เท่านั้น)
- 2026-09-24: private key ทุกตัว 0640 (`ca.key` 0600) · container ที่ใช้ key ได้กลุ่มเจ้าของไฟล์ผ่าน `group_add` ·
  backend / detection mount เฉพาะ cert + key ของตัวเอง (เดิม backend mount ทั้ง `certs/` รวม `ca.key` และอ่านได้)

### E10 — Anti-malware — Req. 5
- `.github/workflows/security.yml` step **ClamAV (blocking)** — `clamav/clamav:stable` · `freshclam` ก่อนสแกน (ไม่ได้ = ใช้ฐานข้อมูล
  ที่มากับ image + warning) · สแกนทุกไฟล์ใน `git ls-files` (ซอร์ส + binary ที่ commit: โมเดล `.pt` · ฟอนต์ `.woff2`) ~15 วินาที
- ทดสอบ 2026-09-24: repo 243 ไฟล์ = 0 · แทรกไฟล์ EICAR → `Eicar-Test-Signature FOUND` exit 1 (job แดง)
- ไม่ครอบ: `node_modules` (~1 GB · สแกนเกิน 10 นาที) → แพ็กเกจที่เป็นมัลแวร์มี advisory ใน GitHub Advisory DB ซึ่ง `npm audit`
  block ที่ HIGH+ อยู่แล้ว (E04) · Python ใช้ lock file (`detection/requirements.lock`) + pip-audit
- **ความเสี่ยงที่ยอมรับ:** ไม่มี anti-malware ตอน runtime บน host หรือใน container (ระบบ dev/demo เครื่องเดียว) · มาตรการชดเชย:
  image สร้างจาก base ทางการ + scan ช่องโหว่ · process ใน container เป็น non-root (ISO R07) · cert / config mount `:ro` ·
  port ทุกตัว bind `127.0.0.1` · `logs` append-only + Merkle root บน blockchain (แก้ข้อมูลแล้วตรวจเจอ)
- ถ้าขึ้น production: ติด anti-malware ระดับ host (เช่น ClamAV `clamd` + on-access scan หรือ EDR ขององค์กร)

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
