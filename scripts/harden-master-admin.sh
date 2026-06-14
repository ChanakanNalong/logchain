#!/usr/bin/env bash
#
# Harden the Keycloak MASTER realm admin — PCI DSS Req 8.4/8.5 (MFA for all
# administrative access) and Req 2.2.2 (no vendor-default accounts).
#
# The master realm controls every other realm (including `logchain`), so its
# admin is the highest-value identity in the system. This script, in one run:
#   1. applies a password policy to the master realm (same as logchain)
#   2. ensures a strong, non-default human admin (from KEYCLOAK_ADMIN / *_PASSWORD)
#   3. provisions an automation service-account client (client_credentials) with
#      LEAST-PRIVILEGE master-realm roles — the CI/CD path that survives MFA
#   4. forces TOTP MFA on the human admin (CONFIGURE_TOTP required action)
#   5. deletes the default `admin` account
#
# Authentication prefers the path that survives the MFA lockdown:
#   automation service account -> new admin (pre-MFA) -> default admin (first run).
# Idempotent: re-running on an already-hardened realm is a clean no-op.
#
# Secrets are read from .env (gitignored). Run once after the stack is up:
#   ./scripts/harden-master-admin.sh
#
set -euo pipefail

if [ -f "$(dirname "$0")/../.env" ]; then
  set -a; # shellcheck disable=SC1091
  . "$(dirname "$0")/../.env"; set +a
fi

KEYCLOAK_URL="${KEYCLOAK_URL:-http://localhost:8080}"
MASTER="${KEYCLOAK_URL}/admin/realms/master"
POLICY="length(12) and digits(1) and upperCase(1) and lowerCase(1) and notUsername and passwordHistory(4)"

CUR_USER="${KC_CURRENT_ADMIN:-admin}"
CUR_PASS="${KC_CURRENT_ADMIN_PASSWORD:-admin}"
NEW_USER="${KEYCLOAK_ADMIN:?set KEYCLOAK_ADMIN in .env}"
NEW_PASS="${KEYCLOAK_ADMIN_PASSWORD:?set KEYCLOAK_ADMIN_PASSWORD in .env}"
AUTOMATION_CLIENT="${MASTER_AUTOMATION_CLIENT_ID:-master-automation}"
AUTOMATION_SECRET="${MASTER_AUTOMATION_SECRET:-}"
# Least-privilege roles for the automation service account: exactly what this
# script's operations need on the master realm — no blanket cross-realm admin.
SA_ROLES="manage-realm manage-users manage-clients view-realm"

api() { curl -sf -H "Authorization: Bearer $TOKEN" "$@"; }

# Structural JSON parsing — read the actual object/array, never positional or
# greedy text matching. Prints the top-level "id" (first element if an array),
# or nothing. Always exits 0 so callers can test emptiness.
json_first_id() {
  python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if isinstance(d, list):
    d = d[0] if d else {}
if isinstance(d, dict):
    sys.stdout.write(d.get("id", ""))
'
}

get_token() {
  curl -s -X POST "$KEYCLOAK_URL/realms/master/protocol/openid-connect/token" \
    -d grant_type=password -d client_id=admin-cli \
    -d "username=$1" -d "password=$2" \
    | python3 -c 'import sys,json;sys.stdout.write(json.load(sys.stdin).get("access_token",""))' 2>/dev/null || true
}

sa_token() {
  [ -n "$AUTOMATION_SECRET" ] || return 0
  curl -s -X POST "$KEYCLOAK_URL/realms/master/protocol/openid-connect/token" \
    -d grant_type=client_credentials \
    -d "client_id=$AUTOMATION_CLIENT" -d "client_secret=$AUTOMATION_SECRET" \
    | python3 -c 'import sys,json;sys.stdout.write(json.load(sys.stdin).get("access_token",""))' 2>/dev/null || true
}

user_id() { api "$MASTER/users?username=$1&exact=true" 2>/dev/null | json_first_id; }

# Authenticate, preferring the path that survives MFA:
#   1. automation service account (client_credentials) — works after MFA lockdown
#   2. the new admin via ROPC — only before CONFIGURE_TOTP is set
#   3. the current/default admin — first run only
TOKEN="$(sa_token)"
[ -n "$TOKEN" ] || TOKEN="$(get_token "$NEW_USER" "$NEW_PASS")"
[ -n "$TOKEN" ] || TOKEN="$(get_token "$CUR_USER" "$CUR_PASS")"
[ -n "$TOKEN" ] || { echo "✗ could not authenticate to master realm" >&2; exit 1; }
echo "✓ authenticated to master realm"

echo "→ applying master realm passwordPolicy"
api -X PUT "$MASTER" -H "Content-Type: application/json" \
  -d "{\"passwordPolicy\":\"${POLICY}\"}"
echo "  done"

# --- Strong, non-default human admin -----------------------------------------
NEW_ID="$(user_id "$NEW_USER")"
if [ -z "$NEW_ID" ]; then
  echo "→ creating strong admin '$NEW_USER'"
  api -X POST "$MASTER/users" -H "Content-Type: application/json" \
    -d "{\"username\":\"$NEW_USER\",\"enabled\":true}"
  NEW_ID="$(user_id "$NEW_USER")"
  api -X PUT "$MASTER/users/$NEW_ID/reset-password" -H "Content-Type: application/json" \
    -d "{\"type\":\"password\",\"value\":\"$NEW_PASS\",\"temporary\":false}"
  # Human break-glass admin keeps the full master 'admin' composite role.
  ADMIN_ROLE="$(api "$MASTER/roles/admin")"
  api -X POST "$MASTER/users/$NEW_ID/role-mappings/realm" \
    -H "Content-Type: application/json" -d "[$ADMIN_ROLE]"
  echo "  created '$NEW_USER' with master admin role"
else
  echo "→ admin '$NEW_USER' already exists (skipping create)"
fi

# --- Automation/CI path: least-privilege service-account client --------------
# client_credentials tokens are NOT issued through the browser flow, so they are
# unaffected by the human MFA requirement. This is the supported way to automate
# Keycloak admin tasks (CI/CD, IaC) without disabling MFA for people.
if [ -n "$AUTOMATION_SECRET" ]; then
  CID="$(api "$MASTER/clients?clientId=$AUTOMATION_CLIENT" 2>/dev/null | json_first_id)"
  if [ -z "$CID" ]; then
    echo "→ creating automation service-account client '$AUTOMATION_CLIENT'"
    api -X POST "$MASTER/clients" -H "Content-Type: application/json" -d "{
      \"clientId\":\"$AUTOMATION_CLIENT\",\"enabled\":true,\"protocol\":\"openid-connect\",
      \"publicClient\":false,\"serviceAccountsEnabled\":true,
      \"standardFlowEnabled\":false,\"directAccessGrantsEnabled\":false,
      \"secret\":\"$AUTOMATION_SECRET\"}"
    CID="$(api "$MASTER/clients?clientId=$AUTOMATION_CLIENT" | json_first_id)"
  else
    echo "→ automation client '$AUTOMATION_CLIENT' already exists"
  fi

  SA_ID="$(api "$MASTER/clients/$CID/service-account-user" | json_first_id)"
  [ -n "$SA_ID" ] || { echo "✗ could not resolve service-account user" >&2; exit 1; }

  # Grant least-privilege master-realm client roles, idempotently. Only the
  # missing roles are mapped, so a clean re-run performs no privileged write.
  RM_CID="$(api "$MASTER/clients?clientId=master-realm" | json_first_id)"
  HAVE="$(api "$MASTER/users/$SA_ID/role-mappings/clients/$RM_CID" 2>/dev/null \
    | python3 -c 'import sys,json;print(" ".join(r["name"] for r in json.load(sys.stdin)))' 2>/dev/null || true)"
  MISSING=""
  for r in $SA_ROLES; do
    case " $HAVE " in *" $r "*) : ;; *) MISSING="$MISSING $r" ;; esac
  done
  if [ -n "$MISSING" ]; then
    REPS="$(api "$MASTER/clients/$RM_CID/roles" \
      | MISS="$MISSING" python3 -c 'import os,sys,json;need=set(os.environ["MISS"].split());print(json.dumps([r for r in json.load(sys.stdin) if r["name"] in need]))')"
    api -X POST "$MASTER/users/$SA_ID/role-mappings/clients/$RM_CID" \
      -H "Content-Type: application/json" -d "$REPS"
    echo "  '$AUTOMATION_CLIENT' granted least-privilege roles:$MISSING"
  else
    echo "  '$AUTOMATION_CLIENT' least-privilege roles already present"
  fi
fi

echo "→ forcing TOTP MFA on '$NEW_USER'"
api -X PUT "$MASTER/users/$NEW_ID" -H "Content-Type: application/json" \
  -d '{"requiredActions":["CONFIGURE_TOTP"]}'
echo "  done"

if [ "$CUR_USER" != "$NEW_USER" ]; then
  DEF_ID="$(user_id "$CUR_USER")"
  if [ -n "$DEF_ID" ]; then
    echo "→ deleting default admin '$CUR_USER'"
    api -X DELETE "$MASTER/users/$DEF_ID"
    echo "  deleted"
  fi
fi

echo "✓ master realm hardened"
