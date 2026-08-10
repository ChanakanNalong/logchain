#!/usr/bin/env bash
# Demo: brute force detection (rule 5710) — ยิง 6 AUTH_FAILURE ให้ trip threshold 5/60s
# ใช้: ./demo-brute-force.sh <INGESTOR_OR_ADMIN_TOKEN>
set -euo pipefail
TOKEN="${1:-${TOKEN:-}}"
API="${API:-http://localhost:3000/api/v1}"

echo "→ ยิง 6 login-fail จาก 203.0.113.66..."
for i in $(seq 1 6); do
  curl -s -o /dev/null -w "  log $i → %{http_code}\n" -X POST \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d '{"source":"web-server-01","sourceIp":"203.0.113.66","eventType":"AUTH_FAILURE","severity":"WARNING","message":"authentication failed for user admin - wrong password"}' \
    "$API/logs"
  sleep 1
done

echo "→ รอ detection + backend consume (5s)..."
sleep 5
echo "→ alert ล่าสุด:"
curl -s -H "Authorization: Bearer $TOKEN" "$API/alerts" | jq -r '.[0] | "  \(.alertType) | \(.severity) | \(.title)"'
