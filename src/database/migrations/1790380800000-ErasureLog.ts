import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * หลักฐานการลบข้อมูลตาม PDPA (tombstone) ย้ายจากไฟล์มาเป็นตาราง
 *
 * เดิม ErasureService ลบ audit_access ก่อน แล้วค่อยเขียน `/app/erasure-log.json` — ใน container backend
 * รันเป็น uid 1000 ซึ่งเขียน /app ไม่ได้ (EACCES) → ข้อมูลหายจริงแต่ไม่มีหลักฐาน + ตอบ 500
 * ต่อให้เขียนได้ ไฟล์อยู่ใน writable layer ของ container: rebuild แล้วหาย และไม่อยู่ใน backup
 * ตารางนี้ถูกเขียนใน transaction เดียวกับการลบ → ลบได้ก็ต่อเมื่อบันทึกหลักฐานได้
 *
 * append-only เหมือน `logs` — tombstone คือหลักฐาน ห้ามแก้/ลบ
 */
export class ErasureLog1790380800000 implements MigrationInterface {
  name = 'ErasureLog1790380800000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS erasure_log (
        id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id         VARCHAR(128) NOT NULL,
        requested_by    VARCHAR(128) NOT NULL,
        deleted_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
        records_deleted INTEGER      NOT NULL,
        hash            CHAR(64)     NOT NULL
      )
    `);
    await q.query(
      `CREATE INDEX IF NOT EXISTS idx_erasure_log_deleted_at ON erasure_log (deleted_at)`,
    );
    await q.query(`
      CREATE OR REPLACE FUNCTION prevent_erasure_log_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'IMMUTABLE_ERASURE_LOG: % not permitted on erasure_log table', TG_OP;
      END;
      $$ LANGUAGE plpgsql
    `);
    await q.query(
      `DROP TRIGGER IF EXISTS trg_erasure_log_no_update ON erasure_log`,
    );
    await q.query(`
      CREATE TRIGGER trg_erasure_log_no_update
        BEFORE UPDATE OR DELETE ON erasure_log
        FOR EACH ROW EXECUTE FUNCTION prevent_erasure_log_mutation()
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS erasure_log`);
    await q.query(`DROP FUNCTION IF EXISTS prevent_erasure_log_mutation()`);
  }
}
