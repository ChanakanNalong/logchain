#!/bin/bash
# Replication role สำหรับ postgres-standby
# pg_hba.conf อ้างถึง user ชื่อ `replicator` อยู่แล้ว แต่ไม่เคยมีใครสร้าง role นี้
# -> standby connect เข้ามาไม่ได้ ถ้าไม่มีขั้นนี้
#
# รันครั้งเดียวตอน primary ถูกสร้างใหม่ (docker-entrypoint-initdb.d)
# cluster ที่ init ไปแล้วต้องสร้าง role เองด้วยมือ (ดู README)
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD '${REPLICATION_PASSWORD}';
EOSQL
