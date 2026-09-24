#!/bin/sh
# สร้างไฟล์ config ให้ kafka CLI (kafka-topics.sh / kafka-consumer-groups.sh …) ต่อ listener mTLS แล้วพิมพ์ path ออกมา
#   client-ssl.sh <cert.pem> <key.pem> <ca.pem>
#   kafka-topics.sh --bootstrap-server kafka-1:9094 --command-config "$(client-ssl.sh …)" --list
#
# Kafka อ่าน keystore แบบ PEM จากไฟล์เดียวที่มีทั้ง key + cert — cert ที่ mount มาแยกสองไฟล์จึงต้องรวมใน /tmp ก่อน
# (key ไม่เข้ารหัส = ไม่ต้องมี ssl.key.password) · umask 077: ไฟล์ที่รวมมี private key
set -eu
cert="$1"; key="$2"; ca="$3"
dir="${TMPDIR:-/tmp}/kafka-client-ssl-$(id -u)"
umask 077
mkdir -p "$dir"
cat "$key" "$cert" > "$dir/keystore.pem"
cat > "$dir/client.properties" <<PROPS
security.protocol=SSL
ssl.keystore.type=PEM
ssl.keystore.location=$dir/keystore.pem
ssl.truststore.type=PEM
ssl.truststore.location=$ca
PROPS
echo "$dir/client.properties"
