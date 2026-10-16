#!/usr/bin/env bash
#
# demo-merkle-100.sh — ยิง log สังเคราะห์ N ใบ(ค่าเริ่มต้น 100) เข้าระบบ เพื่อให้รอบ seal
# ถัดไปได้ batch ก้อนโต ไว้โชว์ Merkle tree + proof บนหน้า Verify
#
# ── รันที่ไหน ───────────────────────────────────────────────────────────────
# รันบน CT141 (เครื่อง cloud) เท่านั้น — ใช้ client `log-ingestor`
# (OAuth2 client_credentials · ไม่มี password) อ่าน LOGCHAIN_INGESTOR_SECRET จาก
# /home/logchain/logchain/.env เหมือน ingest-log.sh · ยิงเข้า Keycloak + API ที่
# bind 127.0.0.1 ของ CT141 (ไม่ต้อง trust CA) · client vps-forwarder ใช้ไม่ได้
# เพราะ secret คนละตัว (ของ forwarder อยู่ /opt) และไม่ได้ออกแบบมายิงเป็นชุด
#
# ล็อกที่ยิง: source "merkle-demo" · severity INFO · classification INTERNAL ·
# cdeScope false · ข้อความธรรมดา (ไม่มีคำ card/pan/cvv · ไม่ใช่ path · ไม่มี
# UNION/SELECT/`;`/`$(`) → ไม่ไปตรง detection rule ใด ๆ = ไม่เกิด alert
#
# ── seal บน CT141 ────────────────────────────────────────────────────────────
# SEAL_CRON="0 17 * * * *"  → seal ทุกชั่วโมงที่นาที :17 · SEAL_BATCH_SIZE=500
# แต่ละรอบ seal หยิบ log ที่ยังไม่อยู่ batch ไหน "ทั้งหมด" เรียงตาม createdAt
# แล้วปิดเป็น batch ละ ≤500 ใบ (1 batch = 1 tx storeRoot)
#
# ⇒ ถ้า (100 demo + ล็อกจริงที่ค้าง) ≤ 500 → ได้ batch เดียว 1 tx (ค่าใช้จ่าย
#    เท่ารอบปกติ) · ถ้าเกิน 500 → แตกเป็นหลาย batch หลาย tx
#
# จำนวนในก้อน = 100 + "ล็อกจริงที่ค้างตั้งแต่ :17 รอบก่อน" (forwarder ส่ง web-proxy
# ~240/ชม. → ยิงตอน :14 จะค้างแล้วราว 220–240 ใบ → รวม ~320–340 ใบ ยัง ≤500)
#
# อยากได้ "100 พอดี" (tree 100 leaf สะอาด ไม่มีล็อกจริงปน):
#   1) (เจ้าของ บน CT141) systemctl stop logchain-forwarder   # หยุดล็อกจริง
#   2) รอให้ล็อกจริงที่ค้างถูก seal ก่อน (รอ :17 รอบหนึ่ง หรือ POST /integrity/seal-now)
#      จนนับ "ล็อกค้าง" = 0
#   3) ./scripts/demo-merkle-100.sh                            # ยิง 100 (ค้าง = 100 พอดี)
#   4) POST /integrity/seal-now (admin) หรือรอ :17 → ได้ batch 100 ใบพอดี 1 tx
#   5) (เจ้าของ) systemctl start logchain-forwarder            # เปิด forwarder คืน
#   นับล็อกค้างได้ด้วย (read-only):
#     docker exec logchain-postgres psql -U logchain -d logchain -At -c \
#       "SELECT count(*) FROM logs l WHERE NOT EXISTS
#        (SELECT 1 FROM log_batch_mapping m WHERE m.log_id = l.id);"
#
# ── ใช้งาน ───────────────────────────────────────────────────────────────────
#   ./scripts/demo-merkle-100.sh            # ยิง 100 ใบ
#   COUNT=100 ./scripts/demo-merkle-100.sh  # กำหนดจำนวน
#   DRY_RUN=1 ./scripts/demo-merkle-100.sh  # แสดงว่าจะทำอะไร โดยไม่ยิงจริง
#
set -euo pipefail

COUNT="${COUNT:-100}"
SOURCE="${SOURCE:-merkle-demo}"
SLEEP="${SLEEP:-0.05}"   # เว้นจังหวะเล็กน้อยกันถล่ม API
DRY_RUN="${DRY_RUN:-0}"

# โหลด secret/config จาก .env (LOGCHAIN_INGESTOR_SECRET อยู่ในนั้น · gitignored)
if [ -f "$(dirname "$0")/../.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$(dirname "$0")/../.env"
  set +a
fi

KEYCLOAK_URL="${KEYCLOAK_LOCAL_URL:-http://localhost:${KEYCLOAK_HOST_PORT:-8080}}"
KEYCLOAK_REALM="${KEYCLOAK_REALM:-logchain}"
API_URL="${API_URL:-http://localhost:3000}"
CLIENT_ID="${INGESTOR_CLIENT_ID:-log-ingestor}"

if [ "$DRY_RUN" = "1" ]; then
  echo "DRY RUN — would POST $COUNT logs (source=$SOURCE, INFO, INTERNAL, cdeScope=false) to $API_URL/api/v1/logs"
  echo "message template: 'merkle tree demo log #<i>/$COUNT — synthetic entry for Verify demo, no sensitive data'"
  echo "no detection rule matches this message; next :17 seal folds them into one batch (<=500 => 1 tx)"
  exit 0
fi

CLIENT_SECRET="${LOGCHAIN_INGESTOR_SECRET:?set LOGCHAIN_INGESTOR_SECRET in .env (run on CT141)}"

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
echo "✓ got token · POSTing $COUNT logs to $API_URL/api/v1/logs (source=$SOURCE)"

ok=0
fail=0
for i in $(seq 1 "$COUNT"); do
  msg="merkle tree demo log #$i/$COUNT — synthetic entry for Verify demo, no sensitive data"
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API_URL/api/v1/logs" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"source\":\"$SOURCE\",\"eventType\":\"USER_ACTIVITY\",\"severity\":\"INFO\",\"message\":\"$msg\",\"classification\":\"INTERNAL\",\"cdeScope\":false}")
  if [ "$code" = "201" ] || [ "$code" = "200" ]; then
    ok=$((ok + 1))
  else
    fail=$((fail + 1))
    echo "  ✗ log #$i → HTTP $code" >&2
  fi
  sleep "$SLEEP"
done

echo "✓ done · ingested $ok/$COUNT (failed $fail)"
echo "  รอรอบ seal :17 ถัดไป (หรือ POST /integrity/seal-now) → batch = $ok + ล็อกจริงที่ค้าง"
echo "  ตรวจ batch ที่หน้า Verify / Batch audit (source ของล็อกใน batch = $SOURCE)"
[ "$fail" -eq 0 ]
