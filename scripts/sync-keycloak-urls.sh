#!/usr/bin/env bash
# เพิ่ม URL ของ dashboard (HTTPS) ลง redirectUris / webOrigins ของ client `logchain-frontend` ใน realm ที่มีอยู่แล้ว
#
# realm ถูก import ครั้งเดียวตอน DB ว่าง — แก้ infra/keycloak/realm-logchain.json.template แล้ว realm เดิมไม่ได้รับ
# script นี้เติมเฉพาะที่ยังไม่มี (รันซ้ำได้ · ไม่ลบของเดิม) · bootstrap.sh เรียกให้หลัง Keycloak พร้อม
#   DASHBOARD_PUBLIC_URL=https://logchain.lan:3453 ./scripts/sync-keycloak-urls.sh   ← ตอนเปิดให้เครื่องอื่นใช้
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

URL="${DASHBOARD_PUBLIC_URL:-https://localhost:3453}"
URL="${URL%/}"
KC=/opt/keycloak/bin/kcadm.sh
CFG=/tmp/kcadm-sync.config

# เช็คจาก endpoint สาธารณะก่อน (ไม่ต้อง login): authorize ตอบ 200 เฉพาะ redirect_uri ที่ลงทะเบียน (ไม่งั้น 400)
# และ token endpoint ใส่ CORS header เฉพาะ origin ที่อยู่ใน webOrigins · realm ที่ import จาก template ปัจจุบันมีครบแล้ว
# → ไม่ต้อง login ซึ่งจำเป็น เพราะหลัง harden-master-admin.sh `kc-admin` ติด CONFIGURE_TOTP login ด้วยรหัสอย่างเดียวไม่ได้
OIDC="http://localhost:${KEYCLOAK_HOST_PORT:-8080}/realms/logchain/protocol/openid-connect"
auth_code=$(curl -s -o /dev/null -w '%{http_code}' \
  "$OIDC/auth?client_id=logchain-frontend&response_type=code&scope=openid&redirect_uri=$URL/callback&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256" || true)
cors=$(curl -s -D - -o /dev/null -X POST "$OIDC/token" -H "Origin: $URL" \
  -d client_id=logchain-frontend -d grant_type=authorization_code -d code=x -d "redirect_uri=$URL/callback" \
  | tr -d '\r' | grep -i '^access-control-allow-origin:' || true)
if [ "$auth_code" = 200 ] && [ "${cors#*: }" = "$URL" ]; then
  echo "✓ logchain-frontend มี $URL อยู่แล้ว"
  exit 0
fi

# master admin จาก .env · ส่งรหัสทาง env ไม่ใช่ argument ของ docker exec (ไม่ค้างใน `ps` ของ host)
if ! err=$(docker exec -e KC_PW="$KEYCLOAK_ADMIN_PASSWORD" logchain-keycloak sh -c \
  "$KC config credentials --config $CFG --server http://localhost:8080 --realm master --user '$KEYCLOAK_ADMIN' --password \"\$KC_PW\"" 2>&1); then
  if grep -q 'not fully set up' <<<"$err"; then
    echo "kcadm login ไม่ได้: '$KEYCLOAK_ADMIN' ต้องตั้ง TOTP ก่อน (harden-master-admin.sh บังคับ MFA)" >&2
    echo "  เพิ่มเองใน admin console https://localhost:8443/admin → realm logchain → Clients → logchain-frontend:" >&2
    echo "  Valid redirect URIs += $URL/*  ·  Web origins += $URL" >&2
  else
    echo "kcadm login ไม่ผ่าน (KEYCLOAK_ADMIN / KEYCLOAK_ADMIN_PASSWORD ใน .env)" >&2
  fi
  exit 1
fi
trap 'docker exec logchain-keycloak rm -f "$CFG"' EXIT

client=$(docker exec logchain-keycloak $KC get clients --config "$CFG" -r logchain -q clientId=logchain-frontend --fields id,redirectUris,webOrigins)
id=$(jq -r '.[0].id' <<<"$client")
[ "$id" != null ] || { echo "ไม่พบ client logchain-frontend ใน realm logchain" >&2; exit 1; }

redirects=$(jq -c --arg u "$URL/*" '.[0].redirectUris | if index($u) then . else [$u] + . end' <<<"$client")
origins=$(jq -c --arg u "$URL" '.[0].webOrigins | if index($u) then . else [$u] + . end' <<<"$client")

if [ "$redirects" = "$(jq -c '.[0].redirectUris' <<<"$client")" ] && [ "$origins" = "$(jq -c '.[0].webOrigins' <<<"$client")" ]; then
  echo "✓ logchain-frontend มี $URL อยู่แล้ว"
else
  docker exec logchain-keycloak $KC update "clients/$id" --config "$CFG" -r logchain \
    -s "redirectUris=$redirects" -s "webOrigins=$origins"
  echo "✅ logchain-frontend: เพิ่ม $URL (redirectUris=$redirects)"
fi
