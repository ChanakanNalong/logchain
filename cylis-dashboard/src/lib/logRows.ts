/** Shared shaping of `GET /logs` rows into what LogTable renders. */
import type { BatchStatus, LogItem } from "@/types/api";

/** One LogTable row */
export interface LogRow {
  id: string;
  ts: string;
  source: string;
  ip: string;
  event: string;
  attackType: string;
  severity: string;
  sev: string;
  batchStatus: BatchStatus | null;
  polygonscanUrl: string | null;
  /** matched via a masked IP in the message (.xxx), not an exact source_id — real IP may be another .x */
  maskedIp: boolean;
}

/**
 * Map a backend severity to a Badge colour.
 *
 * The only values the API can store are the CreateLogDto enum
 * (src/logs/dto/create-log.dto.ts): DEBUG | INFO | WARNING | ERROR | CRITICAL.
 * ERROR has to land on "danger" — it used to fall through to "good" and render
 * an error-level log green. HIGH/MEDIUM are deliberately gone: they were never
 * backend values, only labels from the old mock rows.
 */
export function toTone(sev: string): string {
  switch ((sev ?? "").toUpperCase()) {
    case "CRITICAL":
    case "ERROR":
      return "danger";
    case "WARNING":
      return "warn";
    default: // DEBUG | INFO | anything unrecognised
      return "good";
  }
}

/**
 * Badge colour for an alert severity. Alerts carry more levels than logs
 * (detection also emits HIGH / MEDIUM), so this is not toTone.
 */
export function alertTone(sev: string): string {
  switch ((sev ?? "").toUpperCase()) {
    case "CRITICAL":
    case "ERROR":
      return "danger";
    case "HIGH":
    case "WARNING":
      return "warn";
    case "MEDIUM":
      return "cyan";
    default:
      return "neutral";
  }
}

export function mapLog(l: Partial<LogItem>): LogRow {
  return {
    // full UUID — LogTable truncates for display so the value stays copyable
    // and can be pasted straight into Verify (GET /logs/:id/proof needs it whole)
    id: l.id ?? "—",
    ts: l.createdAt ? new Date(l.createdAt).toLocaleString("sv-SE") : "—",
    source: l.source ?? "—",
    ip: l.sourceIp ?? "—",
    event: l.message ?? "—",
    attackType: l.eventType ?? "—",
    severity: l.severity ?? "—",
    sev: toTone(l.severity ?? ""),
    // older backends (bare array) have no batch columns → shown as not sealed
    batchStatus: l.batchStatus ?? null,
    polygonscanUrl: l.polygonscanUrl ?? null,
    maskedIp: l.matchedMaskedIp === true,
  };
}

/**
 * `GET /logs` returns `{ items, total, limit, offset }` (docs/api/logs-alerts.md §1).
 * A bare array (older backend) and `{ data }` still work, so Dashboard/Verify
 * don't go blank if the envelope changes again.
 */
export function unwrapLogs(payload: any): Partial<LogItem>[] {
  if (Array.isArray(payload)) return payload;
  return payload?.items ?? payload?.data ?? [];
}
