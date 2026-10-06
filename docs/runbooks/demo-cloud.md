# Runbook — รัน demo-tamper / demo-mtls กับ cloud (CT141)

> ทดสอบจริงบน cloud 2026-10-04 (`041902e`) — ผ่านทั้ง 2 สคริปต์ · ติดตั้ง/อัปเดตระบบดู [`deploy-cloud.md`](deploy-cloud.md)

ทั้ง 2 สคริปต์ใช้ `docker exec` เข้า Postgres / Kafka และยิง `localhost:3000` / `localhost:39092`
ซึ่ง bind 127.0.0.1 บน CT141 เท่านั้น → **ต้องรันบน CT141 เอง** (ผ่าน SSH) ยิงจากเครื่องเราผ่าน internet ไม่ได้

## 1. เข้าเครื่อง

```bash
sudo wg-quick up wg-friend                                   # เครื่องเรา (sudo — รันในเทอร์มินัลเอง)
ssh -i ~/.ssh/nblab_ct141 -o IdentitiesOnly=yes root@172.16.40.141
su - logchain && cd ~/logchain                               # ระบบรันในนาม user logchain
```

ตอนสอบ: เปิดเทอร์มินัลที่ SSH ค้างไว้ก่อนขึ้นเวที · dashboard เปิดในเบราว์เซอร์อีกจอ (`https://logchain.nareubad.work`)

## 2. demo-tamper (แก้ log ใน DB → ระบบจับได้ → กู้คืน)

**ไม่มี admin token บน cloud** — `POST /logs/verify-now` ต้อง role `admin` และ `admin-user` บังคับ TOTP
(ขอ token จาก CLI ด้วยรหัสอย่างเดียวไม่ได้) → ส่ง token หลอกไป สคริปต์จะขึ้น `verify-now ตอบ HTTP 401`
แล้ว**รอ cron verify ที่รันทุก 1 นาที** แทน — ผลเหมือนกัน แค่ช้ากว่า

```bash
./scripts/demo-tamper.sh no-admin-token            # ① UPDATE ตรงโดนบล็อก (IMMUTABLE_LOG) → ปิด trigger แก้ hash
#   → รอ ≤ 1 นาที: batch CONFIRMED → TAMPERED + alert INTEGRITY_TAMPERED (CRITICAL) บนหน้า Alerts / Chain Integrity ตก
./scripts/demo-tamper.sh no-admin-token restore    # ② คืน hash — รอบแรกจะขึ้น ⚠ "ยังเป็น TAMPERED" (ปกติ ไม่ใช่พัง)
#   → รอ ≤ 1 นาทีให้ cron verify ผ่าน (batch กลับเป็น CONFIRMED) แล้วรันซ้ำ:
./scripts/demo-tamper.sh no-admin-token restore    # ③ "กู้คืนแล้ว — batches: CONFIRMED x7" · ไฟล์สำรองถูกลบ
```

เช็คสถานะ batch ระหว่างรอ (ไม่ต้องเดา):

```bash
docker compose exec -T postgres psql -U logchain -d logchain -tAc "select status, count(*) from batches group by 1"
```

ผลจริง 2026-10-04: แก้ 22:09 → TAMPERED 22:10 (ภายใน 1 นาที) · restore → CONFIRMED 22:11:30 · alert ถูก backend ปิดเองตอน verify ผ่าน
(`backend ปิดเองตอน verify อีก 1, ยังค้าง OPEN 0`) · ทั้งรอบประมาณ 2–3 นาที

ข้อควรรู้:
- สคริปต์หยิบ log ตัวแรกที่อยู่ใน batch (`LIMIT 1`) — ไม่ใช่ log ที่เลือกเอง
- ไฟล์สำรองอยู่ที่ `/tmp/logchain-tamper-backup.txt` **บน CT141** — ห้ามรีบูต CT ระหว่าง ① กับ ③
  (ถ้าหาย: hash เดิมกู้จาก DB ไม่ได้ → batch นั้นค้าง TAMPERED ถาวร)
- alert CRITICAL ส่ง **อีเมล** ออก (backend + Alertmanager เปิดอีเมลบน cloud) — คาดว่าจะมีเมลเด้งตอน demo
- อย่าลืมขั้น ③ — ไม่งั้น Chain Integrity บน dashboard ค้างต่ำกว่า 100%

## 3. demo-mtls (Kafka ต้องมี client cert)

อ่านอย่างเดียว ไม่แก้ข้อมูล รันได้ทุกเมื่อ:

```bash
./scripts/demo-mtls.sh
```

ผลจริง 2026-10-04:
1. มี client cert → เห็น topic `alerts.cde · alerts.raw · logs.raw · logs.raw.dlq` ✅
2. ไม่มี client cert → `SslAuthenticationException … bad_certificate` ✅ (= mutual TLS จริง)
3. "traffic วิ่งผ่าน port ไหน" → ขึ้นข้อความ `(เปิด backend+detection ด้วย KAFKA_SSL_ENABLED=true …)` —
   **ไม่ได้แปลว่า SSL ปิด**: backend/detection คุยกับ Kafka ใน docker network (`DOCKER_SSL :9094`) ซึ่ง `ss` บน host มองไม่เห็น
   เหมือนกันทั้ง local และ cloud — ข้ามข้อนี้ตอน demo หรืออธิบายตามนี้
4. cert ของ broker: `CN = kafka-1` · SAN `kafka-1, localhost, 127.0.0.1` · หมดอายุ 2029-01-03

ก่อนขึ้นเวทีรันครั้งหนึ่งให้ image `bitnamilegacy/kafka:3.7.1` อุ่นอยู่ (ข้อ 1 ใช้ `docker run`)

## 4. demo อื่นกับ cloud (ไม่ต้อง SSH)

`demo-all-rules.sh` ยิงผ่าน API สาธารณะได้จากเครื่องเรา — ดู `next-steps.md` "คำสั่งที่ใช้บ่อย"
(`API=https://logchain-api.nareubad.work/api/v1 READ_TOKEN=<analyst ขึ้นไป>`)

**Cloudflare:** เพื่อนตั้ง Managed Challenge ไว้ 2026-10-04 · ยกเว้น `logchain-api` แล้ว แต่ `logchain-auth` ยังโดน challenge
→ ถ้า dashboard บน cloud ขึ้น "Could not load dashboard data" อีก เช็คก่อนว่า
`curl -s -o /dev/null -w '%{http_code}' https://logchain-api.nareubad.work/health` ได้ 200 ไม่ใช่ 403

## 5. แผนสำรอง = เครื่อง local

cloud ล่ม / เน็ตห้องสอบมีปัญหา → ใช้ stack บนเครื่อง (`https://localhost:3453`) สคริปต์ชุดเดียวกันรันจาก repo ได้เลย
เช็คก่อนสอบ: `./scripts/demo-preflight.sh` ต้องจบด้วย `🎉 พร้อม demo` (2026-10-04 ผ่าน · FAILED 2 ใบจาก 09-22 เป็น ⚠ ปกติ)

## 6. นาฬิกากระโดด → Kafka ค้างเงียบ (local และ cloud)

> เกิดจริงบน local 2026-10-06 — รายละเอียดใน `docs/worklog/2026-10-06.md` ข้อ 1 และ 4

**สาเหตุ (local):** เครื่องตั้ง `RTC in local TZ: yes` → หลัง suspend kernel อ่านนาฬิกาฮาร์ดแวร์ (เก็บเวลาไทย) เป็น UTC
→ เวลากระโดด**ไปข้างหน้า** +7 ชม. · NTP ติดต่อ `ntp.ubuntu.com` ไม่ได้จึงไม่แก้คืนเอง · พอแก้เวลาก็กระโดด**ถอยหลัง** 7 ชม.
Kafka (KRaft) ทนการกระโดดไปข้างหน้าได้ (broker ถูก fence แล้วกลับมาเอง) แต่หลังถอยหลัง produce บาง partition ค้าง
**cloud (CT141):** เป็น LXC ใช้นาฬิกาของ Proxmox host — ไม่มี suspend แต่ถ้า host ปรับเวลาแบบกระโดด อาการจะเหมือนกัน · แก้เวลาใน CT ไม่ได้ ต้องแจ้งเพื่อน

**อาการ**
- `POST /logs` ค้างจน client timeout (ผ่านไปได้บาง source แล้วค้างเมื่อเจอ partition ที่ค้าง) · แถวถูกบันทึกใน DB และ seal ขึ้น chain ตามปกติ
  แต่**ไม่ถึง detection** → ไม่มี alert
- backend log: `[Producer] Failed to send messages: The request timed out` ซ้ำทุก ~30 วิ
- ทุกอย่างที่ preflight ตรวจยังผ่าน: container healthy · `/health` ต่อ Kafka อยู่ · topic ครบ · ISR ครบ · batch CONFIRMED
  → **`demo-preflight.sh` ตรวจไม่เจอ** (ไม่มีขั้นที่ produce จริง และไม่ตรวจนาฬิกา)
- ผลข้างเคียงจากนาฬิกาเพี้ยน: one-time code (TOTP) ไม่ผ่าน → login พลาดซ้ำจน Keycloak ล็อก user (`user_temporarily_disabled`)

**ตรวจ** (รันในโฟลเดอร์ repo · cloud = บน CT141 ในนาม `logchain`)

```bash
date -u; curl -sI https://www.google.com | grep -i '^date'           # ต่างกันเกินไม่กี่วินาที = นาฬิกาเพี้ยน
timedatectl | grep -E 'synchronized|RTC in local'                   # ต้องเป็น yes / no
docker compose logs --since 10m backend | grep -c 'Failed to send messages'   # ต้องเป็น 0
docker exec logchain-kafka-1 sh /opt/logchain/kafka-cli.sh kafka-topics.sh --describe --under-replicated-partitions   # ต้องไม่มีผลลัพธ์
```

ตรวจแบบ end-to-end (เพิ่ม log 1 แถวซึ่งลบไม่ได้ + เสีย gas 1 tx ตอน seal · ข้อความไม่เข้ากฎใด จึงไม่เกิด alert)
— **อย่าใช้ `scripts/ingest-log.sh` แทน** เพราะข้อความมีเลขบัตร จะเกิด alert CRITICAL พร้อมอีเมล (กฎ 90001)

```bash
set -a; . ./.env; set +a
KC="${KEYCLOAK_LOCAL_URL:-http://localhost:${KEYCLOAK_HOST_PORT:-8080}}"
T=$(curl -s -d grant_type=client_credentials -d client_id=log-ingestor \
      --data-urlencode client_secret="$LOGCHAIN_INGESTOR_SECRET" \
      "$KC/realms/logchain/protocol/openid-connect/token" | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
curl -s -m 10 -o /dev/null -w '%{http_code} %{time_total}s\n' -X POST http://localhost:3000/api/v1/logs \
  -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"source":"probe-kafka","eventType":"WEB_REQUEST","severity":"INFO","message":"kafka probe"}'
# ปกติ: 201 ภายใน < 1 วิ · ค้าง: 000 หลัง 10 วิ
```

**กู้ (ตามลำดับ)**

1. **แก้เวลาให้ถูกก่อน** — ถ้าเวลายังผิด restart ไปก็ไม่หาย
   local (sudo — รันในเทอร์มินัลเอง):
   ```bash
   sudo timedatectl set-ntp false
   sudo date -s "$(curl -sI https://www.google.com | grep -i '^date:' | cut -d' ' -f2- | tr -d '\r')"
   sudo timedatectl set-local-rtc 0
   sudo hwclock --systohc --utc          # เขียน UTC ลงนาฬิกาฮาร์ดแวร์ — ตรวจด้วย cat /sys/class/rtc/rtc0/time ต้องเท่ากับ date -u
   sudo timedatectl set-ntp true
   ```
   cloud: แจ้งเพื่อนให้ตรวจ NTP ของ Proxmox host
2. restart Kafka ทั้ง 3 ตัวพร้อมกัน แล้วรอให้ healthy ครบ:
   `HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose restart kafka-1 kafka-2 kafka-3`
3. ตรวจ `--under-replicated-partitions` ต้องไม่มีผลลัพธ์
4. restart ตัวที่เชื่อม Kafka **หลัง** Kafka เสมอ:
   `HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose restart backend detection-consumer`
   (ช่วงที่ Kafka ปิด backend จะ log `ECONNREFUSED` / `No broker available` — ปกติ)
5. ตรวจ end-to-end ด้านบนต้องได้ 201 ภายใน < 1 วิ
6. ถ้ามี user ถูกล็อก (เกิดจาก TOTP ไม่ผ่าน) → admin console `https://localhost:8443` (cloud: `logchain-auth`) → realm `logchain` → Users → ปิด Temporarily locked
7. `./scripts/demo-preflight.sh` ต้องจบด้วย `🎉 พร้อม demo`

ข้อความที่**ไม่ต้องตกใจ**หลัง restart: `The metadata log appears to be empty` ตอน kafka-1 เริ่ม (ขึ้นทุกครั้งที่ container start)
· ประมาณ 5 นาทีหลัง restart มี `Partition ... marked as failed` ใน kafka-3 = การย้าย leader กลับตามปกติ (ISR ยังครบ)
· log ที่ส่งตอน Kafka ค้างจะอยู่ใน DB และ chain แต่ detection ไม่เห็น — ต้องส่งใหม่ด้วย source ชื่อใหม่ถ้าต้องการ alert
