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

secret ทั้งหมดเก็บใน HashiCorp Vault (`secret/logchain/*`) — ไม่ใช่ `.env`
(`.env` เก็บแค่ Vault AppRole credentials + container bootstrap values)

| Secret | Vault Path | Rotation Frequency | Owner |
|--------|-----------|--------------------|-------|
| Keycloak client secret | `secret/logchain/keycloak` | 90 days | Person A |
| Keycloak ingestor secret | `secret/logchain/keycloak` | 90 days | Person A |
| Blockchain private key | `secret/logchain/blockchain` | 180 days | Person A |
| Database password | `secret/logchain/database` | 90 days | Person B |
| Gmail App Password (SMTP) | `secret/logchain/notification` | 180 days | Person C |
| Vault root token | `infra/vault/.secrets/init.env` | 90 days (or on personnel change) | Person B |
| Vault unseal keys (5) | `infra/vault/.secrets/init.env` | On compromise only | Person B |

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
- Generate wallet ใหม่ → fund test MATIC (Amoy faucet) → redeploy/transfer contract ownership
- Update `secret/logchain/blockchain` → update CONTRACT_ADDRESS ถ้า redeploy

### Database password
- ALTER USER ใน Postgres → update `secret/logchain/database` → restart NestJS
- **ระวัง:** primary + standby ต้อง sync password (replication user แยกต่างหาก)

### SMTP (Gmail App Password)
- Google Account → Security → App Passwords → revoke เก่า + generate ใหม่
- Update `secret/logchain/notification`

---

## 4. Rotation Log

| Date | Secret Rotated | Rotated By | Notes |
|------|----------------|------------|-------|
| ______ | (initial) | ______ | Vault production mode setup |

---

## 5. Compliance References
- **ISO 27001 A.10.1.2** — Key management policy
- **PCI DSS Req 3.6** — Cryptographic key lifecycle
- **PCI DSS Req 3.5** — Protect keys against disclosure/misuse
- **PCI DSS Req 8.2.4** — Change credentials at least every 90 days
