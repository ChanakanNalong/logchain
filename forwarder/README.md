# LogChain VPS forwarder

อ่าน log จริงบน VPS แล้วส่งเข้า `POST /api/v1/logs` — **เฉพาะบรรทัดที่เป็นหลักฐาน** (ทุก log ที่ส่งไปจะถูก seal เข้า batch
แล้ว anchor ขึ้น chain = ค่า gas · ดู [docs/bench-anchor.md](../docs/bench-anchor.md))

Python 3.10+ · stdlib อย่างเดียว (ไม่ต้อง pip install บน VPS)

## ส่งอะไร

| source | eventType | อ่านจาก | ส่งเมื่อ | severity |
|---|---|---|---|---|
| `vps-sshd` | `SSH_AUTH` | `journalctl -u ssh -f -o json` (หรือ tail `/var/log/auth.log`) | `Invalid user` · `Failed password` · `Accepted password/publickey/keyboard-interactive` · `Connection closed by invalid/authenticating user` · `Disconnected from authenticating user` | WARNING (Accepted = INFO) |
| `web-proxy` | `HTTP_ACCESS` | access log ของ reverse proxy — Caddy (json) ของ https-proxy บน CT141 หรือ nginx (combined) | scanner UA · `../` (รวม `%2e%2e`) · SQL keyword (รวม URL-encode) · shell metachar · 4xx/5xx บน `/.env` `/.git/` `/wp-admin` `/wp-login.php` ฯลฯ | WARNING |

- ไม่ส่ง `pam_unix(sshd:auth)` — ซ้ำกับ `Failed password` ของ connection เดียวกัน
- ไม่ส่ง request จาก IP ภายใน (`10.0.0.0/8` `172.16.0.0/12` `127.0.0.0/8` `::1`) และ health check (`/health` `/api/v1/health` `/healthz`)
- `message` = ข้อความหลัง `sshd[pid]: ` / `METHOD PATH STATUS "UA"` · `sourceIp` = IP ผู้กระทำ (`from <ip>` / `user <name> <ip> port`
  / client IP · `CF-Connecting-IP` เมื่อเปิด `TRUST_CF_CONNECTING_IP`) — rule ของ detection นับแยกตาม IP นี้
- `classification: INTERNAL` · `cdeScope: false` · request ปกติถูกทิ้งที่ forwarder ไม่เข้า API

## กันเงินหมด / กันตาย

- **rate cap** `RATE_PER_HOUR` (300) แบบหน้าต่างเลื่อน 1 ชม. รวมทุก source · **dedup** ข้อความเดียวกันภายใน `DEDUP_SECONDS` (10)
- ที่ทิ้ง (เกิน cap / ซ้ำ / API ปฏิเสธ / คิวเต็ม) นับไว้ แล้ว log สรุปทุก `SUMMARY_SECONDS` (600) — `journalctl -u logchain-forwarder | grep summary`
- API ล่ม = backoff 1 → 2 → 4 … ≤ 300 วิ · คิวในหน่วยความจำ ≤ cap → **ดับนานแค่ไหนก็ไม่ส่ง backlog เกิน cap**
- บรรทัดเสีย / JSON เสีย = ข้าม · `journalctl` ตาย = เปิดใหม่ · ไฟล์ถูก rotate (ย้าย / copytruncate) = เปิดไฟล์ใหม่
- token แบบ client_credentials cache ไว้ ต่ออายุก่อนหมด 60 วิ · 401 = ขอใหม่แล้วส่งซ้ำครั้งเดียว
- cursor ของ journald / offset ของไฟล์จำไว้ใน `STATE_FILE` — restart แล้วอ่านต่อ (ครั้งแรกเริ่มที่ "ตอนนี้" ไม่ส่งของเก่า)

## CT141 (NB-Lab) โดยเฉพาะ

- เส้นทางจริง: Cloudflare → cloudflared (container บน CT141) → `172.17.0.1:80` → https-proxy (Caddy) — ไม่มี proxy อื่นคั่น
- `EXCLUDE_IPS=49.48.73.182` (IP ขาออกของ CT141 เอง — request ที่เรายิงจากในเครื่องวนกลับเข้ามาทาง Cloudflare)
- `/home/logchain` เป็น 750 → drop-in `logchain-forwarder.ct141.conf` bind dir log แบบ read-only ไปที่ `/var/log/https-proxy`
  แล้วตั้ง `ACCESS_LOGS=/var/log/https-proxy/access.log`
- access log: `infra/caddy/Caddyfile.cloud` `(access_log)` → `/home/logchain/logchain/logs/https-proxy/access.log`
  (dir `65534:adm 2750` เพราะ Caddy รันเป็น uid 65534 · ไฟล์ `0640` กลุ่ม adm) · `ACCESS_LOGS` ชี้ไฟล์นี้ · `TRUST_CF_CONNECTING_IP=false`
  (Caddy เชื่อ `Cf-Connecting-IP` จาก `172.18.0.1/32` เท่านั้นแล้วเขียน `request.client_ip` ให้ — forwarder ใช้ค่านั้น)
- sshd ของ CT141 เข้าได้เฉพาะผ่าน VPN → ส่วนใหญ่เป็น `Accepted publickey` ของผู้ดูแลเอง (เก็บไว้เป็น audit)
- token/API ใช้ภายในเครื่อง: `LOGCHAIN_API_URL=http://127.0.0.1:3000/api/v1` · `LOGCHAIN_TOKEN_URL=http://127.0.0.1:8080/realms/logchain/protocol/openid-connect/token`

## ติดตั้งบน VPS

```bash
# 1. Keycloak: client vps-forwarder (role ingestor อย่างเดียว) — import มาแบบปิดไว้
#    realm ใหม่: ตั้ง LOGCHAIN_FORWARDER_SECRET ใน .env ก่อน bootstrap · realm เดิม (import ไม่ทับ): สร้างเองใน admin console
#    Clients → Create: vps-forwarder · Client authentication ON · Service accounts ON · Standard flow OFF
#    → Service account roles: ingestor · Credentials: copy secret · เปิด Enabled
#    (realm เดิมที่มี client แล้ว: เปลี่ยน secret ที่ Credentials → Regenerate แล้วเปิด Enabled)

# 2. ไฟล์ + user
sudo useradd --system --no-create-home --shell /usr/sbin/nologin logchain-fwd
sudo mkdir -p /opt/logchain-forwarder && sudo cp -r forwarder/logchain_forwarder /opt/logchain-forwarder/
sudo install -m 640 -o root -g logchain-fwd forwarder/logchain-forwarder.env.example /etc/logchain-forwarder.env
sudoedit /etc/logchain-forwarder.env        # API / token URL / secret / ACCESS_LOGS

# 3. ทดลองแบบไม่ส่งจริงก่อน
#    --stats = อ่าน log ย้อนหลังแล้วสรุปตัวเลข (ดูหัวข้อ "สรุปจาก log จริง") · --dry-run = ตามดูของใหม่แล้วพิมพ์ payload
sudo -u logchain-fwd -g logchain-fwd --preserve-env=LOGCHAIN_FORWARDER_ENV \
  sh -c 'cd /opt/logchain-forwarder && LOGCHAIN_FORWARDER_ENV=/etc/logchain-forwarder.env STATE_FILE=/tmp/fwd-test.json python3 -m logchain_forwarder --dry-run'

# 4. service — ติดตั้งไว้ก่อน ยังไม่ enable (กัน reboot แล้วเปิดเองก่อนพร้อม)
sudo install -m 644 forwarder/logchain-forwarder.service /etc/systemd/system/
sudo systemctl daemon-reload

# 5. เปิดจริง — ครั้งเดียวทั้ง enable และ start
sudo systemctl enable --now logchain-forwarder
```

## เปิด / ปิด / ดูสถานะ

```bash
sudo systemctl enable --now logchain-forwarder             # เปิดจริง (และเปิดเองหลัง reboot)
systemctl status logchain-forwarder
journalctl -u logchain-forwarder -f                       # log ของ forwarder (summary ทุก 10 นาที)
sudo systemctl restart logchain-forwarder                  # หลังแก้ /etc/logchain-forwarder.env
sudo systemctl disable --now logchain-forwarder            # ปิดถาวร
```

**ปิดด่วนเมื่อ POL ใกล้หมด**: `sudo systemctl stop logchain-forwarder` — log ไม่เข้า API = ไม่มี batch ใหม่ = ไม่มี tx
(backend มี guard ของตัวเองด้วย: `SEAL_MIN_BALANCE_TX` ไม่สร้าง batch เมื่อยอดต่ำ + alert `WALLET_LOW_BALANCE`)
ลดค่าใช้จ่ายโดยไม่ปิด: ลด `RATE_PER_HOUR` หรือเอา `ACCESS_LOGS` ออก

## สรุปจาก log จริง (`--stats`)

อ่าน `ACCESS_LOGS` (รวมไฟล์ที่ roll แล้ว) + journald ของ sshd ย้อนหลัง `--since-hours` แล้วพิมพ์ JSON สรุป — **ไม่ส่ง ไม่เขียน state**
ตัวกรองชุดเดียวกับตอนส่งจริง · พิมพ์แค่ตัวเลข / เหตุผล / path ตัวอย่าง (ไม่มี IP) · รันในสภาพเดียวกับ service:

```bash
sudo systemd-run --wait --pipe --quiet \
  -p User=logchain-fwd -p Group=logchain-fwd -p SupplementaryGroups="systemd-journal adm" \
  -p ProtectSystem=strict -p ProtectHome=true -p PrivateTmp=true -p NoNewPrivileges=true \
  -p BindReadOnlyPaths=/home/logchain/logchain/logs/https-proxy:/var/log/https-proxy \
  -p WorkingDirectory=/opt/logchain-forwarder \
  /usr/bin/python3 -m logchain_forwarder --config /etc/logchain-forwarder.env --stats --since-hours 24
```
(บรรทัด `BindReadOnlyPaths` เฉพาะ CT141 — ตรงกับ drop-in `logchain-forwarder.ct141.conf`)

## ข้อจำกัด

- **เวลาของ log = เวลาที่ backend รับ** — API ไม่รับ `createdAt` จาก client · forwarder ดับแล้วกลับมา log ช่วงนั้นมีเวลาเป็นตอนส่ง
  (rule แบบ "5 ครั้งใน 60 วิ" นับจากเวลานี้)
- at-most-once: cursor/offset บันทึกตอนรับเข้าคิว — process ตายขณะมีของในคิว = ของในคิวหาย (ไม่ส่งซ้ำ)
- ไฟล์ที่ถูก rotate ขณะ forwarder ปิดอยู่ ส่วนท้ายของไฟล์เก่าที่ยังไม่ได้อ่านจะไม่ถูกส่ง (อ่านไฟล์ใหม่ตั้งแต่ต้น)
- nginx ต้องใช้ format `combined` (ต่อท้ายฟิลด์เพิ่มได้) · Caddy ต้อง `format json`
- path ที่เป็น probe (`/.env` ฯลฯ) ส่งเฉพาะเมื่อได้ 4xx/5xx — 200 บน `/.env` (ไฟล์รั่วจริง) ไม่ถูกจับที่นี่ ต้องดูจาก scanner UA / rule อื่น

## เทส

```bash
cd forwarder && python3 -m unittest discover -s tests -t . -v     # ต้องมี PyYAML (โหลด rule จริงของ detection)
```
