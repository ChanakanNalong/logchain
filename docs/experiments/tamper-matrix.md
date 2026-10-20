# Tamper matrix — ตารางทำนาย vs ผลจริง ทุกเคส

การทดลองทำให้ batch เป็น TAMPERED / UNVERIFIED เพื่อยืนยันว่าระบบ integrity
(Merkle + anchor บน Polygon + snapshot ต่อ log + DDL audit) จับการแก้ข้อมูลหลัง seal
ได้ครบทุกช่องทาง และเพื่อระบุ "มุมที่หน้าจอกับสถานะไม่ตรงกัน" ไว้ก่อนนำเสนอ

- วันที่: 2026-10-20
- โค้ดอ้างอิง: `src/integrity/integrity.service.ts`, `src/integrity/batch-diff.service.ts`,
  `src/blockchain/blockchain.service.ts`, `src/logs/services/log-hash.ts`,
  `src/database/migrations/1791244800000-DbDdlAudit.ts`
- 5 root ที่ใช้เทียบ: **chainRoot** (บนเชน) · **dbRoot** (`batches.merkle_root`) ·
  **snapshotRoot** (จาก `batch_log_snapshot.raw_hash`) · **storedHashRoot** (merkle จาก `logs.raw_hash` ปัจจุบัน) ·
  **contentRoot** (merkle จาก hash ที่ recompute จากเนื้อ log ปัจจุบัน)
- verify cron ทุก 1 นาที (`verifyAllBatches`) เป็นตัวพลิก `batches.status`; หน้า diff/tree/detail คำนวณสดทุก request

## วิธีทดลอง

| กลุ่ม | ที่ไหน | วิธี |
|---|---|---|
| A, B(=raw_hash), C(=content+hash), D, E, F(=raw_hash), C″, J, replica | **hh** (Hardhat + hh-postgres) | `test/tamper-scenarios.integration.spec.ts` (`TAMPER_HH=1`) — โค้ด service จริง, anchor จริง, ทุกเคส restore + ยืนยันกลับ INTACT |
| F′ (ย้าย mapping), G (แก้ snapshot), H (แก้ dbRoot) | **cloud CT141** | ยิง SQL ตรง + ถ่ายภาพ dashboard + restore (ดู `/home/logchain/restore-tamper-fgh.md`) |
| A, B, I (แก้หลายฟิลด์รวม created_at) | **cloud** (มีภาพแล้ว) | batch `6ca29525` / `73d2e0cd` / `d9a57865` |

> เลขตัวอักษรเคสด้านล่างใช้ตามโจทย์ Kan — ในสเปก hh ชื่อ it อาจสลับ (Kan C = spec B, Kan B/I = spec F/C)

## ตารางทำนาย vs ผลจริง

| เคส | ต้องปิด trigger? | batch status | alert | root ที่ 🔴 | diff category | proof ของ log | ผลจริงตรงทำนาย |
|---|---|---|---|---|---|---|---|
| **A** แก้ message | ใช่ | TAMPERED | INTEGRITY_TAMPERED + TRIGGER_DISABLED | contentRoot | CONTENT_MODIFIED | verify=false · CONTENT_MODIFIED | ✅ (hh) |
| **B** แก้ raw_hash อย่างเดียว | ใช่ | TAMPERED | เดียวกับ A | storedHashRoot | HASH_MODIFIED | **verify=true** · HASH_MODIFIED | ✅ (hh spec F) |
| **C** แก้ content + raw_hash ให้ตรง | ใช่ | TAMPERED | เดียวกับ A | storedHashRoot + contentRoot | CONTENT_MODIFIED | verify=false | ✅ (hh spec B) — เชนจับ (MISMATCH) |
| **D** ลบ log ทั้งแถว | ใช่ (no_delete) | TAMPERED | เดียวกับ A | storedHashRoot + contentRoot | DELETED/ROW_MISSING | ไม่มี log | ✅ (hh) |
| **E** แทรก log ปลอม + map | **ไม่** (INSERT ไม่ถูกบล็อก) | TAMPERED | INTEGRITY_TAMPERED | storedHashRoot + contentRoot | UNMAPPED_OR_INSERTED | verify=false · **UNKNOWN** (ไม่มี snapshot) | ✅ (hh) |
| **F′** ย้าย mapping (cloud) | **ไม่** | TAMPERED **2 ใบ** | INTEGRITY_TAMPERED ×2 | ต้นทาง+ปลายทาง: storedHashRoot + contentRoot | ต้นทาง DELETED/MAPPING_MISSING · ปลายทาง UNMAPPED_OR_INSERTED | — | ✅ (cloud) |
| **G** แก้ batch_log_snapshot (cloud) | **ใช่** (snapshot เป็น immutable!) | **CONFIRMED (ไม่เปลี่ยน)** | TRIGGER_DISABLED (dedup) | **ไม่มี** (5 ช่องเขียว) | — (verdict TAMPERED เฉพาะหน้า diff: SNAPSHOT_CONTENT_MISMATCH) | ✅ (cloud) — แก้ทำนายเดิม (เคยคิดว่าไม่มี trigger) |
| **H** แก้ dbRoot (cloud) | **ไม่** (batches ไม่มี trigger) | **CONFIRMED (ไม่เปลี่ยน)** | **ไม่มี** | dbRoot | — (verdict TAMPERED เฉพาะ diff/tree/chainCheck) | — | ✅ (cloud) |
| **I** แก้ created_at อย่างเดียว | ใช่ | TAMPERED | เดียวกับ A | contentRoot | CONTENT_MODIFIED (field createdAt) | verify=false | ✅ (cloud d9a57865, เหมือน A) |
| **J** UNVERIFIED | — | **UNVERIFIED** | **ไม่มี** (ไม่ใช่ tamper) | ไม่มี (chain MISSING) | UNVERIFIABLE | verify ยัง true | ✅ (hh) — กลับ CONFIRMED เมื่อ root กลับมา |
| **C″** content+raw_hash+dbRoot สอดคล้อง + chain ล่ม | ใช่ | TAMPERED | INTEGRITY_TAMPERED | — | SNAPSHOT_ROOT_MISMATCH | — | ⚠️ **ไม่ใช่ bypass** — ดูข้อค้นพบ |

ทุกเคส hh restore แล้วกลับ `CONFIRMED` + `INTACT` และ trigger กลับ `O` (ยืนยันท้ายสเปก) ·
ทุกเคส cloud restore แล้วกลับ CONFIRMED + 5 ช่องเขียว (sweep สะอาด)

## ข้อค้นพบ

### 1. จอแดง แต่ status ไม่เปลี่ยน / ไม่มี alert — G และ H
- **G (แก้ snapshot):** `verifyAllBatches` ไม่เคยอ่าน `batch_log_snapshot` → status คง CONFIRMED, ไม่มี INTEGRITY_TAMPERED
  แต่หน้า diff คำนวณสด เห็น snapshot ไม่ hash ตรงตัวเอง → verdict **TAMPERED** ทั้งที่ **5 ช่อง root เขียวหมด**
  (snapshotRoot สร้างจากคอลัมน์ `raw_hash` ที่ไม่ได้แก้ จึงไม่แดง — ที่แดงคือ `snapshotTrusted=false`)
- **H (แก้ dbRoot):** verify เทียบ root จาก log กับ **เชน** ไม่เคยอ่าน `batches.merkle_root` → status คง CONFIRMED, ไม่มี alert
  แต่ diff/tree/log-detail chainCheck เอา dbRoot เทียบ reference (เชน) → dbRoot แดงถาวร
- **นัยต่ออาจารย์:** badge ในลิสต์ (`batches.status`) กับ verdict ในหน้า diff เป็นคนละระบบ —
  การแก้ snapshot/ dbRoot โดยไม่แตะ log จริง ทำให้ "จอเตือน" แต่ "ลิสต์ไม่เปลี่ยนสี" และไม่มีอีเมล

### 2. C″ ไม่ใช่ bypass — snapshot ที่ immutable เป็นหลักฐานอิสระจากเชน
สมมติฐานเดิม: แก้ content + raw_hash + dbRoot ให้สอดคล้องกัน + chain ล่ม → verify local จะถูกหลอก
ผลจริง (hh): **ยังถูกจับ** เพราะ `batch_log_snapshot` แก้ไม่ได้ (trigger `trg_snapshot_no_update`/`no_delete`)
→ `snapshotRoot` (จาก snapshot เดิม) ไม่ตรง dbRoot ที่ถูกปลอม → diff `SNAPSHOT_ROOT_MISMATCH` → verdict TAMPERED

**อัปเดต (diff baseline):** เคส cover/C″ เมื่ออ่านเชนได้และ `storedHashRoot == เชน` (raw_hash ยังไม่ถูกแตะ)
diff จะใช้ **raw_hash เป็น baseline** แทนการยอมแพ้ที่ระดับ batch — ชี้ได้ว่า log ตัวไหนเนื้อหาถูกแก้
(`CONTENT_MODIFIED` รายตัว · DELETED/INSERTED=0 เพราะสมาชิกครบตามตอน seal) แต่ "ไม่ทราบค่าเดิม"
(snapshot ถูกแก้) · response มี field `baseline: snapshot|raw_hash|none` · ถ้า raw_hash ก็ไม่ตรงเชน → `none` (ระดับ batch เหมือนเดิม)
แม้เชนอ่านไม่ได้ · bypass offline ที่สมบูรณ์จริงต้องปลอม snapshot ด้วย = ต้อง `DISABLE trg_snapshot_no_update`
ซึ่ง **DDL audit จับเป็น TRIGGER_DISABLED ทันที**

### 3. snapshot เป็น immutable เท่า logs (แก้ตารางทำนายเดิม)
`batch_log_snapshot` มี `trg_snapshot_no_update` + `trg_snapshot_no_delete` (เหมือน `logs`) — UPDATE/DELETE ถูกบล็อก
(INSERT ทำได้). เดิมแผนคิดว่า snapshot ไม่มี trigger; จริง ๆ มี → เคส G ต้องปิด trigger (กลายเป็น TRIGGER_DISABLED)

### 4. TRIGGER_DISABLED รวมใบข้ามตาราง (dedup)
`AlertsService.createOrDedup` ใช้ dedup key = (status=OPEN, alertType, source, batchId, ruleId, sourceIp).
DB_AUDIT alert มี `batchId=null`, `sourceIp` มักเป็น IP เดียว → การปิด trigger ครั้งใหม่ (คนละตาราง คนละเวลา)
ยุบรวมเข้าใบ TRIGGER_DISABLED ที่ยัง OPEN อยู่ (occurrence_count เพิ่ม + อีเมล renotify) ไม่เกิดใบใหม่
→ ถ้าไม่ปิดใบเก่า จะแยกเหตุการณ์ปิด trigger แต่ละครั้งจาก "ใบ alert" ไม่ได้ ต้องดูที่ `db_audit_events`

### 5. trigger ของ snapshot เป็น `O` แต่ของ logs เป็น `A` (ALWAYS) → replica bypass ไม่เท่ากัน
- `logs`: quick win ตั้ง `ENABLE ALWAYS` (tgenabled=`A`) → `SET session_replication_role='replica'` **ข้ามไม่ได้** (ยืนยัน hh: UPDATE โดน IMMUTABLE_LOG)
- `batch_log_snapshot`: ยังเป็น `O` → replica role **ข้ามได้** (ยืนยัน hh: UPDATE snapshot ผ่านโดยไม่ RAISE)
- `batches`: ไม่มี trigger เลย → แก้ dbRoot ได้ตรง ๆ (เคส H)

## งานพัฒนาต่อ (ปิดช่องที่เจอ)

| # | ช่อง | งานที่ควรทำ |
|---|---|---|
| 1 | app role เป็น superuser/owner → ปิด trigger / `session_replication_role` / DROP EVENT TRIGGER ได้ | **แยก role** (ข้อ 4 เต็ม) ให้ app ไม่ใช่ superuser/owner — ปิดต้นตอของ C″/G/replica ทั้งหมด |
| 2 | snapshot trigger เป็น `O` → replica role ข้ามได้ | `ENABLE ALWAYS` ให้ `trg_snapshot_no_update`/`no_delete` เหมือน logs (quick win ต่อ) |
| 3 | `batches` ไม่มี trigger → แก้ dbRoot เงียบ ๆ | เพิ่ม trigger กัน UPDATE `merkle_root`/`tx_hash` หลัง anchor (append-only partial) หรือย้าย root ออกนอก DB เป็นหลัก |
| 4 | G/H จอแดงแต่ status ไม่ขยับ | ให้ verify ตรวจ `dbRoot==storedHashRoot` และ snapshot ด้วย แล้วยกเป็น alert (ไม่ใช่เห็นเฉพาะหน้า diff) |
| 5 | TRIGGER_DISABLED dedup รวมข้ามตาราง | ใส่ `onTable` ลง dedup key ของ DB_AUDIT alert เพื่อแยกเหตุการณ์ต่อตาราง |
| 6 | E: log ปลอมได้ integrity `UNKNOWN` (ไม่มี snapshot) | ถือ `UNKNOWN` ใน batch ที่มี snapshot = สัญญาณผิดปกติ (log ที่ map เข้ามาทีหลังไม่มี snapshot) |

## ยืนยันผลอัตโนมัติ
`test/tamper-scenarios.integration.spec.ts` (hh, `TAMPER_HH=1`) — 7/7 ผ่าน ครอบคลุม A–F, C″, J, replica bypass,
DDL audit (CRITICAL TRIGGER_DISABLED / WARNING SCHEMA_CHANGED) และ quick win (logs ALWAYS กัน replica)
