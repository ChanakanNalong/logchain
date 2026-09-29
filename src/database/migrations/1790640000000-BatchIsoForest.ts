import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * เพิ่มผลจำแนกของ Isolation Forest (ตรวจจับระดับที่ 3) ลงตาราง batches
 *
 * ทุกคอลัมน์ nullable โดยตั้งใจ: NULL = "ยังไม่ได้จำแนก" (detection ล่ม / timeout /
 * ยังไม่ได้ train โมเดล) ซึ่งต่างจาก if_anomaly=false ที่แปลว่า "จำแนกแล้วว่าปกติ"
 * — การปิด batch (แกน integrity) ต้องไม่พึ่งผลนี้ ถ้า detection ไม่ตอบ batch ยังปิดได้
 *
 * รันอัตโนมัติตอน backend boot (migrationsRun) · เขียนให้รันซ้ำได้
 */
export class BatchIsoForest1790640000000 implements MigrationInterface {
  name = 'BatchIsoForest1790640000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE batches ADD COLUMN IF NOT EXISTS if_anomaly BOOLEAN`,
    );
    await q.query(
      `ALTER TABLE batches ADD COLUMN IF NOT EXISTS if_score DOUBLE PRECISION`,
    );
    await q.query(
      `ALTER TABLE batches ADD COLUMN IF NOT EXISTS if_reason TEXT`,
    );
    await q.query(
      `ALTER TABLE batches ADD COLUMN IF NOT EXISTS if_scored_at TIMESTAMPTZ`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE batches DROP COLUMN IF EXISTS if_scored_at`);
    await q.query(`ALTER TABLE batches DROP COLUMN IF EXISTS if_reason`);
    await q.query(`ALTER TABLE batches DROP COLUMN IF EXISTS if_score`);
    await q.query(`ALTER TABLE batches DROP COLUMN IF EXISTS if_anomaly`);
  }
}
