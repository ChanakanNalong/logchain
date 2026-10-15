import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ค่า gas จริงของ tx storeRoot ต่อ batch + index ที่ list/filter ใช้
 *
 * - gas_used BIGINT · effective_gas_price NUMERIC (wei — ใหญ่เกิน bigint ได้บน chain อื่น)
 *   ค่าใช้จ่ายของ batch = gas_used × effective_gas_price · NULL = ไม่มี tx ใหม่ (ROOT_EXISTS / ยังไม่ confirm /
 *   batch ก่อน migration นี้ — เติมย้อนหลังได้ด้วย scripts/backfill-batch-gas.mjs)
 * - idx_batches_status: verify ทุกนาที + GET /batches?status= · idx_batches_sealed_at: GET /batches เรียงตามเวลา
 *
 * รันอัตโนมัติตอน backend boot (migrationsRun) · เขียนให้รันซ้ำได้
 */
export class BatchGasAndIndexes1790899200000 implements MigrationInterface {
  name = 'BatchGasAndIndexes1790899200000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE batches ADD COLUMN IF NOT EXISTS gas_used BIGINT`,
    );
    await q.query(
      `ALTER TABLE batches ADD COLUMN IF NOT EXISTS effective_gas_price NUMERIC(78, 0)`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS idx_batches_status ON batches (status)`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS idx_batches_sealed_at ON batches (sealed_at)`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS idx_batches_sealed_at`);
    await q.query(`DROP INDEX IF EXISTS idx_batches_status`);
    await q.query(
      `ALTER TABLE batches DROP COLUMN IF EXISTS effective_gas_price`,
    );
    await q.query(`ALTER TABLE batches DROP COLUMN IF EXISTS gas_used`);
  }
}
