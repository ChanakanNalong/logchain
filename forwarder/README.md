# LogChain VPS forwarder

อ่าน log จริงบน VPS แล้วส่งเข้า `POST /api/v1/logs` — **เฉพาะบรรทัดที่เป็นหลักฐาน** (ทุก log ที่ส่งไปจะถูก seal เข้า batch
แล้ว anchor ขึ้น chain = ค่า gas · ดู [docs/bench-anchor.md](../docs/bench-anchor.md))

Python 3.10+ · stdlib อย่างเดียว (ไม่ต้อง pip install บน VPS)

## ส่งอะไร

| source | eventType | อ่านจาก | ส่งเมื่อ | severity |
|---|---|---|---|---|
| `vps-sshd` | `SSH_AUTH` | `journalctl -u ssh -f -o json` (หรือ tail `/var/log/auth.log`) | `Invalid user` · `Failed password` · `Accepted password/publickey/keyboard-interactive` · `Connection closed by invalid/authenticating user` · `Disconnected from authenticating user` | WARNING (Accepted = INFO) |
| `vps-nginx` | `HTTP_ACCESS` | access log ของ nginx (combined) / Caddy (json) | scanner UA · `../` (รวม `%2e%2e`) · SQL keyword (รวม URL-encode) · shell metachar · 4xx/5xx บน `/.env` `/.git/` `/wp-admin` `/wp-login.php` ฯลฯ | WARNING |

- ไม่ส่ง `pam_unix(sshd:auth)` — ซ้ำกับ `Failed password` ของ connection เดียวกัน
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

# 3. ทดลองแบบไม่ส่งจริงก่อน (พิมพ์ payload)
sudo -u logchain-fwd -g logchain-fwd --preserve-env=LOGCHAIN_FORWARDER_ENV \
  sh -c 'cd /opt/logchain-forwarder && LOGCHAIN_FORWARDER_ENV=/etc/logchain-forwarder.env STATE_FILE=/tmp/fwd-test.json python3 -m logchain_forwarder --dry-run'

# 4. service
sudo install -m 644 forwarder/logchain-forwarder.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now logchain-forwarder
```

## เปิด / ปิด / ดูสถานะ

```bash
systemctl status logchain-forwarder
journalctl -u logchain-forwarder -f                       # log ของ forwarder (summary ทุก 10 นาที)
sudo systemctl restart logchain-forwarder                  # หลังแก้ /etc/logchain-forwarder.env
sudo systemctl disable --now logchain-forwarder            # ปิดถาวร
```

**ปิดด่วนเมื่อ POL ใกล้หมด**: `sudo systemctl stop logchain-forwarder` — log ไม่เข้า API = ไม่มี batch ใหม่ = ไม่มี tx
(backend มี guard ของตัวเองด้วย: `SEAL_MIN_BALANCE_TX` ไม่สร้าง batch เมื่อยอดต่ำ + alert `WALLET_LOW_BALANCE`)
ลดค่าใช้จ่ายโดยไม่ปิด: ลด `RATE_PER_HOUR` หรือเอา `ACCESS_LOGS` ออก

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
