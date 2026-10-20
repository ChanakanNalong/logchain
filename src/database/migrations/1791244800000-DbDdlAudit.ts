import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DDL audit (แผนป้องกันการแก้ log — ข้อ 1): บันทึกเมื่อมีคนทำ DDL บนตารางหลักฐาน
 * โดยเฉพาะ DISABLE/DROP TRIGGER ซึ่งเป็นขั้นบังคับก่อนจะแก้ logs ได้
 *
 * ตารางที่เฝ้า: logs · log_batch_mapping · batch_log_snapshot · batches
 *
 * event trigger 2 ตัว (ต้องเป็น superuser ตอนสร้าง — รันใน migration โดย owner role):
 *   - evt_ddl_audit (ddl_command_end): จับ ALTER/CREATE บนตารางที่เฝ้า
 *     · query มี "disable ... trigger" → kind DISABLE_TRIGGER
 *     · "enable ... trigger"          → kind ENABLE_TRIGGER
 *     · อื่น ๆ                         → kind SCHEMA_CHANGE
 *   - evt_ddl_audit_drop (sql_drop): จับ DROP TRIGGER / DROP TABLE บนตารางที่เฝ้า
 *     · trigger → kind DROP_TRIGGER · table → kind SCHEMA_CHANGE
 *
 * backend (DbAuditService) poll ทุก 1 นาที → DISABLE/DROP = alert CRITICAL TRIGGER_DISABLED ·
 * อื่น ๆ = WARNING SCHEMA_CHANGED (migration ปกติของเราจะขึ้นอันนี้ — ยอมรับได้)
 *
 * เก็บ: session_user, current_user, inet_client_addr() (NULL เมื่อต่อผ่าน unix socket เช่น
 * docker exec psql), application_name, command/object, current_query() (ตัด 1000 ตัว · ซ่อนถ้ามี password)
 *
 * ⚠️ ข้อจำกัด: ตราบใดที่ app role ยังเป็น superuser ก็ยัง DROP EVENT TRIGGER / ปิด audit นี้ได้
 * (หรือ `SET session_replication_role = replica` เพื่อข้าม event trigger) — ปิดช่องนี้ในข้อ 4 เต็ม
 * (แยก role ให้ app ไม่ใช่ superuser/owner) ดู docs/runbooks/ddl-audit.md
 *
 * INSERT ของ event trigger เป็น DML ไม่ใช่ DDL → ไม่ยิง event trigger ซ้ำ (ไม่มี recursion)
 * เขียนให้รันซ้ำได้
 */
export class DbDdlAudit1791244800000 implements MigrationInterface {
  name = 'DbDdlAudit1791244800000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS db_audit_events (
        id                bigserial PRIMARY KEY,
        occurred_at       timestamptz NOT NULL DEFAULT now(),
        event_tag         text NOT NULL,
        command_tag       text,
        object_type       text,
        object_identity   text,
        on_table          text,
        kind              text NOT NULL,
        session_user_name text,
        current_user_name text,
        client_addr       inet,
        application_name  text,
        query             text,
        processed_at      timestamptz
      )
    `);
    // poll หยิบเฉพาะที่ยังไม่ได้ทำ alert — partial index ให้ query เบา
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_db_audit_unprocessed
        ON db_audit_events (id) WHERE processed_at IS NULL
    `);

    // ddl_command_end — ALTER/CREATE บนตารางที่เฝ้า
    await q.query(`
      CREATE OR REPLACE FUNCTION fn_ddl_audit() RETURNS event_trigger
      LANGUAGE plpgsql AS $fn$
      DECLARE
        r record;
        v_query text;
        v_kind  text;
        v_table text;
      BEGIN
        v_query := current_query();
        IF v_query ~* 'password' THEN v_query := '[redacted]'; END IF;
        v_query := left(coalesce(v_query, ''), 1000);
        FOR r IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
          v_table := split_part(coalesce(r.object_identity, ''), '.', 2);
          IF coalesce(r.schema_name, '') = 'public'
             AND v_table IN ('logs','log_batch_mapping','batch_log_snapshot','batches') THEN
            IF v_query ~* 'disable[[:space:]]+(replica[[:space:]]+|always[[:space:]]+)?trigger' THEN
              v_kind := 'DISABLE_TRIGGER';
            ELSIF v_query ~* 'enable[[:space:]]+(replica[[:space:]]+|always[[:space:]]+)?trigger' THEN
              v_kind := 'ENABLE_TRIGGER';
            ELSE
              v_kind := 'SCHEMA_CHANGE';
            END IF;
            INSERT INTO db_audit_events
              (event_tag, command_tag, object_type, object_identity, on_table, kind,
               session_user_name, current_user_name, client_addr, application_name, query)
            VALUES
              ('ddl_command_end', r.command_tag, r.object_type, r.object_identity, v_table, v_kind,
               session_user, current_user, inet_client_addr(),
               current_setting('application_name', true), v_query);
          END IF;
        END LOOP;
      END
      $fn$
    `);

    // sql_drop — DROP TRIGGER / DROP TABLE บนตารางที่เฝ้า
    await q.query(`
      CREATE OR REPLACE FUNCTION fn_ddl_audit_drop() RETURNS event_trigger
      LANGUAGE plpgsql AS $fn$
      DECLARE
        r record;
        v_query text;
        v_table text;
        v_kind  text;
      BEGIN
        v_query := current_query();
        IF v_query ~* 'password' THEN v_query := '[redacted]'; END IF;
        v_query := left(coalesce(v_query, ''), 1000);
        FOR r IN SELECT * FROM pg_event_trigger_dropped_objects() LOOP
          IF r.object_type = 'trigger' THEN
            -- object_identity เช่น 'trg_logs_no_update on public.logs'
            v_table := split_part(split_part(r.object_identity, ' on ', 2), '.', 2);
            v_kind := 'DROP_TRIGGER';
          ELSIF r.object_type = 'table' THEN
            v_table := r.object_name;
            v_kind := 'SCHEMA_CHANGE';
          ELSE
            CONTINUE;
          END IF;
          IF v_table IN ('logs','log_batch_mapping','batch_log_snapshot','batches') THEN
            INSERT INTO db_audit_events
              (event_tag, command_tag, object_type, object_identity, on_table, kind,
               session_user_name, current_user_name, client_addr, application_name, query)
            VALUES
              ('sql_drop',
               CASE WHEN r.object_type = 'trigger' THEN 'DROP TRIGGER' ELSE 'DROP TABLE' END,
               r.object_type, r.object_identity, v_table, v_kind,
               session_user, current_user, inet_client_addr(),
               current_setting('application_name', true), v_query);
          END IF;
        END LOOP;
      END
      $fn$
    `);

    // สร้าง event trigger ท้ายสุด (CREATE EVENT TRIGGER ไม่มี IF NOT EXISTS → drop ก่อน)
    await q.query(`DROP EVENT TRIGGER IF EXISTS evt_ddl_audit`);
    await q.query(
      `CREATE EVENT TRIGGER evt_ddl_audit ON ddl_command_end EXECUTE FUNCTION fn_ddl_audit()`,
    );
    await q.query(`DROP EVENT TRIGGER IF EXISTS evt_ddl_audit_drop`);
    await q.query(
      `CREATE EVENT TRIGGER evt_ddl_audit_drop ON sql_drop EXECUTE FUNCTION fn_ddl_audit_drop()`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP EVENT TRIGGER IF EXISTS evt_ddl_audit`);
    await q.query(`DROP EVENT TRIGGER IF EXISTS evt_ddl_audit_drop`);
    await q.query(`DROP FUNCTION IF EXISTS fn_ddl_audit()`);
    await q.query(`DROP FUNCTION IF EXISTS fn_ddl_audit_drop()`);
    await q.query(`DROP TABLE IF EXISTS db_audit_events`);
  }
}
