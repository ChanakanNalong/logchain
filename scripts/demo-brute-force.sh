#!/usr/bin/env bash
# Demo: brute force detection (rule 5710) — ยิง 6 AUTH_FAILURE ให้ trip threshold 5/60s
# ใช้: ./demo-brute-force.sh <INGESTOR_OR_ADMIN_TOKEN>
set -euo pipefail
TOKEN="${1:-${TOKEN:-}}"
API="${API:-http://localhost:3000/api/v1}"

echo "→ ยิง 6 login-fail จาก 203.0.113.77..."
for i in $(seq 1 6); do
  curl -s -o /dev/null -w "  log $i → %{http_code}\n" -X POST \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "{\"source\":\"web-server-01\",\"sourceIp\":\"203.0.113.77\",\"eventType\":\"AUTH_FAILURE\",\"severity\":\"WARNING\",\"message\":\"authentication failed for user jdoe - invalid credentials session $(openssl rand -hex 4)\"}" \
    "$API/logs"
  sleep 1
done

echo "→ รอ detection + backend consume (5s)..."
sleep 5
echo "→ RULE_MATCH ล่าสุด:"
# ดัก HTTP code ก่อน jq — token ของ log-ingestor (จาก ingest-log.sh) ยิง /logs ได้
# แต่อ่าน /alerts ไม่ได้ (ต้อง role analyst/operator/admin) ได้ 403 เป็น JSON error
# แล้ว jq พังด้วย "Cannot index string" ทั้งที่ alert ถูกบันทึกไปเรียบร้อยแล้ว
BODY=$(mktemp)
trap 'rm -f "$BODY"' EXIT
CODE=$(curl -s -o "$BODY" -w "%{http_code}" -H "Authorization: Bearer $TOKEN" "$API/alerts")
case "$CODE" in
  200) ;;
  401|403)
    echo "  alert ถูกบันทึกแล้ว แต่ token นี้ไม่มีสิทธิ์อ่าน /alerts (HTTP $CODE)"
    echo "  เปิดดูที่หน้า Alerts บน dashboard หรือรันใหม่ด้วย token ที่มี role analyst/operator/admin"
    exit 0 ;;
  *)
    echo "  อ่าน /alerts ไม่สำเร็จ (HTTP $CODE):" >&2
    cat "$BODY" >&2; echo >&2
    exit 1 ;;
esac
jq -r '[.[] | select(.alertType == "RULE_MATCH")][0]
       | if . == null then
           "  ยังไม่มี RULE_MATCH — รอ detection อีกสักครู่"
         else
           "  \(.alertType) | \(.severity) | \(.title)"
         end' "$BODY"
