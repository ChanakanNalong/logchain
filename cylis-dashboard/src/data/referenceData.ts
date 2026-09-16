/**
 * Verified reference constants for the Dataset and Settings pages.
 *
 * Everything here describes something that genuinely exists OUTSIDE the running
 * LogChain API — the public HDFS_v1 corpus and the detection service's compiled-in
 * config — so it cannot be fetched from a backend endpoint. It is static by
 * necessity, NOT placeholder data.
 *
 * Every value below was read out of a real artefact; the source is cited inline.
 * If you change a number here, re-derive it from the cited source first.
 *
 * Sources (repo `logchain-detection`, sibling checkout of this repo):
 *   data/HDFS.log            — 11,175,629 raw lines
 *   data/anomaly_label.csv   — 575,061 labelled blocks
 *   data/drain_state.json    — 47 Drain3 templates
 *   app/model.py             — WINDOW_SIZE / TOP_K_G / NUM_CLASSES
 *   rules/security_rules.yaml — rule IDs, severities, thresholds
 */

// ─── HDFS_v1 corpus facts ────────────────────────────────────────────────────
// Counts verified by `wc -l` / `uniq -c` over the files above on 2026-09-14.

/** Raw log lines in data/HDFS.log (`wc -l`). */
export const HDFS_RAW_LINES = 11_175_629;
/** Labelled blocks in data/anomaly_label.csv, minus the CSV header. */
export const HDFS_TOTAL_BLOCKS = 575_061;
/** Rows labelled "Anomaly" in data/anomaly_label.csv. */
export const HDFS_ANOMALY_BLOCKS = 16_838;
/** Rows labelled "Normal" in data/anomaly_label.csv. */
export const HDFS_NORMAL_BLOCKS = 558_223;
/**
 * Distinct Drain3 templates in data/drain_state.json (47 keys).
 * Matches app/model.py NUM_CLASSES = 48 minus index 0, which is padding.
 */
export const HDFS_EVENT_TYPES = 47;
/** app/model.py WINDOW_SIZE — the LSTM input window DeepLog slides over a block. */
export const DEEPLOG_WINDOW_SIZE = 10;
/** app/model.py TOP_K_G — next event must fall inside the top-8 predictions. */
export const DEEPLOG_TOP_G = 8;

const pct = (n: number) => (n / HDFS_TOTAL_BLOCKS) * 100;

/** Share of blocks labelled normal / anomalous, derived — never hand-typed. */
export const HDFS_NORMAL_PCT = pct(HDFS_NORMAL_BLOCKS);
export const HDFS_ANOMALY_PCT = pct(HDFS_ANOMALY_BLOCKS);

export const datasetStats = [
  { l: "Raw log lines", v: HDFS_RAW_LINES.toLocaleString() },
  { l: "Total sequences (blocks)", v: HDFS_TOTAL_BLOCKS.toLocaleString() },
  { l: "Anomaly sequences", v: HDFS_ANOMALY_BLOCKS.toLocaleString() },
  { l: "Normal sequences", v: HDFS_NORMAL_BLOCKS.toLocaleString() },
  { l: "Unique event types", v: String(HDFS_EVENT_TYPES) },
  { l: "Window size", v: String(DEEPLOG_WINDOW_SIZE) },
  { l: "Source", v: "logpai/loghub" },
];

/**
 * Real, verbatim lines from the head of data/HDFS.log, each tagged with the
 * Drain3 template key it actually parses to (checked against drain_state.json).
 *
 * HDFS_v1 contains only INFO (10,812,836) and WARN (362,793) lines — there is
 * no ERROR level in this corpus, so don't add one to make the sample look
 * more dramatic.
 */
export const rawHdfsLogs = [
  {
    ts: "081109 203518",
    level: "INFO",
    event: "E1",
    block: "blk_-1608999687919862906",
    text: "Receiving block blk_-1608999687919862906 src: /10.250.19.102:54106 dest: /10.250.19.102:50010",
  },
  {
    ts: "081109 203518",
    level: "INFO",
    event: "E2",
    block: "blk_-1608999687919862906",
    text: "BLOCK* NameSystem.allocateBlock: /mnt/hadoop/mapred/system/job_200811092030_0001/job.jar. blk_-1608999687919862906",
  },
  {
    ts: "081109 203519",
    level: "INFO",
    event: "E3",
    block: "blk_-1608999687919862906",
    text: "PacketResponder 1 for block blk_-1608999687919862906 terminating",
  },
  {
    ts: "081109 203519",
    level: "INFO",
    event: "E5",
    block: "blk_-1608999687919862906",
    text: "BLOCK* NameSystem.addStoredBlock: blockMap updated: 10.250.10.6:50010 is added to blk_-1608999687919862906 size 91178",
  },
  {
    ts: "081109 204917",
    level: "WARN",
    event: "E21",
    block: "blk_3888635850409849568",
    text: "BLOCK* NameSystem.addStoredBlock: Redundant addStoredBlock request received for blk_3888635850409849568 on 10.251.107.227:50010 size 67108864",
  },
];

export const dataSources = [
  { name: "logpai/loghub", url: "github.com/logpai/loghub", desc: "Repository หลักของ HDFS_v1 และ dataset อีก 16 ชุด" },
  { name: "ait-aecid/anomaly-detection-log-datasets", url: "github.com/ait-aecid", desc: "Dataset สำหรับ anomaly detection หลาย format" },
  { name: "CIC-IDS 2017", url: "unb.ca/cic/datasets", desc: "Network intrusion detection จาก Canadian Institute" },
  { name: "Mordor Project", url: "github.com/OTRF/mordor", desc: "Windows event log จำลองการโจมตีตาม MITRE ATT&CK" },
];

// ─── Detection / alerting config ─────────────────────────────────────────────

export const alertConfig = [
  {
    // app/model.py TOP_K_G = 8 ("ค่าที่ได้ F1 ดีสุดจาก detect.py").
    // DeepLog does NOT score against a probability threshold — it ranks the next
    // event against the model's top-g predicted candidates.
    label: "Top-g candidates (DeepLog)",
    desc: "Flag a sequence when the next event falls outside the model's top-g predicted candidates.",
    value: `top-${DEEPLOG_TOP_G}`,
  },
  {
    // rules/security_rules.yaml rule 5710: threshold.count=5, window_seconds=60.
    label: "Failed login burst",
    desc: "Flag when failed logins from one IP exceed this count in 60 seconds (rule 5710).",
    value: "5 attempts / 60s",
  },
  {
    // src/notification/notification.service.ts sends alert emails over SMTP via
    // nodemailer — there is no Slack integration in the backend.
    label: "Notify channel",
    desc: "Where alerts are delivered.",
    value: "Email (SMTP / nodemailer)",
  },
  {
    // alerts.service.ts createOrDedup(): only HIGH and CRITICAL trigger an email.
    label: "Email severity floor",
    desc: "Only alerts at or above this severity send an email; the rest stay in the alert list.",
    value: "HIGH / CRITICAL",
  },
];

/**
 * Role names + descriptions mirror infra/keycloak/realm-logchain.json.template
 * (realm role definitions) and src/admin/admin.constants.ts APP_ROLES — these
 * five are the only roles the backend will assign.
 * User counts are NOT hardcoded: Settings.tsx fetches them live from
 * GET /api/v1/admin/users (admin-only) and hides the column if that fails.
 */
export const rbacRoles = [
  { role: "admin", perms: "Full access" },
  { role: "operator", perms: "Acknowledge and resolve alerts" },
  { role: "ingestor", perms: "POST logs only (service account)" },
  { role: "analyst", perms: "View logs, alerts, integrity" },
  { role: "auditor", perms: "Read compliance reports" },
];
