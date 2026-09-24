path "secret/data/logchain/database" {
  capabilities = ["read"]
}

path "secret/data/logchain/keycloak" {
  capabilities = ["read"]
}

path "secret/data/logchain/blockchain" {
  capabilities = ["read"]
}

path "secret/data/logchain/notification" {
  capabilities = ["read"]
}

# HMAC key สำหรับ pseudonymize audit_access ตอน PDPA erasure
path "secret/data/logchain/erasure" {
  capabilities = ["read"]
}
