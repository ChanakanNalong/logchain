# Vault Key Rotation Runbook

## Background — ทำไม Vault ถึงต้อง unseal
Vault รันแบบ **server mode + file storage** (ไม่ใช่ dev mode) ข้อมูลจึงอยู่บน volume
`vault_data` และรอด restart แต่แลกมาด้วยการที่ Vault ตื่นมาแบบ **sealed** เสมอ —
master key ถูกแยกเป็น 5 shares (Shamir) ต้องใช้ 3 ใน 5 ถึงจะประกอบกลับมาปลดล็อกได้

`vault-unseal` sidecar ทำหน้าที่นี้ให้อัตโนมัติ จึงไม่มี manual step ตอน `docker compose up`

## Where the keys live (dev only)
- Host: `infra/vault/.secrets/init.env` — gitignored, permission `600` เจ้าของเป็น root
- Container: mount ที่ `/vault/secrets/init.env` ทั้งใน `vault-unseal` และ `vault-init`
- เนื้อหา: `UNSEAL_KEY_1..5` + `VAULT_ROOT_TOKEN`

อ่าน root token (ไม่ต้อง sudo — ยืมสิทธิ์ container ที่ mount อยู่แล้ว):

```sh
docker compose exec vault-unseal sh -c 'grep VAULT_ROOT_TOKEN /vault/secrets/init.env'
```

ใช้ token นี้ login Vault UI ที่ http://localhost:8200/ui (เลือก method: Token)

> ⚠️ **นี่คือ dev-only compromise ที่ต้องรู้ตัว**
> unseal key ทั้ง 5 อันนอนอยู่ข้าง ๆ ตัว storage ที่มันปกป้อง แปลว่าใครอ่าน repo ได้
> ก็ถอด Vault ได้ทันที — ในทางปฏิบัติเท่ากับ **ยังไม่ได้ล็อกอะไรเลย** ห้ามใช้รูปแบบนี้
> ใน production ดูหัวข้อ Production ด้านล่าง

## Rotate root token
Root token ไม่มีวันหมดอายุ ควร revoke ทิ้งหลังใช้เสร็จ แล้วสร้างใหม่เมื่อจำเป็น

```sh
# 1. เริ่ม generate-root -> ได้ nonce + otp
docker compose exec vault-unseal vault operator generate-root -init

# 2. ใส่ unseal key ทีละอัน (3 ครั้ง) พร้อม nonce จากขั้นที่ 1
docker compose exec vault-unseal vault operator generate-root -nonce=<NONCE>
#    (paste unseal key เมื่อถูกถาม — ทำซ้ำจนครบ 3 keys จะได้ encoded token ออกมา)

# 3. ถอดรหัส encoded token ด้วย otp จากขั้นที่ 1
docker compose exec vault-unseal vault operator generate-root \
  -decode=<ENCODED_TOKEN> -otp=<OTP>

# 4. revoke token เก่า แล้วอัปเดต VAULT_ROOT_TOKEN ใน .secrets/init.env
docker compose exec vault-unseal vault token revoke <OLD_ROOT_TOKEN>
```

## Rotate unseal keys (rekey)
ใช้เมื่อสงสัยว่า unseal key รั่ว หรือต้องการเปลี่ยนจำนวน shares/threshold

```sh
# 1. เริ่ม rekey (ตั้ง shares/threshold ใหม่)
docker compose exec vault-unseal vault operator rekey -init -key-shares=5 -key-threshold=3

# 2. ใส่ unseal key "ชุดเก่า" 3 อัน พร้อม nonce
docker compose exec vault-unseal vault operator rekey -nonce=<NONCE>
#    ครบ 3 อันแล้วจะพ่น unseal key "ชุดใหม่" ออกมาทั้ง 5 อัน
```

**สำคัญ:** ต้องเอา key ชุดใหม่เขียนทับ `UNSEAL_KEY_1..5` ใน `infra/vault/.secrets/init.env`
ทันที ไม่งั้นรอบหน้าที่ Vault restart ตัว `vault-unseal` จะ unseal ด้วย key เก่าที่ใช้ไม่ได้แล้ว
และ Vault จะค้างอยู่ในสถานะ sealed

หลังแก้ไฟล์เสร็จ ทดสอบทันทีว่า key ชุดใหม่ใช้ได้จริง:

```sh
docker compose restart vault && sleep 15
docker compose exec vault vault status | grep Sealed   # ต้องได้ false
```

## Recovery — ทำ init.env หาย
กู้ไม่ได้ ไม่มีทางลัด ถ้าไม่มี unseal key 3 ใน 5 ข้อมูลใน `vault_data` คือ ciphertext ที่ถอดไม่ออก
`unseal.sh` จะตรวจเจอเคสนี้ (initialized=true แต่ไม่มี init.env) แล้ว exit พร้อม error แทนที่จะ
init ซ้ำเงียบ ๆ

ใน dev ให้ล้างแล้วเริ่มใหม่ — secret ทั้งหมด seed กลับมาได้จาก `.env` อยู่แล้ว:

```sh
docker compose down
docker volume rm logchain_vault_data
docker compose up -d vault vault-unseal
docker compose run --rm vault-init   # เอา role_id/secret_id ชุดใหม่ไปใส่ .env
```

## Production — เลิกใช้ Shamir keys บนดิสก์
รูปแบบข้างบนใช้กับ production ไม่ได้ ต้องย้ายไป **auto-unseal ผ่าน cloud KMS** ซึ่งย้าย
ความรับผิดชอบในการถือ master key ออกจากดิสก์เราไปอยู่กับ KMS แทน — ไม่มี unseal key
ให้ rotate ด้วยมืออีกต่อไป และ `vault-unseal` sidecar จะถูกลบทิ้งทั้งตัว

แทนที่ `seal` stanza ใน `infra/vault/config/vault.hcl`:

```hcl
# AWS KMS
seal "awskms" {
  region     = "ap-southeast-1"
  kms_key_id = "<KEY_ID>"
}

# หรือ GCP KMS
seal "gcpckms" {
  project    = "<PROJECT>"
  region     = "asia-southeast1"
  key_ring   = "vault"
  crypto_key = "vault-unseal"
}
```

สิ่งที่ต้องเปลี่ยนตามไปด้วย:
- **credentials ให้ Vault คุยกับ KMS** — ใช้ IAM role/workload identity ที่ผูกกับ instance
  ห้าม hardcode access key (ไม่งั้นก็แค่ย้ายปัญหา "secret เปล่าเปลือยบนดิสก์" ไปที่อื่น)
- **`storage "file"` → `raft`** — file backend ไม่รองรับ HA มี Vault ตายตัวเดียวก็ดับทั้งระบบ
- **`tls_disable = 1` → เปิด TLS จริง** — ตอนนี้ token กับ secret วิ่งเป็น plaintext บน network
- `vault operator init` จะพ่น **recovery keys** แทน unseal keys (ใช้ตอน disaster recovery
  เท่านั้น ไม่ได้ใช้ unseal) — เก็บแบบ split ในที่ที่คนละทีมถือคนละส่วน
