# PostgreSQL Failover Runbook

## When to trigger
- Primary DB (`logchain-postgres`) unreachable > 60 seconds
- Application errors: "connection refused" หรือ "role logchain not found"
- Prometheus alert `postgres_up{instance="postgres"} == 0`

## Prerequisites
- User with `docker exec` access on host
- Documented database credentials from `.env`

## Procedure (Manual Failover)

### Step 1 — Verify primary is down
docker ps | grep logchain-postgres
docker exec logchain-postgres pg_isready -U logchain
# ควรได้ error หรือ container not running

### Step 2 — Verify standby is healthy
docker exec logchain-postgres-standby pg_isready -U logchain
# ควรได้: /var/run/postgresql:5432 - accepting connections

### Step 3 — Promote standby to primary
docker exec logchain-postgres-standby psql -U logchain -c "SELECT pg_promote();"

# Verify (จะเปลี่ยนจาก recovery=t เป็น f)
docker exec logchain-postgres-standby psql -U logchain -c "SELECT pg_is_in_recovery();"
# ต้องได้: f

### Step 4 — Update application config
# แก้ .env: DATABASE_URL ให้ชี้ port 5434 (standby ที่กลายเป็น primary)
# หรือใช้ pgbouncer/HAProxy ถ้ามี

# Restart NestJS
cd ~/Documents/logchain
# Ctrl+C ที่ terminal npm run start:dev
npm run start:dev

### Step 5 — Post-failover verification
# ทดสอบ write ใหม่
TOKEN=$(curl -s ... | jq -r '.access_token')
curl -X POST http://localhost:3000/api/v1/logs \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"source":"post-failover","eventType":"TEST","severity":"INFO","message":"promoted OK"}'

# ต้อง 201 Created

### Step 6 — Provision new standby (optional, after incident)
1. Investigate old primary failure (logs, disk space, OOM)
2. Rebuild as new standby using pg_basebackup from new primary
3. Update runbook if new failure mode identified

## RTO / RPO
- **RTO (Recovery Time Objective):** ~5 นาที (manual promote + config update)
- **RPO (Recovery Point Objective):** ~0-1 วินาที (async streaming, ขึ้นกับ replay_lag)

## PCI DSS References
- Req 12.10.1 — Incident response plan ต้องมีขั้นตอน database failover
- Req 10.5.5 — Log integrity ต้อง maintain ระหว่าง failover
- ISO 27001 A.17 — Business continuity, IT redundancy