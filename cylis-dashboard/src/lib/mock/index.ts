/**
 * Mock backend for NEXT_PUBLIC_USE_MOCK=1. Only loaded through a dynamic
 * import in lib/endpoints.ts, so a build without the flag ships none of it.
 * Errors are thrown in the axios shape (`e.response.status` / `.data`) so the
 * views handle them exactly like real API failures.
 */
import type { AlertDetail, AlertItem, BatchDiff, BatchesPage, BatchesQuery, BatchTree, LogAlertRef, LogDetail, LogProofResult, LogsPage, LogsQuery } from "@/types/api";
import { normalizeSearch } from "@/lib/searchText";
import { MOCK_ALERTS, MOCK_LOGS } from "./data";
import { MOCK_BATCH_LIST, buildDiff, diffChainIsDown } from "./batches";
import { buildProof, buildTree, treeChainIsDown } from "./trees";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLE_ORDER = { trigger: 0, window: 1, prior: 2, repeat: 3 } as const;

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpError(status: number, message: string | string[], error: string) {
  return Object.assign(new Error(`mock ${status}`), {
    response: { status, data: { message, error, statusCode: status } },
  });
}

function requireUuid(id: string, what: string) {
  if (!UUID_RE.test(id)) throw httpError(400, `${what} ID must be a full UUID`, "Bad Request");
}

export async function getLogs(query: LogsQuery): Promise<LogsPage> {
  await delay(250);
  const limit = query.limit ?? 100;
  const offset = query.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw httpError(400, [limit > 1000 ? "limit must not be greater than 1000" : "limit must not be less than 1"], "Bad Request");
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw httpError(400, ["offset must not be less than 0"], "Bad Request");
  }
  // same cleaning as the search box (lib/searchText.ts), then a case-insensitive substring like ILIKE
  const q = normalizeSearch(query.q ?? "").toLowerCase();
  const inList = (list: string[] | undefined, v: string) => !list?.length || list.includes(v);
  const rows = MOCK_LOGS.map((l) => l.item).filter(
    (l) =>
      inList(query.source, l.source) &&
      inList(query.severity, l.severity) &&
      inList(query.eventType, l.eventType) &&
      (!q || l.message.toLowerCase().includes(q)),
  );
  return { items: rows.slice(offset, offset + limit), total: rows.length, limit, offset };
}

function alertsForLog(logId: string): LogAlertRef[] {
  return MOCK_ALERTS.flatMap(({ alert, links }) => {
    const link = links.find((l) => l.logId === logId);
    if (!link) return [];
    return [{
      id: alert.id,
      alertType: alert.alertType,
      ruleId: alert.ruleId ?? null,
      severity: alert.severity,
      title: alert.title,
      status: alert.status,
      sourceIp: alert.sourceIp ?? null,
      occurrenceCount: alert.occurrenceCount ?? 1,
      createdAt: alert.createdAt,
      lastSeenAt: alert.lastSeenAt ?? alert.createdAt,
      role: link.role,
    }];
  });
}

export async function getLogDetail(id: string): Promise<LogDetail> {
  requireUuid(id, "Log");
  const found = MOCK_LOGS.find((l) => l.item.id === id);
  // the real endpoint reads the chain live (≤ 5 s) — keep it visibly slower
  await delay(found?.batch && "error" in found.batch.chainCheck ? 3000 : found?.batch ? 1200 : 300);
  if (!found) throw httpError(404, "Log not found", "Not Found");

  const { batchId: _b, batchStatus: _s, txHash: _t, blockNumber: _n, polygonscanUrl: _p, ...log } = found.item;
  // same Merkle proof as GET /logs/:id/proof (lib/mock/trees.ts) — the drawer and Verify must agree
  const real = found.batch ? buildProof(id) : null;
  const checkedAt = new Date().toISOString();
  return {
    log,
    batch: found.batch?.info ?? null,
    proof: real ? { verified: real.verify, path: real.proof } : found.proof,
    alerts: alertsForLog(id),
    chainCheck: found.batch ? { ...found.batch.chainCheck, checkedAt } : null,
  };
}

export async function getAlerts(): Promise<AlertItem[]> {
  await delay(250);
  return MOCK_ALERTS.map((a) => ({ ...a.alert })).sort((a, b) =>
    (b.lastSeenAt ?? b.createdAt).localeCompare(a.lastSeenAt ?? a.createdAt),
  );
}

export async function getAlert(id: string): Promise<AlertDetail> {
  requireUuid(id, "Alert");
  await delay(400);
  const found = MOCK_ALERTS.find((a) => a.alert.id === id);
  if (!found) throw httpError(404, "Alert not found", "Not Found");
  const logs = found.links
    .map((link) => {
      const l = MOCK_LOGS.find((m) => m.item.id === link.logId)!.item;
      return { id: l.id, role: link.role, message: l.message, sourceIp: l.sourceIp, createdAt: l.createdAt, batchStatus: l.batchStatus };
    })
    .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.createdAt.localeCompare(b.createdAt));
  return { alert: { ...found.alert }, logs };
}

/** Mutates the in-memory set so the list shows RESOLVED after a reload of the data (not of the page) */
export async function resolveAlert(id: string): Promise<void> {
  requireUuid(id, "Alert");
  await delay(300);
  const found = MOCK_ALERTS.find((a) => a.alert.id === id);
  if (!found) throw httpError(404, "Alert not found", "Not Found");
  found.alert.status = "RESOLVED";
}

export async function getBatches(query: BatchesQuery): Promise<BatchesPage> {
  await delay(250);
  const limit = query.limit ?? 10;
  const offset = query.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw httpError(400, [limit > 100 ? "limit must not be greater than 100" : "limit must not be less than 1"], "Bad Request");
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw httpError(400, ["offset must not be less than 0"], "Bad Request");
  }
  const statuses = (query.status ?? []).map((s) => s.toUpperCase());
  const rows = MOCK_BATCH_LIST.filter((b) => !statuses.length || statuses.includes(b.status));
  return { items: rows.slice(offset, offset + limit), total: rows.length, limit, offset };
}

export async function getBatchDiff(id: string): Promise<BatchDiff> {
  if (!UUID_RE.test(id)) throw httpError(400, "Batch ID must be a UUID", "Bad Request");
  // reads the chain live like the real endpoint — slower when the RPC "times out"
  await delay(diffChainIsDown(id) ? 3000 : 1500);
  const diff = buildDiff(id);
  if (!diff) throw httpError(404, "Batch not found", "Not Found");
  return diff;
}

export async function getBatchTree(id: string): Promise<BatchTree> {
  if (!UUID_RE.test(id)) throw httpError(400, "Batch ID must be a UUID", "Bad Request");
  await delay(treeChainIsDown(id) ? 3000 : 900);
  const tree = buildTree(id);
  if (!tree) throw httpError(404, "Batch not found", "Not Found");
  return tree;
}

export async function getLogProof(id: string): Promise<LogProofResult> {
  requireUuid(id, "Log");
  await delay(400);
  const proof = buildProof(id);
  // unsealed or unknown log — the backend answers 404 for both
  if (!proof) throw httpError(404, "Log not found or not yet sealed", "Not Found");
  return proof;
}
