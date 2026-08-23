#!/usr/bin/env bash
# start backend + detection ในโหมด mTLS (ใช้ก่อน demo)
export KAFKA_SSL_ENABLED=true
export KAFKA_BROKERS=localhost:39092,localhost:39093,localhost:39094
export KAFKA_BROKER=$KAFKA_BROKERS

BACKEND_LOG=/tmp/logchain-backend.log
DETECTION_LOG=/tmp/logchain-detection.log

cd ~/Documents/logchain || { echo "❌ ไม่เจอ ~/Documents/logchain"; exit 1; }

echo "── stop ของเก่า ──"
# nest start fork process ลูก — kill แค่ตัวที่ถือพอร์ตไม่พอ ต้องเก็บ parent ด้วย
pkill -f "nest start"    2>/dev/null
pkill -f "node dist/main" 2>/dev/null
pkill -f "app.consumer"   2>/dev/null
PIDS=$(lsof -t -i:3000 2>/dev/null)
[ -n "$PIDS" ] && kill $PIDS 2>/dev/null

# รอจนพอร์ตว่างจริง ไม่งั้น start ต่อแล้วเจอ EADDRINUSE
for _ in $(seq 1 10); do
  lsof -t -i:3000 >/dev/null 2>&1 || break
  sleep 1
done
if lsof -t -i:3000 >/dev/null 2>&1; then
  echo "❌ port 3000 ยังไม่ว่างหลังรอ 10 วิ — เหลือ pid: $(lsof -t -i:3000 | tr '\n' ' ')"
  echo "   สั่ง kill -9 เองแล้วรันใหม่"
  exit 1
fi
echo "  ✅ port 3000 ว่าง"

echo "── build ──"
# ใช้ production build ไม่ใช่ watch mode — start:dev จะ recompile กลางคัน
# ถ้ามีใครเผลอแตะไฟล์ตอน demo แล้ว backend จะ restart คาเวที
npm run build || { echo "❌ build ไม่ผ่าน — ดูข้างบน"; exit 1; }

echo "── start ──"
nohup node dist/main > "$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!
disown "$BACKEND_PID"
echo "  backend pid=$BACKEND_PID"

nohup bash -c 'cd ~/Documents/logchain-detection && source venv/bin/activate && exec python3 -m app.consumer' \
  > "$DETECTION_LOG" 2>&1 &
DETECTION_PID=$!
disown "$DETECTION_PID"
echo "  detection pid=$DETECTION_PID"

echo "รอ service ขึ้น..."
for _ in $(seq 1 30); do
  curl -sf localhost:3000/health >/dev/null 2>&1 && break
  kill -0 "$BACKEND_PID" 2>/dev/null || break   # backend ตายแล้ว ไม่ต้องรอต่อ
  sleep 1
done

echo "── socket check ──"
ss -tnp 2>/dev/null | grep -E ":(29092|39092)" | grep -E "node|python" | awk '{print $5, $6}'
echo "(ต้องเห็นแค่ :39092 — ถ้าเห็น 29092 แปลว่ายังเป็น plaintext)"

echo "── health ──"
if curl -sf localhost:3000/health >/dev/null 2>&1; then
  echo "  ✅ backend :3000 พร้อม"
else
  echo "  ❌ backend ไม่ตอบ /health — ยังไม่พร้อม demo"
  echo "     20 บรรทัดท้ายของ $BACKEND_LOG:"
  tail -20 "$BACKEND_LOG" | sed 's/^/     /'
  exit 1
fi
pgrep -f "app.consumer" >/dev/null && echo "  ✅ detection consumer รันอยู่" \
  || echo "  ⚠️  detection consumer ไม่ขึ้น — ดู $DETECTION_LOG"

echo "log: $BACKEND_LOG , $DETECTION_LOG"
