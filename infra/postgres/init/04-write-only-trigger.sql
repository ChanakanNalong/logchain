-- ป้องกัน DELETE และ UPDATE บน logs ที่ระดับ database (immutable logs)
CREATE OR REPLACE FUNCTION prevent_log_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'IMMUTABLE_LOG: % not permitted on logs table', TG_OP;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER trg_logs_no_delete
    BEFORE DELETE ON logs FOR EACH ROW
    EXECUTE FUNCTION prevent_log_mutation();

CREATE OR REPLACE TRIGGER trg_logs_no_update
    BEFORE UPDATE ON logs FOR EACH ROW
    EXECUTE FUNCTION prevent_log_mutation();