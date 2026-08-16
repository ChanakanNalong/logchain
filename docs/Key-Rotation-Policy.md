# Key Rotation Policy
## Logchain — Cyber Security Log Integrity System
**Version:** 2.1
**Date:** 2026-08-14
**Scope:** Governance policy (ISO 27001 A.10.1.2 key management)

> **Operational steps:** ดู `docs/runbooks/vault-key-rotation.md`
> สำหรับ Vault unseal/rekey commands (production mode).
> เอกสารนี้เป็น **policy layer** — schedule, ownership, audit log.

---

## 0. How services authenticate to Vault (AppRole)

ทุก secret ถูกอ่านผ่าน **AppRole auth method** ไม่มี service ไหนถือ root token
(setup: `infra/vault/init.sh`; runtime login: `src/vault/vault.service.ts`)

| Item | Value | Source |
|------|-------|--------|
| Auth method | `approle` (`vault auth enable approle`) | `infra/vault/init.sh` |
| NestJS role | `nestjs-api` → policy `nestjs-policy` (read `database`, `keycloak`, `blockchain`, `notification`) | `infra/vault/policies/nestjs-policy.hcl` |
| Detection role | `detection-service` → policy `detection-policy` (read `detection` only) | `infra/vault/policies/detection-policy.hcl` |
| Token TTL | `token_ttl=1h`, `token_max_ttl=4h` | `infra/vault/init.sh` |
| `secret_id_ttl` | `0` (**never expires**) | `infra/vault/init.sh` |
| Login flow | `VaultService.loginWithRetry` — `approleLogin({role_id, secret_id})` → exchanges for a client token, retries 5x with backoff, app **fails to start** if login fails | `src/vault/vault.service.ts` |
| Credentials supplied via | `VAULT_ADDR`, `VAULT_NESTJS_ROLE_ID`, `VAULT_NESTJS_SECRET_ID` env vars (printed by `infra/vault/init.sh` for manual `.env` seeding in dev) | `.env` |

> **Open risk (not yet remediated):** `secret_id_ttl=0` means the `secret_id` issued to each AppRole
> never expires — only the derived login *token* expires (max 4h). Rotating a `secret_id` today
> requires manually revoking and reissuing it (`vault write -f auth/approle/role/<role>/secret-id`)
> and updating the app's env var; there is no scheduled rotation for it yet. Track this alongside
> ISO27001-ISMS R09.

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
> **Current chain: Local Hardhat** (`BLOCKCHAIN_RPC_URL=http://127.0.0.1:8545`). **Target:
> Polygon Amoy testnet** for production. Rotation steps differ by environment:

- **Local Hardhat (current):** generate a new wallet, use one of Hardhat's pre-funded dev accounts
  (no faucet needed — Hardhat mints test ETH on node start) → redeploy the contract with
  `npx hardhat run scripts/deploy.ts` → update `CONTRACT_ADDRESS`
- **Polygon Amoy (target, not yet live):** generate wallet → fund with test MATIC (Amoy faucet) →
  redeploy/transfer contract ownership on Amoy → update `CONTRACT_ADDRESS`
- Either way: update `secret/logchain/blockchain` (`private_key`) in Vault — `BlockchainService`
  reads it from `VaultService.get().blockchain.privateKey`, never from `.env`

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

## 5. Production Hardening Gaps (tracked, not yet closed)

| Gap | Current state (dev) | Required for production | Source |
|-----|----------------------|--------------------------|--------|
| Vault unseal material | 5 Shamir shares + root token sit in `infra/vault/.secrets/init.env` on the same disk as `vault_data` — anyone who reads the repo host can unseal Vault | Auto-unseal via cloud KMS (AWS KMS / GCP Cloud KMS) — see `seal` stanza in `docs/runbooks/vault-key-rotation.md` §Production | `docs/runbooks/vault-key-rotation.md` |
| Vault transport | `tls_disable = 1` in `infra/vault/config/vault.hcl` — tokens/secrets travel as plaintext | Enable TLS | `docs/runbooks/vault-key-rotation.md` |
| Vault storage backend | `storage "file"` — single point of failure, no HA | `storage "raft"` | `docs/runbooks/vault-key-rotation.md` |
| AppRole `secret_id` | `secret_id_ttl=0`, never rotated on a schedule | Set a TTL and add to the rotation schedule (§1) | `infra/vault/init.sh` |
| Blockchain anchor | Local Hardhat (ephemeral in-memory chain — a node restart with no persistent state loses all anchored roots unless redeployed against the same chain data) | Polygon Amoy testnet, then mainnet | `.env.example`, `src/blockchain/blockchain.service.ts` |

---

## 6. Compliance References
- **ISO 27001 A.10.1.2** — Key management policy
- **PCI DSS Req 3.6** — Cryptographic key lifecycle
- **PCI DSS Req 3.5** — Protect keys against disclosure/misuse
- **PCI DSS Req 8.2.4** — Change credentials at least every 90 days
