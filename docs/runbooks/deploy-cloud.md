# Runbook — deploy ขึ้น cloud (Oracle Always Free VM + Vercel)

> ตัดสินใจ 2026-09-30: ทั้ง stack รันบน VM ฟรี 1 เครื่อง (compose ชุดเดิม) · dashboard อยู่บน Vercel · domain จาก DuckDNS
> · เริ่มข้อมูลใหม่ (ไม่ย้าย demo data / secret / wallet ของเครื่อง local ขึ้น cloud)
>
> **ทำไมไม่ใช้ Render / Railway:** ระบบใช้ RAM ~5 GB (Kafka 3 ตัว ~2.3 GB · Keycloak ~850 MB · Vault ~440 MB) ·
> free tier ของ Render ให้ 512 MB ต่อ service และหลับเมื่อไม่มีคนเรียก (cron ปิด batch หยุด) · Railway ไม่มี free tier ถาวร
> · ลงได้ต้องถอด Kafka / Vault / Keycloak ออก = ระบบไม่ตรงกับเล่ม

```
เบราว์เซอร์ ──► https://<app>.vercel.app            (dashboard · Vercel)
     │
     ├──────► https://auth.<name>.duckdns.org ─┐
     └──────► https://api.<name>.duckdns.org  ─┤  VM :443 → Caddy (Let's Encrypt)
                                               ├─► keycloak:8080
                                               └─► backend:3000 ─► Postgres · Kafka · Vault · detection · Amoy
   พอร์ตที่เปิดให้ internet: 22 (SSH key) · 80 · 443 เท่านั้น — ที่เหลือ bind 127.0.0.1 (เข้าผ่าน SSH tunnel)
```

ไฟล์ที่เกี่ยวข้อง: `docker-compose.cloud.yml` (override เฉพาะ `https-proxy`) · `infra/caddy/Caddyfile.cloud`

ในเอกสารนี้ `<name>` = ชื่อ DuckDNS · `<app>` = ชื่อ project บน Vercel

---

## A. บัญชี (เจ้าของทำ — ทำขั้น A2 ก่อนเพราะนานสุด)

1. **DuckDNS** — https://www.duckdns.org login ด้วย GitHub/Google → เพิ่ม subdomain `<name>` · จด **token**
   (DuckDNS ตอบทุกชื่อย่อยด้วย IP เดียวกัน: `auth.<name>.duckdns.org` / `api.<name>.duckdns.org` ใช้ได้ทันที)
2. **Oracle Cloud** — https://www.oracle.com/cloud/free/ สมัคร (ต้องใช้บัตรเครดิตยืนยัน ไม่ถูกตัดเงินถ้าอยู่ใน Always Free)
   - **home region เลือกแล้วเปลี่ยนไม่ได้** — เลือกที่ใกล้และมักมีเครื่องว่าง (เช่น Singapore / Tokyo / Osaka)
   - ⚠️ บัญชี Free Tier: instance ที่ CPU ใช้น้อยมากต่อเนื่อง 7 วันอาจถูก Oracle เรียกคืน — อัปเกรดบัญชีเป็น
     Pay As You Go (ยังไม่เสียเงินถ้าใช้แค่ในโควตา Always Free) จะไม่โดนเงื่อนไขนี้ · **ตรวจเงื่อนไขล่าสุดในหน้า Oracle อีกครั้ง**
3. **Vercel** — https://vercel.com login ด้วย GitHub (บัญชีที่เห็น repo `logchain`)

## B. สร้าง VM (Oracle console)

1. Compute → Instances → Create
   - Image: **Canonical Ubuntu 24.04** (aarch64) · Shape: **VM.Standard.A1.Flex — 4 OCPU / 24 GB**
   - Boot volume: 100 GB (Always Free รวมไม่เกิน 200 GB)
   - SSH key: อัปโหลด public key ของเครื่องนี้ (`~/.ssh/id_ed25519.pub`)
   - ถ้าขึ้น "Out of capacity" = region เต็ม ลองใหม่ภายหลัง / เปลี่ยน availability domain
2. Networking → VCN ของ instance → Security List → Ingress: เพิ่ม TCP **80** และ **443** จาก `0.0.0.0/0` (22 มีอยู่แล้ว)
3. จด **public IP** → ตั้งใน DuckDNS ให้ `<name>` ชี้ IP นี้ · ตรวจ: `dig +short api.<name>.duckdns.org`
   (IP ของ instance คงเดิมตราบใดที่ไม่ลบ instance · อยากได้ถาวรจริงใช้ Reserved Public IP)

## C. Vercel — ทำก่อน bootstrap (ต้องรู้ URL ของ dashboard ก่อนตั้ง `.env` บน VM)

1. Add New → Project → import repo `logchain`
2. **Root Directory: `cylis-dashboard`** · Framework: Next.js (ตรวจเจอเอง)
3. Environment Variables (inline ตอน build — แก้แล้วต้อง Redeploy):
   | ชื่อ | ค่า |
   |---|---|
   | `NEXT_PUBLIC_API_URL` | `https://api.<name>.duckdns.org/api/v1` |
   | `NEXT_PUBLIC_KEYCLOAK_URL` | `https://auth.<name>.duckdns.org` |
   | `NEXT_PUBLIC_KEYCLOAK_REALM` | `logchain` |
   | `NEXT_PUBLIC_KEYCLOAK_CLIENT_ID` | `logchain-frontend` |
4. Deploy → จด URL production `https://<app>.vercel.app` (ตอนนี้ login ยังไม่ได้ — backend ยังไม่ขึ้น)

## D. เตรียม VM

```bash
ssh ubuntu@<public-ip>

# firewall ของ image Ubuntu บน Oracle บล็อกทุกพอร์ตยกเว้น 22 (นอกเหนือจาก Security List) — เปิด 80/443
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80  -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save

# SSH: key อย่างเดียว (image ของ Oracle ปิด password อยู่แล้ว — ตรวจ)
sudo sshd -T | grep -E '^passwordauthentication'     # ต้องเป็น no

sudo apt update && sudo apt install -y git curl jq openssl python3
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker ubuntu && exit               # login ใหม่ให้กลุ่ม docker มีผล
```

## E. ติดตั้ง LogChain

```bash
ssh ubuntu@<public-ip>
git clone https://github.com/<owner>/logchain.git && cd logchain
cp .env.example .env && chmod 600 .env
```

แก้ `.env` (bootstrap จะสุ่ม `CHANGE_ME` ที่เหลือให้เอง):

```bash
# ใช้ override ของ cloud กับทุกคำสั่ง docker compose + scripts/
COMPOSE_FILE=docker-compose.yml:docker-compose.cloud.yml
AUTH_HOST=auth.<name>.duckdns.org
API_HOST=api.<name>.duckdns.org
ACME_EMAIL=<อีเมลรับแจ้ง cert ใกล้หมดอายุ>
# issuer ของ token = URL ที่เบราว์เซอร์เรียก Keycloak (ต้องเท่ากับ NEXT_PUBLIC_KEYCLOAK_URL บน Vercel)
KEYCLOAK_URL=https://auth.<name>.duckdns.org
# CORS ของ backend + redirect URI ของ Keycloak (sync-keycloak-urls.sh อ่านจาก .env)
ALLOWED_ORIGINS=https://<app>.vercel.app
DASHBOARD_PUBLIC_URL=https://<app>.vercel.app
# ห้ามตั้ง PUBLISH_ADDR — Prometheus / Alertmanager / Kafka EXTERNAL ไม่มี auth
```

```bash
install -d -m 2770 infra/caddy/.data                 # cert ของ Let's Encrypt (ต้องอยู่ข้าม restart)
./scripts/bootstrap.sh                               # build บน ARM ครั้งแรกนาน (detection มี torch)
```

bootstrap จะพิมพ์ URL `https://localhost:3453` ตอนจบ — บน VM ไม่ต้องสนใจ (และไม่ต้องรัน `trust-web-ca.sh`: cert เป็นของ Let's Encrypt)

## F. blockchain (wallet ใหม่ของ cloud)

ทำตาม README หัวข้อ **"ตั้ง blockchain เอง"** บน VM ทั้งหมด — wallet ใหม่ · ขอ POL จาก faucet · deploy contract ใหม่
(contract เดิม `0x5dC86975…` เขียนได้เฉพาะ wallet ของเครื่อง local) · ต้องมี Node.js 22 บน VM
ข้ามได้ถ้ายังไม่พร้อม — batch เป็น `SEALED` แล้วถูก anchor ย้อนหลังเมื่อตั้งเสร็จ

## G. ตรวจ

```bash
# จากเครื่องไหนก็ได้
curl -s https://api.<name>.duckdns.org/health                                   # {"status":"ok",...}
curl -s https://auth.<name>.duckdns.org/realms/logchain/.well-known/openid-configuration | jq -r .issuer
#   ต้องได้ https://auth.<name>.duckdns.org/realms/logchain
curl -s -o /dev/null -w '%{http_code}\n' https://api.<name>.duckdns.org/api/v1/stats/overview   # 401

# พอร์ตที่เปิดจาก internet — ต้องเหลือ 22 / 80 / 443 เท่านั้น (รันจากเครื่องอื่น ไม่ใช่บน VM)
nmap -Pn -p 1-65535 --open <public-ip>
```

- เปิด `https://<app>.vercel.app` → login → ต้องเข้าหน้า Dashboard ได้ · user ของ realm `logchain` เป็นชุดใหม่ (bootstrap พิมพ์วิธีตั้งไว้)
- ยิง log: บน VM `./scripts/demo-brute-force.sh "$T"` (ขอ token ตามคำสั่งใน `docs/plan/next-steps.md`) → เห็น alert บน dashboard
- `docker compose ps` ครบ · `docker logs logchain-https-proxy | grep -i 'certificate obtained'`

## H. ดูแลระบบ

- **Grafana / Prometheus / Keycloak admin ภายใน** — ผ่าน SSH tunnel ไม่เปิด internet:
  `ssh -L 3002:127.0.0.1:3002 -L 9090:127.0.0.1:9090 ubuntu@<public-ip>` แล้วเปิด `http://localhost:3002`
- **Keycloak admin console** ถึงได้จาก internet ที่ `https://auth.<name>.duckdns.org/admin` — รัน `./scripts/harden-master-admin.sh`
  ทันทีหลัง bootstrap (บังคับ TOTP ให้ master admin)
- อัปเดตโค้ด: `git pull` → `HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose build backend && docker compose up -d --no-deps backend`
  · dashboard: push ขึ้น GitHub แล้ว Vercel build ให้เอง
- เปลี่ยน URL ของ Vercel (เช่นใส่ custom domain): แก้ `ALLOWED_ORIGINS` + `DASHBOARD_PUBLIC_URL` → `./scripts/sync-keycloak-urls.sh`
  → `docker compose up -d --no-deps backend`

## I. ความเสี่ยงที่ยังเหลือ / ต่างจากเครื่อง local

| เรื่อง | บนเครื่อง local | บน VM |
|---|---|---|
| encryption at rest | LUKS2 + TPM2/PIN (`check-encryption-at-rest.sh`) | boot volume ของ Oracle เข้ารหัสด้วย key ที่ Oracle จัดการ — **ไม่ใช่ LUKS** · เอกสาร compliance (PCI 3.1 / E12) อ้างถึงเครื่อง local เท่านั้น |
| Vault unseal key | อยู่บนดิสก์ที่เข้ารหัส + ต้องใส่ PIN ตอน boot | อยู่บนดิสก์ของ VM — ใครได้สิทธิ์ root/snapshot ของ VM ได้ทั้ง key และข้อมูล |
| การเข้าถึง | bind 127.0.0.1 ทั้งหมด | 80/443 เปิด internet (Caddy → Keycloak/backend ที่มี auth) · rate limit ต่อ IP ทำงานผ่าน `trust proxy` |
| backup offsite | Google Drive (rclone crypt) | ยังไม่ได้ตั้ง — รัน `./scripts/setup-offsite-backup.sh` ถ้าต้องการ |
| wallet | `0x8cBCfC04…4C55` | wallet ใหม่ + contract ใหม่ (ขั้น F) |
