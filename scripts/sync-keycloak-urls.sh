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

# master admin จาก .env · ส่งรหัสทาง env ไม่ใช่ argument ของ docker exec (ไม่ค้างใน `ps` ของ host)
docker exec -e KC_PW="$KEYCLOAK_ADMIN_PASSWORD" logchain-keycloak sh -c \
  "$KC config credentials --config $CFG --server http://localhost:8080 --realm master --user '$KEYCLOAK_ADMIN' --password \"\$KC_PW\"" >/dev/null 2>&1 \
  || { echo "kcadm login ไม่ผ่าน (KEYCLOAK_ADMIN / KEYCLOAK_ADMIN_PASSWORD ใน .env)" >&2; exit 1; }
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
