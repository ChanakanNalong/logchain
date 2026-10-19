import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * seal_reason ต่อ batch — เหตุผลที่ batch ถูกปิด: count | age | manual | cron
 *
 * - count/age = ตัวเช็ค hybrid (ครบ SEAL_BATCH_SIZE / ค้างเกิน SEAL_MAX_WAIT_MINUTES)
 * - manual = POST /logs/seal-now · cron = รอบ seal ตาม SEAL_CRON
 * - NULL = batch ที่ปิดก่อน migration นี้ (ย้อนหลังไม่ได้ — ไม่รู้เหตุผลเดิม)
 *
 * nullable ไม่มี default · batches ไม่มี trigger กัน UPDATE (ต่างจาก logs) จึงเพิ่มคอลัมน์ได้ปกติ
 * ไม่อยู่ใน Merkle/raw_hash · รันอัตโนมัติตอน boot (migrationsRun) · เขียนให้รันซ้ำได้
 */
export class BatchSealReason1790985600000 implements MigrationInterface {
  name = 'BatchSealReason1790985600000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE batches ADD COLUMN IF NOT EXISTS seal_reason VARCHAR(16)`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE batches DROP COLUMN IF EXISTS seal_reason`);
  }
}
