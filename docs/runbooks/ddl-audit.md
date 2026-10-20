# DDL audit — จับการ DISABLE/DROP trigger บนตารางหลักฐาน

ตอบโจทย์: "ใครปิด trigger ของ logs เพื่อแก้ log" — เดิมคำสั่งที่ **สำเร็จ** ไม่ถูกบันทึกเลย
(เห็นจาก `docs/experiments/incident-20261020.md` — การแก้ `raw_hash` ผ่าน `DISABLE TRIGGER` ไม่ขึ้น log ใด ๆ)

ครอบคลุม **ข้อ 4-quick win** + **ข้อ 1** ของแผนป้องกันการแก้ log · ข้อ 4-เต็ม และข้อ 2+3 ยังไม่ทำ

## กลไก

### Quick win — `ENABLE ALWAYS` (migration `LogsTriggersEnableAlways`)
- `trg_logs_no_update` / `trg_logs_no_delete` ตั้งเป็น `ENABLE ALWAYS` (`pg_trigger.tgenabled = 'A'`)
- → ยิง **แม้ session อยู่ใน `session_replication_role = replica`**
- ปิดช่องที่ superuser `SET session_replication_role = replica;` แล้ว UPDATE/DELETE logs ได้โดยไม่ต้อง `DISABLE TRIGGER` (ไม่มี DDL ให้จับ)
- ปลอดภัยกับ backup (`pg_dump -Fc` → restore เป็น COPY/INSERT ไม่แตะ UPDATE/DELETE trigger) และ standby (physical streaming, trigger ไม่ยิงบน standby)

### DDL audit — event trigger (migration `DbDdlAudit`)
ตารางที่เฝ้า: `logs` · `log_batch_mapping` · `batch_log_snapshot` · `batches`

- `evt_ddl_audit` (`ddl_command_end`) → ALTER/CREATE บนตารางที่เฝ้า
- `evt_ddl_audit_drop` (`sql_drop`) → DROP TRIGGER / DROP TABLE บนตารางที่เฝ้า
- เขียนลง `db_audit_events`: `occurred_at`, `session_user`, `current_user`, `inet_client_addr()`,
  `application_name`, `command_tag`, `object_identity`, `kind`, `query` (= `current_query()` ตัด 1000 ตัว · ซ่อนถ้ามี `password`)
- `kind`: `DISABLE_TRIGGER` · `DROP_TRIGGER` · `ENABLE_TRIGGER` · `SCHEMA_CHANGE`

### Backend → alert (`DbAuditService`, poll ทุก 1 นาที)
- `DISABLE_TRIGGER` / `DROP_TRIGGER` → **alert CRITICAL `TRIGGER_DISABLED`** (ส่งอีเมล)
- อื่น ๆ (`ENABLE_TRIGGER` / `SCHEMA_CHANGE` — รวม migration ปกติ) → **WARNING `SCHEMA_CHANGED`**
- dedup ของ `AlertsService`: event ซ้ำจาก IP เดียวกันรวมเป็น alert OPEN เดียว (`occurrence_count++`)
- mark `processed_at` หลังสร้าง alert สำเร็จ — ถ้าพลาดจะถูกหยิบใหม่รอบหน้า

## ⚠️ ข้อจำกัด (สำคัญ — ต้องรู้)

ปัจจุบัน **role `logchain` ที่ backend ใช้เป็น superuser + owner ของทุกตาราง** ดังนั้น:

1. superuser ยัง **`DROP EVENT TRIGGER evt_ddl_audit`** หรือ `ALTER EVENT TRIGGER … DISABLE` เพื่อปิด audit นี้ได้เอง
2. `SET session_replication_role = replica;` **ปิด event trigger ด้วย** (ไม่ใช่แค่ row trigger) → DDL หลังจากนั้นไม่ถูกบันทึก
   - แต่ row trigger `ENABLE ALWAYS` ยังบล็อก UPDATE/DELETE อยู่ → แก้ logs ไม่ได้อยู่ดี (ต้อง `DISABLE TRIGGER` ซึ่งเป็น DDL)
   - ยกเว้นทำทั้งคู่: `SET replica` ทำให้ event trigger ไม่ยิง **แต่** ALWAYS trigger ยังยิง → UPDATE ถูกบล็อก; ถ้าจะข้าม ALWAYS ต้อง `DISABLE TRIGGER` (เป็น DDL) แต่ event trigger ถูกปิดด้วย replica แล้ว → **DISABLE ไม่ถูกบันทึก**

→ ชั้นนี้จับ "การ DISABLE/DROP trigger แบบตรงไปตรงมา" (รวมสคริปต์ demo-tamper เดิม) ได้ และบังคับให้ผู้โจมตีที่เป็น superuser ต้องใช้ขั้นตอนซับซ้อนขึ้น
**การปิดช่อง superuser ให้ขาดต้องทำ "ข้อ 4 เต็ม": แยก role** ให้ app ไม่ใช่ superuser/owner (owner ถือ trigger + event trigger + `db_audit_events`, app แค่ CRUD) — ยังไม่ทำ

หมายเหตุ: `inet_client_addr()` เป็น `NULL` เมื่อต่อผ่าน unix socket (เช่น `docker exec … psql`) — ยังได้ `session_user`/`current_user`/`query` · การต่อผ่าน TCP (backend, psql ข้ามเครื่อง) ได้ IP ครบ

## ตรวจ / เฝ้า

```sql
-- เหตุการณ์ DDL ล่าสุดบนตารางหลักฐาน
SELECT occurred_at, kind, on_table, session_user_name, client_addr, left(query,120)
FROM db_audit_events ORDER BY id DESC LIMIT 20;

-- alert ที่เปิดอยู่
SELECT alert_type, severity, occurrence_count, created_at
FROM alerts WHERE source = 'DB_AUDIT' AND status = 'OPEN';

-- event trigger ยังอยู่ไหม (ถ้าหาย = มีคนลบ)
SELECT evtname, evtenabled FROM pg_event_trigger WHERE evtname LIKE 'evt_ddl_audit%';
```

## ทดสอบ (hh)
`test/tamper-scenarios.integration.spec.ts` (TAMPER_HH=1):
- scenario A–F ที่ `DISABLE TRIGGER` → `TRIGGER_DISABLED` CRITICAL
- `ALTER TABLE` ปกติ → `SCHEMA_CHANGED` WARNING (ไม่มี false CRITICAL)
- `ENABLE ALWAYS` + `session_replication_role = replica` → UPDATE logs ยังถูกบล็อก (`IMMUTABLE_LOG`)
