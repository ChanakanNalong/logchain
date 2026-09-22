#!/usr/bin/env bash
# ปลด Vault user lockout ของ AppRole — อาการ: approle login ตอบ "permission denied"
# ทั้งที่ค่าใน .env ถูก (ดู README หัวข้อ "Vault user lockout")
#
# ใช้:  ./scripts/vault-unlock.sh             ← ดูว่ามีใครโดนล็อกอยู่ (ไม่แก้อะไร)
#       ./scripts/vault-unlock.sh backend     ← หยุด backend → unlock → เปิดใหม่
#       ./scripts/vault-unlock.sh detection   ← หยุด detection-consumer/api → unlock → เปิดใหม่
#
# ต้องหยุด container ก่อน unlock เสมอ — restart: unless-stopped วน retry login อยู่
# unlock ตอนมันยังวนก็โดนล็อกซ้ำทันที
#
# ตั้งใจไม่ปิด lockout ทั้งระบบ: account lockout เป็น control ตาม PCI DSS Req 8.3.4
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="${1:-}"
case "$TARGET" in
  "")        ROLE_VAR="" ;;
  backend)   ROLE_VAR=VAULT_NESTJS_ROLE_ID;    SERVICES=(backend) ;;
  detection) ROLE_VAR=VAULT_DETECTION_ROLE_ID; SERVICES=(detection-consumer detection-api) ;;
  *) echo "ใช้: $0 [backend|detection]" >&2; exit 2 ;;
esac

# คำสั่ง vault ด้วย root token ที่ vault-unseal เก็บไว้ (ไม่ดึง token ออกมานอก container)
VAULT(){
  docker exec -i logchain-vault-unseal sh -c '. /vault/secrets/init.env
    VAULT_TOKEN=$VAULT_ROOT_TOKEN VAULT_ADDR=http://vault:8200 vault "$@"' vault "$@"
}

echo "→ log lockout ล่าสุดของ Vault:"
docker logs --tail=200 logchain-vault 2>&1 | grep -i "locked out" | tail -3 | sed 's/^/  /' \
  || echo "  (ไม่มี — ถ้า login ยังพังอยู่ อาจไม่ใช่ lockout ดู log ของแอปก่อน)"

echo "→ user ที่ถูกล็อกอยู่ตอนนี้:"
VAULT read -format=json sys/locked-users 2>/dev/null | sed 's/^/  /' || echo "  (อ่านไม่ได้)"

[ -z "$ROLE_VAR" ] && { echo; echo "ระบุ backend หรือ detection เพื่อปลดล็อก"; exit 0; }

RID=$(grep "^$ROLE_VAR=" .env | cut -d= -f2-)
[ -n "$RID" ] || { echo "✗ ไม่พบ $ROLE_VAR ใน .env" >&2; exit 1; }

ACC=$(VAULT auth list -detailed -format=json \
  | grep -o '"auth_approle_[a-z0-9]*"' | head -1 | tr -d '"')
[ -n "$ACC" ] || { echo "✗ หา mount accessor ของ approle ไม่เจอ" >&2; exit 1; }

echo "→ หยุด ${SERVICES[*]} (กันไม่ให้ retry ล็อกซ้ำ)"
docker compose stop "${SERVICES[@]}" >/dev/null

echo "→ unlock $ROLE_VAR (accessor $ACC)"
VAULT write -f "sys/locked-users/$ACC/unlock/$RID" >/dev/null

echo "→ เปิด ${SERVICES[*]} ใหม่"
HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose up -d --no-deps "${SERVICES[@]}" >/dev/null

echo "✓ เสร็จ — ดูผล: docker logs -f logchain-${SERVICES[0]} | grep -i vault"
