# Vault server config (แทน dev mode)
# ⚠️ TLS ปิดอยู่ — ใช้ได้เฉพาะ dev/lab ที่อยู่หลัง docker network เท่านั้น
#    prod ต้องเปิด tls_cert_file/tls_key_file และเลิกใช้ storage "file"

ui = true

# file backend = ข้อมูลอยู่บน volume vault_data ไม่หายตอน restart
# (ไม่รองรับ HA — ถ้าจะทำ HA ต้องเปลี่ยนเป็น raft/consul)
storage "file" {
  path = "/vault/file"
}

listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = 1
}

# address ที่ client ใน docker network เรียกถึงตัวนี้ได้
api_addr = "http://vault:8200"

# mlock กัน secret หลุดลง swap — ทำงานได้เพราะ compose ให้ cap_add: IPC_LOCK
# ถ้าเครื่องไหน cap นี้ไม่ผ่านแล้ว vault สตาร์ทไม่ขึ้น ค่อยเปลี่ยนเป็น true
disable_mlock = false
