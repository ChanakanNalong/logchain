import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * จดเวลาที่ส่ง email ของ alert ครั้งล่าสุด — ใช้ตัดสินว่าการเกิดซ้ำควรเตือนอีกรอบไหม
 *
 * หลังแยก dedup ตาม rule (AlertsRuleDedup) การเกิดซ้ำถูกนับใน occurrence_count แต่ email
 * ส่งแค่ตอนสร้าง alert — brute force ที่ยังดำเนินอยู่หลายชั่วโมงหลังจากนั้นเงียบสนิท
 * ถ้าไม่มีใครเปิดหน้า Alerts
 */
export class AlertsLastNotified1790208000000 implements MigrationInterface {
  name = 'AlertsLastNotified1790208000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE alerts ADD COLUMN IF NOT EXISTS last_notified_at TIMESTAMPTZ`,
    );
    // alert เดิมที่ severity ถึงเกณฑ์ถูกส่ง email ไปแล้วตอนสร้าง — นับจาก created_at
    // (null = ยังไม่เคยเตือน → การเกิดซ้ำครั้งแรกหลัง migrate จะเตือนทันที ซึ่งไม่ตรงความจริง)
    await q.query(
      `UPDATE alerts SET last_notified_at = created_at
        WHERE last_notified_at IS NULL AND severity IN ('HIGH', 'CRITICAL')`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE alerts DROP COLUMN IF EXISTS last_notified_at`);
  }
}
