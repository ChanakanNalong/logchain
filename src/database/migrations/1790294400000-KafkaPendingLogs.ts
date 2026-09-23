import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * outbox ของ log ที่ยังส่งขึ้น Kafka ไม่ได้
 *
 * ก่อนหน้านี้ log ที่เข้ามาระหว่าง Kafka ยังต่อไม่ติด (เช่น compose ยก backend ขึ้นก่อน broker)
 * ถูกบันทึกลง DB ครบแต่ไม่เคยถึง `logs.raw` → detection ไม่เห็นเลย ไม่มี replay
 * ผู้โจมตีที่ยิงตรงช่วงนั้นจึงไม่โดน rule ใด ๆ
 */
export class KafkaPendingLogs1790294400000 implements MigrationInterface {
  name = 'KafkaPendingLogs1790294400000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS kafka_pending_logs (
        log_id    UUID        PRIMARY KEY,
        payload   JSONB       NOT NULL,
        queued_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    // replay ต้องเรียงตามลำดับที่ log เข้ามา ไม่งั้น sequence ที่ ML ใช้เพี้ยน
    await q.query(
      `CREATE INDEX IF NOT EXISTS idx_kafka_pending_queued_at
         ON kafka_pending_logs (queued_at)`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS kafka_pending_logs`);
  }
}
