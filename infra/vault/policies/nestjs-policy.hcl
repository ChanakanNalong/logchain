# NestJS api-gateway policy - อ่านได้แค่ path ที่จำเป็น
# หลัก least privilege ของ PCI Req 8.6

path "secret/data/logchain/database" {
    capabilities = ["read"]
}

path "secret/data/logchain/keycloak" {
    capabilities = ["read"]
}

path "secret/data/logchain/blockchain" {
    capabilities = ["read"]
}