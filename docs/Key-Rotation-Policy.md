# Key Rotation Policy
## Logchain — Cyber Security Log Integrity System
**Version:** 2.0
**Date:** 2026-07-17
**Scope:** Governance policy (ISO 27001 A.10.1.2 key management)

> **Operational steps:** ดู `docs/runbooks/vault-key-rotation.md`
> สำหรับ Vault unseal/rekey commands (production mode).
> เอกสารนี้เป็น **policy layer** — schedule, ownership, audit log.

---

## 1. Keys in Scope

secret ของแอป (backend / detection) อยู่ใน HashiCorp Vault (`secret/logchain/*`)
`.env` ยังเก็บค่า bootstrap ของ container ที่เป็นความลับด้วย: `POSTGRES_PASSWORD`, `KC_DB_PASSWORD`,
`REPLICATION_PASSWORD`, `KEYCLOAK_ADMIN_PASSWORD`, `KEYCLOAK_ADMIN_USER_PASSWORD`, client secrets, Vault AppRole
(ทบทวน 2026-09-23 — เดิมเขียนว่า "ไม่ใช่ `.env`")

| Secret | Vault Path | Rotation Frequency | Owner |
|--------|-----------|--------------------|-------|
| Keycloak client secret | `secret/logchain/keycloak` | 90 days | Person A |
| Keycloak ingestor secret | `secret/logchain/keycloak` | 90 days | Person A |
| Blockchain private key | `secret/logchain/blockchain` | 180 days | Person A |
| Database password | `secret/logchain/database` | 90 days | Person B |
| Gmail App Password (SMTP) | `.env` `MAIL_PASS` → `vault-init` seed ลง `secret/logchain/notification` (แก้ที่ `.env` เท่านั้น — `vault-init` ทับ Vault ทุกครั้งที่ `compose up`) | 180 days | Person C |
| Vault root token | `infra/vault/.secrets/init.env` | 90 days (or on personnel change) | Person B |
| Vault unseal keys (5) | `infra/vault/.secrets/init.env` | On compromise only | Person B |
| Postgres / Keycloak / Grafana bootstrap passwords | `.env` | 90 days | Person B |
| Alertmanager SMTP (Gmail App Password) | `infra/alertmanager/.secrets/smtp_password` — **ชุดเดียวกับ `MAIL_PASS`** บนเครื่องนี้ (rotate ต้องแก้ทั้ง 2 ที่ · `setup-alert-email.sh` รันซ้ำเพื่อ sync) | 180 days | Person C |
| rclone Google Drive token | `infra/rclone/.secrets/rclone.conf` | เมื่อถูกถอนสิทธิ์ / หมดอายุ (`OffsiteBackupFailing`) — `scripts/setup-offsite-backup.sh` | Person B |
| rclone crypt password ×2 | `infra/rclone/.secrets/rclone.conf` + password manager ของเจ้าของ | **ห้าม rotate โดยไม่ re-encrypt** — สำเนาเดิมบน cloud จะถอดไม่ได้ | Person B |

---

## 2. Rotation Procedure (General)

1. ดู operational commands ใน `docs/runbooks/vault-key-rotation.md`
2. Update secret ใน Vault: `vault kv put secret/logchain/<group> <key>=<new_value>`
3. Restart affected service (NestJS / detection consumer) เพื่อ fetch ค่าใหม่
   - Pattern A (bootstrap fetch): secret โหลดตอน start เท่านั้น
4. Verify service ทำงานปกติหลัง restart
5. บันทึกใน Rotation Log ด้านล่าง

---

## 3. Secret-Specific Notes

### Keycloak secrets
- Rotate ผ่าน Keycloak admin → regenerate client secret → update Vault → restart NestJS

### Blockchain private key
- Generate wallet ใหม่ → fund test MATIC (Amoy faucet) → **redeploy contract** (LogIntegrity ไม่มี `transferOwnership`)
- Update `secret/logchain/blockchain` → update `CONTRACT_ADDRESS` → batch เดิมจะ `UNVERIFIED` → re-anchor root เดิม (`INTEGRITY_AUTO_REANCHOR=true` ชั่วคราว)

### Database password
- ALTER USER ใน Postgres → update `secret/logchain/database` → restart NestJS
- **ระวัง:** primary + standby ต้อง sync password (replication user แยกต่างหาก)

### SMTP (Gmail App Password)
- Google Account → Security → App Passwords → revoke เก่า + generate ใหม่
- ใส่รหัสใหม่ใน `infra/alertmanager/.secrets/smtp_password` → `docker compose up -d --force-recreate alertmanager`
- รัน `./scripts/setup-alert-email.sh` (ตอบใช้ชุดเดียวกับ Alertmanager) → เขียน `.env` + seed Vault + restart backend
- **อย่า** `vault kv put secret/logchain/notification` ตรง ๆ — `vault-init` จะทับด้วยค่าใน `.env` รอบหน้า

---

## 4. Rotation in Practice

rotate deployment key จริงก่อนส่งมอบ — contract เดิมถูกแทนที่ด้วย deployment ใหม่
ที่ใช้คีย์ที่ไม่เคยเปิดเผย (contract ปัจจุบัน:
`0x5dC86975615d3bc713cdf9f25ad1cA25CE7949f5`, ตรวจสอบได้ที่ amoy.polygonscan.com)

**บทเรียน:** secret ที่มีหลายแหล่ง (`.env` + Vault) ต้อง sync ให้ครบทุกที่
ถ้าแก้แค่ที่เดียว ระบบจะพังเงียบ ๆ ตอน cache หมดอายุ — เจอจริง 2 ครั้ง

---

## 5. Rotation Log

| Date | Secret Rotated | Rotated By | Notes |
|------|----------------|------------|-------|
| ______ | (initial) | ______ | Vault production mode setup |
| 2026-08-18 | Keycloak `logchain-admin-svc` client secret | Chanakan | Regenerate → sync Vault + `.env` → restart backend; verified `GET /admin/users` = 200 |
| 2026-09-06 | Blockchain deployment key | Chanakan | คีย์เดิมเคยแสดงเป็น plaintext ระหว่างพัฒนา → wallet ใหม่ + redeploy contract `0xE2502FC1…` + re-seal batch |
| 2026-09-17 | Blockchain deployment key (+ secret อื่นทั้งชุด) | Chanakan | wallet ใหม่ `0x8cBCfC04…4C55` + redeploy contract `0xE2502FC1…` → `0x5dC86975…` (contract ไม่มี `transferOwnership`) · batch เดิม re-anchor root เดิมลง contract ใหม่ → `CONFIRMED` ที่ block 47802992 · รายละเอียด `docs/worklog/2026-09-17.md` หัวข้อ 4.3 |

---

## 6. Compliance References
- **ISO 27001 A.10.1.2** — Key management policy
- **PCI DSS Req 3.6** — Cryptographic key lifecycle
- **PCI DSS Req 3.5** — Protect keys against disclosure/misuse
- **PCI DSS Req 8.2.4** — Change credentials at least every 90 days
