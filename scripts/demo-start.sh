#!/usr/bin/env bash
# start backend + detection ในโหมด mTLS สำหรับ demo
# ใช้ production build ไม่ใช่ watch mode — watch จะ recompile กลางคันถ้าไฟล์ถูกแตะ
set -uo pipefail
ROOT=~/Documents/logchain
DET=~/Documents/logchain-detection

# ── ล็อก Node version ตาม .nvmrc — jwks-rsa@4 ดึง jose@6 ที่เป็น ESM-only
#    Node < 20.19 จะตายด้วย ERR_REQUIRE_ESM ตอน import jwt.strategy
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  set +u
  . "$HOME/.nvm/nvm.sh"
  [ -f "$ROOT/.nvmrc" ] && nvm use "$(cat "$ROOT/.nvmrc")" >/dev/null 2>&1
  set -u
fi
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(((a===20&&b>=19)||(a===22&&b>=12)||a>=23)?0:1)' 2>/dev/null; then
  echo "  ❌ Node $(node -v 2>/dev/null || echo '?') ใช้ไม่ได้ — ต้อง ^20.19 || ^22.12 || >=23"
  echo "     ลอง: nvm install \$(cat $ROOT/.nvmrc)"
  exit 1
fi
echo "── node $(node -v) ──"

export KAFKA_SSL_ENABLED=true
export KAFKA_BROKERS=localhost:39092,localhost:39093,localhost:39094
export KAFKA_BROKER=$KAFKA_BROKERS

# lsof บนเครื่องนี้สะดุด docker overlay fs แล้วคืนผลไม่ครบแบบเงียบ ๆ
# ("WARNING: can't stat() overlay file system ... Output information may be incomplete")
# จน มองไม่เห็น listener บางตัว — ใช้ ss แทนทั้งหมด
pids_on_port() { ss -tlnpH "sport = :$1" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u; }

# ── cleanup: ถ้าล้มกลางคันอย่าทิ้ง process ที่เพิ่ง start ไว้ลอย ──
CLEAN_EXIT=0
BACKEND_PID=""
DETECTION_PID=""
cleanup() {
  [ "$CLEAN_EXIT" = 1 ] && return 0
  killed=0
  [ -n "$BACKEND_PID" ]   && kill "$BACKEND_PID"   2>/dev/null && killed=1
  [ -n "$DETECTION_PID" ] && kill "$DETECTION_PID" 2>/dev/null && killed=1
  [ "$killed" = 1 ] && echo "  ↩︎  ล้มกลางคัน — kill process ที่เพิ่ง start ไปแล้ว"
  return 0
}
trap cleanup EXIT
trap 'exit 130' INT TERM

echo "── หยุด process เดิม ──"
pkill -f "nest [s]tart"    2>/dev/null
pkill -f "node dist/[m]ain" 2>/dev/null
pkill -f "app[.]consumer"   2>/dev/null
kill $(pids_on_port 3000) 2>/dev/null

# รอจนพอร์ต 3000 ว่างจริง — ถ้าไม่รอจะเจอ EADDRINUSE
for i in $(seq 1 15); do
  [ -z "$(pids_on_port 3000)" ] && break
  [ "$i" = 15 ] && { echo "  ❌ port 3000 ไม่ยอมว่าง — เช็ค: ss -tlnp 'sport = :3000'"; exit 1; }
  sleep 1
done
echo "  ✅ port 3000 ว่างแล้ว"

echo "── build backend ──"
( cd "$ROOT" && npm run build ) || { echo "  ❌ build ไม่ผ่าน"; exit 1; }

echo "── start ──"
( cd "$ROOT" && exec nohup node dist/main > /tmp/logchain-backend.log 2>&1 ) &
BACKEND_PID=$!
disown "$BACKEND_PID" 2>/dev/null
( cd "$DET" && . venv/bin/activate && \
  exec nohup python3 -m app.consumer > /tmp/logchain-detection.log 2>&1 ) &
DETECTION_PID=$!
disown "$DETECTION_PID" 2>/dev/null

echo "── รอ service ขึ้น ──"
for i in $(seq 1 30); do
  curl -sf localhost:3000/health >/dev/null 2>&1 && break
  [ "$i" = 30 ] && { echo "  ❌ backend ไม่ตอบใน 30 วิ — ดู /tmp/logchain-backend.log"; tail -20 /tmp/logchain-backend.log; exit 1; }
  sleep 1
done
echo "  ✅ backend :3000 ตอบแล้ว"

pgrep -f "app.consumer" >/dev/null && echo "  ✅ detection consumer รันอยู่" \
  || { echo "  ❌ detection ไม่ขึ้น — ดู /tmp/logchain-detection.log"; tail -20 /tmp/logchain-detection.log; }

echo
echo "── socket check (ต้องต่อแต่ 3909x ครบทั้ง 3 broker) ──"
sleep 3
# $5 = peer address ของ ss -tn — ดูเฉพาะปลายทาง ไม่ให้ ephemeral port ฝั่งเราหลอก
PEERS=$(ss -tnp 2>/dev/null | grep -E "node|python3?" | awk '{print $5}')
MTLS=$(printf '%s\n' "$PEERS" | grep -E ":3909[234]$" | sort)
PLAIN=$(printf '%s\n' "$PEERS" | grep -E ":2909[234]$" | sort -u)
printf '%s\n' "$MTLS" | grep . | uniq -c | sed 's/^/  mTLS  /'
if [ -n "$PLAIN" ]; then
  echo "  ⚠️  ยังมี plaintext ค้างอยู่:"
  printf '%s\n' "$PLAIN" | sed 's/^/       /'
elif [ -z "$MTLS" ]; then
  echo "  ⚠️  ไม่เจอ socket ไป Kafka เลย — เช็ค log"
else
  echo "  ✅ mTLS อย่างเดียว — ไม่มี 2909x"
fi

echo
CLEAN_EXIT=1
echo "🎉 พร้อม — ต่อด้วย ./scripts/demo-preflight.sh \$TOKEN"
echo "log: /tmp/logchain-backend.log , /tmp/logchain-detection.log"
