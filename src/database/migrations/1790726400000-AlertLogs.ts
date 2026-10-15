import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * alert ↔ log หลายตัว + source IP ของ alert
 *
 * เดิม alerts.log_id เก็บได้ log เดียว (ตัวที่ทำให้ rule เด้งครั้งแรก) — log อีก 4 ครั้งในหน้าต่าง
 * ของ 5710, log ของ 5710 ที่ 5715 อ้างถึง และ log ที่เกิดซ้ำระหว่าง OPEN หายหมด ไล่หลักฐานไม่ได้
 *
 * alert_logs
 *   role: trigger (= alerts.log_id) · window (log อื่นในหน้าต่าง threshold) · prior (log ของ rule ก่อนหน้า
 *         ในกฎแบบ chain) · repeat (เกิดซ้ำระหว่าง OPEN) · PK (alert_id, log_id) = log หนึ่งมี role เดียวต่อ alert
 *   alert_id ON DELETE CASCADE — retention ลบ alert เก่า (ComplianceService) ลิงก์ต้องหายตาม
 *   **ไม่มี append-only trigger** โดยตั้งใจ: ตารางนี้เป็นดัชนีชี้ไปหา log ไม่ใช่หลักฐานเอง
 *   (หลักฐานคือ logs ที่ append-only + Merkle) ถ้าใส่ trigger retention จะลบ alert ไม่ได้
 *   log_id FK ไม่ cascade: logs ลบไม่ได้อยู่แล้ว (trg_logs_no_delete)
 *
 * alerts.source_ip — IP ของผู้กระทำจาก detection · ใส่ใน dedup key ด้วย ไม่งั้น 5710 จาก 2 IP
 * บน source (forwarder) เดียวกันถูกรวมเป็นแถวเดียว
 *
 * รันอัตโนมัติตอน backend boot (migrationsRun) · เขียนให้รันซ้ำได้
 */
export class AlertLogs1790726400000 implements MigrationInterface {
  name = 'AlertLogs1790726400000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS source_ip INET`);

    await q.query(
      `CREATE TABLE IF NOT EXISTS alert_logs (
         alert_id  UUID         NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
         log_id    UUID         NOT NULL REFERENCES logs(id),
         role      VARCHAR(16)  NOT NULL
                   CHECK (role IN ('trigger', 'window', 'prior', 'repeat')),
         added_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
         PRIMARY KEY (alert_id, log_id)
       )`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS idx_alert_logs_log_id ON alert_logs (log_id)`,
    );

    // alert เดิมมี log ตัวเดียว = trigger · JOIN logs กัน log_id ที่ไม่มีอยู่จริง (POST /alerts ใส่อะไรก็ได้)
    await q.query(
      `INSERT INTO alert_logs (alert_id, log_id, role, added_at)
         SELECT a.id, a.log_id, 'trigger', a.created_at
           FROM alerts a JOIN logs l ON l.id = a.log_id
       ON CONFLICT DO NOTHING`,
    );

    // index ใหม่มี column มากกว่าเดิม = เข้มน้อยกว่า แถวที่ผ่าน index เดิมผ่านตัวนี้แน่นอน
    await q.query(`DROP INDEX IF EXISTS idx_alerts_open_dedup_rule`);
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_open_dedup_ip
         ON alerts (alert_type, source,
                    COALESCE(batch_id, '00000000-0000-0000-0000-000000000000'::uuid),
                    COALESCE(rule_id, ''),
                    COALESCE(source_ip, '0.0.0.0'::inet))
         WHERE status = 'OPEN'`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    // ⚠️ index เดิมเข้มกว่า — ถ้ามี alert OPEN ของ rule เดียวกันคนละ IP บน source เดียวกัน
    // CREATE จะพัง ต้อง resolve ให้เหลือตัวเดียวก่อน
    await q.query(`DROP INDEX IF EXISTS idx_alerts_open_dedup_ip`);
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_open_dedup_rule
         ON alerts (alert_type, source,
                    COALESCE(batch_id, '00000000-0000-0000-0000-000000000000'::uuid),
                    COALESCE(rule_id, ''))
         WHERE status = 'OPEN'`,
    );
    await q.query(`DROP TABLE IF EXISTS alert_logs`);
    await q.query(`ALTER TABLE alerts DROP COLUMN IF EXISTS source_ip`);
  }
}
