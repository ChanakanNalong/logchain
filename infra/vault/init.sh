#!/bin/sh
# Vault initialization - seed secrets + create AppRoles + apply policies

set -e
echo "▶ Waiting for Vault..."
until vault status > /dev/null 2>&1; do
    sleep 1
done
echo "✓ Vault ready"

# ── 0. Auth ──
# root token ถูกสร้างโดย vault-unseal ตอน operator init แล้วเก็บไว้ใน init.env
# ไม่มีขั้นนี้ = ทุก call ด้านล่างโดน 403 permission denied
SECRETS_FILE=/vault/secrets/init.env
if [ ! -f "$SECRETS_FILE" ]; then
    echo "✗ ไม่พบ $SECRETS_FILE — vault-unseal ยังไม่ได้ init Vault" >&2
    exit 1
fi
# shellcheck source=/dev/null
. "$SECRETS_FILE"
export VAULT_TOKEN="$VAULT_ROOT_TOKEN"

# ── 1. Enable KV-v2 secret engine (ถ้ายังไม่เปิด) ──
if ! vault secrets list -format=json | grep -q '"secret/"'; then
    echo "▶ Enabling KV-v2 at secret/..."
    vault secrets enable -path=secret -version=2 kv
fi

# ── 2. Enable AppRole auth ──
if ! vault auth list -format=json | grep -q '"approle/"'; then
    echo "▶ Enabling AppRole auth..."
    vault auth enable approle
fi  

# ── 3. Apply policies ──
echo "▶ Applying policies..."
vault policy write nestjs-policy /vault/policies/nestjs-policy.hcl
vault policy write detection-policy /vault/policies/detection-policy.hcl

# ── 4. Seed secrets (from env vars, from current .env) ──
echo "▶ Seeding secrets..."

vault kv put secret/logchain/database \
    password="${POSTGRES_PASSWORD}" \
    keycloak_password="${KC_DB_PASSWORD}"

vault kv put secret/logchain/keycloak \
    client_secret="${LOGCHAIN_CLIENT_SECRET}" \
    ingestor_secret="${LOGCHAIN_INGESTOR_SECRET}" \
    admin_client_secret="${LOGCHAIN_ADMIN_CLIENT_SECRET}"

vault kv put secret/logchain/blockchain \
    private_key="${BLOCKCHAIN_PRIVATE_KEY}"

# detection-policy ให้สิทธิ์อ่าน path นี้ และ app/vault.py ก็อ่านจากตรงนี้
# ถ้า ABUSEIPDB_KEY ว่าง enrichment จะ fallback เป็น mock mode เอง
vault kv put secret/logchain/notification \
  host="${MAIL_HOST:-smtp.gmail.com}" \
  port="${MAIL_PORT:-587}" \
  user="${MAIL_USER:-}" \
  pass="${MAIL_PASS:-}" \
  to="${MAIL_TO:-${MAIL_USER:-}}"

vault kv put secret/logchain/detection \
    abuseipdb_key="${ABUSEIPDB_KEY}"

# ── 5. Create AppRoles ──
echo "▶ Creating AppRole: nestjs-api..."
vault write auth/approle/role/nestjs-api \
    token_policies="nestjs-policy" \
    token_ttl=1h \
    token_max_ttl=4h \
    secret_id_ttl=0

echo "▶ Creating AppRole: detection-service..."
vault write auth/approle/role/detection-service \
    token_policies="detection-policy" \
    token_ttl=1h \
    token_max_ttl=4h \
    secret_id_ttl=0

# ── 6. Get role_id + secret_id ── 
# save ไว้ใน tmpfs volume ที่ app จะ mount ตอน dev
NESTJS_ROLE_ID=$(vault read -field=role_id auth/approle/role/nestjs-api/role-id)
NESTJS_SECRET_ID=$(vault write -field=secret_id -f auth/approle/role/nestjs-api/secret-id)
DETECTION_ROLE_ID=$(vault read -field=role_id auth/approle/role/detection-service/role-id)
DETECTION_SECRET_ID=$(vault write -field=secret_id -f auth/approle/role/detection-service/secret-id)

echo ""
echo "══════════════════════════════════════════════════"
echo " Vault initialized. Add these to .env:"
echo "══════════════════════════════════════════════════"
echo "VAULT_ADDR=http://localhost:8200"
echo "VAULT_NESTJS_ROLE_ID=${NESTJS_ROLE_ID}"
echo "VAULT_NESTJS_SECRET_ID=${NESTJS_SECRET_ID}"
echo "VAULT_DETECTION_ROLE_ID=${DETECTION_ROLE_ID}"
echo "VAULT_DETECTION_SECRET_ID=${DETECTION_SECRET_ID}"
echo "══════════════════════════════════════════════════"
