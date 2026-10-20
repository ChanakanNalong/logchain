import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * index สำหรับค้นหา Source IP ในหน้า Logs (GET /logs?q=<ip>)
 *
 * ค้นผ่าน host(source_id) (text) ทั้งแบบตรงตัวและ prefix (`49.229%`) ด้วย LIKE
 * → ใช้ expression index + text_pattern_ops (รองรับ `=`/`LIKE 'x%'` บน C-collation)
 * host(inet) เป็น immutable จึงสร้าง expression index ได้
 *
 * รันอัตโนมัติตอน backend boot (migrationsRun) · เขียนให้รันซ้ำได้
 */
export class LogsSourceIpIndex1791072000000 implements MigrationInterface {
  name = 'LogsSourceIpIndex1791072000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE INDEX IF NOT EXISTS idx_logs_source_ip_text
         ON logs ((host(source_id)) text_pattern_ops)`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS idx_logs_source_ip_text`);
  }
}
