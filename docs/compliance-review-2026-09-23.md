# Compliance Document Review — 2026-09-23

ทบทวน `ISO27001-ISMS.md` · `PCI-SAQ-Evidence.md` · `Chain-of-Custody.md` · `Key-Rotation-Policy.md` ·
`RTO-RPO-Compliance-Signoff.md` เทียบกับโค้ดและ stack ที่รันอยู่จริง (HEAD `ddddb92`)
ทุกข้อมีหลักฐานที่ตรวจซ้ำได้ · เอกสารต้นฉบับแก้ตามนี้แล้ว (หัวข้อ C) · บั๊ก A1 แก้แล้ว

---

## A. บั๊กในระบบ (ไม่ใช่แค่เอกสาร)

### A1. ✅ (แก้แล้ว 2026-09-23) PDPA erasure ลบข้อมูลแล้ว แต่บันทึกหลักฐานการลบไม่ได้ + ตอบ 500
- `src/erasure/erasure.service.ts` ลบ `audit_access` ของ user **ก่อน** (บรรทัด 25) แล้วค่อยเขียน tombstone ลง
  `process.cwd()/erasure-log.json` = `/app/erasure-log.json` (บรรทัด 42, 50–60)
- backend รันเป็น uid 1000 และ `/app` **เขียนไม่ได้** — ยืนยันใน container: `writeFileSync` → `EACCES: permission denied`
- ผล: คำขอลบข้อมูลตาม PDPA = ข้อมูลหายจริง แต่**ไม่มีหลักฐาน (tombstone)** และ client ได้ 500
- ต่อให้เขียนได้: ไฟล์อยู่ใน writable layer ของ container ไม่มี volume → หายทุกครั้งที่ rebuild backend และไม่อยู่ใน backup
- หน้า Reports (`src/compliance/compliance.service.ts` "Right-to-erasure log") อ่านจากไฟล์เดียวกัน → แสดง 0 เสมอ
- บั๊กซ้อน: หน้า Reports จัดกลุ่มตาม `erasedAt`/`requestedAt`/… แต่ ErasureService เขียน `deletedAt` → ต่อให้ไฟล์เขียนได้
  ก็ไม่แสดง · เทสต์เดิมใช้ fixture `erasedAt` ที่ระบบไม่เคยสร้าง จึงผ่าน
- บั๊กซ้อน: `requestedBy` ใน tombstone รับจาก **body** ของ request — พิมพ์ชื่อใครก็ได้ลงหลักฐาน
- **ที่แก้:** migration `ErasureLog1790380800000` (ตาราง `erasure_log` + trigger append-only) · ErasureService ลบ + insert
  tombstone ใน transaction เดียว (insert พัง = rollback การลบ) · Reports อ่านจากตาราง · `requestedBy` จาก JWT
- **ทดสอบ:** unit 4 เคส (รวม "insert พัง → ไม่ลบ") · Reports 8 เคสใช้รูปแบบจริง (`deletedAt`) · e2e กับ DB จริง 3 เคส
  (ลบ + tombstone + Reports เห็น · requestedBy มาจาก JWT แม้ body ส่งชื่ออื่น · UPDATE/DELETE tombstone → `IMMUTABLE_ERASURE_LOG`)

---

## B. ข้อความในเอกสารที่ไม่ตรงกับระบบจริง

| # | เอกสาร | ข้อความ | ของจริง | หลักฐาน |
|---|---|---|---|---|
| B1 | PCI 3.1 · ISO R03 | "PostgreSQL encryption at rest" (PASS) | **ไม่มี** — Postgres ไม่มี TDE · ดิสก์ไม่ได้เข้ารหัส (ไม่มี LUKS) · `show ssl` = off | `lsblk -o FSTYPE` ไม่มี crypto_LUKS |
| B2 | PCI 4.1 | "HTTPS enforced" (PASS) | **ไม่มี HTTPS** — backend / dashboard / Keycloak เป็น HTTP ล้วน | `src/main.ts` ไม่มี httpsOptions · compose ไม่มี reverse proxy/TLS |
| B3 | PCI 4.1 · E08 · ISO A.13.2.1 §5 | Kafka mTLS ระหว่าง Detection ↔ API Gateway | **มีความสามารถ แต่ปิดอยู่** — `KAFKA_SSL_ENABLED=false` ทั้ง `.env` และ compose (backend hard-code `"false"`) · ใช้ listener plaintext 9092 | `docker exec … printenv KAFKA_SSL_ENABLED` = false ทั้ง backend และ consumer |
| B4 | PCI 2.1 | "Custom JWT secret" | ไม่มี shared secret — Keycloak ออก JWT แบบ RS256 ตรวจด้วย JWKS | `src/auth/strategies/jwt.strategy.ts` `passportJwtSecret({ jwksUri })` |
| B5 | PCI 8.1 · E01 · ISO A.9.1 | "JWT authentication on all endpoints" | ทุก endpoint ใต้ `/api/v1` ✅ แต่ `/`, `/health`, `/metrics` เปิดสาธารณะ (ตั้งใจ) · `/metrics` เปิดเผยจำนวน batch/สถานะ | controller ที่ไม่มี `UseGuards`: app · health · metrics |
| B6 | PCI 5.1 | "Anti-malware — Trivy" | Trivy เป็น vulnerability/secret scanner ไม่ใช่ anti-malware · vuln scan ตั้ง `exit-code: 0` (ไม่ block) | `.github/workflows/security.yml` |
| B7 | PCI 6.2 · E04 · ISO A.12.6 | "Trivy + npm audit + **pip audit**" | **ไม่มี pip audit** ใน CI · npm audit `continue-on-error: true` (ไม่ block) | `security.yml` |
| B8 | ISO R07 | "Non-root container enforcement" | ส่วนใหญ่ non-root แต่ **dashboard และ kafka-exporter รัน process เป็น root** (postgres/vault เริ่ม root แล้วลดสิทธิ์เอง) | `docker top cylis-dashboard-app` → root |
| B9 | PCI E05 · 10.2 · Chain #6 | "Cron deletes records older than 365 days (`logs.retention_days`)" | cron ลบเฉพาะ **alerts + audit_access** เก่ากว่า 365 วัน · **ตาราง `logs` ไม่ถูกลบ** (append-only trigger) · คอลัมน์ `retention_days` มีแต่ job ไม่ได้ใช้ | `src/retention/retention.service.ts` |
| B10 | PCI E06 | "removes all personal data" | ลบเฉพาะ `audit_access` ของ userId · `logs` ไม่ถูกแตะ (PII ถูก mask ตั้งแต่ ingest) · + บั๊ก A1 | `erasure.service.ts` |
| B11 | PCI E07 · ISO A.16.1 | "HIGH/CRITICAL alerts trigger email" | โค้ดมี แต่**ปิดอยู่บน deployment นี้** — SMTP ใน Vault `secret/logchain/notification` ว่าง | backend log `Notification disabled — SMTP not configured in Vault` |
| B12 | Chain-of-Custody #2–3, T002 | Kafka ก่อน Storage · "Kafka → NestJS Backend: Message consumed" | **ลำดับกลับกัน:** backend insert ลง Postgres ก่อน (`logs.service.ts:67`) แล้วค่อย publish ขึ้น Kafka (`:70`) · detection เป็นฝั่ง consume · alert ย้อนกลับมาทาง `alerts.raw` | `src/logs/logs.service.ts` |
| B13 | Key-Rotation §1 | "secret ทั้งหมดอยู่ใน Vault — ไม่ใช่ `.env`" | `.env` ยังมี `POSTGRES_PASSWORD`, `KEYCLOAK_ADMIN_PASSWORD`, `KC_DB_PASSWORD`, client secrets ฯลฯ · secret ใหม่ของวันนี้ไม่อยู่ในตาราง: Alertmanager SMTP (`infra/alertmanager/.secrets/`) · rclone token + crypt password (`infra/rclone/.secrets/`) | `.env` · worklog หัวข้อ 22, 30 |
| B14 | Key-Rotation §3 | "redeploy/transfer contract ownership" | contract **ไม่มี `transferOwnership`** → rotate key = redeploy เท่านั้น | worklog 2026-09-17 หัวข้อ 4.3 |
| B15 ✅ | PCI 1.1 | "Firewall — Docker network isolation" (PASS) | ทุก port ที่ publish bind **`0.0.0.0`** — Postgres 5433/5434 · Kafka plaintext 29092 · Vault 8200 · Prometheus 9090 / Alertmanager 9093 (ไม่มี auth — ใครใน LAN silence alert ได้) · node-exporter 9100 · เครื่องมี IP LAN `10.5.50.253` · Docker publish ข้าม host firewall | `ss -ltn` |

### ตรงกับของจริง (ตรวจแล้ว)
- Chain-of-Custody "Hash Coverage" — field ใน `computeRawHash` ตรงตามตาราง (+ `v` เวอร์ชัน) · PAN mask ก่อน hash
- RBAC 5 roles · guard ที่ controller ใต้ `/api/v1` ครบทุกตัว · audit interceptor
- Trivy secret scan + gitleaks + check-tracked-secrets เป็นแบบ block จริง
- contract address `0x5dC86975…` (แก้แล้ววันนี้) · RTO/RPO + backup (แก้/ทดสอบแล้ววันนี้)

---

## C. ผลการตัดสินใจ (2026-09-23)

- **A1** → แก้แล้ว (ด้านบน)
- **B1–B15** → เจ้าของเลือก "แก้เอกสารให้ตรงความจริงก่อน" — แก้แล้วใน PCI / ISO / Chain-of-Custody / Key-Rotation /
  RTO-RPO (สถานะ PASS ที่ไม่จริงเปลี่ยนเป็น PARTIAL / FAIL / N/A พร้อมหมายเหตุ · Attestation ระบุข้อยกเว้น)
- การทำระบบให้ผ่านทีละข้อ → `docs/plan/next-steps.md` ข้อ 6
- **B15 แก้แล้ว** (ข้อ 6.1): port ทั้ง 19 ตัว bind `127.0.0.1` · PCI 1.1 → PASS

## D. คำถามเดิม (เก็บไว้อ้างอิง)


1. **สถานะ PASS ที่ไม่จริง (B1 B2 B3 B8):** เปลี่ยนเป็น PARTIAL/FAIL + หมายเหตุ หรือทำให้ระบบเป็นไปตามเอกสาร
   (เปิด mTLS ใน compose · ใส่ TLS หน้า backend/dashboard · เข้ารหัสดิสก์ · dashboard non-root)
2. **บั๊ก A1** — แก้เลยไหม (แนะนำ: ใช่ — กระทบ PDPA โดยตรง)
3. **B11** — ใส่ Gmail app password ลง Vault `secret/logchain/notification` เพื่อเปิด email ของ security alert
   (คนละชุดกับ Alertmanager ที่แจ้งเรื่อง infra)
4. **B10 × PCI 10** — erasure ลบ `audit_access` ขัดกับการเก็บ audit trail ≥ 12 เดือน (PCI 10.5.1) หรือไม่ ควรเปลี่ยนเป็น
   pseudonymize (แทน userId ด้วย hash) แทนการลบ
