import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Quick win (แผนป้องกันการแก้ log — ข้อ 4): ทำ trigger กัน UPDATE/DELETE บน logs
 * ให้ยิง "เสมอ" แม้ session อยู่ใน replication role = replica
 *
 * ปัญหา: role ที่ backend ใช้เป็น superuser · `SET session_replication_role = replica`
 * ปิด trigger แบบ origin (ค่า default) ได้โดยไม่ต้อง DISABLE TRIGGER (ไม่มี DDL ให้จับ)
 * → แก้ logs ได้เงียบ ๆ
 *
 * ENABLE ALWAYS → trigger ยิงทั้งใน origin และ replica mode (pg_trigger.tgenabled = 'A')
 * → ช่อง session_replication_role ปิดสำหรับ row-trigger ทันที (ยังเหลือ DISABLE TRIGGER
 *   ซึ่งเป็น DDL จับได้ด้วย event trigger ใน DbDdlAudit · และ DROP ซึ่งต้องแยก role ในข้อ 4 เต็ม)
 *
 * ปลอดภัยกับ backup/restore/replication:
 *   - trigger เป็น BEFORE UPDATE/DELETE เท่านั้น — การ restore (pg_restore = COPY/INSERT) ไม่แตะ
 *   - standby เป็น physical streaming (WAL replay) — trigger ไม่ยิงบน standby
 *   - ไม่มีส่วนใดในระบบใช้ session_replication_role = replica (ตรวจแล้ว)
 *
 * เขียนให้รันซ้ำได้
 */
export class LogsTriggersEnableAlways1791158400000 implements MigrationInterface {
  name = 'LogsTriggersEnableAlways1791158400000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE logs ENABLE ALWAYS TRIGGER trg_logs_no_update`);
    await q.query(`ALTER TABLE logs ENABLE ALWAYS TRIGGER trg_logs_no_delete`);
  }

  async down(q: QueryRunner): Promise<void> {
    // กลับเป็น origin (ค่า default — ยิงเฉพาะ origin mode)
    await q.query(`ALTER TABLE logs ENABLE TRIGGER trg_logs_no_update`);
    await q.query(`ALTER TABLE logs ENABLE TRIGGER trg_logs_no_delete`);
  }
}
