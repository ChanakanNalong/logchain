/** Shared shaping of `GET /logs` rows into what LogTable renders. */

export function toTone(sev: string): string {
  const s = (sev ?? "").toUpperCase();
  if (s === "CRITICAL" || s === "HIGH") return "danger";
  if (s === "WARNING" || s === "MEDIUM") return "warn";
  return "good";
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
