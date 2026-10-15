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
