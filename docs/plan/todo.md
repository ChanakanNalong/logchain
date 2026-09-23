# สิ่งที่ต้องทำต่อ — LogChain

> อัปเดต 2026-09-24 (HEAD `735b792`) · สรุปงานที่ทำไปแล้ว: [`docs/summary-2026-09-17-to-09-24.md`](../summary-2026-09-17-to-09-24.md)
> คำสั่งที่ใช้บ่อย · ข้อ "ห้ามทำ" · ตารางกับดัก → [`next-steps.md`](next-steps.md) (อ่านก่อนลงมือทุกครั้ง)
> ผลทบทวน compliance + หลักฐาน → [`docs/compliance-review-2026-09-23.md`](../compliance-review-2026-09-23.md)

---

## ลำดับที่แนะนำ

| # | งาน | ใครทำ | ขนาด |
|---|---|---|---|
| 1 | 6.8 erasure ขัด PCI 10.5.1 หรือไม่ (หัวข้อ 1) | **เจ้าของตัดสินใจ** → Claude ทำ | เล็ก–กลาง |
| 2 | เก็บ password ของ backup ให้ปลอดภัย (หัวข้อ 2) | เจ้าของ | 5 นาที |
| 3 | งานเล็กที่เหลือจากการทบทวน (หัวข้อ 3) | Claude | เล็ก |
| 4 | 6.6 HTTPS (หัวข้อ 4) | Claude | ใหญ่ |
| 5 | 6.7 encryption at rest (หัวข้อ 5) | เจ้าของ (ระดับเครื่อง) | ใหญ่ |
| 6 | งานตามรอบเวลา (หัวข้อ 6) | เจ้าของ | ตามกำหนด |

---

## 1. 6.8 — PDPA erasure ลบ `audit_access` ขัด PCI 10.5.1 หรือไม่

**ปัญหา:** `DELETE /api/v1/erasure/user/:userId` **ลบ** แถวใน `audit_access` ของ user · PCI DSS 10.5.1 ให้เก็บ audit trail
อย่างน้อย 12 เดือน · สองข้อนี้ขัดกัน (PDPA ให้ลบข้อมูลส่วนบุคคล / PCI ให้เก็บหลักฐานการเข้าถึง)

**ทางเลือก — ต้องให้เจ้าของเลือก**

| ทาง | ทำอะไร | ข้อดี | ข้อเสีย |
|---|---|---|---|
| A. คงเดิม | ลบจริง + tombstone (ตอนนี้) | ง่าย ไม่ต้องแก้ | audit trail ของ user นั้นหายก่อน 12 เดือน — ขัด PCI 10.5.1 |
| B. **pseudonymize** (แนะนำ) | แทน `user_id` / `username` / `ip_address` ด้วย hash (มี salt ลับ) แทนการลบ | เก็บ audit trail ครบ (ว่าเกิดอะไร เมื่อไร) แต่ระบุตัวคนไม่ได้ · ตอบทั้ง PDPA และ PCI | `audit_access` ต้องแก้ได้ (ตอนนี้ไม่มี trigger กันอยู่แล้ว) · ต้องเก็บ salt ใน Vault |
| C. ลบเฉพาะที่เกิน 12 เดือน | รับคำขอ แต่ลบจริงเมื่อครบ 12 เดือน · ระหว่างนั้นจำกัดการเข้าถึง | ตรง PCI ตามตัวอักษร | ซับซ้อน ต้องมีคิวรอลบ · PDPA มีข้อยกเว้นเรื่องหน้าที่ตามกฎหมาย ต้องอ้างให้ถูก |

ตัดสินแล้ว → แก้ `src/erasure/erasure.service.ts` + เทสต์ (unit + e2e ที่มีอยู่) + PCI E06 / ISO R05 / review B10

---

## 2. เก็บ password ของ backup ไว้นอกเครื่อง + ตรวจ

- **password ของ rclone crypt 2 ตัว** ต้องอยู่ใน password manager — เครื่องหาย + ไม่มีค่านี้ = สำเนาบน Google Drive ถอดไม่ได้
  (ถ้าไม่ได้จดตอนรัน `setup-offsite-backup.sh`: ก๊อปทั้งไฟล์ `infra/rclone/.secrets/rclone.conf` เข้า password manager แทน)
- ทดสอบว่าจดถูก (ไม่บังคับ): สร้าง crypt remote ใหม่ในเครื่องอื่นด้วย password ที่จด แล้ว `rclone lsf` ต้องเห็นชื่อจริง

---

## 3. งานเล็กที่เหลือจากการทบทวน

| งาน | ทำไม | ที่มา |
|---|---|---|
| dashboard ใช้ `next/font/local` แทน Google Fonts | build ดึงฟอนต์จากเน็ตทุกครั้ง — CI แดงชั่วคราวมาแล้ว 1 ครั้ง · bootstrap บนเครื่องไม่มีเน็ตจะพัง | worklog หัวข้อ 38 |
| `/metrics` ของ backend เปิดสาธารณะ | เปิดเผยจำนวน batch ตามสถานะ · ตอนนี้ bind localhost แล้วความเสี่ยงต่ำ · ถ้าจะเปิด LAN ต้องจำกัด | review B5 |
| pip-audit ครอบ dependency ทางอ้อม | CI ใช้ `--no-deps` ตรวจเฉพาะที่ pin · ทางเลือก: lock file (`pip-compile`) หรือ audit image แบบตัด torch ออก | review B7 |
| client key ของ Kafka เป็น 0644 | detection รันเป็น uid 10001 ต้องอ่านได้ · แก้ได้ด้วย group ร่วม หรือ copy + chown ตอน build | worklog หัวข้อ 35 |
| Kafka PLAINTEXT `:9092` ใน docker network | inter-broker / kafka-init / kafka-exporter ยังใช้ · ย้ายเป็น SSL ทั้งหมดได้ แต่ต้องทดสอบ broker ครบ | worklog หัวข้อ 35 |
| anti-malware (PCI 5.1 = N/A) | ไม่มี · ทางเลือก ClamAV scan ใน CI หรือระบุเป็นความเสี่ยงที่ยอมรับในเอกสาร | review B6 |

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
