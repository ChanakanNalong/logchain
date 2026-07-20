# Key Rotation Runbook
## Logchain — Cyber Security Log Integrity System

**Version:** 1.0
**Date:** 2026-06-04

---

## 1. Keys in Scope

| Key | Location | Rotation Frequency | Owner |
|-----|----------|--------------------|-------|
| JWT Secret | .env JWT_SECRET | Every 90 days | Person 1 |
| Blockchain Private Key | .env PRIVATE_KEY | Every 180 days | Person 1 |
| Database Password | .env DB_PASSWORD | Every 90 days | Person 1 |
| Gmail App Password | .env MAIL_PASS | Every 180 days | Person 2 |

---

## 2. JWT Secret Rotation Steps

1. Generate new secret: `openssl rand -hex 64`
2. Update .env: `JWT_SECRET=<new_secret>`
3. Restart NestJS backend: `pm2 restart logchain`
4. Verify all endpoints still authenticate correctly
5. Invalidate old tokens by bumping token version in DB
6. Record rotation in this runbook

---

## 3. Blockchain Private Key Rotation Steps

1. Generate new wallet: `npx hardhat run scripts/create-wallet.js`
2. Fund new wallet with test ETH
3. Deploy new contract or transfer ownership
4. Update .env: `PRIVATE_KEY=<new_key>`
5. Update contract address if redeployed
6. Verify blockchain writes still work
7. Record rotation in this runbook

---

## 4. Rotation Log

| Date | Key Rotated | Rotated By | Notes |
|------|-------------|------------|-------|
| ______ | JWT_SECRET | ______ | Initial setup |
| ______ | PRIVATE_KEY | ______ | Initial setup |
