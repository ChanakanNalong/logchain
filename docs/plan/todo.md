# สิ่งที่ต้องทำต่อ — LogChain

> อัปเดต 2026-09-25 (HEAD `f798173` — ข้อ 1–5 ปิดครบ ดู worklog 2026-09-25) · สรุปงานที่ทำไปแล้ว: [`docs/summary-2026-09-17-to-09-24.md`](../summary-2026-09-17-to-09-24.md)
> คำสั่งที่ใช้บ่อย · ข้อ "ห้ามทำ" · ตารางกับดัก → [`next-steps.md`](next-steps.md) (อ่านก่อนลงมือทุกครั้ง)
> ผลทบทวน compliance + หลักฐาน → [`docs/compliance-review-2026-09-23.md`](../compliance-review-2026-09-23.md)

---

## ลำดับที่แนะนำ

| # | งาน | ใครทำ | ขนาด |
|---|---|---|---|
| 1 ✅ | 6.8 erasure → pseudonymize (หัวข้อ 1) | เสร็จ 2026-09-24 | — |
| 2 ✅ | เก็บ password ของ backup ให้ปลอดภัย (หัวข้อ 2) | เสร็จ 2026-09-24 | — |
| 3 | งานเล็กที่เหลือจากการทบทวน (หัวข้อ 3) | Claude | เล็ก |
| 4 ✅ | 6.6 HTTPS (หัวข้อ 4) | เสร็จ 2026-09-24 | — |
| 5 ✅ | 6.7 encryption at rest (หัวข้อ 5) | เสร็จ 2026-09-25 · เหลือเก็บตก 2 ข้อของเจ้าของ | — |
| 6 | งานตามรอบเวลา (หัวข้อ 6) | เจ้าของ | ตามกำหนด |
| 7 | เอกสาร sign-off — Claude เตรียมแล้ว 2026-09-25 เหลือลงนาม (หัวข้อ 7) | เจ้าของ + ทีม | เล็ก |

---

## 1. ✅ 6.8 — PDPA erasure → pseudonymize (เสร็จ 2026-09-24)

เจ้าของเลือกทาง B · รายละเอียด worklog 2026-09-24 หัวข้อ 1 · PCI E06 / E05 · ISO R05 · review B10 อัปเดตแล้ว
เจอเพิ่มระหว่างทำ: retention ลบ `audit_access` ที่ 90 วัน (ไม่ใช่ 365 ตามเอกสาร) → บังคับขั้นต่ำ 365 แล้ว

---

## 2. ✅ password ของ backup อยู่นอกเครื่องแล้ว (2026-09-24)

password ของ rclone crypt 2 ตัวอยู่ใน password manager ของเจ้าของ · **ทดสอบแล้ว**: พิมพ์ค่าจาก password manager ใส่ crypt remote
ชั่วคราว → `rclone lsf` เห็นชื่อโฟลเดอร์จริง (`20260923T151851Z/` …)
- ลืมจด/หายจาก password manager แต่เครื่องยังอยู่: `rclone.conf` เก็บแบบ obscure ถอดได้ด้วย `rclone reveal` (worklog 2026-09-24 หัวข้อ 3)
- ✅ เก็บเพิ่มแล้ว (2026-09-24): `.env` + `infra/vault/.secrets/init.env` เป็น Secure Note ใน password manager ของเจ้าของ
  · **อัปเดต note ของ `.env` ทุกครั้งที่ rotate secret** (ครั้งถัดไปภายใน 2026-12-16) · `init.env` เปลี่ยนเฉพาะตอน init Vault ใหม่

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

## 4. ✅ 6.6 — HTTPS (เสร็จ 2026-09-24 · worklog หัวข้อ 11)

Caddy (`https-proxy`) หน้า Keycloak `:8443` / backend `:3443` / dashboard `:3453` · HTTP เดิม bind 127.0.0.1 เสมอ · PCI 4.1 → PASS
เจ้าของ trust CA (`./scripts/trust-web-ca.sh`) + login `admin-user` + OTP ที่ https://localhost:3453 ผ่านแล้ว (2026-09-24)
✅ smoke test clone ใหม่จาก GitHub (`ce1eacc`) ผ่านครบ 2026-09-25 — worklog 2026-09-25 หัวข้อ 3 · เจอ + แก้ `sync-keycloak-urls.sh` ล้มหลัง harden

---

## 5. ✅ 6.7 — encryption at rest (เสร็จ 2026-09-25 · worklog 2026-09-25)

รัน runbook ครบขั้น 0–8 · reboot → ปลดล็อก + stack ขึ้นเองครบ · `check-encryption-at-rest.sh` **ผ่าน** · PCI 3.1 → PASS (E12) · ISO R03 · review B1 ✅

**เก็บตก (เจ้าของ · ต้อง sudo):**
- [x] ลบ `/var/lib/docker.old` (volume เดิม **ไม่เข้ารหัส**) — ทำแล้ว 2026-09-25 · rollback ไม่ได้แล้ว
- [x] ปิด swap — ทำแล้ว 2026-09-25 · script ✅ ครบ 4 ข้อ
- [ ] (ไม่บังคับ) ลบไฟล์ `/swapfile` 8 GB ที่ปิดใช้แล้ว: `sudo rm /swapfile && sudo fstrim -v /`
- [ ] (ไม่บังคับ) ยืนยัน slot TPM: `sudo cryptsetup luksDump /var/lib/lcsecure.img` ต้องเห็น token `systemd-tpm2`

<details><summary>แผนเดิม (2026-09-24)</summary>


**ทำตาม `docs/runbooks/encryption-at-rest.md`** — ไฟล์ LUKS2 150 GB → `/srv/lcsecure` · ย้าย Docker data-root + repo (symlink ที่เดิม) ·
ปลดล็อกตอน boot ด้วย TPM2 + PIN (Secure Boot ปิด → TPM อย่างเดียวไม่พอ) · recovery passphrase ใน password manager
- ต้องใช้ sudo · stack ล่ม ~30–45 นาที · ต้องทดสอบ reboot (ขั้น 8)
- เสร็จแล้ว `./scripts/check-encryption-at-rest.sh` ต้อง "ผ่าน" → บอก Claude ให้เปลี่ยน PCI 3.1 เป็น PASS + ISO R03
- ก่อนทำ script ตรวจ: ❌ data-root · ❌ repo · ❌ backups · ⚠️ swap → หลังทำ: ✅ ✅ ✅ ✅

</details>

---

## 5.1 🔴 MFA ของ `kc-admin` (master realm) ไม่ได้บังคับ — เจอ 2026-09-25

`kc-admin` มีแค่ password ไม่มี OTP · requiredActions ว่าง (worklog 2026-09-25 หัวข้อ 3) · PCI 8.4
- [ ] เจ้าของ: `./scripts/harden-master-admin.sh` → login `https://localhost:8443/admin` ด้วย `kc-admin` → สแกน QR ตั้ง TOTP
- [ ] ยืนยัน: credential ของ `kc-admin` มี `otp` (Claude ตรวจให้ได้)

---

## 6. งานตามรอบเวลา

| งาน | ครั้งถัดไป | อ้างอิง |
|---|---|---|
| rotate secret รอบ 90 วัน (Keycloak / DB / Grafana …) — เสร็จแล้วอัปเดต note `.env` ใน password manager ด้วย | **ภายใน 2026-12-16** (rotate ทั้งชุดล่าสุด 2026-09-17) | `docs/Key-Rotation-Policy.md` |
| rotate Gmail app password (180 วัน) — แก้ 2 ที่: Alertmanager + `.env` `MAIL_PASS` | ภายใน 2027-03-22 | Key-Rotation §3 SMTP |
| ทดสอบกู้คืนจาก backup (ในเครื่อง + จาก Google Drive) | ทุกไตรมาส — ครั้งถัดไป ~2026-12 | `docs/RTO-RPO-Compliance-Signoff.md` §3.1–3.2 |
| ตรวจกล่อง email ว่ายังได้ alert (ทดสอบ: หยุด `node-exporter` > 2 นาที) | ทุกเดือน | worklog หัวข้อ 27 |
| เซ็นเอกสาร sign-off — ดูหัวข้อ 7 | ก่อนส่งงาน | RTO-RPO §5 · Chain-of-Custody · PCI Attestation |

---

## 7. เอกสาร sign-off (Claude เตรียมแล้ว 2026-09-25 — เหลือคนลงนาม)

ที่ Claude ทำแล้ว (ข้อเท็จจริงที่ตรวจได้เท่านั้น ไม่ใส่ชื่อ / ลายเซ็นแทนใคร):
- PCI Attestation: ข้อยกเว้นเป็นตาราง (5.1 PARTIAL · 9.1 N/A · **MFA kc-admin เปิดอยู่**) · Date เปลี่ยนเป็นช่องวันที่ลงนาม (เดิมค้าง 2026-06-04)
- RTO-RPO §4: แถวใหม่ backup / offsite / mTLS / HTTPS / encryption at rest / MFA — ช่อง Verified By ว่างให้คนตรวจ
- Chain-of-Custody แถว 7: แก้ "ลบ" → **pseudonymize** (ของเดิมผิดตั้งแต่ 6.8)
- Key-Rotation: แถว (initial) = 2026-07-15 · Chanakan (commit `9d6c229`)

ที่ต้องเป็นคนทำ:
- [ ] แก้ MFA `kc-admin` (ข้อ 5.1) **ก่อนเซ็น** แล้วลบแถว MFA ออกจาก PCI Attestation + RTO-RPO §4 (หรือบอก Claude)
- [ ] RTO-RPO §4: ใส่ชื่อคนตรวจในแถวใหม่ 6 แถว
- [ ] Chain-of-Custody T001–T003: Date + Authorized By
- [ ] ชื่อ Person 3 + Supervisor · ลายเซ็น + วันที่: PCI Attestation · RTO-RPO §5 · Chain-of-Custody Signatures

---

## ที่ตัดสินใจไม่ทำแล้ว (อย่าหยิบกลับมาโดยไม่อ่านเหตุผล)

- detection จำ id ข้าม restart — ทำให้ rule นับขาด (next-steps "ห้ามทำ")
- เปลี่ยน `INTEGRITY_AUTO_REANCHOR` เป็น true เป็นค่าเริ่มต้น — เจ้าของเลือกคง false (`.env.example` มีเหตุผล)
- `vault-unseal` / `vault-init` เป็น non-root — ต้อง chown ไฟล์ secret ตอน clone ใหม่ (worklog หัวข้อ 36)
- ลบ batch `FAILED` 2 ใบของ 2026-09-22 — เป็นประวัติ ไม่กระทบตัวเลข integrity
