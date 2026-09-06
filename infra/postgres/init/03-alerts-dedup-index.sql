-- Dedup guard for open alerts.
-- findOne-then-save in AlertsService.createOrDedup is not atomic: two alerts
-- arriving milliseconds apart can both see "no existing OPEN" and both insert.
-- This index makes the database the source of truth for that invariant.
--
-- batch_id is included so integrity alerts stay per-batch (each tampered batch
-- deserves its own alert), while Kafka alerts (batch_id NULL) dedup on
-- alert_type + source alone.
CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_open_dedup
  ON alerts (alert_type, source, COALESCE(batch_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status = 'OPEN';