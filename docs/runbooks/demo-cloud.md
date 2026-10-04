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
