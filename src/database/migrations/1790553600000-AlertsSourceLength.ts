import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * alerts.source VARCHAR(32) → VARCHAR(128) ให้เท่ากับ logs.source / CreateLogDto.source
 *
 * detection ส่ง source ของ log มาตรง ๆ — log ที่ชื่อแหล่งยาวเกิน 32 ตัวผ่าน POST /logs ได้ (DTO ยอม 128)
 * แต่ INSERT alert ชน `value too long for type character varying(32)` → alert หายทั้งที่ detection
 * log ว่า PUBLISHED แล้ว (ยืนยันบน stack จริง 2026-09-27)
 *
 * ขยายเฉพาะเมื่อยังสั้นกว่า 128 — รันซ้ำได้ และไม่หดคอลัมน์ถ้ามีคนขยายเกิน 128 ไปแล้ว
 * varchar ที่ยาวขึ้นไม่ rewrite ตาราง/ไม่ rebuild index (binary-coercible) จึงไม่ล็อกนาน
 */
export class AlertsSourceLength1790553600000 implements MigrationInterface {
  name = 'AlertsSourceLength1790553600000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      DO $$
      BEGIN
        IF (SELECT character_maximum_length FROM information_schema.columns
             WHERE table_schema = current_schema()
               AND table_name = 'alerts' AND column_name = 'source') < 128 THEN
          ALTER TABLE alerts ALTER COLUMN source TYPE VARCHAR(128);
        END IF;
      END $$;
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    // หดกลับได้เฉพาะเมื่อไม่มีแถวที่ยาวเกิน 32 — ไม่ตัดข้อมูลทิ้งเงียบ ๆ
    const [{ n }] = (await q.query(
      `SELECT count(*)::int AS n FROM alerts WHERE length(source) > 32`,
    )) as { n: number }[];
    if (n > 0) {
      throw new Error(
        `alerts มี ${n} แถวที่ source ยาวเกิน 32 — ย้อน migration นี้ไม่ได้โดยไม่ทำข้อมูลหาย`,
      );
    }
    await q.query(`ALTER TABLE alerts ALTER COLUMN source TYPE VARCHAR(32)`);
  }
}
