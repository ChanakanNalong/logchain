#!/usr/bin/env bash
#
# One-shot onboarding: clone repo -> ./scripts/bootstrap.sh -> ทั้งระบบขึ้น
#
# ทำ 6 อย่างตามลำดับ (ข้ามขั้นที่ทำไปแล้วทุกขั้น — รันซ้ำได้ ไม่พัง):
#   1. .env               — copy จาก .env.example แล้วสุ่มค่าที่เป็น CHANGE_ME
#   2. kafka certs        — infra/kafka/gen-certs.sh (mTLS listener ขึ้นไม่ได้ถ้าไม่มี)
#   3. infra up           — postgres/keycloak/kafka/vault/prometheus/grafana
#   4. vault AppRole      — รอ vault-init เขียน approle.env แล้ว merge เข้า .env
#   5. app up             — backend / dashboard / detection (ต้องรอ AppRole ก่อน)
#   6. harden keycloak    — scripts/harden-master-admin.sh
#
# ทำไมต้องแยก infra กับ app เป็นคนละ phase:
#   backend และ detection-consumer ต้องมี VAULT_*_ROLE_ID/SECRET_ID ตั้งแต่ตอน
#   start ไม่งั้น refuse to start — แต่ค่าพวกนั้นเพิ่งถูกสร้างโดย vault-init
#   ซึ่งรันหลัง vault ขึ้นแล้ว compose อ่าน .env ครั้งเดียวตอนสั่ง up จึงต้องรอให้
#   ค่าอยู่ใน .env ก่อนค่อยสั่ง up รอบสอง
#
# ⚠️ DEV ONLY — secret ที่สุ่มให้เก็บเป็น plaintext ใน .env ห้ามใช้กับ production
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

APPROLE_FILE="infra/vault/.secrets/approle.env"
COMPOSE=(docker compose)
# vault-init รันเป็น root แล้วเขียน approle.env ลง bind mount — ถ้าไม่บอก uid/gid
# ของเรา ไฟล์จะเป็น root:root 0600 แล้วสคริปต์นี้อ่านไม่ได้ในขั้นที่ 4
export HOST_UID="$(id -u)"
export HOST_GID="$(id -g)"
INFRA_SERVICES=(postgres postgres-standby postgres-exporter
                keycloak-config keycloak
                kafka-1 kafka-2 kafka-3 kafka-init kafka-exporter
                vault vault-unseal vault-init
                prometheus grafana node-exporter)
APP_SERVICES=(backend cylis-dashboard detection-api detection-consumer)

say()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[0;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[0;33m! %s\033[0m\n' "$*"; }
die()  { printf '\033[0;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || die "ไม่มี docker — ติดตั้งก่อน"
docker compose version >/dev/null 2>&1 || die "ไม่มี docker compose v2 (plugin)"
command -v openssl >/dev/null || die "ไม่มี openssl — ใช้สุ่ม secret และสร้าง kafka cert"

# ── 1. .env ────────────────────────────────────────────────────────────────
say "1/6  เตรียม .env"

if [ -f .env ]; then
    ok ".env มีอยู่แล้ว — ไม่แตะต้อง"
else
    cp .env.example .env
    ok "copy .env.example -> .env"
fi

# สุ่มค่าให้ทุกบรรทัดที่ยังเป็น CHANGE_ME* — ยกเว้น 2 ตัวที่สุ่มแล้วไม่มีความหมาย
#   BLOCKCHAIN_PRIVATE_KEY : ต้องเป็น private key จริงของ wallet ที่มี MATIC
#                            ปล่อยว่าง = blockchain.service.ts ปิด integrity anchoring
#                            แล้วไปต่อ (ดู src/blockchain/blockchain.service.ts)
#   VAULT_*_ROLE_ID/SECRET_ID : Vault เป็นคนออกให้ในขั้นที่ 4
# password ของ Keycloak ต้องผ่าน policy: length(12) + upper + lower + digit
# base64 ธรรมดาไม่การันตีว่ามีครบทั้ง 3 ชนิด เลยเติม "Aa1" ต่อท้ายให้ชัวร์
randpw() { printf 'Aa1%s' "$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-20)"; }
rand()   { openssl rand -base64 32 | tr -d '/+=' | cut -c1-32; }

filled=0
while IFS= read -r key; do
    case "$key" in
        BLOCKCHAIN_PRIVATE_KEY|VAULT_*_ROLE_ID|VAULT_*_SECRET_ID) continue ;;
        *PASSWORD*) value="$(randpw)" ;;
        *)          value="$(rand)" ;;
    esac
    # ใช้ | เป็น delimiter — ค่าที่สุ่มถูก strip / ออกแล้วจึงไม่ชนกัน
    sed -i "s|^${key}=.*|${key}=${value}|" .env
    filled=$((filled + 1))
done < <(grep -E '^[A-Z_][A-Z_0-9]*=CHANGE_ME' .env | cut -d= -f1)

if [ "$filled" -gt 0 ]; then
    ok "สุ่ม secret ให้ $filled ตัว"
else
    ok "ไม่มี CHANGE_ME ค้าง"
fi

# DATABASE_URL มี password ฝังอยู่ในสตริง — sync ให้ตรงกับ POSTGRES_PASSWORD
# ตัวแอปไม่ได้อ่านค่านี้ (password มาจาก Vault) แต่ psql/runbook ใช้
PG_PASS="$(sed -nE 's/^POSTGRES_PASSWORD=(.*)$/\1/p' .env)"
sed -i "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://logchain:${PG_PASS}@localhost:5433/logchain|" .env

if grep -q '^BLOCKCHAIN_PRIVATE_KEY=CHANGE_ME' .env; then
    warn "BLOCKCHAIN_PRIVATE_KEY ยังเป็น CHANGE_ME"
    warn "  ingest / PII masking / detection / alert / dashboard ทำงานครบตามปกติ"
    warn "  แต่ Merkle integrity (M2) จะไม่ทำงานเลย — sealBatch() return ทันที"
    warn "  ถ้า blockchain ไม่พร้อม (src/integrity/integrity.service.ts:35) แปลว่า"
    warn "  ไม่มี batch/proof เกิดขึ้น ไม่ใช่แค่ไม่ anchor"
    warn "  อยากเปิด: ใส่ private key ของ wallet ที่มี MATIC บน Polygon Amoy"
    warn "  + ตั้ง CONTRACT_ADDRESS แล้วรันซ้ำ"
fi

# ── 2. kafka certs ─────────────────────────────────────────────────────────
say "2/6  Kafka mTLS certs"

if [ -f infra/kafka/certs/ca.crt ]; then
    ok "infra/kafka/certs/ มีอยู่แล้ว — ข้าม (gen-certs.sh ลบของเดิมทิ้งทุกครั้ง)"
else
    ./infra/kafka/gen-certs.sh
    ok "สร้าง CA + broker cert 3 ใบ + client cert (nestjs, detection)"
fi

# ── 3. infra ───────────────────────────────────────────────────────────────
say "3/6  ยก infrastructure"

"${COMPOSE[@]}" up -d "${INFRA_SERVICES[@]}"
ok "สั่ง up แล้ว — รอ vault init เขียน AppRole"

# ── 4. vault AppRole -> .env ───────────────────────────────────────────────
say "4/6  ดึง Vault AppRole เข้า .env"

# vault-unseal ต้อง operator init + unseal ก่อน แล้ว vault-init ถึงจะรันจบ
# บนเครื่องที่ pull image ใหม่ ขั้นนี้กินเวลาได้เป็นนาที
for _ in $(seq 1 60); do
    [ -f "$APPROLE_FILE" ] && break
    sleep 5
done
[ -f "$APPROLE_FILE" ] || die "ไม่มี $APPROLE_FILE หลังรอ 5 นาที — ดู: docker compose logs vault-unseal vault-init"

# มีไฟล์แล้วแต่อ่านไม่ได้ = vault-init รอบก่อนรันโดยไม่มี HOST_UID (เช่นสั่ง
# `docker compose up` เองตรง ๆ) ไฟล์เลยเป็นของ root
if [ ! -r "$APPROLE_FILE" ]; then
    warn "$APPROLE_FILE อ่านไม่ได้ (เป็นของ root) — สั่ง vault-init ใหม่พร้อม HOST_UID"
    "${COMPOSE[@]}" up --force-recreate vault-init
fi
[ -r "$APPROLE_FILE" ] || die "ยังอ่าน $APPROLE_FILE ไม่ได้ — แก้เอง: sudo chown $(id -u):$(id -g) $APPROLE_FILE"
ok "เจอ $APPROLE_FILE"

# merge เข้า .env (upsert ทีละ key)
while IFS='=' read -r key value; do
    case "$key" in VAULT_*) ;; *) continue ;; esac
    if grep -q "^${key}=" .env; then
        sed -i "s|^${key}=.*|${key}=${value}|" .env
    else
        printf '%s=%s\n' "$key" "$value" >> .env
    fi
done < "$APPROLE_FILE"
ok "เขียน VAULT_NESTJS_* / VAULT_DETECTION_* ลง .env แล้ว"

# detection/.env สำหรับคนที่อยากรัน detection บน host (โหมด compose ไม่ได้ใช้ไฟล์นี้)
if [ ! -f detection/.env ]; then
    cp detection/.env.example detection/.env
fi
while IFS='=' read -r key value; do
    case "$key" in VAULT_DETECTION_*) ;; *) continue ;; esac
    if grep -q "^${key}=" detection/.env; then
        sed -i "s|^${key}=.*|${key}=${value}|" detection/.env
    else
        printf '%s=%s\n' "$key" "$value" >> detection/.env
    fi
done < "$APPROLE_FILE"
ok "sync VAULT_DETECTION_* ลง detection/.env แล้ว"

# ── 5. app services ────────────────────────────────────────────────────────
say "5/6  build + ยก backend / dashboard / detection"
warn "ครั้งแรกจะนาน — ต้อง build image ทั้ง 3 ตัว (torch CPU wheel ~200 MB)"

"${COMPOSE[@]}" up -d --build "${APP_SERVICES[@]}"
ok "สั่ง up แล้ว"

say "รอ backend ตอบ /health"
for _ in $(seq 1 60); do
    if curl -fsS http://localhost:3000/health >/dev/null 2>&1; then
        ok "backend healthy"
        break
    fi
    sleep 5
done
curl -fsS http://localhost:3000/health >/dev/null 2>&1 \
    || warn "backend ยังไม่ตอบ /health — ดู: docker compose logs backend"

# ── 6. harden keycloak master realm ────────────────────────────────────────
say "6/6  harden Keycloak master realm"

# ต้องรอ realm import เสร็จก่อน ไม่งั้น script ยิง admin API ไม่ติด
for _ in $(seq 1 60); do
    curl -fsS http://localhost:8080/realms/logchain >/dev/null 2>&1 && break
    sleep 5
done

if ./scripts/harden-master-admin.sh; then
    ok "hardened"
else
    warn "harden-master-admin.sh ไม่ผ่าน — รันซ้ำเองได้ (idempotent): ./scripts/harden-master-admin.sh"
fi

# ── สรุป ───────────────────────────────────────────────────────────────────
KC_USER="$(sed -nE 's/^KEYCLOAK_ADMIN=(.*)$/\1/p' .env)"
cat <<EOF

╔══════════════════════════════════════════════════════════════════════╗
║  LogChain พร้อมใช้งาน                                                ║
╚══════════════════════════════════════════════════════════════════════╝

  Dashboard    http://localhost:3003     <- เริ่มที่นี่
  API          http://localhost:3000     (/health, /metrics, /api/v1/*)
  Swagger      http://localhost:3000/api
  Detection    http://localhost:8000/health
  Keycloak     http://localhost:8080     admin console: ${KC_USER}
  Grafana      http://localhost:3002     admin / (ดู GRAFANA_ADMIN_PASSWORD ใน .env)
  Prometheus   http://localhost:9090
  Vault        http://localhost:8200

  บัญชีสำหรับ login ที่ dashboard อยู่ใน realm 'logchain'
  (password = KEYCLOAK_ADMIN_USER_PASSWORD ใน .env)

  ตรวจสถานะ:  docker compose ps
  ดู log:      docker compose logs -f backend detection-consumer
  ลองยิง log:  ./scripts/ingest-log.sh
  ลอง alert:   ./scripts/demo-brute-force.sh

EOF
