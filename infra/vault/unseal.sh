#!/bin/sh
# Vault auto-unseal sidecar
#
# server mode ต่างจาก dev mode ตรงที่ตื่นมาแบบ sealed เสมอ และไม่มี root token ให้
# สคริปต์นี้เลยทำ 2 อย่าง:
#   1. operator init ครั้งแรกครั้งเดียว -> เก็บ unseal key + root token ลง init.env
#   2. วนเฝ้าตลอด ถ้าเจอ vault กลับไป sealed (restart/reboot) ก็ unseal ให้อัตโนมัติ
#
# ⚠️ DEV ONLY: unseal key ถูกเก็บเป็น plaintext ข้าง ๆ storage ซึ่งเท่ากับไม่ได้ล็อกอะไรเลย
#    ถ้าใครอ่าน volume ได้ก็ถอด vault ได้ทันที — prod ต้องใช้ auto-unseal ผ่าน KMS/transit
#    แล้วให้ unseal key อยู่คนละที่กับ data เสมอ

set -eu

SECRETS_FILE=/vault/secrets/init.env

# 0 = unsealed, 2 = sealed, อื่น ๆ = ยังต่อไม่ติด
vault_state() {
    if vault status >/dev/null 2>&1; then
        echo unsealed
    elif [ $? -eq 2 ]; then
        echo sealed
    else
        echo down
    fi
}

echo "▶ Waiting for Vault API..."
while [ "$(vault_state)" = "down" ]; do
    sleep 1
done
echo "✓ Vault API responding"

# ── 1. Initialize (ครั้งแรกเท่านั้น) ──
if [ ! -f "$SECRETS_FILE" ]; then
    # กันเคสที่ volume มี data เก่าอยู่แต่ init.env หาย = unseal key หายถาวร กู้ไม่ได้
    if vault status -format=json 2>/dev/null | grep -q '"initialized": *true'; then
        echo "✗ Vault initialized แล้ว แต่ไม่มี $SECRETS_FILE — unseal key หาย กู้ข้อมูลไม่ได้" >&2
        echo "  ถ้าเป็น dev ล้างทิ้งแล้วเริ่มใหม่: docker compose down && docker volume rm logchain_vault_data" >&2
        exit 1
    fi

    echo "▶ Initializing Vault (5 key shares, threshold 3)..."
    vault operator init -key-shares=5 -key-threshold=3 \
        | sed -n \
            -e 's/^Unseal Key \([0-9][0-9]*\): \(.*\)$/UNSEAL_KEY_\1=\2/p' \
            -e 's/^Initial Root Token: \(.*\)$/VAULT_ROOT_TOKEN=\1/p' \
        > "$SECRETS_FILE"
    chmod 600 "$SECRETS_FILE"

    if ! grep -q '^VAULT_ROOT_TOKEN=' "$SECRETS_FILE"; then
        echo "✗ parse ผล operator init ไม่ได้ — ลบ $SECRETS_FILE แล้วลองใหม่" >&2
        exit 1
    fi
    echo "✓ เก็บ unseal keys + root token ไว้ที่ infra/vault/.secrets/init.env แล้ว"
fi

unseal() {
    # shellcheck source=/dev/null
    . "$SECRETS_FILE"
    echo "▶ Unsealing (3 of 5 keys)..."
    vault operator unseal "$UNSEAL_KEY_1" >/dev/null
    vault operator unseal "$UNSEAL_KEY_2" >/dev/null
    vault operator unseal "$UNSEAL_KEY_3" >/dev/null
    echo "✓ Vault unsealed"
}

# ── 2. เฝ้าตลอดอายุ container ──
# ต้องวนเฝ้าไม่ใช่รันครั้งเดียวจบ เพราะ vault มี restart: unless-stopped
# พอ container มันฟื้นเองตอน reboot มันจะกลับไป sealed แต่ไม่มีใคร unseal ให้
while true; do
    case "$(vault_state)" in
        sealed)   unseal ;;
        down)     echo "… Vault ไม่ตอบสนอง กำลังรอ" ;;
    esac
    sleep 10
done
