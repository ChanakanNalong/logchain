# LogChain

NestJS API gateway สำหรับ **log ingestion** ที่ออกแบบตามแนวทาง **PCI DSS** — มี PII masking,
ความสมบูรณ์ของ log แบบ Merkle batch + anchoring บน blockchain, การส่งต่อไป Kafka เพื่อ detection,
authentication/RBAC ผ่าน Keycloak (OIDC/JWT) และ Prometheus metrics.

---

## คุณสมบัติหลัก

- **Ingestion + PII masking** — mask PII ก่อน hash เสมอ (PCI DSS Req 3); PAN ไม่เคยเข้า hash function
- **Integrity (M2)** — Merkle batch + per-log proof + tamper detection, anchor `merkleRoot` ลง blockchain
- **Streaming** — ส่ง log ไป Kafka (KRaft mode) ให้ detection service วิเคราะห์
- **AuthN/AuthZ** — Keycloak OIDC/JWT (RS256 + JWKS), RBAC 5 roles (`admin` / `operator` / `ingestor` / `analyst` / `auditor`) ผ่าน realm roles + `RolesGuard`
- **Observability** — Prometheus metrics, health checks, Swagger (`@ApiTags`)
- **PCI Req 8 hardening** — ดูหัวข้อ [Authentication & PCI DSS Req 8](#authentication--pci-dss-req-8) ด้านล่าง

## Stack

| ส่วน | เทคโนโลยี |
|---|---|
| Framework | NestJS 11 (TypeScript) |
| Database | PostgreSQL 16 + TypeORM |
| Messaging | Kafka 3.7 (KRaft, ไม่มี Zookeeper) |
| Identity | Keycloak 24 (OIDC/JWT) |
| Blockchain | ethers v6 (Polygon Amoy testnet) |
| Metrics/Docs | Prometheus, Swagger |

---

## Prerequisites

- **Docker + Docker Compose v2** — จำเป็นอย่างเดียวถ้ารันผ่าน `bootstrap.sh`
- `openssl` (มากับ Linux/macOS อยู่แล้ว) — ใช้สุ่ม secret + สร้าง Kafka cert
- **Node.js 22** — เฉพาะตอนจะรัน backend บน host เอง (ดู `.nvmrc`)
  `package.json` engines = `^20.19.0 || ^22.12.0 || >=23.0.0` — node 18 พังตอน boot
  ด้วย `ERR_REQUIRE_ESM` เพราะ `jwks-rsa@4` ลาก `jose@6` ที่เป็น ESM-only
- (optional) Polygon Amoy testnet — contract `0x5dC86975615d3bc713cdf9f25ad1cA25CE7949f5`
  (ตรวจสอบได้ที่ amoy.polygonscan.com) · **เขียนได้เฉพาะ wallet ที่เป็น owner** — clone ไปใช้เองให้
  deploy `LogIntegrity.sol` ด้วย wallet ของตัวเองแล้วใส่ address นั้นแทน ไม่ตั้งเลยก็ได้ (batch เป็น `SEALED`
  proof + tamper detection ยังทำงานครบ)

> **ไม่ต้อง clone `logchain-contracts`** ถ้าใช้ contract ที่ deploy ไว้แล้วข้างบน —
> backend ฝัง minimal ABI 3 function ไว้เองที่ `src/blockchain/blockchain.service.ts`
> ไม่ได้ import artifact จาก repo นั้น เชื่อมกันผ่าน `CONTRACT_ADDRESS` ใน `.env` อย่างเดียว

---

## Setup & Run

### เริ่มต้นใช้งาน — จาก clone จนเห็นหน้าเว็บ

> ฉบับ PDF สำหรับส่งต่อ: [`docs/guides/getting-started.pdf`](docs/guides/getting-started.pdf)

| OS | สถานะ |
|---|---|
| Linux (Ubuntu) | ✅ ทดสอบ clone ใหม่ครบทั้งสาย (2026-09-25) |
| Windows 10/11 — ผ่าน **WSL2** | 🟡 script รองรับแล้ว ยังไม่ได้ทดสอบบนเครื่องจริง |
| macOS (Intel / Apple Silicon) | 🟡 script รองรับแล้ว ยังไม่ได้ทดสอบบนเครื่องจริง · image ทุกตัวมี arm64 แต่ยังไม่ได้ build บน arm64 |

เครื่อง: RAM ≥ 8 GB (ระบบใช้จริง ~3.5 GB · Windows / macOS แนะนำ 16 GB) · ดิสก์ว่าง ≥ 15 GB

**0. ติดตั้งโปรแกรมที่ต้องใช้** (ครั้งเดียวต่อเครื่อง) — `bootstrap.sh` เช็คให้แค่ `docker` กับ `openssl` แต่ script ย่อยใช้ `jq` และ `python3` ด้วย

*Linux (Ubuntu)*

```bash
sudo apt update
sudo apt install -y git curl jq openssl python3 libnss3-tools   # libnss3-tools = ให้เบราว์เซอร์ trust CA (ขั้น 3)
curl -fsSL https://get.docker.com | sh      # ถ้ายังไม่มี Docker + Compose v2
sudo usermod -aG docker $USER               # แล้ว logout/login ใหม่ 1 ครั้ง
docker compose version                      # ต้องขึ้น v2.x
```

*Windows 10/11* — script เป็น bash จึงรันใน **WSL2 (Ubuntu)** · ทุกคำสั่งตั้งแต่นี้ไปพิมพ์ใน terminal "Ubuntu" ไม่ใช่ PowerShell

1. PowerShell แบบ **Run as administrator**: `wsl --install -d Ubuntu` → restart เครื่อง → เปิดแอป "Ubuntu" ตั้ง username / password
2. ติดตั้ง [Docker Desktop](https://www.docker.com/products/docker-desktop/) → Settings → Resources → **WSL integration** → เปิด Ubuntu
3. ใน terminal Ubuntu:

```bash
sudo apt update && sudo apt install -y git curl jq openssl python3
docker compose version                      # ต้องขึ้น v2.x (มาจาก Docker Desktop)
```

*macOS*

1. ติดตั้ง [Docker Desktop](https://www.docker.com/products/docker-desktop/) (เลือก Apple Silicon หรือ Intel ให้ตรงเครื่อง) →
   Settings → Resources → Memory **≥ 6 GB**
2. ใน Terminal:

```bash
xcode-select --install                      # git + python3 (ถ้ามีแล้วจะขึ้นว่าติดตั้งอยู่แล้ว)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"   # Homebrew ถ้ายังไม่มี
brew install jq
docker compose version                      # ต้องขึ้น v2.x
```

curl / openssl มากับ macOS อยู่แล้ว

**1. clone**

```bash
cd ~                                        # Windows: ต้องอยู่ในโฟลเดอร์ของ Ubuntu — ห้ามใต้ /mnt/c/...
git clone https://github.com/ChanakanNalong/logchain.git
cd logchain
```

> **Windows:** clone ใน terminal Ubuntu เท่านั้น — ใต้ `/mnt/c` ตั้งสิทธิ์ไฟล์ 0600/0640 ไม่ได้ (Kafka อ่าน key ไม่ผ่าน) และช้ามาก ·
> clone ด้วย Git for Windows จะได้ `/bin/bash^M: bad interpreter`

**2. ยกทั้งระบบ — คำสั่งเดียว**

```bash
./scripts/bootstrap.sh
docker compose ps          # ทุกตัวต้อง Up / healthy · ไม่มี Restarting
```

ครั้งแรกบนเครื่องใหม่ build image ~10–20 นาที (รอบต่อไป ~2–3 นาที) · Windows / macOS: เปิด Docker Desktop ค้างไว้ก่อนรัน ·
จบแล้วต้องเห็นกรอบ **"LogChain พร้อมใช้งาน"**

**3. ให้เบราว์เซอร์ trust HTTPS** (ครั้งเดียวต่อเครื่อง)

```bash
./scripts/trust-web-ca.sh  # เลือกวิธีตาม OS ให้เอง · แล้วปิดเบราว์เซอร์ทุกหน้าต่าง เปิดใหม่
```

| OS | script ทำอะไร | ต้องทำเพิ่ม |
|---|---|---|
| Linux | ใส่ CA ลง NSS ของ Chrome / Edge / Firefox | – |
| Windows (WSL) | ใส่ CA ลง cert store ของ user ฝั่ง Windows (Chrome / Edge) | Windows เด้งหน้าต่าง **Security Warning** → กด **Yes** |
| macOS | ใส่ CA ลง login keychain (Chrome / Safari / Edge) | ใส่รหัสผ่านเครื่อง / Touch ID |

Firefox บน Windows / macOS ใช้ store ของตัวเอง — ถ้ายังเตือน: `about:config` → `security.enterprise_roots.enabled` = `true`

**4. เปิด https://localhost:3453 แล้ว login** (Windows: เปิดในเบราว์เซอร์ฝั่ง Windows ได้เลย)

| ช่อง | ค่า |
|---|---|
| Username | `admin-user` |
| Password | `grep KEYCLOAK_ADMIN_USER_PASSWORD .env` |

login ครั้งแรก Keycloak ให้ตั้ง **OTP** — เปิดแอป Authenticator (Google / Microsoft Authenticator ฯลฯ) สแกน QR แล้วใส่รหัส 6 หลัก ·
ครั้งต่อไปใช้รหัสผ่าน + OTP

**5. ยิงข้อมูล demo ให้หน้าเว็บมีอะไรให้ดู**

```bash
./scripts/ingest-log.sh                 # log 1 รายการ (PAN ถูก mask เป็น [PAN])

set -a; . ./.env; set +a
T=$(curl -sf -X POST http://localhost:8080/realms/logchain/protocol/openid-connect/token \
  -d grant_type=client_credentials -d client_id=log-ingestor \
  -d "client_secret=$LOGCHAIN_INGESTOR_SECRET" | jq -r .access_token)
./scripts/demo-brute-force.sh "$T"      # 6 AUTH_FAILURE → alert brute force (rule 5710)
```

รอ ~1 นาทีแล้ว refresh: **Logs** มี log ที่ยิง · **Alerts** มี alert CRITICAL · **Integrity** มี batch `SEALED`
(ขึ้น `CONFIRMED` บน blockchain ต้องใส่ `BLOCKCHAIN_PRIVATE_KEY` เอง — ไม่บังคับ)

**6. ใช้งาน dashboard** — เมนูแถบซ้าย · `admin-user` มีครบทุก role จึงเห็นทุกเมนู

| เมนู | ใช้ทำอะไร | role |
|---|---|---|
| Dashboard | จำนวน log · Chain Integrity · กราฟปริมาณ log (1H – All) · IP ต้นทางที่เจอบ่อย · log ล่าสุด | analyst · operator · admin |
| Logs | ค้นหา ID / source / IP / event · กรองประเภทการโจมตี + severity | analyst · operator · admin |
| ML Detection | ผล train DeepLog (confusion matrix) + detection ที่เกิดจริง | analyst · operator · admin |
| Dataset | ข้อมูลอ้างอิง dataset HDFS ที่ใช้ train (คงที่ ไม่ได้ดึงจากระบบ) | – |
| Verify | สถานะ chain (Integrity · Sealed · Tampered · Anchored) + ตรวจ Merkle proof ของ log | analyst · operator · admin |
| Alerts | กรอง status / severity / ประเภท · กดแถวดูรายละเอียด · **Resolve** | ดู: analyst ขึ้นไป · Resolve: operator · admin |
| Reports | รายงาน compliance ตามช่วงวันที่ · **Export CSV** | auditor · admin |
| Settings | เพิ่ม / ถอด role · ปิดบัญชี (ถอด admin ตัวเองหรือคนสุดท้ายไม่ได้) | admin |

ลองทำตาม:
- **จัดการ alert:** ขั้น 5 → **Alerts** → กรอง `OPEN` → alert CRITICAL brute force → กดแถว → **Resolve** → `RESOLVED`
- **พิสูจน์ว่า log ไม่ถูกแก้:** **Verify** → Chain integrity 100% · Tampered 0 → กด **Verify** ที่ log ในรายการ →
  **"Verified — proof valid"** (ขึ้น "not yet sealed" = รอ 1 นาทีให้ปิด batch ก่อน)
- **ออกรายงาน:** **Reports** → เลือก From / To → **Export CSV** → `compliance_<from>_<to>.csv`

**หน้าอื่น**

| อะไร | URL | login |
|---|---|---|
| Swagger (API) | https://localhost:3443/api | – |
| Grafana | http://localhost:3002 | `admin` / `GRAFANA_ADMIN_PASSWORD` ใน `.env` |
| Prometheus | http://localhost:9090 | – |
| Keycloak admin | https://localhost:8443/admin | `kc-admin` / `KEYCLOAK_ADMIN_PASSWORD` (ครั้งแรกตั้ง OTP) |

**ปัญหาที่เจอบ่อยตอนเริ่ม** (ที่เหลือดู [Troubleshooting](#troubleshooting))

| อาการ | แก้ |
|---|---|
| เบราว์เซอร์เตือน cert | ยังไม่รัน `./scripts/trust-web-ca.sh` หรือยังไม่ restart เบราว์เซอร์ |
| `Invalid parameter: redirect_uri` | `./scripts/sync-keycloak-urls.sh` |
| `permission denied` ตอนใช้ docker | ยังไม่ logout/login หลัง `usermod -aG docker` |
| `address already in use` | มีโปรแกรมอื่นใช้พอร์ต (เช่น LogChain อีกชุดบนเครื่องเดียวกัน) — ปิดก่อน |
| Windows: `ports are not available` / `access a socket in a way forbidden` | Windows จองพอร์ตไว้ — PowerShell (admin): `net stop winnat` แล้ว `net start winnat` แล้วรัน bootstrap ซ้ำ |
| Windows: Kafka ขึ้นไม่ได้ `Permission denied` ที่ `.key` · `bad interpreter` | repo อยู่ใต้ `/mnt/c` หรือ clone ด้วย Git for Windows — clone ใหม่ใน `~` ของ Ubuntu |
| Windows / macOS: container ตายเอง (`Exited (137)`) หรือช้ามาก | Docker Desktop ได้ RAM น้อยไป — Settings → Resources → Memory ≥ 6 GB |
| เคยพิมพ์ `docker compose up -d` เปล่า ๆ แล้ว Vault / Kafka / backend พัง | รัน `./scripts/bootstrap.sh` ซ้ำ — ใส่ `HOST_UID` / `HOST_GID` ให้เองแล้วสร้าง container ใหม่ |
| อยากเริ่มใหม่หมด (**ข้อมูลหาย**) | `docker compose down -v && rm -rf .env infra/vault/.secrets infra/kafka/certs infra/tls/certs` แล้ว bootstrap ใหม่ |

**ปิดระบบ และเปิดใช้ครั้งต่อไป**

| สถานการณ์ | ทำอะไร |
|---|---|
| ปิดคอม / รีสตาร์ตเฉย ๆ (ไม่ได้สั่ง `down`) | กลับมาเองเมื่อ Docker เริ่มทำงาน (`restart: unless-stopped`) · Windows / macOS: เปิด Docker Desktop แล้วรอ 1–2 นาที |
| ปิดระบบเอง | `docker compose down` — ข้อมูลยังอยู่ |
| เปิดหลังสั่ง `down` / container ไม่ขึ้นเอง | คำสั่งข้างล่าง — ไม่ต้อง trust HTTPS หรือตั้ง OTP ใหม่ |
| ลบทิ้งทั้งหมด | `docker compose down -v` — **ข้อมูลหาย** |

```bash
cd ~/logchain                               # Windows: ในหน้าต่าง Ubuntu · เปิด Docker Desktop ก่อน
HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose up -d
```

> **ห้ามพิมพ์แค่ `docker compose up -d`** — ไม่มี `HOST_UID` / `HOST_GID` ไฟล์ของ Vault จะเป็นของ root และบน macOS (gid 20 ไม่ใช่ 1000)
> Kafka อ่าน key ไม่ได้ · จำไม่ได้ให้รัน `./scripts/bootstrap.sh` ซ้ำแทน (รันซ้ำได้)

#### `bootstrap.sh` ทำอะไรบ้าง

`bootstrap.sh` idempotent — รันซ้ำได้ ข้ามขั้นที่ทำไปแล้วเอง มันทำ 6 อย่าง:

| # | ขั้น | หมายเหตุ |
|---|---|---|
| 1 | `cp .env.example .env` + สุ่มค่าที่เป็น `CHANGE_ME` | ข้าม `BLOCKCHAIN_PRIVATE_KEY` ให้ใส่เอง |
| 2 | `infra/kafka/gen-certs.sh` + `infra/tls/gen-certs.sh` | Kafka: CA + broker 3 ใบ + client (nestjs, detection, admin, exporter) · HTTPS: CA + server cert ของ Caddy |
| 3 | `docker compose up -d` เฉพาะ infra | postgres, keycloak, kafka×3, vault, prometheus, alertmanager, grafana |
| 4 | รอ `vault-init` แล้ว merge AppRole เข้า `.env` | `infra/vault/.secrets/approle.env` |
| 5 | `docker compose up -d --build` ฝั่งแอป | backend, dashboard, detection×2, https-proxy (Caddy) |
| 6 | `scripts/harden-master-admin.sh` + `scripts/sync-keycloak-urls.sh` | master realm: strong cred + MFA + automation SA · redirect URI ของ dashboard HTTPS |

> ขั้นที่ 4 มีอยู่เพราะ backend กับ detection-consumer **ปฏิเสธที่จะ start** ถ้าไม่มี
> Vault AppRole — แต่ AppRole เพิ่งถูกสร้างหลัง Vault ขึ้น จึงต้องยกเป็น 2 รอบ

### ทำมือ

```bash
cp .env.example .env            # แล้วเติมค่า CHANGE_ME ทุกตัว
./infra/kafka/gen-certs.sh      # ขาดขั้นนี้ kafka SSL listener ขึ้นไม่ได้
docker compose up -d            # vault-unseal init + unseal ให้เองอัตโนมัติ
                                # AppRole โผล่ที่ infra/vault/.secrets/approle.env
                                # -> ก๊อป VAULT_* 4 ตัวลง .env แล้ว up ซ้ำ
docker compose up -d backend detection-consumer
./scripts/harden-master-admin.sh
```

### โหมด dev — รัน backend บน host

```bash
docker compose up -d                        # infra ทั้งหมด
docker compose stop backend                 # กันชนพอร์ต 3000
nvm use                                     # อ่าน .nvmrc -> node 22.19.0
npm install && npm run start:dev
```

> **Keycloak:** ตั้ง `KEYCLOAK_INTERNAL_URL=http://localhost:8080` ใน `.env` — `KEYCLOAK_URL` (issuer) เป็น https ผ่าน Caddy ซึ่ง
> Node ยังไม่ trust CA ของเรา ถ้าปล่อยว่าง backend จะดึง JWKS ไม่ได้ แล้วทุก request ได้ 401

> **Prometheus:** target ของ backend ชี้ `backend:9464` (container · port metrics แยกจาก API) — หยุด container แล้ว alert `ServiceDown`
> จะเด้ง (และส่ง email ถ้าตั้งไว้) ใน 2 นาที · เปลี่ยน target ของ job `nestjs-api` ใน
> `infra/prometheus/prometheus.yml` เป็น `host.docker.internal:9464` แล้ว `curl -X POST localhost:9090/-/reload`
> (อย่าใส่ทั้งสองคู่กัน — scrape ซ้ำ) หรือ silence ที่ http://localhost:9093

`.env` เขียนค่าไว้สำหรับโหมดนี้ (`localhost:5433`, `localhost:29092`, …)
โหมด compose ใช้ `environment:` ใน `docker-compose.yml` override เป็นชื่อ service ให้เอง

> **หมายเหตุ:** Keycloak realm `logchain` ถูก import อัตโนมัติตอน startup โดยไม่มี secret hardcode —
> init container `keycloak-config` จะ render `infra/keycloak/realm-logchain.json.template`
> (แทนค่า `${...}` จาก `.env`) ลง shared volume ก่อน Keycloak เริ่มทำงาน.

> **หมายเหตุ:** Kafka topic (`logs.raw`, `logs.raw.dlq`, `alerts.raw`, `alerts.cde`) ถูกสร้าง
> โดย init container `kafka-init` หลัง broker ทั้ง 3 ตัว healthy — ไม่ต้องสร้างเองหลัง
> `docker compose down -v` ไม่ควรพึ่ง auto-create เพราะ alert จะหายเงียบ ๆ ถ้า topic ไม่มี
> ดู [docs/runbooks/kafka-topics.md](docs/runbooks/kafka-topics.md)

> **ไม่มี detection service ก็ใช้งานได้** — ingest / masking / Merkle seal / anchoring /
> verify / dashboard ทำงานครบ **แค่ไม่มี alert** เพราะ backend เป็นฝั่ง *consume*
> `alerts.raw` / `alerts.cde` ซึ่ง detection-consumer เป็นคน publish

> **ไม่ตั้ง blockchain ก็ยังได้ Merkle integrity** — batch จะถูกปิดเป็นสถานะ `SEALED`
> แทน `CONFIRMED` ซึ่ง **Merkle root / per-log proof / tamper detection ใช้ได้ครบ**
> ตัวที่ยังไม่มีคือการตรึง root ไว้บน chain
>
> ความต่างที่แท้จริง: `SEALED` เก็บ root ไว้ใน DB ก้อนเดียวกับ log ใครที่แก้ `logs`
> **และ** แก้ `batches.merkle_root` ตามได้ด้วยจะรอดการตรวจ — `CONFIRMED` ปิดช่องนี้
> เพราะ root ถูกตรึงไว้นอก DB
>
> ตั้ง `CONTRACT_ADDRESS` (0x + 40 hex) + private key ใน Vault เมื่อไหร่
> `anchorSealedBatches()` จะไล่ anchor batch ที่ค้าง `SEALED` ย้อนหลังให้เองภายใน 1 นาที
> โดย **ไม่ recompute root** (ใช้ root เดิมที่ปิดไว้ตอน seal)

---

## Ports

| Service | URL | หมายเหตุ |
|---|---|---|
| **dashboard** | **https://localhost:3453** | เริ่มที่นี่ — login ผ่าน Keycloak · HTTP `:3003` ใช้ได้เฉพาะเครื่องนี้ |
| backend (NestJS) | https://localhost:3443 | `/health`, `/api`, `/api/v1/*` · HTTP `:3000` เฉพาะเครื่องนี้ (script / demo) · metrics อยู่ `:9464/metrics` ใน docker network เท่านั้น (ไม่ publish) |
| detection (FastAPI) | http://localhost:8000 | `/health`, `/metrics`, `/api/v1/detect` |
| keycloak | https://localhost:8443 | admin console · issuer ของ token · HTTP `:8080` เฉพาะเครื่องนี้ |
| grafana | http://localhost:3002 | user `admin` |
| prometheus | http://localhost:9090 | |
| alertmanager | http://localhost:9093 | ส่ง email เมื่อตั้งค่า — ดู [Alert แจ้งทาง email](#alert-แจ้งทาง-email) |
| vault | http://localhost:8200 | |
| postgres | `localhost:5433` | 5432 ถูก native postgres จองไว้บนเครื่อง dev |
| postgres-standby | `localhost:5434` | hot standby (pg_basebackup) |
| kafka EXTERNAL (PLAINTEXT) | `localhost:29092-29094` | |
| kafka SSL (mTLS) | `localhost:39092-39094` | จาก host · ใน docker network backend/detection ใช้ `kafka-N:9094` (mTLS เปิดอยู่) |
| detection-consumer metrics | `localhost:9101` | ไม่ได้ publish ออก host |

ทุก port bind ที่ **`127.0.0.1`** (เข้าได้จากเครื่องนี้เท่านั้น) · HTTPS (8443 / 3443 / 3453) ผ่าน service `https-proxy` (Caddy ·
cert จาก `infra/tls/gen-certs.sh` · TLS 1.2+ · HSTS) · HTTP ของ Keycloak / backend / dashboard (8080 / 3000 / 3003) bind 127.0.0.1
**เสมอ** แม้ตั้ง `PUBLISH_ADDR` → เครื่องอื่นเข้าได้เฉพาะ HTTPS

ต้องให้เครื่องอื่นเข้า (เช่น log source ข้ามเครื่องยิง `https://<host>:3443/api/v1/logs`):
1. `.env`: `PUBLISH_ADDR=0.0.0.0` · `TLS_EXTRA_SANS=DNS:<ชื่อ>,IP:<ip>` · เปลี่ยน `KEYCLOAK_URL`, `NEXT_PUBLIC_API_URL`,
   `NEXT_PUBLIC_KEYCLOAK_URL`, `ALLOWED_ORIGINS` เป็นชื่อนั้น
2. `./infra/tls/gen-certs.sh --renew` · `docker compose up -d --build` · `DASHBOARD_PUBLIC_URL=https://<ชื่อ>:3453 ./scripts/sync-keycloak-urls.sh`
3. เครื่องปลายทาง trust `infra/tls/certs/ca.crt`

ระวัง: `PUBLISH_ADDR` เปิดทุก port รวม Postgres / Vault / Grafana / Alertmanager ซึ่งยังเป็น plaintext

`/health` อยู่**นอก** global prefix `api/v1` โดยตั้งใจ — คือ `/health` ไม่ใช่ `/api/v1/health`

`/metrics` ของ backend **ไม่อยู่บน :3000** — แยกไป `:9464` ซึ่งไม่ publish ออก host (review B5: เดิมใครเรียกก็เห็นจำนวน batch
ตามสถานะ) · ดูค่าเอง: `docker exec logchain-backend wget -qO- 127.0.0.1:9464/metrics` หรือหน้า Prometheus `:9090`

---

## Backup ฐานข้อมูล

service `postgres-backup` dump Postgres (role + DB `logchain` + DB `keycloak` ที่มี users/OTP) **วันละครั้งอัตโนมัติ**
ลง `./backups/postgres/<UTC timestamp>/` เก็บ 7 ชุดล่าสุด (ไฟล์ 0600 · ไม่เข้า git) · backup เก่าเกิน 26 ชม. หรือพังติดกัน → alert

```bash
ls backups/postgres/                                        # ชุดที่มี
docker exec logchain-postgres-backup sh /backup.sh once     # ทำเพิ่มทันที (เช่นก่อนแก้ข้อมูลใหญ่)
docker logs logchain-postgres-backup --tail 5
```

กู้คืน: `docs/RTO-RPO-Compliance-Signoff.md` หัวข้อ Database Failure (ทดสอบกู้จากไฟล์ที่ job สร้างจริงแล้ว)

### สำเนาบน cloud (เข้ารหัส)

`./backups/` อยู่เครื่องเดียวกับ DB — ดิสก์พังหายพร้อมกัน · service `backup-offsite` ส่งสำเนาขึ้น cloud ทุกชั่วโมงผ่าน
**rclone crypt** (cloud เห็นแต่ข้อมูลเข้ารหัส ทั้งเนื้อไฟล์และชื่อ) · ตรวจ checksum หลังส่ง · เก็บบน cloud 30 วัน
ยังไม่ตั้ง = service รอเฉย ๆ ไม่มี alert · ตั้งครั้งเดียว (Google Drive) — **ใช้ script** ไม่ต้องตอบเมนูเอง:

```bash
./scripts/setup-offsite-backup.sh    # เปิดลิงก์ที่ขึ้นมา → login → Allow · สุ่ม password ให้ + แสดงครั้งเดียวให้จด
docker exec logchain-backup-offsite sh /offsite.sh once
```

ระหว่างเชื่อม Google (เจอจริงตอนตั้งครั้งแรก):
- หน้า **"Google hasn't verified this app"** → **Advanced → Go to rclone (unsafe) → Continue** · กด Back to safety = `access_denied`
  (rclone ใช้ OAuth client ที่แชร์ทั้งโลก · scope `drive.file` เห็นเฉพาะไฟล์ที่ rclone สร้าง · ถอนสิทธิ์ได้ที่
  https://myaccount.google.com/permissions)
- rclone ถาม **"Configure this as a Shared Drive (Team Drive)?"** → **`n`** · ตอบ `y` = 403 insufficient authentication scopes

ตั้งด้วยเมนูของ rclone เอง (ทางเลือก — เคยพลาดเพราะออกจากเมนูก่อนกด `y` บันทึก แล้วไม่มีไฟล์ config):

```bash
# --network host: ให้เบราว์เซอร์ในเครื่องนี้กด "อนุญาต" ได้ · ไฟล์ config ลง infra/rclone/.secrets/ (gitignored)
docker run --rm -it --network host --user $(id -u):$(id -g) \
  -v $PWD/infra/rclone/.secrets:/config/rclone rclone/rclone:1.68 config
```

ในเมนูของ rclone:
1. `n` → name **`gdrive`** → storage **`drive`** → client_id / client_secret: Enter (ว่าง)
   → scope **`drive.file`** (rclone เห็นเฉพาะไฟล์ที่ตัวเองสร้าง ไม่เห็นไฟล์อื่นใน Drive) → service_account_file: Enter
   → advanced: `n` → web browser: `y` → เปิดลิงก์ `http://127.0.0.1:53682/...` ที่ขึ้นมา → login → อนุญาต → shared drive: `n` → `y`
2. `n` → name **`logchain-backup`** → storage **`crypt`** → remote **`gdrive:logchain-backups`**
   → filename_encryption `standard` → directory_name_encryption `true`
   → password: `g` (สุ่ม) → **จดไว้** → password2 (salt): `g` → **จดไว้** → advanced `n` → `y` → `q`

> ⚠️ **เก็บ password ทั้งสองตัว (หรือทั้งไฟล์ `infra/rclone/.secrets/rclone.conf`) ไว้ใน password manager**
> ไฟล์ config อยู่เครื่องเดียวกับ backup — เครื่องหาย = ไม่มีรหัสถอด = สำเนาบน cloud ใช้ไม่ได้

```bash
docker exec logchain-backup-offsite sh /offsite.sh once     # ส่งทันที → ต้องขึ้น "OK → logchain-backup: (N ชุดบน cloud)"
```

ดึงกลับจาก cloud (เครื่องใหม่: วาง `rclone.conf` เดิม หรือสร้าง crypt remote ด้วย password ชุดเดิม):
```bash
docker run --rm --user $(id -u):$(id -g) -v $PWD/infra/rclone/.secrets:/config/rclone -v $PWD/restore:/restore \
  rclone/rclone:1.68 copy logchain-backup:<UTC timestamp> /restore/<UTC timestamp>
```
แล้ว restore ตาม `docs/RTO-RPO-Compliance-Signoff.md`

## Alert แจ้งทาง email

Prometheus ส่ง alert (rule ใน `infra/prometheus/alerts.yml` — service ล่ม, Postgres ล่ม, Kafka broker ขาด,
consumer ค้าง, detection ส่ง alert ไม่ถึง backend, ethers rejection หลุด) ต่อให้ Alertmanager ที่ http://localhost:9093
ค่าเริ่มต้น **ยังไม่ส่งไปไหน** — รับไว้ให้ดูเฉย ๆ จนกว่าจะตั้ง 3 อย่างนี้ครบ:

```bash
# 1. รหัส — Gmail: เปิด 2-Step Verification ก่อน แล้วสร้างที่ https://myaccount.google.com/apppasswords
#    ใส่ในไฟล์ (gitignored) ไม่ใช่ .env · read -rs = ไม่โชว์บนจอ ไม่ลง shell history · ตัดช่องว่างให้เอง
read -rs PW && printf '%s' "${PW// /}" > infra/alertmanager/.secrets/smtp_password && unset PW
chmod 600 infra/alertmanager/.secrets/smtp_password

# 2. ใน .env
ALERT_SMTP_USER=you@gmail.com
ALERT_EMAIL_TO=oncall@example.com

# 3. สร้าง container ใหม่ (config ถูก render ตอน start)
HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose up -d --no-deps --force-recreate alertmanager
docker logs logchain-alertmanager 2>&1 | head -1   # ต้องขึ้น "ส่ง email → ..."
```

ไม่ใช่ Gmail: ตั้ง `ALERT_SMTP_SMARTHOST=host:port` (และ `ALERT_SMTP_FROM` ถ้าต่างจาก user) ใน `.env`

### Security alert (brute force ฯลฯ) ทาง email

Alertmanager ข้างบนแจ้งเรื่อง **ระบบ** (service ล่ม, backup) · alert **ความปลอดภัย** ระดับ HIGH/CRITICAL ที่ detection จับได้
ส่งโดย backend ผ่าน SMTP ใน Vault (`secret/logchain/notification`) — ค่าเริ่มต้นปิดอยู่ · เปิดด้วย:

```bash
./scripts/setup-alert-email.sh   # ใช้บัญชี + app password ชุดเดียวกับ Alertmanager ได้ (ไม่ต้องพิมพ์รหัสใหม่)
```

ค่าอยู่ใน `.env` (`MAIL_USER` / `MAIL_TO` / `MAIL_PASS`) แล้ว `vault-init` seed เข้า Vault — **อย่าเขียน Vault ตรง ๆ**
`vault-init` รันทุกครั้งที่ `docker compose up` และ seed จาก `.env` ใหม่ ค่าที่เขียนเองจะถูกทับ

> SMTP ชุดนี้แยกจากของ backend (`secret/logchain/notification` ใน Vault — ใช้แจ้ง alert ความปลอดภัย)
> Alertmanager อ่าน Vault ไม่ได้ จึงเก็บรหัสเป็นไฟล์แทน

## Troubleshooting

| อาการ | สาเหตุ | แก้ |
|---|---|---|
| `kafka-1/2/3` วน restart, log ว่า *No matching PRIVATE KEY entries in PEM file* | ไม่มี `infra/kafka/certs/` (gitignored) | `./infra/kafka/gen-certs.sh` แล้ว `docker compose up -d --force-recreate kafka-1 kafka-2 kafka-3` |
| Keycloak ขึ้นแต่ไม่มี realm `logchain` / client secret ว่าง | `.env` ยังเป็น `CHANGE_ME` ตอน `keycloak-config` render template | เติม `.env` → `docker compose up -d --force-recreate keycloak-config keycloak` |
| `backend` วน restart: *Vault config missing* หรือ *Vault login failed* | `VAULT_NESTJS_ROLE_ID` / `_SECRET_ID` ยังไม่อยู่ใน `.env` | `./scripts/bootstrap.sh` (ข้ามขั้นที่ทำแล้วเอง) หรือก๊อปจาก `infra/vault/.secrets/approle.env` |
| `detection-consumer` วน restart: *Vault config missing* | เหมือนข้างบน แต่เป็นคู่ `VAULT_DETECTION_*` | เหมือนข้างบน |
| `backend` / `detection-consumer` ขึ้น ***permission denied*** ตอน approle login ทั้งที่ค่าใน `.env` ถูกแล้ว | **Vault User Lockout** — login พลาดครบ 5 ครั้งแล้วโดนแบน alias 15 นาที หลังจากนั้นตอบ `permission denied` กับทุก request แม้รหัสถูก และ `restart: unless-stopped` จะวน retry ต่ออายุ lockout ไปเรื่อย ๆ ไม่หลุดเอง | ดูหัวข้อ [Vault user lockout](#vault-user-lockout) ด้านล่าง |
| `vault` healthy แต่ `vault-init` exit 1 *ไม่พบ /vault/secrets/init.env* | `vault-unseal` ยัง init ไม่เสร็จ | รอแล้ว `docker compose up -d vault-init` ซ้ำ |
| `postgres-standby` ขึ้นไม่ได้ | `REPLICATION_PASSWORD` ว่าง | เติมใน `.env` แล้ว `docker compose down -v` + bootstrap ใหม่ |
| ยิง `/api/v1/*` แล้วได้ **404** | global prefix / route ไม่ต่อ | ไม่ใช่เรื่อง auth — ดู log backend |
| ยิง `/api/v1/*` แล้วได้ **401** | ปกติ — แปลว่า route ต่อแล้ว แค่ยังไม่ได้แนบ token | `./scripts/ingest-log.sh` ขอ token ให้เอง |
| `verify-now` ตอบ **403** | token ไม่มี realm role `admin` | login ด้วยบัญชี admin หรือใช้ service account ที่มี role ครบ |
| `401 invalid issuer` ตอน backend อยู่ใน docker | `KEYCLOAK_URL` ถูก override เป็น `keycloak:8080` หรือยังเป็น `http://localhost:8080` (`.env` ก่อน 2026-09-24) | `KEYCLOAK_URL` ต้องเป็น **public URL** `https://localhost:8443` (= `KC_HOSTNAME_URL` = issuer) — ที่อยู่ภายในใช้ `KEYCLOAK_INTERNAL_URL` · `.env` เก่า: `./scripts/bootstrap.sh` ย้ายให้ |
| เบราว์เซอร์ขึ้น *Your connection is not private* / `NET::ERR_CERT_AUTHORITY_INVALID` ที่ `:3453` / `:8443` | ยังไม่ได้ trust CA ของเรา | `./scripts/trust-web-ca.sh` แล้ว restart เบราว์เซอร์ · สร้าง CA ใหม่ (ลบ `infra/tls/certs/`) ต้องรันซ้ำ |
| Keycloak ขึ้น *Invalid parameter: redirect_uri* ตอน login dashboard | realm เดิม (import ก่อนมี HTTPS) ไม่มี `https://localhost:3453/*` | `./scripts/sync-keycloak-urls.sh` |
| `curl https://localhost:3443/...` ได้ *SSL certificate problem* | curl ไม่ได้ใช้ NSS DB ของเบราว์เซอร์ | `curl --cacert infra/tls/certs/ca.crt …` หรือยิง `http://localhost:3000` บนเครื่องเดียวกัน |
| login dashboard ด้วย `admin-user` + `KEYCLOAK_ADMIN_USER_PASSWORD` แล้วขึ้น *Invalid username or password* | Keycloak import realm (พร้อมรหัสจาก `.env`) **ครั้งเดียวตอน boot แรก** — ถ้าเคยเปลี่ยนรหัสผ่านหน้าเว็บ หรือแก้ `.env` ทีหลัง ค่าใน `.env` จะไม่ตรงกับของจริงอีกต่อไป | ใช้รหัสที่ตั้งไว้เอง หรือ reset ที่ Keycloak admin console (`https://localhost:8443` → realm `logchain` → Users) · ระวัง brute force protection ล็อกหลังพลาด 5 ครั้ง |
| dashboard login แล้ว redirect กลับมาเปล่า ๆ | `NEXT_PUBLIC_*` ถูกตั้งเป็นชื่อ service หรือ `NEXT_PUBLIC_KEYCLOAK_URL` ≠ `KEYCLOAK_URL` | ต้องเป็น URL ที่เบราว์เซอร์เรียก (`https://localhost:8443` / `:3443`) เสมอ (inline ตอน build + รันบนเบราว์เซอร์ซึ่งอยู่นอก docker network) — แก้แล้วต้อง `--build` ใหม่ |
| batch ค้างที่ `SEALED` ไม่ขึ้น `CONFIRMED` | ไม่ได้ตั้ง `CONTRACT_ADDRESS` / private key ใน Vault | **ปกติ** — batch ถูกปิดแล้ว proof กับ tamper detection ทำงานครบ แค่ยังไม่ได้ตรึง root ขึ้น chain · ตั้ง blockchain เมื่อไหร่ `anchorSealedBatches()` จะตามไป anchor ย้อนหลังให้เองภายใน 1 นาที |
| batch ค้างที่ `UNVERIFIED` ไม่ขึ้น `CONFIRMED` | anchor ไปแล้วแต่ tx ยังไม่ confirm ใน `BLOCKCHAIN_TX_TIMEOUT_MS` หรือ RPC พังระหว่างรอ receipt | รอบ verify ถัดไปตามผลให้เอง — ไม่ใช่ `FAILED` |
| batch ค้าง `UNVERIFIED` **เป็นชั่วโมง** · backend log `unverifiable — no root on chain` · alert `BatchStuckUnverified` (เกิน 30 นาที) | tx ถูก drop ไม่เคยลง chain (หรือ chain reset) · `INTEGRITY_AUTO_REANCHOR=false` (ค่าเริ่มต้น) ระบบจึง**ไม่ส่งใหม่เอง** — ตั้งใจ: re-anchor เอา `merkle_root` จาก DB ขึ้น chain ถ้า DB ถูกแก้มาก่อน ของปลอมจะถูกตรึงบน chain | ตรวจก่อนว่าไม่มีใครแก้ DB (`demo-tamper.sh` / audit log) แล้วตั้ง `INTEGRITY_AUTO_REANCHOR=true` ใน `.env` → `docker compose up -d --no-deps backend` · ส่งเสร็จปิดกลับได้ |

### Vault user lockout

Vault 1.13+ เปิด user lockout มาโดย default — `lockout_threshold=5`, `lockout_duration=15m`
แอปทั้งสองตัว retry login 5 ครั้งตอน start พอดี **ใส่ secret ผิดครั้งเดียวก็ครบโควตาทันที**

อาการที่หลอกมากคือ error เปลี่ยนจาก `invalid role or secret ID` เป็น **`permission denied`**
ซึ่งทำให้เข้าใจผิดว่าเป็นเรื่อง policy — จริง ๆ คือโดนแบน และจะแบนต่อไปเรื่อย ๆ ตราบใดที่
container ยังวน retry อยู่ (ทุกครั้งที่พลาดคือรีเซ็ตนาฬิกา 15 นาทีใหม่)

**วิธีดูว่าใช่เคสนี้ไหม** — ดู log ของตัว Vault เอง ไม่ใช่ log ของแอป:

```bash
docker logs --tail=20 logchain-vault | grep -i lockout
# core: login attempts exceeded, user is locked out: request_path=auth/approle/login
```

**วิธีแก้แบบเร็ว** — สคริปต์ทำขั้นตอนด้านล่างให้ครบ (หยุด container → unlock → เปิดใหม่):

```bash
./scripts/vault-unlock.sh              # ดูอย่างเดียวว่ามีใครโดนล็อก
./scripts/vault-unlock.sh detection    # หรือ backend
```

**วิธีแก้แบบทำเอง** — ต้องหยุด container ที่วน retry ก่อน ไม่งั้น unlock ไปก็โดนล็อกซ้ำทันที:

```bash
docker compose stop detection-consumer          # หรือ backend แล้วแต่ตัวไหนพัง

# หา mount accessor ของ approle
ACC=$(docker exec logchain-vault-unseal sh -c '. /vault/secrets/init.env
  VAULT_TOKEN=$VAULT_ROOT_TOKEN VAULT_ADDR=http://vault:8200 \
  vault auth list -detailed -format=json' | grep -o '"auth_approle_[a-z0-9]*"' | head -1 | tr -d '"')

# alias ที่ถูกล็อกคือ role_id
RID=$(grep '^VAULT_DETECTION_ROLE_ID=' .env | cut -d= -f2-)

docker exec -e ACC="$ACC" -e RID="$RID" logchain-vault-unseal sh -c '. /vault/secrets/init.env
  VAULT_TOKEN=$VAULT_ROOT_TOKEN VAULT_ADDR=http://vault:8200 \
  vault write -f "sys/locked-users/$ACC/unlock/$RID"'

docker compose up -d detection-consumer
```

หรือถ้าไม่รีบ — **หยุด container ทิ้งไว้เฉย ๆ 15 นาที** lockout จะหมดอายุเอง

> ไม่ได้ปิด lockout ให้เป็น default เพราะ account lockout เป็น control ตาม PCI DSS Req 8.3.4
> ซึ่งเป็นแก่นของโปรเจกต์นี้ ถ้าอยากปิดเฉพาะตอน dev เพิ่ม block นี้ใน `infra/vault/config/vault.hcl`
> แล้ว `docker compose restart vault`:
> ```hcl
> user_lockout "approle" {
>   disable_lockout = true
> }
> ```

เริ่มใหม่หมดจด (ลบ data ทั้งหมด):

```bash
docker compose down -v
rm -rf infra/vault/.secrets infra/kafka/certs .env detection/.env
./scripts/bootstrap.sh
```

### Scripts

| Script | หน้าที่ |
|---|---|
| `scripts/bootstrap.sh` | onboarding ครบวงจร (idempotent) — ใช้ตัวนี้ตัวเดียวก็พอ |
| `scripts/ingest-log.sh` | ingestion path — ขอ token ด้วย `client_credentials` แล้ว POST log |
| `scripts/harden-master-admin.sh` | harden master realm (strong cred + MFA + automation service account, idempotent) |
| `scripts/check-tracked-secrets.sh` | ตรวจว่าไม่มี `.env` / key / cert หลุดเข้า git |
| `scripts/demo-brute-force.sh` | ยิง log รัว ๆ ให้ detection จับได้ → alert โผล่ที่หน้า Alerts (ต้องใช้ token ที่มี role `analyst`/`operator`/`admin` ไม่งั้นขั้นสุดท้ายที่ไปอ่าน `/alerts` ได้ 403 ทั้งที่ alert ถูกบันทึกแล้ว) |
| `scripts/demo-tamper.sh` | แก้ log ในฐานข้อมูลตรง ๆ → Merkle verify จับได้ |
| `scripts/demo-mtls.sh` | ต่อ Kafka ผ่าน SSL listener (39092-39094) |
| `infra/kafka/gen-certs.sh` | สร้าง CA + cert ของ broker/client (อายุ 825 วัน) |
| `npm run deploy:contract` | deploy smart contract สำหรับ anchoring |

---

## API Endpoints

| Method | Path | Roles | คำอธิบาย |
|---|---|---|---|
| `POST` | `/api/v1/logs` | `ingestor`, `admin` | Ingest log (mask → hash) |
| `GET` | `/api/v1/logs` | `analyst`, `operator`, `admin` | รายการ log ล่าสุด |
| `GET` | `/api/v1/logs/:id` | `analyst`, `operator`, `admin` | log ตาม ID |
| `GET` | `/api/v1/logs/:id/proof` | `analyst`, `operator`, `admin` | Merkle proof ของ log |
| `GET` | `/health` | — | Health check |

ทุก endpoint ของ logs/integrity ป้องกันด้วย `AuthGuard('jwt')` + `RolesGuard` (Bearer token).
ระบบมี 5 roles: `admin` / `operator` / `ingestor` / `analyst` / `auditor` — หน้า Reports ผูกกับ role `auditor`.

---

## Authentication & PCI DSS Req 8

ระบบ auth ทำตาม PCI DSS Requirement 8 (*Identify Users & Authenticate Access*) แบ่งเป็น 2 ส่วน:
(A) `logchain` realm และ (B) `master` realm. **โค้ด M1 auth (RolesGuard/JwtStrategy) และ M2 (Merkle integrity) ไม่ถูกแตะต้อง.**

> เอกสารฉบับเต็มแบบ HTML: [`docs/pci-req8-hardening-summary.html`](docs/pci-req8-hardening-summary.html)

### ส่วน A — `logchain` realm

| Item | Req | สิ่งที่ทำ |
|---|---|---|
| 3 | 8.6 | Service account สำหรับ ingestion — client `log-ingestor` (confidential, client_credentials); ปิด ROPC ของ `api-gateway`; ลบ user `ingestor-service` |
| 1 | 8.3.6 | Password policy: `length(12)` + digit + upper + lower + notUsername + `passwordHistory(4)` |
| 2 | 8.4 | MFA conditional OTP — browser flow บังคับ TOTP เฉพาะ role `admin` |
| 4 | 2.2.2 | Externalize secrets ไป `.env`; render realm จาก template; compose ใช้ `${VAR}` |

**MFA flow (logchain realm):**

```
logchain-browser (top-level)
 ├─ auth-cookie                      ALTERNATIVE
 ├─ identity-provider-redirector     ALTERNATIVE
 └─ logchain-browser-forms           ALTERNATIVE
     ├─ auth-username-password-form  REQUIRED
     └─ logchain-conditional-otp     CONDITIONAL
         ├─ conditional-user-role    REQUIRED   (condition.user.role = admin)
         └─ auth-otp-form            REQUIRED
```

**ผลทดสอบ (รันจริง):**

- ✅ `log-ingestor` client_credentials → token มี `roles:[ingestor]`; ingest สำเร็จ (PII masked → `card [PAN]`)
- ✅ admin ROPC ถูกปฏิเสธ: `unauthorized_client – Client not allowed for direct access grants`
- ✅ weak password ถูกปฏิเสธ: `HTTP 400 – must contain at least 1 upper case`
- ✅ ไม่มี secret จริงใน git-tracked file; realm import สำเร็จ

### ส่วน B — `master` realm

master realm ควบคุมทุก realm จึงเป็น identity ที่มีค่าสูงสุด — hardening ผ่าน `scripts/harden-master-admin.sh`
(idempotent, รันรวดเดียวบน fresh state ได้):

| การเปลี่ยนแปลง | รายละเอียด |
|---|---|
| Strong non-default admin | `admin/admin` → `kc-admin` + password แข็งแรงจาก `.env`; ลบ user `admin` |
| Password policy | เหมือน logchain realm |
| MFA | `CONFIGURE_TOTP` required action บน `kc-admin` + conditional-OTP browser flow |
| Automation SA | client `master-automation` (client_credentials) — **least-privilege**: `manage-realm, manage-users, manage-clients, view-realm` (ไม่ใช่ blanket `admin`) |

**ผลทดสอบ (รันจริงบน fresh state):**

- ✅ single clean run บน fresh state → hardened ครบ ไม่ต้องแก้มือ
- ✅ idempotent re-run = clean no-op (auth ผ่าน service account)
- ✅ default `admin/admin` ล้มเหลว: `invalid_grant – Invalid user credentials`
- ✅ `kc-admin` + password ถูกต้อง → gate ด้วย MFA: `Account is not fully set up`
- ✅ automation SA ได้ token โดยไม่โดน MFA; least-privilege confirmed (ไม่มี realm role `admin`)
- ✅ logchain realm + app log data preserved (logs rows ไม่ถูกลบ)

### การ automate Keycloak หลังเปิด MFA (CI/CD)

ใช้ **service-account client + `grant_type=client_credentials`** — token แบบนี้ไม่ผ่าน browser flow จึงไม่ติด MFA:

- authenticate เป็น service account แล้วเรียก Admin REST API (หรือ `kcadm.sh --client master-automation --secret …`)
- **least-privilege:** ให้เฉพาะ `realm-management` client roles ที่จำเป็น ไม่ให้ `admin` รวม
- เก็บ secret ใน CI secret store, rotate สม่ำเสมอ; assurance สูงขึ้นใช้ signed-JWT (`private_key_jwt`) หรือ mTLS
- หนึ่ง service account ต่อหนึ่ง consumer เพื่อ audit/revoke แยกกันได้

---

## Security notes

- `.env` ถูก gitignore — secret จริงทั้งหมดอยู่ในนั้น ไม่ถูก track. ใช้ `.env.example` เป็น reference (ค่า placeholder)
- ค่า secret ใน setup เป็น **DEV-ONLY** — ห้ามใช้ใน production; ต้อง generate/rotate ใหม่
- master admin TOTP ลงทะเบียนแบบ interactive ตอน login console ครั้งแรก (ไม่มี seed OTP secret โดยตั้งใจ)

## Project structure (ย่อ)

```
src/                    NestJS API gateway (Dockerfile ที่ root)
 ├─ logs/               ingestion, PII masking, entities
 ├─ integrity/          Merkle batch + per-log proof (M2)
 ├─ blockchain/         anchoring (ethers, inline ABI)
 ├─ kafka/              producer + consumer (alerts.raw / alerts.cde)
 ├─ auth/               JwtStrategy, RolesGuard (Keycloak OIDC)
 ├─ admin/              Keycloak Admin REST proxy
 └─ audit/ alerts/ metrics/ health/ vault/ stats/ compliance/ retention/ erasure/
cylis-dashboard/        Next.js 16 + React 19 dashboard (พอร์ต 3003) — ไม่ใช่ submodule
detection/              FastAPI + Kafka consumer (DeepLog) — ดู detection/README.md
infra/
 ├─ keycloak/           realm-logchain.json.template
 ├─ kafka/              create-topics.sh, gen-certs.sh, certs/ (gitignored)
 ├─ vault/              init.sh, unseal.sh, policies/, .secrets/ (gitignored)
 ├─ prometheus/ grafana/
 └─ postgres/init/      00-keycloak-db.sh, 01-replication-user.sh
scripts/                bootstrap.sh, ingest-log.sh, harden-master-admin.sh, demo-*.sh
docs/                   runbooks/, worklog/, plan/, pci-req8-hardening-summary.html
docker-compose.yml      20 service — infra + backend + dashboard + detection
```

**repo ที่เกี่ยวข้อง:** [`logchain-contracts`](https://github.com/ChanakanNalong/logchain-contracts)
(Solidity/Hardhat) แยกไว้ต่างหากโดยตั้งใจ — deploy ครั้งเดียวจบ และ backend ไม่ได้ import
อะไรจากมัน ผูกกันผ่าน `CONTRACT_ADDRESS` อย่างเดียว **ไม่ต้อง clone**
