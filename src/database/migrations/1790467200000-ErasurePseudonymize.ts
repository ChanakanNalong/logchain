import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PDPA erasure เปลี่ยนจาก "ลบ audit_access" เป็น "pseudonymize" (review B10 · PCI 10.5.1 ให้เก็บ audit trail ≥ 12 เดือน)
 *
 * tombstone จึงต้องบอกได้ว่าใช้วิธีไหน — แถวเก่าทั้งหมดคือการลบจริง (DEFAULT 'DELETE')
 * `pseudonym` = ค่าที่เอาไปแทน user_id ใน audit_access ใช้ผูก tombstone กับแถว audit ที่เหลืออยู่
 *
 * ADD COLUMN ... DEFAULT ไม่ยิง row trigger → ไม่ชน trg_erasure_log_no_update
 */
export class ErasurePseudonymize1790467200000 implements MigrationInterface {
  name = 'ErasurePseudonymize1790467200000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE erasure_log ADD COLUMN IF NOT EXISTS method VARCHAR(16) NOT NULL DEFAULT 'DELETE'`,
    );
    await q.query(
      `ALTER TABLE erasure_log ADD COLUMN IF NOT EXISTS pseudonym VARCHAR(128)`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE erasure_log DROP COLUMN IF EXISTS pseudonym`);
    await q.query(`ALTER TABLE erasure_log DROP COLUMN IF EXISTS method`);
  }
}
