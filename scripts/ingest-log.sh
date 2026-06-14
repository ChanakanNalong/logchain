#!/usr/bin/env bash
#
# Ingestion path — PCI DSS Req 8.6 (application/system accounts).
# Obtains an access token for the `log-ingestor` confidential client using the
# OAuth2 client_credentials grant (no interactive password / no ROPC), then
# POSTs a log to the API. The client's service account holds the realm role
# `ingestor`, which the API's RolesGuard checks via the `roles` claim.
#
# Secrets are read from .env (gitignored) — never hardcode them here.
#
# Usage:  ./scripts/ingest-log.sh
#
set -euo pipefail

# Load secrets/config from .env if present (LOGCHAIN_INGESTOR_SECRET lives there).
if [ -f "$(dirname "$0")/../.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$(dirname "$0")/../.env"
  set +a
fi

KEYCLOAK_URL="${KEYCLOAK_URL:-http://localhost:8080}"
KEYCLOAK_REALM="${KEYCLOAK_REALM:-logchain}"
API_URL="${API_URL:-http://localhost:3000}"
CLIENT_ID="${INGESTOR_CLIENT_ID:-log-ingestor}"
CLIENT_SECRET="${LOGCHAIN_INGESTOR_SECRET:?set LOGCHAIN_INGESTOR_SECRET in .env}"

echo "→ requesting token (grant_type=client_credentials, client=$CLIENT_ID)"
TOKEN=$(curl -sf -X POST \
  "$KEYCLOAK_URL/realms/$KEYCLOAK_REALM/protocol/openid-connect/token" \
  -d "grant_type=client_credentials" \
  -d "client_id=$CLIENT_ID" \
  -d "client_secret=$CLIENT_SECRET" \
  | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')

if [ -z "${TOKEN:-}" ]; then
  echo "✗ failed to obtain access token" >&2
  exit 1
fi
echo "✓ got token"

echo "→ POST $API_URL/api/v1/logs"
curl -sf -X POST "$API_URL/api/v1/logs" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "auth-service",
    "eventType": "LOGIN_SUCCESS",
    "severity": "INFO",
    "message": "card 4111111111111111 authenticated",
    "classification": "INTERNAL",
    "cdeScope": true
  }'
echo
echo "✓ ingested"
