# สิ่งที่ต้องทำต่อ — LogChain

> อัปเดต 2026-10-04 (HEAD `0a257d7` · cloud `5bfc97b` — เพิ่มข้อ 14 สไลด์/โปสเตอร์/เล่ม · ข้อ 15 บัญชี/รหัส · worklog 2026-10-03) · ก่อนหน้า 2026-10-02 · สรุปงานที่ทำไปแล้ว: [`docs/summary-2026-09-17-to-09-25.md`](../summary-2026-09-17-to-09-25.md)
> คำสั่งที่ใช้บ่อย · ข้อ "ห้ามทำ" · ตารางกับดัก → [`next-steps.md`](next-steps.md) (อ่านก่อนลงมือทุกครั้ง)
> ผลทบทวน compliance + หลักฐาน → [`docs/compliance-review-2026-09-23.md`](../compliance-review-2026-09-23.md)

---

## ลำดับที่แนะนำ

| # | งาน | ใครทำ | ขนาด |
|---|---|---|---|
| 1 ✅ | 6.8 erasure → pseudonymize (หัวข้อ 1) | เสร็จ 2026-09-24 | — |
| 2 ✅ | เก็บ password ของ backup ให้ปลอดภัย (หัวข้อ 2) | เสร็จ 2026-09-24 | — |
| 3 ✅ | งานเล็กที่เหลือจากการทบทวน (หัวข้อ 3) | เสร็จ 2026-09-24 | — |
| 4 ✅ | 6.6 HTTPS (หัวข้อ 4) | เสร็จ 2026-09-24 | — |
| 5 ✅ | 6.7 encryption at rest (หัวข้อ 5) | เสร็จ 2026-09-25 · เก็บตกครบแล้ว | — |
| 6 | งานตามรอบเวลา (หัวข้อ 6) | เจ้าของ | ตามกำหนด |
| 7 | เอกสาร sign-off — Claude เตรียมแล้ว 2026-09-25 เหลือลงนาม (หัวข้อ 7) | เจ้าของ + ทีม | เล็ก |
| 8 ✅ | commit detection ที่ระบบรันอยู่แล้ว (หัวข้อ 8) | เสร็จ 2026-09-28 (`979aa3d`) | — |
| 9 ✅ | ตัวเลข log key / F1 สำหรับรายงาน (หัวข้อ 9) — อยู่ในเล่มแล้ว (4.6.3 · 4.14) | เสร็จ 2026-10-02 | — |
| 10 | clone ทดสอบ: CA ชื่อใหม่ · ลบ volume smoke · (อาจารย์ตอบแล้ว: blockchain ใส่แค่ขั้นตอน ✅) (หัวข้อ 10) | เจ้าของ | เล็ก |
| 11 | ทดสอบ `trust-web-ca.sh` บน macOS / Windows (หัวข้อ 11) | คนที่มีเครื่อง | เล็ก |
| 12 | กรณีทดสอบ/เล่ม (หัวข้อ 12) — ฝั่ง Claude ปิดครบ · เหลือเจ้าของเปิดเล่มรอบ 7 ใน MS Word | เจ้าของ | เล็ก |
| 13 ✅ | deploy ขึ้นอินเทอร์เน็ต https://logchain.nareubad.work (NB-Lab · Cloudflare Tunnel) | เสร็จ 2026-10-02 · `docs/runbooks/deploy-cloud.md` | — |
| 14 | **สไลด์ 8 จุด · โปสเตอร์ 5 จุด · เล่มรอบ 7 (OS + ข้อจำกัด IF)** (หัวข้อ 14) — ถามคณะก่อนว่าส่งเล่มล่วงหน้ากี่วัน | เจ้าของ (Claude แชทร่างข้อความ) | กลาง |
| 15 | บัญชีสาธิตบน cloud · รหัส `admin-user` (หัวข้อ 15) | เจ้าของ | เล็ก |

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
- [x] ลบไฟล์ `/swapfile` 8 GB + `fstrim` (2026-09-25 · trim 21.6 GiB)
- [x] ยืนยัน slot TPM (2026-09-25): keyslot 0 passphrase + keyslot 1 token `systemd-tpm2` · PCR 7 · `tpm2-pin: true`

<details><summary>แผนเดิม (2026-09-24)</summary>


**ทำตาม `docs/runbooks/encryption-at-rest.md`** — ไฟล์ LUKS2 150 GB → `/srv/lcsecure` · ย้าย Docker data-root + repo (symlink ที่เดิม) ·
ปลดล็อกตอน boot ด้วย TPM2 + PIN (Secure Boot ปิด → TPM อย่างเดียวไม่พอ) · recovery passphrase ใน password manager
- ต้องใช้ sudo · stack ล่ม ~30–45 นาที · ต้องทดสอบ reboot (ขั้น 8)
- เสร็จแล้ว `./scripts/check-encryption-at-rest.sh` ต้อง "ผ่าน" → บอก Claude ให้เปลี่ยน PCI 3.1 เป็น PASS + ISO R03
- ก่อนทำ script ตรวจ: ❌ data-root · ❌ repo · ❌ backups · ⚠️ swap → หลังทำ: ✅ ✅ ✅ ✅

</details>

---

## 5.1 ✅ MFA ของ `kc-admin` (master realm) — เจอ + แก้ 2026-09-25

`kc-admin` มีแค่ password ไม่มี OTP · requiredActions ว่าง (worklog 2026-09-25 หัวข้อ 3) · PCI 8.4
- [x] เจ้าของ: `./scripts/harden-master-admin.sh` → login `https://localhost:8443/admin` ด้วย `kc-admin` → สแกน QR ตั้ง TOTP
- [x] ยืนยัน: credential `otp` สร้าง 2026-09-25 15:25 UTC · login รหัสอย่างเดียว = `invalid_grant`

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
- [x] แก้ MFA `kc-admin` (ข้อ 5.1) — ลบแถวจาก PCI Attestation · RTO-RPO §4 เป็น DONE แล้ว
- [ ] RTO-RPO §4: ใส่ชื่อคนตรวจในแถวใหม่ 6 แถว
- [ ] Chain-of-Custody T001–T003: Date + Authorized By
- [ ] ชื่อ Person 3 + Supervisor · ลายเซ็น + วันที่: PCI Attestation · RTO-RPO §5 · Chain-of-Custody Signatures

---

## 8. ✅ commit detection ที่ระบบรันอยู่แล้ว (2026-09-28)

image detection บนเครื่อง rebuild แล้ว + ทดสอบบนระบบจริงผ่าน (worklog 2026-09-28 หัวข้อ 9) · ตรงกับ git แล้ว:
- [x] `979aa3d` — `detection/app/consumer.py` · `detection/app/log_keys.py` · `detection/tests/test_log_keys.py` — ข้าม ML เมื่อ key 0 +
  `mask()` รับรูปที่ backend PII-mask แล้ว (ไม่งั้น ~66% ของ log HDFS ถูกข้าม ML) · คำสั่ง commit ท้าย worklog
- [x] worklog `cef8e76` · [x] `docs/plan/next-steps.md` + ไฟล์นี้

---

## 9. ตัวเลขสำหรับรายงาน (DeepLog)

- log key **45** (โค้ดปัจจุบัน) เทียบ Loghub **29** (`HDFS_v1.zip` preprocessed — สำเนา `~/Documents/logchain-data/HDFS.log_templates.csv`)
  · ไฟล์บน GitHub ของ Loghub มี 30 (E30 ไม่มีใน trace) · 45 = 29 + 17 (Drain แยก exception) − 1 (E8 + E11 รวม)
- [x] train 5 seed (2026-09-28 · worklog หัวข้อ 10) — F1 ที่ g=8: 45 key **0.7252 ± 0.0181** (P 0.9705 · R 0.5791) · 47 key 0.7185 ± 0.0201
  · **ไม่ต่างกันอย่างมีนัยสำคัญ** (Welch p ≈ 0.6) · 0.7339 vs 0.7138 เดิม (seed 42 รอบเดียว) เป็นความแกว่งของ seed
  · ผล + script: `~/Documents/logchain-data/multiseed/`
- [x] ตรวจ block สั้น (worklog หัวข้อ 11) — test abnormal 6,191 block (36.8%) สั้นกว่า 11 key · normal ไม่มีเลย ·
  `detect.py` นับเป็น anomaly โดยไม่ผ่านโมเดล → **F1 0.7252 รวมกฎความยาวไว้** · เฉพาะโมเดล (ตัด block สั้นออก)
  **0.4900 ± 0.0397** (P 0.9230 · R 0.3344) · ตอนรันจริง consumer ไม่มีกฎนี้ = ใกล้ 0.49
- [x] ลอง embedding (worklog หัวข้อ 13) — **ไม่ช่วย** · แต่เจอว่า **g=8 ไม่ใช่ค่าที่ดีสุด** (`detect.py` ลองแค่ 8–10)
  · เลือก g จาก validation 20% (ได้ g=4 เกือบทุก seed) รายงานบน 80%: model-only F1 **0.7746 ± 0.0575** · with-short **0.8587 ± 0.0328**
  · แลกกับ FP 0.50% ของ block ปกติ (g=8 = 0.07%) · 45 vs 47 key ยังไม่ต่าง
- [x] `TOP_K_G` ของระบบจริง — **คง 8** (2026-09-28 · ดูหมวด "ตัดสินใจไม่ทำแล้ว")

## 12. กรณีทดสอบในเล่มที่ "รอผล" (2026-09-29 · worklog 2026-09-29)

- [x] 21 กรณี: ผ่าน 18 · FT-14 ผ่านบางส่วน (ค้นได้ 100 log ล่าสุด) · DR-09/10 เอาออก (Isolation Forest ไม่มีในโค้ด) · กรอกลงเล่มแล้ว
- [x] บั๊ก IM-12 (seal พร้อมกัน → batch ผี) แก้แล้ว — commit `9d96376`
- [x] rate limit — เปิดแล้ว global `ThrottlerGuard` `a33b455` (worklog 09-30 หัวข้อ 5) · ทดสอบผ่าน Cloudflare Tunnel 200×401 + 10×429 (worklog 10-01 หัวข้อ 4.7)
- [ ] ปิด batch ได้ 100 log/นาที (รับได้ ~280/วิ) — เขียนเป็นข้อจำกัดในเล่มแล้ว (4.18 · PT-07) · **ไม่แก้ในรอบนี้** แก้ถ้าจะใช้งานจริง
- [x] เติม POL — เติมแล้ว 09-30 · ยอด 2026-10-02: เครื่อง local `0x8cBC…4C55` **0.147** · cloud `0xA03e…1C59` **0.080** POL
- [x] Isolation Forest จำแนก batch — ทำครบ 5 สเตจ 2026-09-30 (`5cb1303` … `5caeffe`) · DR-09/10 กลับเข้าเล่มพร้อมผลจริง: [`isolation-forest-option.md`](isolation-forest-option.md)
- [ ] เขียนข้อจำกัด Isolation Forest ในเล่ม (4.18 / 5.6) — ดูหัวข้อ 14
- [x] (มีในเล่มตั้งแต่ก่อนรอบ 6 · ตรวจ 2026-10-02: 4.14 ย่อหน้า short-block / model-only / 45 vs 47 key) เขียนในรายงานว่าแก้ parse แล้ว **ประสิทธิภาพไม่ลดลง** — ห้ามเขียนว่าแม่นขึ้น · **ต้องรายงานทั้ง 0.725 และ 0.49** พร้อมเหตุผลเรื่อง block สั้น
- [x] ระบุในรายงานว่า DeepLog train ด้วย HDFS อย่างเดียว — log อื่นไป rule engine (`ml_skipped_unknown`) — **เล่มรอบ 7** (2026-10-02): 4.6.3 · 4.18 · ตาราง 5-9 · สคริปต์ `~/Documents/logchain-data/tools/edit_book7.py`

---

## 14. สไลด์ + โปสเตอร์ + เล่มรอบ 7 (ตรวจ 2026-10-03 · worklog 2026-10-03 หัวข้อ 2–3)

ไฟล์: `~/Documents/present-final/` · ตารางเต็ม + ข้อความสำหรับ Claude แชท: Claude Doc
https://claude.ai/code/artifact/03409103-1f33-4bc1-8b19-ca55a3e9b2e5

- [ ] ถามคณะว่าต้องส่งเล่มก่อนสอบกี่วัน (กำหนดเส้นตายของข้อนี้ทั้งหมด)
- [ ] ส่งข้อความ + ไฟล์ 4 ไฟล์ให้ Claude แชทร่างข้อความแก้ (สไลด์ · โปสเตอร์ · ภาพหน้าจอ 2 ภาพ)
- [ ] **สไลด์ `CPE66-027.pdf` 8 จุด:** หน้า 2 "ระแบบ" → "ระบบ" · หน้า 4 คำบรรยายใต้ภาพ (detection ใน container · ข้อความตัด "PyTorc") ·
      หน้า 4 **แผนภาพ** (HOST WSL2 → Linux Mint 22.3 · "not containerized") · หน้า 7 "Triggerp" · หน้า 7 mTLS "ผ่าน Kafka" ·
      หน้า 10 → 31 ชุด 416 กรณี (unit 26 ชุด 385 + integration 5 ชุด 31 · วัด 2026-10-04) · หน้า 12 เพิ่มผล IF (P 0.8400 · R 1.0 · F1 0.9130 · FP 2.22% · ข้อมูลจำลอง) · หน้า 15 ข้อจำกัด IF
- [ ] **โปสเตอร์ `LogChain_Poster_A1.png` 5 จุด:** P 0.9705 · F1 0.7252 · R 0.5791 · ภาพ ③ แทนด้วย `ml-detection-2026-10-03.jpg`
      (+ `ml-detection-isoforest-2026-10-03.jpg` ถ้ามีที่) · Contact "[อีเมล]" · เติม IF เป็น "9 กฎ + DeepLog + Isolation Forest" (**ไม่ใช่ "11 ประเภท"**)
- [ ] **เล่มรอบ 7 (ใหม่):** 4.1.1 OS → Linux Mint 22.3 (kernel 6.8) บนเครื่องจริง (เดิม Ubuntu 22.04 บน WSL2 ผิด · CPU/RAM ตรงแล้ว) ·
      ลบ "detection นอก container" · ข้อจำกัด IF ใน 4.18 / 5.6 (ฝึกด้วย ~154 log/วินาที → ไวต่ออัตรา log · FP 2.22% เฉพาะเงื่อนไขควบคุม) ·
      4.15 เทสต์อัตโนมัติ 266 → **416** (unit 23 ชุด 235 → 26 ชุด 385 · integration 5 ชุด 31 เท่าเดิม) — เพิ่มจาก IF stage 2 · ThrottlerGuard · RBAC matrix 135 กรณี (`it.each`)
- [ ] **เล่มรอบ 7 (เดิม · MS Word):** ภาพ 3.9.6/4.6.6 · DR-09/10 · ตาราง 4-2 / 5-9 · update field · ภาพ 4-4 · ลบไฮไลต์เหลือง 6 + แดง 1 → export PDF
- [x] ข้อความเหตุผลของ IF อ้างช่วงค่าตอนฝึก (`f79156b`) · หน้า ML Detection แสดงการ์ด IF (`5bfc97b`) · cloud อัปเดตแล้ว
- [x] contract: ไม่ต้องแก้ — เล่มรอบ 6 ระบุทั้ง 2 สัญญาแล้ว · Block 47894150 / 78,144 gas มาจากสัญญาเครื่องทดลอง

---

## 15. บัญชี + รหัส (เจ้าของ)

- [ ] บัญชีสาธิตบน cloud (analyst/operator/auditor/ingestor-user) — รหัสเดาได้ + ไม่มี OTP → หลังอัดคลิป: รหัสสุ่ม หรือ Disable
- [ ] เปลี่ยนรหัส `admin-user` (local + cloud) → แก้ `.env` → อัปเดต Secure Note `.env` (+ รหัส user ทดสอบ 4 บรรทัดจาก `seed-test-users.sh`)

---

## 10. clone ทดสอบ `~/clone_logchain/logchain` (project `logchain-smoke`)

- [x] ถามอาจารย์เรื่อง blockchain ของชุดที่ติดตั้งใหม่ — ตอบ **ใส่แค่ขั้นตอน** → README หัวข้อ "ตั้ง blockchain เอง" (worklog 09-28 หัวข้อ 12)
  · ✅ ขั้น 3–4 (deploy) ใช้ได้จริง — ทดสอบในโฟลเดอร์ชุดจริงโดยบังเอิญ ได้ `0xC149…` · คืน `CONTRACT_ADDRESS` เป็น `0x5dC86975…` แล้ว
  · [ ] (ถ้าสะดวก) ขั้น 5–6 บน clone ด้วย wallet ทดสอบใหม่ — ยังไม่ได้ทดสอบ
- [x] เติม POL ให้ wallet `0x8cBCfC045Aa4058816D24Af7C0BEf88515B34C55` (2026-09-28 · faucet +0.1) — ยอด **0.1192 POL** ≈ 30–50 batch
  · ครั้งหน้าเติมที่ https://faucet.polygon.technology (Amoy) · **ห้ามเติม `0xfb10EfD7…0695`** (wallet เดิม key หลุด 09-17)
- [ ] ถ้าจะ trust ทั้งสองชุดพร้อมกัน: สร้าง CA ของ clone ใหม่ให้ได้ชื่อ `LogChain-Web-CA (logchain-smoke)` (คำสั่งใน next-steps 7.3)
- [ ] เลิกใช้แล้ว: `docker compose -p logchain-smoke down -v` (volume `logchain-smoke_*` 9 ตัว — ไม่โดน `logchain_*`)

---

## 11. `trust-web-ca.sh` บน macOS / Windows

- [ ] ทดสอบหลังเปลี่ยนชื่อ CA (`2afc52e`) · ระวัง: รันกับ CA **ชื่อเก่า** จะลบ CA ของ clone อื่นด้วย (ค้นชื่อแบบ substring)

---

## ที่ตัดสินใจไม่ทำแล้ว (อย่าหยิบกลับมาโดยไม่อ่านเหตุผล)

- detection จำ id ข้าม restart — ทำให้ rule นับขาด (next-steps "ห้ามทำ")
- เปลี่ยน `INTEGRITY_AUTO_REANCHOR` เป็น true เป็นค่าเริ่มต้น — เจ้าของเลือกคง false (`.env.example` มีเหตุผล)
- `vault-unseal` / `vault-init` เป็น non-root — ต้อง chown ไฟล์ secret ตอน clone ใหม่ (worklog หัวข้อ 36)
- ลบ batch `FAILED` 2 ใบของ 2026-09-22 — เป็นประวัติ ไม่กระทบตัวเลข integrity
- ให้ detection-consumer สร้าง/เรียน Drain เองตอนรัน — id ไม่ตรงกับตอน train (next-steps "ห้ามทำ")
- ถอด `container_name` ให้ชุดจริงกับ clone รันพร้อมกัน — ชั่งแล้วไม่คุ้ม (next-steps "ห้ามทำ")
- retrain Isolation Forest ก่อนสอบ — ตัวเลขเล่ม/สไลด์/โปสเตอร์ต้องแก้ทั้งหมด · เขียนเป็นข้อจำกัด + ไม่โชว์ IF ใน demo สดแทน (2026-10-03)
- ย้ายตัวเลข blockchain ในเล่มไปอ้าง contract cloud — ต้องวัดใหม่ทั้งหมด · เล่มรอบ 6 ระบุ 2 สัญญาแล้ว (2026-10-03)
- เปลี่ยน `TOP_K_G` ของระบบจริงเป็น 4 — F1 ดีกว่า (0.77 vs 0.49 เฉพาะโมเดล) แต่ FP ~7 เท่า · เจ้าของเลือก FP ต่ำ (worklog 2026-09-28 หัวข้อ 13)
