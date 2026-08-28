#!/usr/bin/env bash
# start backend + detection ในโหมด mTLS สำหรับ demo
# ใช้ production build ไม่ใช่ watch mode — watch จะ recompile กลางคันถ้าไฟล์ถูกแตะ
set -uo pipefail
ROOT=~/Documents/logchain
DET=~/Documents/logchain-detection

export KAFKA_SSL_ENABLED=true
export KAFKA_BROKERS=localhost:39092,localhost:39093,localhost:39094
export KAFKA_BROKER=$KAFKA_BROKERS

echo "── หยุด process เดิม ──"
pkill -f "nest start"    2>/dev/null
pkill -f "node dist/main" 2>/dev/null
pkill -f "app.consumer"   2>/dev/null
kill $(lsof -t -i:3000 2>/dev/null) 2>/dev/null

# รอจนพอร์ต 3000 ว่างจริง — ถ้าไม่รอจะเจอ EADDRINUSE
for i in $(seq 1 15); do
  lsof -i:3000 >/dev/null 2>&1 || break
  [ "$i" = 15 ] && { echo "  ❌ port 3000 ไม่ยอมว่าง — เช็ค: lsof -i:3000"; exit 1; }
  sleep 1
done
echo "  ✅ port 3000 ว่างแล้ว"

echo "── build backend ──"
( cd "$ROOT" && npm run build ) || { echo "  ❌ build ไม่ผ่าน"; exit 1; }

echo "── start ──"
( cd "$ROOT" && nohup node dist/main > /tmp/logchain-backend.log 2>&1 & disown )
( cd "$DET" && source venv/bin/activate && \
  nohup python3 -m app.consumer > /tmp/logchain-detection.log 2>&1 & disown )

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
echo "── socket check (ต้องเห็นแค่ :39092) ──"
sleep 3
ss -tnp 2>/dev/null | grep -E ":(29092|39092)" | grep -E "node|python" | awk '{print $5}' | sort -u
grep -q ":29092" <(ss -tnp 2>/dev/null | grep -E "node|python") \
  && echo "  ⚠️  เจอ 29092 = ยังเป็น plaintext!" || echo "  ✅ mTLS อย่างเดียว"

echo
echo "🎉 พร้อม — ต่อด้วย ./scripts/demo-preflight.sh \$TOKEN"
echo "log: /tmp/logchain-backend.log , /tmp/logchain-detection.log"
