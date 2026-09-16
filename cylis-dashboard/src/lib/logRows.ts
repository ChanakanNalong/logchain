/** Shared shaping of `GET /logs` rows into what LogTable renders. */

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

export function mapLog(l: any) {
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
    sev: toTone(l.severity),
  };
}

/** `GET /logs` may return a bare array or a paginated `{ data: [...] }`. */
export function unwrapLogs(payload: any): any[] {
  return Array.isArray(payload) ? payload : (payload?.data ?? []);
}
