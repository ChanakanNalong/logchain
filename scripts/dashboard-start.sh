#!/usr/bin/env bash
# start cylis-dashboard (Next.js) บนพอร์ต 3003 — dev mode
# คู่กับ ./scripts/demo-start.sh ที่ start backend + detection
set -uo pipefail
ROOT=~/Documents/logchain
APP=$ROOT/cylis-dashboard
PORT=3003

# ── ล็อก Node version ตาม .nvmrc — Next 16 ต้องการ >= 20.9 ไม่งั้นขึ้น
#    "You are using Node.js 18.x. For Next.js, Node.js version >=20.9.0 is required."
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  set +u
  . "$HOME/.nvm/nvm.sh"
  [ -f "$APP/.nvmrc" ] && nvm use "$(cat "$APP/.nvmrc")" >/dev/null 2>&1
  set -u
fi
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit((a>20||(a===20&&b>=9))?0:1)' 2>/dev/null; then
  echo "  ❌ Node $(node -v 2>/dev/null || echo '?') ใช้ไม่ได้ — Next 16 ต้องการ >= 20.9"
  echo "     ลอง: nvm install \$(cat $APP/.nvmrc)"
  exit 1
fi
echo "── node $(node -v) ──"

# lsof บนเครื่องนี้สะดุด docker overlay fs แล้วคืนผลไม่ครบแบบเงียบ ๆ
# ("WARNING: can't stat() overlay file system ... Output information may be incomplete")
# จน มองไม่เห็น listener บางตัว — ใช้ ss แทนทั้งหมด
pids_on_port() { ss -tlnpH "sport = :$1" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u; }

# ── cleanup: ถ้าล้มกลางคันอย่าทิ้ง dev server ไว้ลอย ──
CLEAN_EXIT=0
DASH_PID=""
cleanup() {
  [ "$CLEAN_EXIT" = 1 ] && return 0
  # ยังไม่ทันได้ start อะไร (เช่นตกด่าน node version) — อย่าไปฆ่าของเดิมที่รันอยู่ก่อน
  [ -z "$DASH_PID" ] && return 0
  killed=0
  kill "$DASH_PID" 2>/dev/null && killed=1
  # npm run dev แตกลูกเป็น next-server — เก็บซ้ำด้วยพอร์ตกันลูกหลุด
  pids=$(pids_on_port "$PORT")
  [ -n "$pids" ] && kill $pids 2>/dev/null && killed=1
  [ "$killed" = 1 ] && echo "  ↩︎  ล้มกลางคัน — kill dashboard ที่เพิ่ง start ไปแล้ว"
  return 0
}
trap cleanup EXIT
trap 'exit 130' INT TERM

echo "── หยุด process เดิมบน :$PORT ──"
kill $(pids_on_port "$PORT") 2>/dev/null
pkill -f "[n]ext dev -p $PORT" 2>/dev/null   # เก็บ wrapper ที่ไม่ได้ถือ socket เอง
for i in $(seq 1 15); do
  [ -z "$(pids_on_port "$PORT")" ] && break
  [ "$i" = 15 ] && { echo "  ❌ port $PORT ไม่ยอมว่าง — เช็ค: ss -tlnp \"sport = :$PORT\""; exit 1; }
  sleep 1
done
echo "  ✅ port $PORT ว่างแล้ว"

# NEXT_PUBLIC_* ถูก inline ตอน build — ถ้าไม่มี .env.local จะได้ undefined แล้ว Keycloak init พัง
if [ ! -f "$APP/.env.local" ]; then
  echo "  ⚠️  ไม่มี .env.local — copy จาก .env.local.example ให้"
  cp "$APP/.env.local.example" "$APP/.env.local" || { echo "  ❌ copy ไม่สำเร็จ"; exit 1; }
fi

echo "── start dashboard ──"
( cd "$APP" && exec nohup npm run dev > /tmp/cylis-dashboard.log 2>&1 ) &
DASH_PID=$!
disown "$DASH_PID" 2>/dev/null

echo "── รอ dashboard ขึ้น ──"
for i in $(seq 1 60); do
  curl -sf "localhost:$PORT" >/dev/null 2>&1 && break
  [ "$i" = 60 ] && { echo "  ❌ dashboard ไม่ตอบใน 60 วิ — ดู /tmp/cylis-dashboard.log"; tail -20 /tmp/cylis-dashboard.log; exit 1; }
  sleep 1
done
echo "  ✅ dashboard :$PORT ตอบแล้ว"

# dependency ฝั่งหลัง — เตือนอย่างเดียว ไม่ถือว่า fail
curl -sf localhost:3000/health >/dev/null 2>&1 \
  && echo "  ✅ backend :3000 ตอบ" \
  || echo "  ⚠️  backend :3000 ไม่ตอบ — dashboard จะดึงข้อมูลไม่ได้ (รัน ./scripts/demo-start.sh)"
curl -sf "localhost:8080/realms/logchain/.well-known/openid-configuration" >/dev/null 2>&1 \
  && echo "  ✅ keycloak realm logchain พร้อม" \
  || echo "  ⚠️  keycloak :8080 realm logchain ไม่ตอบ — จะ login ไม่ได้"

echo
CLEAN_EXIT=1
echo "🎉 เปิด http://localhost:$PORT"
echo "log: /tmp/cylis-dashboard.log"
