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

# down = ต่อ API ไม่ติด, uninitialized = ยังไม่เคย init, sealed/unsealed = ตามชื่อ
#
# ต้องอ่านจาก -format=json ไม่ใช่ดู exit code เพราะ `vault status` คืน 2 ทั้งตอน sealed
# และตอน uninitialized แยกกันไม่ออก — ซึ่งเป็นสองสถานะที่ต้องทำคนละอย่างกันสุดขั้ว
# (uninitialized ต้อง operator init, sealed ต้อง operator unseal)
vault_state() {
    _status=$(vault status -format=json 2>/dev/null) || true
    if ! echo "$_status" | grep -q '"initialized"'; then
        echo down
    elif echo "$_status" | grep -q '"initialized": *false'; then
        echo uninitialized
    elif echo "$_status" | grep -q '"sealed": *false'; then
        echo unsealed
    else
        echo sealed
    fi
}

do_init() {
    echo "▶ Initializing Vault (5 key shares, threshold 3)..."
    vault operator init -key-shares=5 -key-threshold=3 \
        | sed -n \
            -e 's/^Unseal Key \([0-9][0-9]*\): \(.*\)$/UNSEAL_KEY_\1=\2/p' \
            -e 's/^Initial Root Token: \(.*\)$/VAULT_ROOT_TOKEN=\1/p' \
        > "$SECRETS_FILE"
    chmod 600 "$SECRETS_FILE"

    if ! secrets_file_is_valid; then
        echo "✗ parse ผล operator init ไม่ได้ — ลบ $SECRETS_FILE แล้วลองใหม่" >&2
        exit 1
    fi
    echo "✓ เก็บ unseal keys + root token ไว้ที่ infra/vault/.secrets/init.env แล้ว"
}

# init.env ต้องเป็น KEY=VALUE ที่ `.` กินได้ ไม่ใช่ผลดิบจาก operator init
# ("Unseal Key 1: xxx") — ถ้าเป็นผลดิบ shell จะพยายามรัน `Unseal` เป็นคำสั่ง
# แล้วตายด้วย exit 127 วน restart ไปเรื่อย ๆ โดยไม่บอกสาเหตุจริง
secrets_file_is_valid() {
    [ -f "$SECRETS_FILE" ] \
        && grep -q '^UNSEAL_KEY_1=' "$SECRETS_FILE" \
        && grep -q '^UNSEAL_KEY_2=' "$SECRETS_FILE" \
        && grep -q '^UNSEAL_KEY_3=' "$SECRETS_FILE" \
        && grep -q '^VAULT_ROOT_TOKEN=' "$SECRETS_FILE"
}

# เก็บไฟล์ที่ใช้ไม่ได้เข้ากรุแทนการลบ เผื่อเจ้าของเครื่องอยากกู้อะไรจากมัน
archive_secrets_file() {
    _bak="$SECRETS_FILE.stale-$(date +%Y%m%d%H%M%S).bak"
    mv "$SECRETS_FILE" "$_bak"
    echo "! ย้าย $SECRETS_FILE ไป $_bak แล้ว" >&2
}

echo "▶ Waiting for Vault API..."
while [ "$(vault_state)" = "down" ]; do
    sleep 1
done
echo "✓ Vault API responding"

# ── 1. Initialize (ครั้งแรกเท่านั้น) ──
# ตัดสินจากสถานะจริงของ Vault ไม่ใช่แค่ "ไฟล์ init.env มีอยู่ไหม" เพราะสองอย่างนี้
# หลุดจากกันได้ง่ายมากในเครื่อง dev — ลบ volume ทิ้งแต่ไฟล์ยังอยู่ก็เป็นเคสหนึ่ง
if [ "$(vault_state)" = "uninitialized" ]; then
    # volume ว่าง แต่มี init.env ค้าง = ของ Vault ตัวก่อนที่ volume ถูกลบไปแล้ว
    # key ในไฟล์ใช้กับ Vault ตัวใหม่ไม่ได้ และไม่มีข้อมูลอะไรให้เสีย เพราะ storage ว่าง
    if [ -f "$SECRETS_FILE" ]; then
        echo "! Vault ยังไม่ init แต่มี $SECRETS_FILE ค้างอยู่ — เป็น key ของ volume เก่า" >&2
        archive_secrets_file
    fi
    do_init
elif [ ! -f "$SECRETS_FILE" ]; then
    # กันเคสที่ volume มี data เก่าอยู่แต่ init.env หาย = unseal key หายถาวร กู้ไม่ได้
    echo "✗ Vault initialized แล้ว แต่ไม่มี $SECRETS_FILE — unseal key หาย กู้ข้อมูลไม่ได้" >&2
    echo "  ถ้าเป็น dev ล้างทิ้งแล้วเริ่มใหม่: docker compose down && docker volume rm logchain_vault_data" >&2
    exit 1
elif ! secrets_file_is_valid; then
    # Vault มี data อยู่จริง ห้ามลบไฟล์เองเด็ดขาด — key ที่ถูกอาจซ่อนอยู่ในนั้น
    echo "✗ $SECRETS_FILE ไม่ใช่รูปแบบ KEY=VALUE ที่ source ได้" >&2
    echo "  ต้องมี UNSEAL_KEY_1..3= และ VAULT_ROOT_TOKEN= อย่างละบรรทัด" >&2
    echo "  ถ้าไฟล์เป็นผลดิบจาก operator init ให้แปลงเป็น KEY=VALUE ด้วย:" >&2
    echo "    sed -i -E 's/^Unseal Key ([0-9]+): /UNSEAL_KEY_\\1=/; s/^Initial Root Token: /VAULT_ROOT_TOKEN=/' infra/vault/.secrets/init.env" >&2
    exit 1
fi

unseal() {
    if ! secrets_file_is_valid; then
        echo "✗ $SECRETS_FILE ใช้ไม่ได้แล้ว — unseal ต่อไม่ได้" >&2
        exit 1
    fi
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
        sealed)        unseal ;;
        uninitialized) echo "✗ Vault กลับไปเป็น uninitialized (volume ถูกลบ?) — restart vault-unseal เพื่อ init ใหม่" >&2 ;;
        down)          echo "… Vault ไม่ตอบสนอง กำลังรอ" ;;
    esac
    sleep 10
done
