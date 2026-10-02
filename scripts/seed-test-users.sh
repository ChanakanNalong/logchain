#!/usr/bin/env bash
# สร้าง/อัปเดต user ทดสอบ 1 คนต่อ 1 role ใน realm logchain — สำหรับเครื่อง dev เท่านั้น
#
# ใช้:  ./scripts/seed-test-users.sh                     ← สร้าง user ที่ยังไม่มี · คนที่มีแล้วอัปเดต email/ชื่อ/role (ไม่แตะรหัส)
#       ./scripts/seed-test-users.sh --reset-passwords   ← เหมือนข้างบน + ตั้งรหัสทุกคนตาม .env
#       ./scripts/seed-test-users.sh --delete            ← ลบ user ทั้ง 4 คน (รหัสใน .env ไม่ถูกลบ)
#       เพิ่ม --force ถ้า KEYCLOAK_URL ไม่ใช่ localhost (ต้องพิมพ์ชื่อ host ยืนยัน)
#
# รหัสอยู่ใน .env (ANALYST_/OPERATOR_/AUDITOR_/INGESTOR_USER_PASSWORD) — ตัวไหนยังไม่มี script สุ่มให้แล้วต่อท้าย .env
# ใช้ kcadm ใน container ผ่าน service account logchain-admin-svc (ไม่ใช้ master admin)
# secret และรหัสส่งทาง stdin ทั้งหมด ไม่อยู่ใน argv (มองไม่เห็นใน ps) และไม่พิมพ์ออกจอ
# ไม่แตะ admin-user
set -euo pipefail
cd "$(dirname "$0")/.."

CONTAINER=logchain-keycloak
KCADM=/opt/keycloak/bin/kcadm.sh
SERVER=http://localhost:8080   # มุมมองจากใน container
REALM=logchain
KCFG="/tmp/kcadm-seed-$$.config"
APP_ROLES=(admin analyst operator auditor ingestor)   # ไม่รวม default-roles-logchain
# username|role|email|firstName|lastName|ตัวแปรรหัสใน .env
USERS=(
  "analyst-user|analyst|analyst@logchain.local|Analyst|User|ANALYST_USER_PASSWORD"
  "operator-user|operator|operator@logchain.local|Operator|User|OPERATOR_USER_PASSWORD"
  "auditor-user|auditor|auditor@logchain.local|Auditor|User|AUDITOR_USER_PASSWORD"
  "ingestor-user|ingestor|ingestor@logchain.local|Ingestor|User|INGESTOR_USER_PASSWORD"
)

die(){ echo "✗ $*" >&2; exit 1; }
usage(){ sed -n '4,7p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

MODE=seed; RESET=0; FORCE=0
for arg in "$@"; do
  case "$arg" in
    --delete)          MODE=delete ;;
    --reset-passwords) RESET=1 ;;
    --force)           FORCE=1 ;;
    -h|--help)         usage ;;
    *) echo "ไม่รู้จัก option: $arg" >&2; usage ;;
  esac
done
[ "$MODE" = delete ] && [ "$RESET" = 1 ] && die "--delete กับ --reset-passwords ใช้พร้อมกันไม่ได้"

# ค่าของตัวแปรจาก .env (ไม่ source ทั้งไฟล์) · key ซ้ำใช้บรรทัดสุดท้ายเหมือน docker compose
# ตัด CR และ quote ครอบ · ไม่มี = ว่าง
env_get(){
  local v
  v=$(grep "^$1=" .env | tail -n1 || true)
  v=${v#*=}; v=${v%$'\r'}
  if [ "${#v}" -ge 2 ] && { [[ $v == \"*\" ]] || [[ $v == \'*\' ]]; }; then v=${v:1:${#v}-2}; fi
  printf '%s' "$v"
}

# ── preflight ────────────────────────────────────────────────────────────────
[ -f .env ] || die "ไม่พบ .env ที่ $(pwd) — คัดลอกจาก .env.example หรือรัน ./scripts/bootstrap.sh ก่อน"
SECRET=$(env_get LOGCHAIN_ADMIN_CLIENT_SECRET)
[ -n "$SECRET" ] && [ "$SECRET" != CHANGE_ME ] \
  || die "LOGCHAIN_ADMIN_CLIENT_SECRET ใน .env ว่างหรือยังเป็น CHANGE_ME"

# guard กันรันบน production: KEYCLOAK_URL ต้องเป็น localhost และ docker ต้องเป็นของเครื่องนี้
KC_URL=$(env_get KEYCLOAK_URL)
[ -n "$KC_URL" ] || die "ไม่พบ KEYCLOAK_URL ใน .env"
KC_HOST=${KC_URL#*://}; KC_HOST=${KC_HOST%%/*}; KC_HOST=${KC_HOST%:*}
REMOTE=""
case "$KC_HOST" in localhost|127.0.0.1|'[::1]') ;; *) REMOTE="KEYCLOAK_URL host = $KC_HOST" ;; esac
case "${DOCKER_HOST:-}" in ""|unix://*) ;; *) REMOTE="${REMOTE:+$REMOTE · }DOCKER_HOST = $DOCKER_HOST" ;; esac
if [ -n "$REMOTE" ]; then
  [ "$FORCE" = 1 ] || die "ดูเหมือนไม่ใช่เครื่อง dev ($REMOTE) — script นี้ห้ามรันบน production · ถ้าแน่ใจใส่ --force"
  echo "⚠ $REMOTE — script นี้สร้าง user ทดสอบที่รหัสอยู่ใน .env ห้ามใช้กับ production" >&2
  read -r -p "พิมพ์ '$KC_HOST' เพื่อยืนยัน: " answer </dev/tty
  [ "$answer" = "$KC_HOST" ] || die "ยกเลิก"
fi
[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)" = true ] \
  || die "container $CONTAINER ไม่ได้รันอยู่ — ยก stack ก่อน: HOST_UID=\$(id -u) HOST_GID=\$(id -g) docker compose up -d keycloak"

# ── รหัสผ่าน: ตัวไหนยังไม่มีใน .env สุ่มให้แล้วต่อท้าย (ไม่แก้บรรทัดเดิม) ──────────
gen_password(){   # 20 ตัว A-Za-z0-9 มีครบตัวใหญ่/เล็ก/ตัวเลข → ผ่าน passwordPolicy ของ realm
  local p=""
  until [ "${#p}" -ge 16 ] && [[ $p =~ [A-Z] ]] && [[ $p =~ [a-z] ]] && [[ $p =~ [0-9] ]]; do
    p=$(head -c 96 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9' | cut -c1-20)
  done
  printf '%s' "$p"
}

if [ "$MODE" = seed ]; then
  header_written=0
  for entry in "${USERS[@]}"; do
    IFS='|' read -r _ _ _ _ _ var <<<"$entry"
    # มีค่าแล้วไม่แตะ · ว่าง (เช่นคัดลอกมาจาก .env.example) ถือว่ายังไม่มี → ต่อท้ายบรรทัดใหม่ซึ่งชนะบรรทัดว่าง
    [ -z "$(env_get "$var")" ] || continue
    if [ "$header_written" = 0 ]; then
      [ -s .env ] && [ -n "$(tail -c1 .env)" ] && echo >> .env   # บรรทัดสุดท้ายไม่มี newline
      echo "# user ทดสอบของ scripts/seed-test-users.sh (dev only) — สุ่มเมื่อ $(date +%F)" >> .env
      header_written=1
    fi
    printf '%s=%s\n' "$var" "$(gen_password)" >> .env
    echo "→ สุ่มรหัสใหม่ให้ $var แล้วต่อท้าย .env"
  done
fi

# ── kcadm ────────────────────────────────────────────────────────────────────
kc(){ timeout 90 docker exec "$CONTAINER" "$KCADM" "$@" --config "$KCFG"; }
kc_stdin(){ timeout 90 docker exec -i "$CONTAINER" "$KCADM" "$@" --config "$KCFG"; }
trap 'docker exec "$CONTAINER" rm -f "$KCFG" >/dev/null 2>&1 || true' EXIT

# ไม่ใส่ --secret → kcadm อ่าน secret จาก stdin (ไม่อยู่ใน argv)
# stdin ต้องเปิดค้างไว้จนกว่า kcadm จะอ่านเสร็จ ถ้า EOF มาก่อน prompt ของ kcadm จะค้างถาวร
# (เจอบนเครื่องนี้ราวครึ่งหนึ่งของรอบที่ลอง) ปิด feeder เองหลัง docker exec จบ
login_log=$(mktemp)
exec {feed}< <(printf '%s\n' "$SECRET"; exec sleep 120)
feeder=$!
login_rc=0
timeout 90 docker exec -i "$CONTAINER" "$KCADM" config credentials --config "$KCFG" --server "$SERVER" \
  --realm "$REALM" --client logchain-admin-svc <&"$feed" >"$login_log" 2>&1 || login_rc=$?
exec {feed}<&-
kill "$feeder" 2>/dev/null || true
login_out=$(tail -n1 "$login_log"); rm -f "$login_log"
[ "$login_rc" = 0 ] || die "login ด้วย service account logchain-admin-svc ไม่ผ่าน (rc=$login_rc) — เช็ค LOGCHAIN_ADMIN_CLIENT_SECRET: $login_out"

json_escape(){ local s=$1; s=${s//\\/\\\\}; s=${s//\"/\\\"}; printf '%s' "$s"; }

# ตั้งรหัสผ่าน body ทาง stdin · คืน 0 = สำเร็จ · พิมพ์สาเหตุเมื่อไม่สำเร็จ (ไม่มีรหัสในข้อความ)
set_password(){
  local id=$1 var=$2 out
  if out=$(printf '{"type":"password","value":"%s","temporary":false}' "$(json_escape "$(env_get "$var")")" \
           | kc_stdin update "users/$id/reset-password" -r "$REALM" -n -f - 2>&1); then
    return 0
  fi
  if grep -qi 'history\|last [0-9]* passwords' <<<"$out"; then
    echo "รหัสใน .env ($var) ซ้ำกับรหัสเก่า (passwordHistory 4) — เปลี่ยน $var ใน .env แล้วรัน --reset-passwords ใหม่"
  else
    echo "ตั้งรหัสไม่ผ่าน: ${out##*$'\n'}"
  fi
  return 1
}

user_id(){ kc get users -r "$REALM" -q username="$1" -q exact=true --fields id --format csv --noquotes; }
direct_roles(){ kc get "users/$1/role-mappings/realm" -r "$REALM" --fields name --format csv --noquotes; }

# ── ทำทีละ user ───────────────────────────────────────────────────────────────
ROWS=(); FAILED=0
for entry in "${USERS[@]}"; do
  IFS='|' read -r username role email first last var <<<"$entry"
  [ "$username" != admin-user ] || die "ห้ามแตะ admin-user"
  id=$(user_id "$username")

  if [ "$MODE" = delete ]; then
    if [ -n "$id" ]; then kc delete "users/$id" -r "$REALM" >/dev/null; ROWS+=("$username|$role|deleted")
    else ROWS+=("$username|$role|not found"); fi
    continue
  fi

  notes=()
  if [ -z "$id" ]; then
    id=$(kc create users -r "$REALM" -i -s username="$username" -s enabled=true -s emailVerified=true \
           -s email="$email" -s firstName="$first" -s lastName="$last" -s 'requiredActions=[]')
    status=created
    msg=$(set_password "$id" "$var") || { status="created · FAILED"; notes+=("$msg"); FAILED=1; }
  else
    before=$(kc get "users/$id" -r "$REALM" --fields email,firstName,lastName,emailVerified,enabled,requiredActions)
    kc update "users/$id" -r "$REALM" -s email="$email" -s firstName="$first" -s lastName="$last" \
      -s emailVerified=true -s enabled=true -s 'requiredActions=[]' >/dev/null
    after=$(kc get "users/$id" -r "$REALM" --fields email,firstName,lastName,emailVerified,enabled,requiredActions)
    status=updated
    [ "$before" = "$after" ] || notes+=("profile")
    if [ "$RESET" = 1 ]; then
      if msg=$(set_password "$id" "$var"); then notes+=("password")
      else status="updated · FAILED"; notes+=("$msg"); FAILED=1; fi
    fi
  fi

  # app role ต้องมีแค่ตัวเดียวตามตาราง · default-roles-logchain ไม่แตะ
  current=$(direct_roles "$id")
  for r in "${APP_ROLES[@]}"; do
    if [ "$r" != "$role" ] && grep -qx "$r" <<<"$current"; then
      kc remove-roles -r "$REALM" --uid "$id" --rolename "$r" >/dev/null
      notes+=("removed role $r")
    fi
  done
  if ! grep -qx "$role" <<<"$current"; then
    kc add-roles -r "$REALM" --uid "$id" --rolename "$role" >/dev/null
    notes+=("added role $role")
  fi

  if [ "$status" = updated ] && [ "${#notes[@]}" -eq 0 ]; then notes=("no changes"); fi
  detail=""
  for n in ${notes[@]+"${notes[@]}"}; do detail+="${detail:+, }$n"; done
  ROWS+=("$username|$role|$status${detail:+ ($detail)}")
done

# ── สรุป ─────────────────────────────────────────────────────────────────────
echo
printf '%-14s | %-8s | %s\n' username role status
printf '%-14s-+-%-8s-+-%s\n' -------------- -------- ------
for row in "${ROWS[@]}"; do
  IFS='|' read -r u r s <<<"$row"
  printf '%-14s | %-8s | %s\n' "$u" "$r" "$s"
done
echo
if [ "$MODE" = seed ]; then
  echo "รหัสผ่านอยู่ใน .env — ดูด้วย: grep -E '^(ANALYST|OPERATOR|AUDITOR|INGESTOR)_USER_PASSWORD=.' .env"
fi
[ "$FAILED" = 0 ] || die "มี user ที่ตั้งรหัสไม่สำเร็จ (ดูคอลัมน์ status)"
