CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── logs ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS logs (
  id                UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
  source            VARCHAR(128)    NOT NULL,
  source_id         INET,
  event_type        VARCHAR(64)     NOT NULL,
  severity          VARCHAR(16)     NOT NULL DEFAULT 'INFO',
  message           TEXT            NOT NULL,
  raw_hash          CHAR(64)        NOT NULL,
  classification    VARCHAR(16)     NOT NULL DEFAULT 'INTERNAL',
  retention_days    INTEGER         NOT NULL DEFAULT 365,
  cde_scope         BOOLEAN         NOT NULL DEFAULT FALSE,
  batch_id          UUID,
  created_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_logs_created_at ON logs(created_at DESC);
CREATE INDEX idx_logs_source ON logs(source);
CREATE INDEX idx_logs_severity ON logs(severity);
CREATE INDEX idx_logs_cde ON logs(cde_scope);

-- ── batches ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS batches (
  id                UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
  merkle_root       CHAR(64)        NOT NULL,
  log_count         INTEGER         NOT NULL,
  tx_hash           VARCHAR(128),
  block_number      BIGINT,
  status            VARCHAR(16)     NOT NULL DEFAULT 'PENDING',
  sealed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at      TIMESTAMPTZ
);

-- ── alerts ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alerts (
  id                UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
  log_id            UUID,
  batch_id          UUID,
  alert_type        VARCHAR(64)     NOT NULL,
  severity          VARCHAR(16)     NOT NULL,
  source            VARCHAR(32)     NOT NULL,
  title             TEXT            NOT NULL,
  detail            JSONB,
  status            VARCHAR(16)     NOT NULL DEFAULT 'OPEN',
  created_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- ── audit_access ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_access (
  id                UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           VARCHAR(128)    NOT NULL,
  username          VARCHAR(128),
  action            VARCHAR(64)     NOT NULL,
  resource          VARCHAR(256)    NOT NULL,
  method            VARCHAR(8),
  status_code       INTEGER,
  ip_address        INET,
  duration_ms       INTEGER,
  created_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_access(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_accessed ON audit_access(created_at DESC);

-- ── log_batch_mapping (ยก batch_id ออกจาก logs) ──────
-- logs table ยังคง INSERT-only สมบูรณ์ การผูก batch ทำที่นี่แทน

CREATE TABLE IF NOT EXISTS log_batch_mapping (
  log_id            UUID            PRIMARY KEY REFERENCES logs(id),
  batch_id          UUID            NOT NULL REFERENCES batches(id),
  mapped_at         TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_mapping_batch ON log_batch_mapping(batch_id);