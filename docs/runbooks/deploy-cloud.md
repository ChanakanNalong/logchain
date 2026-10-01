# Runbook — deploy ขึ้น server เพื่อน (NB-Lab · Proxmox LXC CT141 · Cloudflare Tunnel)

> ตัดสินใจ 2026-09-30: ทั้ง stack รันบนเครื่องเดียว (compose ชุดเดิม) · เริ่มข้อมูลใหม่ (ไม่ย้าย demo data / secret / wallet ของเครื่อง local)
>
> **2026-10-02 ใช้ server ของเพื่อน** แทน Oracle (บัตร prepaid ตก) และ Cloud VPS ไทย (แผนสำรอง — runbook ฉบับ VPS ดูใน git history
> ก่อน commit ที่เพิ่มไฟล์นี้) · dashboard ย้ายจาก Vercel มารันบนเครื่องเดียวกัน · ไม่ใช้ DuckDNS / Let's Encrypt
>
> **ทำไมไม่ใช้ Render / Railway:** ระบบใช้ RAM ~5.3 GB (วัด 2026-10-01: Kafka 3 ตัว ~2.7 GB · Keycloak ~730 MB · Vault ~440 MB · detection-api ~370 MB) ·
> free tier ของ Render ให้ 512 MB ต่อ service และหลับเมื่อไม่มีคนเรียก (cron ปิด batch หยุด) · Railway ไม่มี free tier ถาวร

```
เบราว์เซอร์ ─https─► Cloudflare (cert + DNS ของเพื่อน · nareubad.work)
                       │  Cloudflare Tunnel
                       ▼
CT141 (172.16.40.141) ─ cloudflared (container ของเพื่อน · bridge 172.17.0.0/16)
                       │  http://172.17.0.1:80   ← ปลายทางทั้ง 3 ชื่อ (เพื่อนตั้งใน Cloudflare)
                       ▼
                     Caddy (https-proxy :8080) แยกตาม Host
                       ├─ logchain.nareubad.work       → cylis-dashboard:3000
                       ├─ logchain-api.nareubad.work   → backend:3000 ─► Postgres · Kafka · Vault · detection · Amoy
                       └─ logchain-auth.nareubad.work  → keycloak:8080

ผู้ดูแล (เครื่องเรา) ─ WireGuard wg-friend (10.10.31.19) ─► ssh root@172.16.40.141
ไม่มีพอร์ตเปิด internet บน CT141 เลย — ขาเข้ามีแค่ tunnel (cloudflared ต่อออกไปเอง) + SSH ผ่าน VPN
```

ไฟล์ที่เกี่ยวข้อง: `docker-compose.cloud.yml` (override เฉพาะ `https-proxy`) · `infra/caddy/Caddyfile.cloud`

---

## A. สิ่งที่ได้จากเพื่อน ✅ (2026-10-02)

| เรื่อง | ค่า |
|---|---|
| เครื่อง | Proxmox **LXC unprivileged** CT141 · Ubuntu 24.04 · 4 vCPU · 8 GB RAM · ไม่มี swap · disk **30 GB** (ZFS) · `nesting=1` `keyctl=1` |
| IP ภายใน | `172.16.40.141` · user `root` · SSH key ED25519 (ไฟล์ `CT141-KAN-logchain_keyssh`) |
| VPN | WireGuard config `CT141 - kan.conf` · `Address 10.10.31.19/32` · split tunnel (`172.16.40.0/24, 10.10.31.0/24, 172.31.255.0/30, 10.10.50.0/24`) |
| domain | `logchain` / `logchain-api` / `logchain-auth` `.nareubad.work` → Cloudflare Tunnel → `http://172.17.0.1` |

ไฟล์ทั้งหมดอยู่ที่ `~/Documents/deploy/CT141 - kan/` (สิทธิ์ 600 · **ห้าม commit**)

## B. ต่อ VPN + SSH (เครื่องเรา) ✅

```bash
sudo install -m 600 "$HOME/Documents/deploy/CT141 - kan/CT141 - kan.conf" /etc/wireguard/wg-friend.conf
sudo sed -i '/^DNS/d' /etc/wireguard/wg-friend.conf     # ไม่ให้ DNS ทั้งเครื่องไปพึ่ง DNS เพื่อน
sudo wg-quick up wg-friend                              # ปิด: sudo wg-quick down wg-friend
install -m 600 "$HOME/Documents/deploy/CT141 - kan/CT141-KAN-logchain_keyssh" ~/.ssh/nblab_ct141

ping -c 3 10.10.31.1                                    # gateway ตอบ = handshake ผ่าน
ssh -i ~/.ssh/nblab_ct141 -o IdentitiesOnly=yes root@172.16.40.141
```

> ⚠️ **ห้ามแก้ `AllowedIPs` เป็น `0.0.0.0/0`** — เน็ตทั้งเครื่อง + stack local จะวิ่งผ่านบ้านเพื่อน
> · `wg-quick up` ไม่ขึ้นเองหลัง reboot (ตั้งใจ — เปิดเฉพาะตอนดูแล)

## C. เตรียมเครื่อง (CT141 · root)

Docker ✅ ติดตั้งแล้ว (repo ทางการ · 29.8.2 · Compose v5.5.1 · storage `overlayfs` · `hello-world` ผ่าน) + log rotation:

```bash
cat /etc/docker/daemon.json     # {"log-driver":"json-file","log-opts":{"max-size":"10m","max-file":"3"}}
```

> แปะ heredoc (`<<'EOF'`) ต้องให้ `EOF` บรรทัดสุดท้าย **ชิดซ้าย** — ไม่งั้นคำว่า EOF ติดเข้าไปในไฟล์ (เคยทำ docker ล้มรอบแรก)

ที่เหลือ — แปะทีละก้อน:

```bash
timedatectl set-timezone Asia/Bangkok
apt-get install -y git jq openssl python3 unattended-upgrades

# user แยกสำหรับรันระบบ — bootstrap ใช้ $(id -u) เป็นเจ้าของไฟล์ (Vault approle / Kafka key) ไม่ควรเป็น root
adduser --disabled-password --gecos '' logchain
usermod -aG docker logchain

# Node.js 22 — ใช้ตอน deploy contract (ขั้น F)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
```

> **ไม่มี swap และ LXC ใส่ swapfile เองไม่ได้** (swap ของ CT ตั้งที่ Proxmox) — build image detection (torch) ใช้ RAM สูง
> ถ้า build ล้มด้วย `Killed` / exit 137 → build ทีละ service (`docker compose build detection-api`) หรือขอเพื่อนเพิ่ม swap ให้ CT141

## D. ติดตั้ง LogChain (user `logchain`)

```bash
su - logchain
git clone https://github.com/ChanakanNalong/logchain.git && cd logchain
cp .env.example .env && chmod 600 .env
```

แก้ `.env` (bootstrap จะสุ่ม `CHANGE_ME` ที่เหลือให้เอง):

```bash
# ใช้ override ของ cloud กับทุกคำสั่ง docker compose + scripts/
COMPOSE_FILE=docker-compose.yml:docker-compose.cloud.yml
# Caddy แยกตามชื่อนี้ (infra/caddy/Caddyfile.cloud)
DASHBOARD_HOST=logchain.nareubad.work
API_HOST=logchain-api.nareubad.work
AUTH_HOST=logchain-auth.nareubad.work
# issuer ของ token = URL ที่เบราว์เซอร์เรียก Keycloak (= NEXT_PUBLIC_KEYCLOAK_URL)
KEYCLOAK_URL=https://logchain-auth.nareubad.work
# dashboard build บนเครื่องนี้ — NEXT_PUBLIC_* ถูก inline ตอน build (แก้แล้วต้อง build cylis-dashboard ใหม่)
NEXT_PUBLIC_API_URL=https://logchain-api.nareubad.work/api/v1
NEXT_PUBLIC_KEYCLOAK_URL=https://logchain-auth.nareubad.work
# CORS ของ backend + redirect URI ของ Keycloak (sync-keycloak-urls.sh อ่านจาก .env)
ALLOWED_ORIGINS=https://logchain.nareubad.work
DASHBOARD_PUBLIC_URL=https://logchain.nareubad.work
# ห้ามตั้ง PUBLISH_ADDR — Prometheus / Alertmanager / Kafka EXTERNAL ไม่มี auth
```

```bash
./scripts/bootstrap.sh            # build ครั้งแรกนาน (detection มี torch)
docker builder prune -f           # คืนพื้นที่ build cache 3–5 GB — disk มีแค่ 30 GB
df -h /
```

bootstrap จะพิมพ์ URL `https://localhost:3453` ตอนจบ — บนเครื่องนี้ไม่ต้องสนใจ (ไม่มี cert ในเครื่อง ไม่ต้อง `trust-web-ca.sh`)

## E. Caddy กับ IP ของผู้ใช้ (อ่านก่อนแก้ `Caddyfile.cloud`)

- Caddy publish แค่ `172.17.0.1:80` (docker0) = ปลายทางที่ cloudflared ตั้งไว้ · เครื่องอื่นในวง `172.16.40.0/24` ยิงตรงไม่ได้
- **IP ผู้ใช้:** Caddy เชื่อ `Cf-Connecting-IP` เฉพาะ request จาก `172.17.0.0/16` (`trusted_proxies` · เปลี่ยนได้ด้วย `TUNNEL_TRUSTED_CIDR`)
  แล้วเขียน `X-Forwarded-For` เป็นค่านั้นค่าเดียว → backend `trust proxy` **1** ชั้นเหมือนเดิม (`src/main.ts`) · rate limit นับต่อผู้ใช้จริง
  - ทดสอบแล้ว 2026-10-02 (container จำลอง): client ปลอม `X-Forwarded-For` → ถูกแทนด้วย Cf-Connecting-IP ·
    request จากวงที่ไม่ trust ปลอม `Cf-Connecting-IP` → ไม่เชื่อ ใช้ IP ต้นทางจริง
  - ถ้าย้าย cloudflared ไป network อื่น / `--network host` ต้องแก้ `TUNNEL_TRUSTED_CIDR` ตาม ไม่งั้นทุกคนกลายเป็น IP เดียวกัน
- `X-Forwarded-Proto` ถูกตั้งเป็น `https` เสมอ (ผู้ใช้เข้ามาทาง https ที่ Cloudflare) — Keycloak (`KC_PROXY_HEADERS=xforwarded`) ใช้สร้าง redirect
- Host อื่น / เข้าด้วย IP ตรง → 404

## F. blockchain (wallet ใหม่ของ cloud)

ทำตาม README หัวข้อ **"ตั้ง blockchain เอง"** บนเครื่องนี้ทั้งหมด — wallet ใหม่ · ขอ POL จาก faucet · deploy contract ใหม่
(contract เดิม `0x5dC86975…` เขียนได้เฉพาะ wallet ของเครื่อง local) · outbound ไป Amoy RPC (`polygon-amoy-bor-rpc.publicnode.com`) ผ่านแล้ว
ข้ามได้ถ้ายังไม่พร้อม — batch เป็น `SEALED` แล้วถูก anchor ย้อนหลังเมื่อตั้งเสร็จ

## G. ตรวจ

```bash
# จากเครื่องไหนก็ได้ (ไม่ต้องต่อ VPN)
curl -s https://logchain-api.nareubad.work/health                                    # {"status":"ok",...}
curl -s https://logchain-auth.nareubad.work/realms/logchain/.well-known/openid-configuration | jq -r .issuer
#   ต้องได้ https://logchain-auth.nareubad.work/realms/logchain
curl -s -o /dev/null -w '%{http_code}\n' https://logchain-api.nareubad.work/api/v1/stats/overview   # 401
curl -s -o /dev/null -w '%{http_code}\n' https://logchain.nareubad.work/                             # 200

# บน CT141 — พอร์ตที่ฟังนอก 127.0.0.1 ต้องเหลือ :22 (sshd) + 172.17.0.1:80 เท่านั้น
ss -ltn | grep -vE '127\.0\.0\.|\[::1\]'
```

- เปิด `https://logchain.nareubad.work` → login → ต้องเข้าหน้า Dashboard ได้ · user ของ realm `logchain` เป็นชุดใหม่ (bootstrap พิมพ์วิธีตั้งไว้)
- ยิง log: บนเครื่องนี้ `./scripts/demo-brute-force.sh "$T"` (ขอ token ตามคำสั่งใน `docs/plan/next-steps.md`) → เห็น alert บน dashboard
- rate limit เห็น IP จริง: ยิง `/api/v1/stats/overview` เกิน 200 ครั้งใน 1 นาทีจากเครื่องหนึ่งจนได้ 429 (ThrottlerGuard global ทำงานก่อนเช็ค token) → อีกเครื่อง (เน็ตคนละวง เช่นมือถือ) ต้องยังได้ 401 ไม่ใช่ 429
  (ถ้าได้ 429 ด้วย = ทุกคนถูกนับเป็น IP เดียว → ดูหัวข้อ E)
- `docker compose ps` ครบ

## H. ดูแลระบบ

- **Grafana / Prometheus ภายใน** — ต่อ VPN แล้ว SSH tunnel:
  `ssh -i ~/.ssh/nblab_ct141 -L 3002:127.0.0.1:3002 -L 9090:127.0.0.1:9090 root@172.16.40.141` แล้วเปิด `http://localhost:3002`
- **Keycloak admin console** ถึงได้จาก internet ที่ `https://logchain-auth.nareubad.work/admin` — รัน `./scripts/harden-master-admin.sh`
  ทันทีหลัง bootstrap (บังคับ TOTP ให้ master admin)
- อัปเดตโค้ด (user `logchain`): `git pull` → `HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose build backend && docker compose up -d --no-deps backend`
  · dashboard: `docker compose build cylis-dashboard && docker compose up -d --no-deps cylis-dashboard` · ตามด้วย `docker builder prune -f`
- disk: `df -h /` · `docker system df` (ตัวเลข volume ของ Kafka ใน `system df` เกินจริง — ใช้ `du`)
- **cloudflared เป็นของเพื่อน** (container `cloudflare` · `--restart=always`) — อย่าลบ / อย่าใส่เข้า compose ของเรา
  · tunnel ล่ม = 502 / 530 จาก Cloudflare → `docker logs --tail 20 cloudflare` แล้วทักเพื่อน

## I. ความเสี่ยงที่ยังเหลือ / ต่างจากเครื่อง local

| เรื่อง | บนเครื่อง local | บน CT141 |
|---|---|---|
| encryption at rest | LUKS2 + TPM2/PIN (`check-encryption-at-rest.sh`) | ZFS บน Proxmox ของเพื่อน — **ไม่ใช่ LUKS** · เอกสาร compliance (PCI 3.1 / E12) อ้างถึงเครื่อง local เท่านั้น |
| Vault unseal key | อยู่บนดิสก์ที่เข้ารหัส + ต้องใส่ PIN ตอน boot | อยู่บนดิสก์ของ CT — **เพื่อน (root ของ Proxmox) เข้าถึงได้ทั้ง key และข้อมูล** |
| TLS | Caddy ในเครื่อง (CA ของเราเอง) | จบที่ **Cloudflare** — Cloudflare เห็นข้อมูลแบบ plaintext · tunnel → Caddy เป็น http ภายในเครื่อง |
| การเข้าถึง | bind 127.0.0.1 ทั้งหมด | ไม่มีพอร์ตเปิด internet · เข้าทาง tunnel (Caddy → dashboard / Keycloak / backend ที่มี auth) · rate limit ต่อ IP ผ่าน `Cf-Connecting-IP` |
| Vault mlock | ใช้ได้ (`IPC_LOCK`) | unprivileged LXC อาจจำกัด memlock — ถ้า Vault ขึ้นไม่ได้ (`failed to lock memory`) ค่อยแก้ · ไม่มี swap อยู่แล้ว |
| disk | เหลือเฟือ | **30 GB** — prune build cache ทุกครั้งหลัง build · ไม่พอขอเพื่อนขยายเป็น 50 GB |
| backup offsite | Google Drive (rclone crypt) | ยังไม่ได้ตั้ง — รัน `./scripts/setup-offsite-backup.sh` ถ้าต้องการ |
| wallet | `0x8cBCfC04…4C55` | wallet ใหม่ + contract ใหม่ (ขั้น F) |
