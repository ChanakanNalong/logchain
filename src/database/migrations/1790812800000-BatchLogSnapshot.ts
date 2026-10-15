import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * snapshot ของทุก log ตอน seal — ไว้บอกว่า "ตำแหน่ง N ถูกแก้ field ไหน จากอะไรเป็นอะไร" หรือ "ถูกลบ เนื้อเดิมคือ…"
 *
 * เดิมรู้ได้แค่ระดับ batch (root ไม่ตรง) · log ที่ถูกลบหายไปพร้อมเนื้อ · log ที่ถูกแก้ไม่มีค่าเดิมให้เทียบ
 *
 * - snapshot = input ของ raw_hash ครบทุก field (log-hash.ts rawHashCanonical) — hash ใหม่ต้องได้ raw_hash เดิม
 * - position = ลำดับ leaf ใน Merkle tree (0-based) ตามชุดเดียวกับที่สร้าง root
 * - log_id **ไม่มี FK → logs** โดยตั้งใจ: log ที่ถูกลบต้องยังอยู่ใน snapshot (คือหลักฐานว่าเคยมี)
 * - batch_id FK → batches · write-only ด้วย trigger แบบเดียวกับ logs (UPDATE/DELETE = IMMUTABLE_SNAPSHOT)
 *   snapshot ยังถูกแก้ได้ถ้าปิด trigger — /batches/:id/diff จึงพิสูจน์ snapshot กับ root บน chain ก่อนเชื่อ
 *
 * batch ที่ seal ก่อน migration นี้ไม่มี snapshot (legacy) → diff ได้แค่ระดับ batch
 * รันอัตโนมัติตอน backend boot (migrationsRun) · เขียนให้รันซ้ำได้
 */
export class BatchLogSnapshot1790812800000 implements MigrationInterface {
  name = 'BatchLogSnapshot1790812800000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE IF NOT EXISTS batch_log_snapshot (
         batch_id    UUID         NOT NULL REFERENCES batches(id),
         log_id      UUID         NOT NULL,
         position    INTEGER      NOT NULL CHECK (position >= 0),
         snapshot    JSONB        NOT NULL,
         raw_hash    CHAR(64)     NOT NULL,
         created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
         PRIMARY KEY (batch_id, log_id),
         CONSTRAINT uq_batch_log_snapshot_position UNIQUE (batch_id, position)
       )`,
    );
    await q.query(
      `CREATE OR REPLACE FUNCTION prevent_snapshot_mutation()
       RETURNS TRIGGER LANGUAGE plpgsql AS $$
       BEGIN
           RAISE EXCEPTION 'IMMUTABLE_SNAPSHOT: % not permitted on batch_log_snapshot table', TG_OP;
           RETURN NULL;
       END;
       $$`,
    );
    await q.query(
      `CREATE OR REPLACE TRIGGER trg_snapshot_no_delete
         BEFORE DELETE ON batch_log_snapshot FOR EACH ROW
         EXECUTE FUNCTION prevent_snapshot_mutation()`,
    );
    await q.query(
      `CREATE OR REPLACE TRIGGER trg_snapshot_no_update
         BEFORE UPDATE ON batch_log_snapshot FOR EACH ROW
         EXECUTE FUNCTION prevent_snapshot_mutation()`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS batch_log_snapshot`);
    await q.query(`DROP FUNCTION IF EXISTS prevent_snapshot_mutation()`);
  }
}
