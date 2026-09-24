# สิ่งที่ต้องทำต่อ — LogChain

> อัปเดต 2026-09-24 (HEAD `735b792`) · สรุปงานที่ทำไปแล้ว: [`docs/summary-2026-09-17-to-09-24.md`](../summary-2026-09-17-to-09-24.md)
> คำสั่งที่ใช้บ่อย · ข้อ "ห้ามทำ" · ตารางกับดัก → [`next-steps.md`](next-steps.md) (อ่านก่อนลงมือทุกครั้ง)
> ผลทบทวน compliance + หลักฐาน → [`docs/compliance-review-2026-09-23.md`](../compliance-review-2026-09-23.md)

---

## ลำดับที่แนะนำ

| # | งาน | ใครทำ | ขนาด |
|---|---|---|---|
| 1 ✅ | 6.8 erasure → pseudonymize (หัวข้อ 1) | เสร็จ 2026-09-24 | — |
| 2 ✅ | เก็บ password ของ backup ให้ปลอดภัย (หัวข้อ 2) | เสร็จ 2026-09-24 | — |
| 3 | งานเล็กที่เหลือจากการทบทวน (หัวข้อ 3) | Claude | เล็ก |
| 4 | 6.6 HTTPS (หัวข้อ 4) | Claude | ใหญ่ |
| 5 | 6.7 encryption at rest (หัวข้อ 5) | เจ้าของ (ระดับเครื่อง) | ใหญ่ |
| 6 | งานตามรอบเวลา (หัวข้อ 6) | เจ้าของ | ตามกำหนด |

---

## 1. ✅ 6.8 — PDPA erasure → pseudonymize (เสร็จ 2026-09-24)

เจ้าของเลือกทาง B · รายละเอียด worklog 2026-09-24 หัวข้อ 1 · PCI E06 / E05 · ISO R05 · review B10 อัปเดตแล้ว
เจอเพิ่มระหว่างทำ: retention ลบ `audit_access` ที่ 90 วัน (ไม่ใช่ 365 ตามเอกสาร) → บังคับขั้นต่ำ 365 แล้ว

---

## 2. ✅ password ของ backup อยู่นอกเครื่องแล้ว (2026-09-24)

password ของ rclone crypt 2 ตัวอยู่ใน password manager ของเจ้าของ · **ทดสอบแล้ว**: พิมพ์ค่าจาก password manager ใส่ crypt remote
ชั่วคราว → `rclone lsf` เห็นชื่อโฟลเดอร์จริง (`20260923T151851Z/` …)
- ลืมจด/หายจาก password manager แต่เครื่องยังอยู่: `rclone.conf` เก็บแบบ obscure ถอดได้ด้วย `rclone reveal` (worklog 2026-09-24 หัวข้อ 3)
- ควรเก็บเพิ่ม (ยังไม่บังคับ): `.env` (seed Vault ตอนย้ายเครื่อง) · `infra/vault/.secrets/init.env` (unseal key — หาย = เปิด Vault เดิมไม่ได้)

---

## 3. งานเล็กที่เหลือจากการทบทวน

| งาน | ทำไม | ที่มา |
|---|---|---|
| ✅ dashboard ใช้ `next/font/local` แทน Google Fonts | เสร็จ 2026-09-24 — ฟอนต์อยู่ `cylis-dashboard/src/app/fonts/` · build ผ่านใน container `--network none` | worklog 2026-09-24 หัวข้อ 4 |
| ✅ `/metrics` ของ backend เปิดสาธารณะ | เสร็จ 2026-09-24 — ย้ายไป `:9464` ไม่ publish · detection-api `:8000/metrics` ยังเปิด (สถิติ HTTP ความเสี่ยงต่ำ) | worklog 2026-09-24 หัวข้อ 5 |
| ✅ pip-audit ครอบ dependency ทางอ้อม | เสร็จ 2026-09-24 — `detection/requirements.lock` (48 ตัว) · Dockerfile ลงตาม lock + build พังถ้าไม่ตรง · สร้างใหม่ `./scripts/detection-lock.sh` | worklog 2026-09-24 หัวข้อ 6 |
| ✅ client key ของ Kafka เป็น 0644 | เสร็จ 2026-09-24 — key 0640 + `group_add` · `ca.key` 0600 ไม่ mount เข้า container ไหน · แต่ละ service เห็นแค่ key ตัวเอง | worklog 2026-09-24 หัวข้อ 7 |
| ✅ Kafka PLAINTEXT `:9092` ใน docker network | เสร็จ 2026-09-24 — inter-broker + controller + kafka-init + exporter เป็น mTLS · เหลือ EXTERNAL `:29092` จาก host (localhost) | worklog 2026-09-24 หัวข้อ 9 |
| ✅ anti-malware (PCI 5.1) | เสร็จ 2026-09-24 — ClamAV สแกน repo ใน Security Scan (block) + runtime เป็นความเสี่ยงที่ยอมรับ (PCI E10 · ISO R09) · 5.1 N/A → PARTIAL | worklog 2026-09-24 หัวข้อ 8 |

---

## 4. 6.6 — HTTPS หน้า backend / dashboard / Keycloak

PCI 4.1 ยัง PARTIAL เพราะข้อนี้ข้อเดียว · ตอนนี้ทุก port เปิดแค่ localhost ความจำเป็นลดลง — **คุ้มเมื่อจะเปิดให้เครื่องอื่นใช้**

ต้องแตะ:
- reverse proxy (Caddy / Traefik) + cert (CA ภายในแบบเดียวกับ Kafka หรือ mkcert)
- `KEYCLOAK_URL` = issuer ใน token (**ห้าม**เปลี่ยนเป็นชื่อ service — ดู next-steps "ห้ามทำ") → ต้องเป็น `https://localhost:…`
- `NEXT_PUBLIC_*` inline ตอน build → rebuild dashboard · CORS `ALLOWED_ORIGINS` · redirect URI ของ realm Keycloak
- smoke test clone ใหม่ + e2e + login จริง (ต้องใช้ OTP ของเจ้าของ)

---

## 5. 6.7 — encryption at rest

PCI 3.1 ยัง PARTIAL · Postgres ไม่มี TDE → ทำที่ระดับดิสก์ (LUKS) หรือ volume ที่เข้ารหัส — **เป็นเรื่องของเครื่อง ไม่ใช่โปรเจกต์**
ถ้าไม่ทำ: เขียนเป็นความเสี่ยงที่ยอมรับใน ISO R03 (มีมาตรการชดเชย: PAN ถูก mask ก่อนเก็บ · port bind localhost · สำเนา backup เข้ารหัส)

---

## 6. งานตามรอบเวลา

| งาน | ครั้งถัดไป | อ้างอิง |
|---|---|---|
| rotate secret รอบ 90 วัน (Keycloak / DB / Grafana …) | **ภายใน 2026-12-16** (rotate ทั้งชุดล่าสุด 2026-09-17) | `docs/Key-Rotation-Policy.md` |
| rotate Gmail app password (180 วัน) — แก้ 2 ที่: Alertmanager + `.env` `MAIL_PASS` | ภายใน 2027-03-22 | Key-Rotation §3 SMTP |
| ทดสอบกู้คืนจาก backup (ในเครื่อง + จาก Google Drive) | ทุกไตรมาส — ครั้งถัดไป ~2026-12 | `docs/RTO-RPO-Compliance-Signoff.md` §3.1–3.2 |
| ตรวจกล่อง email ว่ายังได้ alert (ทดสอบ: หยุด `node-exporter` > 2 นาที) | ทุกเดือน | worklog หัวข้อ 27 |
| เซ็นเอกสาร sign-off (ช่องลายเซ็นยังว่างทุกไฟล์) | ก่อนส่งงาน | RTO-RPO §5 · Chain-of-Custody · PCI Attestation |

---

## ที่ตัดสินใจไม่ทำแล้ว (อย่าหยิบกลับมาโดยไม่อ่านเหตุผล)

- detection จำ id ข้าม restart — ทำให้ rule นับขาด (next-steps "ห้ามทำ")
- เปลี่ยน `INTEGRITY_AUTO_REANCHOR` เป็น true เป็นค่าเริ่มต้น — เจ้าของเลือกคง false (`.env.example` มีเหตุผล)
- `vault-unseal` / `vault-init` เป็น non-root — ต้อง chown ไฟล์ secret ตอน clone ใหม่ (worklog หัวข้อ 36)
- ลบ batch `FAILED` 2 ใบของ 2026-09-22 — เป็นประวัติ ไม่กระทบตัวเลข integrity
