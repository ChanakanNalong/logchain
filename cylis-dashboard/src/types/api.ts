/**
 * Shapes of the backend JSON this dashboard reads.
 * Contract: docs/api/logs-alerts.md (repo root) — keep these in step with it.
 * Times are ISO-8601 UTC strings; every `id` is a full UUID.
 */

/** `batchStatus: null` on a log = not sealed into a batch yet */
export type BatchStatus = "PENDING" | "SEALED" | "UNVERIFIED" | "CONFIRMED" | "TAMPERED" | "FAILED";

/** Paged list envelope (`GET /logs`, `GET /batches`) */
export interface Paged<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/** One row of `GET /logs` — the log plus the on-chain status of its batch */
export interface LogItem {
  id: string;
  createdAt: string;
  source: string;
  sourceIp: string | null;
  eventType: string;
  severity: string;
  message: string;
  classification: string;
  cdeScope: boolean;
  retentionDays: number;
  /** hex 64, no 0x */
  rawHash: string;
  batchId: string | null;
  batchStatus: BatchStatus | null;
  txHash: string | null;
  blockNumber: number | null;
  /** null when there is no tx, or the explorer is unset (Hardhat) */
  polygonscanUrl: string | null;
}

export type LogsPage = Paged<LogItem>;

/** Query of `GET /logs` — the array fields go out comma-joined (OR within a field, AND across fields) */
export interface LogsQuery {
  limit?: number;
  offset?: number;
  source?: string[];
  severity?: string[];
  eventType?: string[];
  /** ILIKE on `message`, ≤ 200 chars */
  q?: string;
}

/** The log part of `GET /logs/:id/detail` (no batch columns) */
export type LogRecord = Omit<LogItem, "batchId" | "batchStatus" | "txHash" | "blockNumber" | "polygonscanUrl">;

export interface BatchInfo {
  id: string;
  status: BatchStatus;
  /** hex 64, no 0x */
  merkleRoot: string;
  txHash: string | null;
  blockNumber: number | null;
  polygonscanUrl: string | null;
  sealedAt: string;
  confirmedAt: string | null;
}

export interface ProofStep {
  position: "left" | "right";
  /** 0x-prefixed */
  data: string;
}

export interface LogProof {
  /** the proof rebuilds `batch.merkleRoot` (checked against the DB, not the chain) */
  verified: boolean;
  path: ProofStep[];
}

/** Live root check against the contract. The `error` form still comes back as HTTP 200. */
export type ChainCheck =
  | { chainRoot: string; dbRoot: string; match: boolean; checkedAt: string }
  | { error: string; checkedAt: string };

/** How a log relates to an alert (docs/api/logs-alerts.md §4) */
export type AlertLogRole = "trigger" | "window" | "prior" | "repeat";

/** An alert as listed inside a log's detail */
export interface LogAlertRef {
  id: string;
  alertType: string;
  ruleId: string | null;
  severity: string;
  title: string;
  status: string;
  sourceIp: string | null;
  occurrenceCount: number;
  createdAt: string;
  lastSeenAt: string;
  role: AlertLogRole;
}

export interface LogDetail {
  log: LogRecord;
  batch: BatchInfo | null;
  proof: LogProof | null;
  alerts: LogAlertRef[];
  /** null = not sealed yet, nothing to compare */
  chainCheck: ChainCheck | null;
}

/** One row of `GET /alerts` (a bare array, not paged) */
export interface AlertItem {
  id: string;
  logId: string | null;
  batchId: string | null;
  alertType: string;
  ruleId?: string | null;
  severity: string;
  source: string;
  sourceIp?: string | null;
  title: string;
  detail: Record<string, unknown> | null;
  status: string;
  /** first occurrence */
  createdAt: string;
  /** times this alert fired while OPEN (1 = once). Older backends don't send it */
  occurrenceCount?: number;
  /** most recent occurrence — the list is ordered by this */
  lastSeenAt?: string;
  lastNotifiedAt?: string | null;
}

/** A log linked to an alert, as listed by `GET /alerts/:id` */
export interface AlertLogRef {
  id: string;
  role: AlertLogRole;
  message: string;
  sourceIp: string | null;
  createdAt: string;
  batchStatus: BatchStatus | null;
}

export interface AlertDetail {
  alert: AlertItem;
  logs: AlertLogRef[];
}

/* ── Batch audit — docs/api/batches-diff.md ─────────────────────────── */

/** One row of `GET /batches` */
export interface BatchListItem {
  id: string;
  /** hex 64, no 0x */
  merkleRoot: string;
  txHash: string | null;
  blockNumber: number | null;
  polygonscanUrl: string | null;
  status: BatchStatus;
  /** logs sealed into the batch */
  logCount: number;
  sealedAt: string;
  confirmedAt: string | null;
  ifAnomaly?: boolean | null;
  ifScore?: number | null;
  ifReason?: string | null;
  ifScoredAt?: string | null;
  /** false = sealed before snapshots existed → diff is batch-level only */
  hasSnapshot?: boolean;
  /**
   * Not in GET /batches yet (only in GET /batches/:id/tree → cost) — the mock
   * sends them; the real list shows "—" until the backend adds them.
   * Decimal string (like /tree) or number.
   */
  gasUsed?: string | number | null;
  effectiveGasPriceGwei?: string | number | null;
}

export type BatchesPage = Paged<BatchListItem>;

export interface BatchesQuery {
  limit?: number;
  offset?: number;
  status?: string[];
}

export type BatchChangeType = "CONTENT_MODIFIED" | "HASH_MODIFIED" | "DELETED" | "UNMAPPED_OR_INSERTED";

/** A log as stored in the seal-time snapshot (DELETED) or as it is now (UNMAPPED_OR_INSERTED) */
export interface SnapshotLog {
  id: string;
  createdAt: string;
  source: string;
  sourceIp: string | null;
  eventType: string;
  severity: string;
  message: string;
  classification: string;
  cdeScope: boolean;
  rawHash: string;
}

export interface FieldChange {
  field: string;
  before: string | boolean | null;
  after: string | boolean | null;
}

export interface BatchChange {
  /** leaf index in the Merkle tree, from 0 */
  position: number;
  logId: string;
  type: BatchChangeType;
  /** CONTENT_MODIFIED / HASH_MODIFIED */
  fields?: FieldChange[];
  /** DELETED: the row is gone, or only its mapping to this batch */
  reason?: "ROW_MISSING" | "MAPPING_MISSING";
  /** DELETED: content at seal time */
  snapshot?: SnapshotLog;
  /** UNMAPPED_OR_INSERTED: content now */
  current?: SnapshotLog;
}

export type DiffVerdict = "INTACT" | "TAMPERED" | "UNVERIFIABLE";

export interface BatchDiff {
  batchId: string;
  status: BatchStatus;
  txHash: string | null;
  blockNumber: number | null;
  polygonscanUrl: string | null;
  /** null = chain unreadable (see chainError) · 0x000… = never anchored */
  chainRoot: string | null;
  chainError: string | null;
  /** root rebuilt from the seal-time snapshot · null for legacy batches */
  snapshotRoot: string | null;
  /** root stored in the DB at seal */
  dbRoot: string;
  /** root rebuilt from the logs mapped to the batch now · null when none are left */
  currentRoot: string | null;
  /** null for legacy batches */
  snapshotTrusted: boolean | null;
  /** what the snapshot was checked against · null for legacy */
  trustBasis: "chain" | "db" | null;
  untrustedReasons: ("SNAPSHOT_ROOT_MISMATCH" | "SNAPSHOT_CONTENT_MISMATCH")[];
  legacy: boolean;
  checkedAt: string;
  summary: {
    verdict: DiffVerdict;
    snapshotLogs: number;
    mappedLogs: number;
    /** per-position counts are null when the snapshot is untrusted or missing */
    unchanged: number | null;
    contentModified: number | null;
    hashModified: number | null;
    deleted: number | null;
    unmappedOrInserted: number | null;
  };
  changes: BatchChange[];
}

/* ── Merkle tree + proof — docs/api/merkle-tree.md ──────────────────── */

/** Decimal as text (backend) — the worksheet example sends numbers, so both are accepted */
export type Decimalish = string | number;

export interface CostTriple {
  batch: Decimalish;
  perLog: Decimalish;
  oneTxPerLog: Decimalish;
}

export interface TreeCost {
  gasUsed: Decimalish;
  effectiveGasPriceGwei: Decimalish;
  batchCostPol: Decimalish;
  perLogCostPol: Decimalish;
  /** logCount × batchCostPol — anchoring one log per tx */
  oneTxPerLogCostPol: Decimalish;
  savingFactor: Decimalish;
  /** POL value converted at the configured rate — null when the rate is unset */
  eth: CostTriple | null;
  thb: CostTriple | null;
  rates: {
    polEth: Decimalish | null;
    polThb: Decimalish | null;
    asOf: string | null;
    source: "config";
  };
}

/** GET /batches/:id/tree — built from the logs mapped to the batch now */
export interface BatchTree {
  batchId: string;
  status: BatchStatus;
  logCount: number;
  txHash: string | null;
  blockNumber: number | null;
  polygonscanUrl: string | null;
  /** root stored at seal (0x…) */
  dbRoot: string;
  /** root rebuilt from `layers` */
  computedRoot: string;
  rootMatchesDb: boolean;
  /** null = chain unreadable · 0x000… = not anchored */
  chainRoot: string | null;
  chainError: string | null;
  checkedAt: string;
  /** createdAt ASC, id ASC */
  leaves: { index: number; logId: string; rawHash: string; leafHash: string }[];
  /** layers[0] = leaf hashes … layers[last] = [root]; 2k and 2k+1 make node k above */
  layers: string[][];
  /** odd last node of a layer, moved up unchanged to floor(index/2) */
  promoted: { layer: number; index: number }[];
  cost: TreeCost | null;
}

/** GET /logs/:id/proof */
export interface LogProofResult {
  logId: string;
  /** hex 64, no 0x */
  rawHash: string;
  /** = leaves[].index of the tree */
  leafIndex: number;
  leafHash: string;
  batch: {
    id: string;
    /** hex 64, no 0x */
    merkleRoot: string;
    txHash: string | null;
    blockNumber: number | null;
    status: BatchStatus;
    ifAnomaly?: boolean | null;
    ifReason?: string | null;
  };
  proof: ProofStep[];
  /** proof rebuilds batch.merkleRoot (the DB root, not the chain) */
  verify: boolean;
}
