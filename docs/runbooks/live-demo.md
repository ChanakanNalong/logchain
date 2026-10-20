# Runbook: live-demo.sh — สาธิตการแก้ไขข้อมูลสดบน cloud

สคริปต์ `scripts/live-demo.sh` ให้สาธิต "มีคนแก้ข้อมูลหลัง seal" บน LogChain สด ๆ แล้ว restore คืนได้ปลอดภัย
ใช้ตอนนำเสนอ (รันเองบน CT141 ในชื่อ user `logchain`)

## เตรียมตัว

```bash
ssh root@CT141            # แล้ว su - logchain   (หรือเข้ามาเป็น logchain โดยตรง)
cd ~/logchain
git pull                  # ให้มี scripts/live-demo.sh ล่าสุด
./scripts/live-demo.sh status
```

> สคริปต์ยิง `psql` ในคอนเทนเนอร์ `logchain-postgres` ผ่าน `docker exec` — ไม่เรียก API, ไม่ seal, ไม่เขียนเชน, ไม่แก้ `.env`

## คำสั่ง

| คำสั่ง | ทำอะไร |
|---|---|
| `./live-demo.sh status` | ตารางสถานะทุกเคส (batch · CONFIRMED/TAMPERED · ยิงค้างไหม) + Chain integrity % + จำนวน alert OPEN |
| `./live-demo.sh <case>` | ยิงเคส (`content` `rehash` `hash` `move` `snapshot` `dbroot`) |
| `./live-demo.sh restore <case>` | คืนค่าเคสนั้นจาก backup |
| `./live-demo.sh restore-all` | คืนทุกเคสที่ยังค้างอยู่ |

## 6 เคส (แต่ละเคสใช้ batch CONFIRMED คนละใบ เลือกไว้ล่วงหน้าในสคริปต์)

| เคส | ทำ | ช่องที่ควรแดงบนหน้า Check | status พลิกไหม |
|---|---|---|---|
| `content` | แก้ `message` อย่างเดียว | contentRoot · proof CONTENT_MODIFIED | TAMPERED ใน ≤1 นาที |
| `rehash` | แก้ `message` + `raw_hash` ให้ตรงกัน | storedHashRoot + contentRoot (เทียบ chain = MISMATCH) | TAMPERED ใน ≤1 นาที |
| `hash` | แก้คอลัมน์ `raw_hash` อย่างเดียว | storedHashRoot · proof HASH_MODIFIED (verify ยัง true) | TAMPERED ใน ≤1 นาที |
| `move` | ย้าย mapping ของ log ไป batch อื่น | ต้นทาง DELETED/MAPPING_MISSING · ปลายทาง UNMAPPED_OR_INSERTED | ทั้งสอง batch TAMPERED ใน ≤1 นาที |
| `snapshot` | แก้ทั้ง `logs` และ `batch_log_snapshot` | contentRoot + snapshotTrusted=false (SNAPSHOT_CONTENT_MISMATCH) | TAMPERED ใน ≤1 นาที |
| `dbroot` | แก้ `batches.merkle_root` (คง 64-hex) | dbRoot | **ไม่พลิก** (verify ยึด chain) |

ยิงแต่ละเคสแล้วสคริปต์พิมพ์: batch id · log id · ช่องที่ควรแดง · ให้เปิดหน้า Check/กด Verify
(เห็นแดงทันทีเพราะหน้า Check คำนวณสด · status badge ในลิสต์พลิกตาม verify cron ≤1 นาที)

### หมายเหตุสำคัญ (อีเมล)
`content` `rehash` `hash` `snapshot` ต้อง **ปิด trigger ชั่วคราว** → DDL audit จับเป็น `TRIGGER_DISABLED`
= เด้งอีเมลเข้าอินบ็อกซ์ของ **Kan คนเดียว** (to = user เดียวกัน · อาจารย์ไม่อยู่ในรายชื่อ)
ถ้ามี alert `TRIGGER_DISABLED` ที่ยัง OPEN อยู่ก่อน จะ **ยุบรวม** (occurrence เพิ่ม) ไม่ใช่ใบใหม่
`move` และ `dbroot` ไม่ปิด trigger → ไม่มีอีเมล

## กลไกความปลอดภัย

- **ก่อนยิง**: batch เป้าหมายต้อง `CONFIRMED` และยังไม่ถูกยิงค้าง (มี backup row = ปฏิเสธ) · `move` เช็ค batch ปลายทางด้วย
- **backup**: เก็บค่าเดิมลงตาราง `_live_demo_backup` (ไม่พิมพ์ค่าเอง) ภายในทรานแซกชันเดียวกับการยิง
- **ทุกการแก้ = transaction เดียว + guard จำนวนแถว** (UPDATE ต้องได้ 1 แถว ไม่งั้น ROLLBACK)
- **DDL ใน Postgres เป็น transactional** → ถ้า rollback trigger กลับสถานะเดิมอัตโนมัติ (ไม่มีทางหลุดค้าง)
- **restore**: ดึงค่าจาก backup → revert → เช็ค `IS NOT DISTINCT FROM` → ค่อยลบ backup row ของเคสนั้น
  (ถ้าค่าไม่ตรง จะไม่ลบ backup และเตือน — ลองใหม่ได้)
- trigger คืนเป็น **ALWAYS** (logs) / **O** (snapshot) เสมอ · ไม่แตะ batch/log อื่น
- `raw_hash` ของ `rehash` คำนวณใน SQL ด้วย canonical v2 เดียวกับ backend (ยืนยันแล้วว่า hash ตรง)

## ขั้นตอนสาธิตที่แนะนำ

```bash
./live-demo.sh status           # ก่อนเริ่ม: ทุกเคส CONFIRMED, integrity 100%
./live-demo.sh content          # ยิง → เปิดหน้า Check ของ batch ที่พิมพ์ออกมา (contentRoot แดง)
# ... อธิบายให้อาจารย์ดู รอ ≤1 นาที ให้ status พลิก TAMPERED + เห็น alert ...
./live-demo.sh restore content  # คืน → ≤1 นาที กลับ CONFIRMED + alert auto-resolve
```
ทำซ้ำเคสอื่น ๆ ได้ · จบงานเช็คว่าเคลียร์หมด:
```bash
./live-demo.sh restore-all      # คืนทุกเคสที่ยังค้าง
./live-demo.sh status           # ต้องไม่มี "ยิงค้าง" เหลือ · integrity กลับ 100%
```

## กู้ฉุกเฉิน
- ลืมว่ายิงอะไรไว้ → `./live-demo.sh status` (คอลัมน์ "ยิงค้าง?")
- คืนทุกอย่าง → `./live-demo.sh restore-all`
- ตาราง backup อยู่ที่ `_live_demo_backup` (ว่าง = ไม่มีอะไรค้าง)

## ทดสอบแล้ว
- hh (seed 7 batch): ยิงครบ 6 เคส · guard double-fire ปฏิเสธ · restore / restore-all คืนตรง backup · trigger A/O · ทุก log intact
- cloud: เคส `content` 1 รอบ (ยิง → ตรวจ → restore → CONFIRMED)
