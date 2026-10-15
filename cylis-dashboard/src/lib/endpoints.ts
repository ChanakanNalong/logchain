/**
 * Typed calls for the logs/alerts API (docs/api/logs-alerts.md).
 *
 * NEXT_PUBLIC_USE_MOCK=1 swaps every call here for the in-memory mock in
 * lib/mock/. This file is the only place that reads the flag. The flag is
 * always inlined (next.config.ts pins it to "0" unless it is "1"), and the
 * import sits directly under that constant condition, so a normal build drops
 * the branch and never emits the mock chunk — the default is the real API.
 * Mock mode still signs in through Keycloak; roles come from the real token.
 */
import { api } from "@/lib/api";
import type { AlertDetail, AlertItem, BatchDiff, BatchesPage, BatchesQuery, BatchTree, LogDetail, LogProofResult, LogsPage, LogsQuery } from "@/types/api";

/** For a "mock data" marker in the UI */
export const USE_MOCK = process.env.NEXT_PUBLIC_USE_MOCK === "1";

/** The mock module, or null when mock mode is off */
function loadMock() {
  // keep the env comparison inline here — a variable would stop the bundler
  // from removing the import at build time
  return process.env.NEXT_PUBLIC_USE_MOCK === "1" ? import("./mock") : null;
}

/** Arrays go out comma-joined; empty values are left off the query entirely */
function logsParams(query: LogsQuery) {
  const join = (v?: string[]) => (v && v.length ? v.join(",") : undefined);
  return {
    limit: query.limit,
    offset: query.offset,
    source: join(query.source),
    severity: join(query.severity),
    eventType: join(query.eventType),
    q: query.q || undefined,
  };
}

export async function getLogs(query: LogsQuery): Promise<LogsPage> {
  const mock = await loadMock();
  if (mock) return mock.getLogs(query);
  const r = await api.get<LogsPage>("/logs", { params: logsParams(query) });
  return r.data;
}

export async function getLogDetail(id: string): Promise<LogDetail> {
  const mock = await loadMock();
  if (mock) return mock.getLogDetail(id);
  const r = await api.get<LogDetail>(`/logs/${id}/detail`);
  return r.data;
}

export async function getAlerts(): Promise<AlertItem[]> {
  const mock = await loadMock();
  if (mock) return mock.getAlerts();
  const r = await api.get<AlertItem[]>("/alerts");
  return r.data ?? [];
}

export async function getAlert(id: string): Promise<AlertDetail> {
  const mock = await loadMock();
  if (mock) return mock.getAlert(id);
  const r = await api.get<AlertDetail>(`/alerts/${id}`);
  return r.data;
}

export async function resolveAlert(id: string): Promise<void> {
  const mock = await loadMock();
  if (mock) return mock.resolveAlert(id);
  await api.patch(`/alerts/${id}/resolve`);
}

/** GET /batches — `status` goes out comma-joined */
export async function getBatches(query: BatchesQuery): Promise<BatchesPage> {
  const mock = await loadMock();
  if (mock) return mock.getBatches(query);
  const r = await api.get<BatchesPage>("/batches", {
    params: { limit: query.limit, offset: query.offset, status: query.status?.length ? query.status.join(",") : undefined },
  });
  return r.data;
}

/** GET /batches/:id/diff — admin / auditor only; reads the chain live */
export async function getBatchDiff(id: string): Promise<BatchDiff> {
  const mock = await loadMock();
  if (mock) return mock.getBatchDiff(id);
  const r = await api.get<BatchDiff>(`/batches/${id}/diff`);
  return r.data;
}

/** GET /batches/:id/tree — layers, roots and anchoring cost; reads the chain live */
export async function getBatchTree(id: string): Promise<BatchTree> {
  const mock = await loadMock();
  if (mock) return mock.getBatchTree(id);
  const r = await api.get<BatchTree>(`/batches/${id}/tree`);
  return r.data;
}

/** GET /logs/:id/proof — Merkle proof of one log against the batch root in the DB */
export async function getLogProof(id: string): Promise<LogProofResult> {
  const mock = await loadMock();
  if (mock) return mock.getLogProof(id);
  const r = await api.get<LogProofResult>(`/logs/${id}/proof`);
  return r.data;
}
