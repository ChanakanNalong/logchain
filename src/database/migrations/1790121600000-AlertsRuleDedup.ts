import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * dedup ของ alert ต้องแยกตาม rule + นับการเกิดซ้ำ
 *
 * เดิม idx_alerts_open_dedup = (alert_type, source, batch_id) WHERE OPEN — source คือชื่อ host
 * ตราบใดที่ RULE_MATCH ของ host หนึ่งค้าง OPEN ทุก rule หลังจากนั้นบน host เดียวกันถูกรวมเข้า
 * ตัวเดิมแล้วหายเงียบ รวมถึง 5715 "Successful login after multiple failures" ที่ตามหลัง
 * brute force (5710) — สัญญาณว่าเจาะเข้ามาได้แล้ว (ยืนยันบน stack จริง 2026-09-23)
 *
 * รันอัตโนมัติตอน backend boot (migrationsRun) ทั้ง DB ใหม่และ DB เดิม — ไฟล์ใน
 * infra/postgres/init/ รันเฉพาะตอน volume ว่าง จึงใช้แก้ DB ที่มีอยู่แล้วไม่ได้
 * ทุกคำสั่งเขียนให้รันซ้ำได้ เผื่อมีคนรัน SQL นี้เองมาก่อน
 */
export class AlertsRuleDedup1790121600000 implements MigrationInterface {
  name = 'AlertsRuleDedup1790121600000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE alerts ADD COLUMN IF NOT EXISTS rule_id VARCHAR(32)`,
    );
    await q.query(
      `ALTER TABLE alerts ADD COLUMN IF NOT EXISTS occurrence_count INTEGER NOT NULL DEFAULT 1`,
    );
    // เพิ่มแบบ nullable ก่อน แล้วเติมจาก created_at — ไม่ใช่ now() ของวันที่ migrate
    await q.query(
      `ALTER TABLE alerts ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ`,
    );
    await q.query(
      `UPDATE alerts SET last_seen_at = created_at WHERE last_seen_at IS NULL`,
    );
    await q.query(
      `ALTER TABLE alerts ALTER COLUMN last_seen_at SET DEFAULT now(),
                          ALTER COLUMN last_seen_at SET NOT NULL`,
    );

    // alert เดิมเก็บ rule_id ไว้ใน detail อยู่แล้ว (detection/app/consumer.py)
    await q.query(
      `UPDATE alerts SET rule_id = detail->>'rule_id'
        WHERE rule_id IS NULL AND detail->>'rule_id' IS NOT NULL`,
    );

    // index ใหม่มี column มากกว่าเดิม = เข้มน้อยกว่า แถวที่ผ่าน index เดิมผ่านตัวนี้แน่นอน
    await q.query(`DROP INDEX IF EXISTS idx_alerts_open_dedup`);
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_open_dedup_rule
         ON alerts (alert_type, source,
                    COALESCE(batch_id, '00000000-0000-0000-0000-000000000000'::uuid),
                    COALESCE(rule_id, ''))
         WHERE status = 'OPEN'`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    // ⚠️ index เดิมเข้มกว่า — ถ้ามี RULE_MATCH คนละ rule ของ host เดียวกันค้าง OPEN
    // พร้อมกันอยู่ CREATE จะพัง ต้อง resolve ให้เหลือตัวเดียวต่อ (alert_type, source) ก่อน
    await q.query(`DROP INDEX IF EXISTS idx_alerts_open_dedup_rule`);
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_open_dedup
         ON alerts (alert_type, source,
                    COALESCE(batch_id, '00000000-0000-0000-0000-000000000000'::uuid))
         WHERE status = 'OPEN'`,
    );
    await q.query(`ALTER TABLE alerts DROP COLUMN IF EXISTS last_seen_at`);
    await q.query(`ALTER TABLE alerts DROP COLUMN IF EXISTS occurrence_count`);
    await q.query(`ALTER TABLE alerts DROP COLUMN IF EXISTS rule_id`);
  }
}
