import { useMemo, useState, useEffect, type ReactNode, type CSSProperties } from "react";
import { Download, RefreshCw, ShieldCheck, Archive, Activity, UserX } from "lucide-react";
import { useTheme, monoFont, sansFont } from "@/theme";
import { Card, Badge, Button } from "@/components/ui";
import { api } from "@/lib/api";

/**
 * Shape of GET /api/v1/compliance/reports — see src/compliance/compliance.service.ts.
 * `erasure[].records` mirrors the tombstone written by ErasureService.eraseUser
 * (userId/requestedBy/deletedAt/recordsDeleted/hash) — NOT a generic "requester" field.
 */
interface ReportData {
  period: { from: string; to: string };
  generatedAt: string;
  integrity: {
    day: string;
    confirmed: number;
    tampered: number;
    unverified: number;
    pending: number;
    total: number;
    integrityRate: number;
  }[];
  retention: { expired: number; dueIn30d: number; cdeScoped: number; total: number };
  erasure: {
    day: string;
    requests: number;
    records: {
      userId?: string;
      requestedBy?: string;
      deletedAt?: string;
      recordsDeleted?: number;
      hash?: string;
    }[];
  }[];
  audit: { day: string; byAction: Record<string, number> }[];
}

// group วันด้วย Asia/Bangkok (UTC+7) ให้ตรงกับ backend — กันช่วงตี 0-7 โมงส่งวันผิด
const fmt = (d: Date) => new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
const daysAgo = (d: Date, n: number) => new Date(d.getTime() - n * 86400000);

/** every calendar day between from/to inclusive — used to zero-fill days the API omitted */
function enumerateDays(from: string, to: string): string[] {
  const days: string[] = [];
  let cur = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cur <= end) {
    days.push(cur.toISOString().slice(0, 10));
    cur = new Date(cur.getTime() + 86400000);
  }
  return days;
}

/** "GET /api/v1/foo" -> { method, path }; admin-style actions like "ROLE_ASSIGN" -> null */
function parseEndpointAction(action: string): { method: string; path: string } | null {
  const m = /^(GET|POST|PUT|PATCH|DELETE)\s+(.+)$/.exec(action);
  return m ? { method: m[1], path: m[2] } : null;
}

// tones picked to match reference-reports.html's .v-get/.v-post/.v-patch colors
// (GET=blue, POST=good/green, PATCH=warn/amber); PUT/DELETE aren't in that sample, so they
// take the remaining distinct theme tones.
const METHOD_TONE: Record<string, string> = {
  GET: "blue",
  POST: "good",
  PUT: "cyan",
  PATCH: "warn",
  DELETE: "danger",
};

/** escape ค่าให้ปลอดภัยใน CSV (comma / quote / newline) */
const csvCell = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;

/** flatten any per-day / snapshot section into rows for a CSV file */
function toCsv(data: ReportData): string {
  const lines: string[] = [];
  lines.push("section,day,key,value");
  data.integrity.forEach((r) =>
    ["confirmed", "tampered", "unverified", "pending", "total", "integrityRate"].forEach((k) =>
      lines.push(`integrity,${r.day},${k},${(r as any)[k]}`),
    ),
  );
  (["expired", "dueIn30d", "cdeScoped", "total"] as const).forEach((k) =>
    lines.push(`retention,,${k},${data.retention[k]}`),
  );
  data.erasure.forEach((r) => {
    lines.push(`erasure,${r.day},requests,${r.requests}`);
    r.records?.forEach((rec) => {
      lines.push(`erasure,${r.day},userId,${csvCell(rec.userId)}`);
      lines.push(`erasure,${r.day},requestedBy,${csvCell(rec.requestedBy)}`);
      lines.push(`erasure,${r.day},deletedAt,${csvCell(rec.deletedAt)}`);
      lines.push(`erasure,${r.day},recordsDeleted,${csvCell(rec.recordsDeleted)}`);
    });
  });
  data.audit.forEach((r) =>
    Object.entries(r.byAction).forEach(([k, v]) => lines.push(`audit,${r.day},${csvCell(k)},${v}`)),
  );
  return lines.join("\n");
}

function download(filename: string, text: string, type: string) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function headCell(t: any, extra: CSSProperties = {}): CSSProperties {
  return {
    padding: "8px 10px",
    textAlign: "left",
    color: t.muted,
    fontSize: 11,
    fontWeight: 500,
    lineHeight: 1.5,
    whiteSpace: "nowrap",
    ...sansFont,
    ...extra,
  };
}

function bodyCell(t: any, extra: CSSProperties = {}): CSSProperties {
  return {
    padding: "8px 10px",
    borderTop: `1px solid ${t.border}`,
    fontSize: 12.5,
    lineHeight: 1.5,
    ...extra,
  };
}

function ReportFrame({ header, children }: { header: ReactNode; children: ReactNode }) {
  return (
    <div
      style={{
        boxSizing: "border-box",
        padding: 20,
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      {header}
      {children}
    </div>
  );
}

export default function Reports() {
  const t = useTheme();
  const toneColor = (tone: string) => (tone === "neutral" || tone === "muted" ? t.muted : (t as any)[tone] ?? t.blue);

  const today = useMemo(() => new Date(), []);
  const [from, setFrom] = useState(fmt(daysAgo(today, 6))); // default: last 7 days
  const [to, setTo] = useState(fmt(today));
  const [data, setData] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [forbidden, setForbidden] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setForbidden(false);

    api
      .get("/compliance/reports", { params: { from, to } })
      .then((res) => {
        if (!cancelled) setData(res.data);
      })
      .catch((e) => {
        if (cancelled) return;
        console.error("reports fetch failed", e);
        const status = e.response?.status;
        if (status === 403) setForbidden(true);
        else if (status === 400) setError("Invalid date range — please check the from/to dates.");
        else setError("Could not load compliance report.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [from, to, reloadKey]);

  const windowDays = useMemo(() => enumerateDays(from, to).length, [from, to]);

  const dateWrapStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 6,
    background: t.surface2,
    border: `1px solid ${t.border}`,
    borderRadius: 10,
    padding: "6px 10px",
  };
  const dateLabelStyle: CSSProperties = {
    color: t.muted,
    fontSize: 11,
    ...sansFont,
  };
  const dateInputStyle: CSSProperties = {
    background: "transparent",
    border: "none",
    color: t.text,
    fontSize: 12.5,
    padding: 0,
    outline: "none",
    colorScheme: t.text === "#e6e9f2" ? "dark" : "light",
    ...monoFont,
  };

  // ---- Header bar (always visible so the range picker stays usable) ----
  const headerCard = (
    <Card
      style={{
        padding: "14px 24px 12px",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 16 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 11.5, color: t.muted, ...sansFont }}>Logchain / Reports</div>
          <h2 style={{ margin: "2px 0 0", fontSize: 21, fontWeight: 600, letterSpacing: "-0.01em", ...sansFont }}>
            Compliance report
          </h2>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <label style={dateWrapStyle}>
            <span style={dateLabelStyle}>From</span>
            <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} style={dateInputStyle} />
          </label>
          <label style={dateWrapStyle}>
            <span style={dateLabelStyle}>To</span>
            <input type="date" value={to} min={from} max={fmt(today)} onChange={(e) => setTo(e.target.value)} style={dateInputStyle} />
          </label>
          <Button icon={RefreshCw} variant="ghost" small onClick={() => setReloadKey((k) => k + 1)}>
            Refresh
          </Button>
          <Button
            icon={Download}
            variant="primary"
            small
            disabled={!data}
            onClick={() => data && download(`compliance_${from}_${to}.csv`, toCsv(data), "text/csv")}
          >
            Export CSV
          </Button>
        </div>
      </div>
      <div style={{ fontSize: 11.5, color: t.muted, marginTop: 6, ...sansFont }}>
        {data
          ? `Generated ${new Date(data.generatedAt).toLocaleString()} · ${windowDays}-day window · source: /api/v1/compliance/reports`
          : " "}
      </div>
    </Card>
  );

  const centeredMsg = (msg: ReactNode, color = t.muted, retry = false) => (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        color,
        fontSize: 13,
        textAlign: "center",
        ...sansFont,
      }}
    >
      <div>{msg}</div>
      {retry && (
        <Button icon={RefreshCw} small onClick={() => setReloadKey((k) => k + 1)}>
          Retry
        </Button>
      )}
    </div>
  );

  if (loading) return <ReportFrame header={headerCard}>{centeredMsg("Loading report…")}</ReportFrame>;
  if (forbidden)
    return (
      <ReportFrame header={headerCard}>
        {centeredMsg(
          <>
            Not authorised — this page needs the <b>admin</b> or <b>auditor</b> role.
          </>,
          t.warn,
        )}
      </ReportFrame>
    );
  if (error) return <ReportFrame header={headerCard}>{centeredMsg(error, t.danger, true)}</ReportFrame>;
  if (!data) return <ReportFrame header={headerCard}>{centeredMsg("No data available")}</ReportFrame>;

  // ---- ① Batch integrity by day — zero-fill every day in range, then collapse the empty ones ----
  const days = enumerateDays(from, to);
  const integrityByDay = new Map(data.integrity.map((r) => [r.day, r]));
  const integrityRows = days.map(
    (day) =>
      integrityByDay.get(day) ?? {
        day, confirmed: 0, tampered: 0, unverified: 0, pending: 0, total: 0, integrityRate: 0,
      },
  );
  const activeIntegrityRows = integrityRows.filter((r) => r.total > 0);
  const inactiveIntegrityDays = integrityRows.length - activeIntegrityRows.length;
  const confirmedSum = activeIntegrityRows.reduce((s, r) => s + r.confirmed, 0);
  const totalBatchSum = activeIntegrityRows.reduce((s, r) => s + r.total, 0);
  const chainIntegrityPct = totalBatchSum > 0 ? Math.round((confirmedSum / totalBatchSum) * 100) : null;
  const anyTampered = activeIntegrityRows.some((r) => r.tampered > 0);
  const anyUnverifiedOrPending = activeIntegrityRows.some((r) => r.unverified > 0 || r.pending > 0);
  const integrityTone = chainIntegrityPct === null ? "neutral" : anyTampered ? "danger" : anyUnverifiedOrPending ? "warn" : "good";

  // ---- ② Data retention snapshot (as of now) ----
  // 365 is log.entity.ts's `retention_days` column default (src/logs/entities/log.entity.ts) —
  // hardcoded because the reports endpoint doesn't return a window value (per-log retention_days
  // can actually vary). TODO: switch to the API's value once it starts sending one.
  const retentionWindowDays = 365;

  // ---- ③ Audit activity — endpoints as rows, days as columns ----
  const auditActions = Array.from(new Set(data.audit.flatMap((r) => Object.keys(r.byAction))));
  const auditByDay = new Map(data.audit.map((r) => [r.day, r.byAction]));
  const auditRows = auditActions
    .map((action) => {
      const perDay = days.map((day) => auditByDay.get(day)?.[action] ?? 0);
      const total = perDay.reduce((a, b) => a + b, 0);
      return { action, perDay, total };
    })
    .sort((a, b) => b.total - a.total);
  const activeAuditRows = auditRows.filter((r) => r.total > 0);
  const inactiveAuditEndpoints = auditRows.length - activeAuditRows.length;
  const auditTotal = activeAuditRows.reduce((s, r) => s + r.total, 0);
  const maxAuditTotal = Math.max(1, ...activeAuditRows.map((r) => r.total));

  // ---- ④ Erasure requests ----
  const erasureTotal = data.erasure.reduce((s, r) => s + r.requests, 0);
  const daysWithErasure = data.erasure.filter((r) => r.requests > 0).length;

  const kpis: { key: string; label: string; icon: any; value: string; context: string; tone: string; accent?: boolean }[] = [
    {
      key: "integrity",
      label: "Chain integrity",
      icon: ShieldCheck,
      value: chainIntegrityPct === null ? "—" : `${chainIntegrityPct}%`,
      context: totalBatchSum > 0
        ? `${confirmedSum.toLocaleString()} of ${totalBatchSum.toLocaleString()} batch${totalBatchSum === 1 ? "" : "es"} confirmed`
        : "no batches in this period",
      tone: integrityTone,
      accent: true,
    },
    {
      key: "retention",
      label: "Logs in retention",
      icon: Archive,
      value: data.retention.total.toLocaleString(),
      context: `${data.retention.dueIn30d.toLocaleString()} due in next 30 days`,
      tone: "blue",
    },
    {
      key: "audit",
      label: "Audit events",
      icon: Activity,
      value: auditTotal.toLocaleString(),
      context: `across ${auditActions.length.toLocaleString()} endpoints, ${windowDays} days`,
      tone: "cyan",
    },
    {
      key: "erasure",
      label: "Erasure requests",
      icon: UserX,
      value: erasureTotal.toLocaleString(),
      context: erasureTotal === 0 ? "none in this period" : `across ${daysWithErasure} day${daysWithErasure === 1 ? "" : "s"}`,
      tone: erasureTotal === 0 ? "good" : "blue",
    },
  ];

  const kpiRow = (
    <div style={{ display: "flex", gap: 12, flexShrink: 0 }}>
      {kpis.map((k) => (
        <Card
          key={k.key}
          style={{
            flex: 1,
            minWidth: 0,
            padding: "12px 14px",
            boxSizing: "border-box",
            display: "flex",
            flexDirection: "column",
            ...(k.accent ? { borderLeft: `3px solid ${toneColor(k.tone)}` } : {}),
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 11.5, color: t.muted, ...sansFont }}>{k.label}</span>
            <k.icon size={13} color={t.muted} />
          </div>
          <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-0.6px", lineHeight: 1.15, marginTop: 2, ...monoFont }}>
            {k.value}
          </div>
          <div
            style={{
              fontSize: 11.5,
              color: t.muted,
              marginTop: 3,
              ...sansFont,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {k.context}
          </div>
        </Card>
      ))}
    </div>
  );

  // ---- card header row: matches reference-reports.html's .card-h (11px/14px padding, 13.5px
  // title) — built locally instead of via the shared SectionLabel component (uppercase/dot
  // styled for the rest of the app) so this page-specific match doesn't change SectionLabel's
  // look everywhere else it's used.
  const cardHeader = (title: string, sub: ReactNode, dot?: string) => (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "11px 14px", flexShrink: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        {dot && (
          <span
            style={{ width: 6, height: 6, borderRadius: 999, background: dot, boxShadow: `0 0 8px ${dot}`, flexShrink: 0 }}
          />
        )}
        <span style={{ fontSize: 13.5, fontWeight: 600, letterSpacing: "0.1px", color: t.text, ...sansFont }}>{title}</span>
      </div>
      {sub}
    </div>
  );

  const middleRow = (
    <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
      {/* Batch integrity by day */}
      <Card
        style={{
          flex: 7,
          minWidth: 0,
          padding: 0,
          boxSizing: "border-box",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {cardHeader(
          "Batch integrity by day",
          <span style={{ fontSize: 11.5, color: t.muted, ...sansFont }}>
            {activeIntegrityRows.length} day{activeIntegrityRows.length === 1 ? "" : "s"} with activity
          </span>,
        )}
        <div style={{ overflowX: "auto", maxWidth: "100%" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
            <colgroup>
              <col style={{ width: "26%" }} />
              <col />
              <col />
              <col />
              <col />
              <col />
              <col style={{ width: "16%" }} />
            </colgroup>
            <thead>
              <tr>
                <th style={headCell(t)}>Day</th>
                <th style={headCell(t, { textAlign: "right" })}>Confirmed</th>
                <th style={headCell(t, { textAlign: "right" })}>Tampered</th>
                <th style={headCell(t, { textAlign: "right" })}>Unverified</th>
                <th style={headCell(t, { textAlign: "right" })}>Pending</th>
                <th
                  style={headCell(t, { textAlign: "right" })}
                  title="Total counts every batch the API returned for that day. Statuses it doesn't break out (e.g. failed sealing attempts) still count toward Total."
                >
                  Total
                </th>
                <th style={headCell(t, { textAlign: "right" })}>Integrity</th>
              </tr>
            </thead>
            <tbody>
              {activeIntegrityRows.map((r) => {
                const dim = (n: number): CSSProperties => (n === 0 ? { color: t.muted, opacity: 0.5 } : {});
                const bad = r.tampered > 0;
                const tone = r.tampered > 0 ? "danger" : r.unverified > 0 ? "warn" : "good";
                return (
                  <tr key={r.day} style={bad ? { background: "rgba(244,63,94,0.08)" } : undefined}>
                    <td style={bodyCell(t, { ...monoFont })}>{r.day}</td>
                    <td style={bodyCell(t, { textAlign: "right", ...monoFont, ...dim(r.confirmed) })}>{r.confirmed}</td>
                    <td
                      style={bodyCell(t, {
                        textAlign: "right",
                        ...monoFont,
                        ...(r.tampered > 0 ? { color: t.danger, fontWeight: 700 } : dim(r.tampered)),
                      })}
                    >
                      {r.tampered}
                    </td>
                    <td
                      style={bodyCell(t, {
                        textAlign: "right",
                        ...monoFont,
                        ...(r.unverified > 0 ? { color: t.warn } : dim(r.unverified)),
                      })}
                    >
                      {r.unverified}
                    </td>
                    <td style={bodyCell(t, { textAlign: "right", ...monoFont, ...dim(r.pending) })}>{r.pending}</td>
                    <td style={bodyCell(t, { textAlign: "right", ...monoFont, ...dim(r.total) })}>{r.total}</td>
                    <td style={bodyCell(t, { textAlign: "right" })}>
                      <Badge tone={tone}>{r.integrityRate}%</Badge>
                    </td>
                  </tr>
                );
              })}
              {inactiveIntegrityDays > 0 && (
                <tr>
                  <td style={bodyCell(t, { color: t.muted })}>
                    Other {inactiveIntegrityDays} day{inactiveIntegrityDays === 1 ? "" : "s"}
                  </td>
                  <td style={bodyCell(t, { color: t.muted, textAlign: "right", ...monoFont })}>—</td>
                  <td style={bodyCell(t, { color: t.muted, textAlign: "right", ...monoFont })}>—</td>
                  <td style={bodyCell(t, { color: t.muted, textAlign: "right", ...monoFont })}>—</td>
                  <td style={bodyCell(t, { color: t.muted, textAlign: "right", ...monoFont })}>—</td>
                  <td style={bodyCell(t, { color: t.muted, textAlign: "right", ...monoFont })}>—</td>
                  <td style={bodyCell(t, { textAlign: "right" })}>
                    <Badge tone="neutral">no batches</Badge>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Data retention */}
      <Card
        style={{
          flex: 5,
          minWidth: 0,
          padding: 0,
          boxSizing: "border-box",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {cardHeader(
          "Data retention",
          <span style={{ fontSize: 11.5, color: t.muted, ...sansFont }}>
            as of {new Date(data.generatedAt).toLocaleTimeString()}
          </span>,
          t.warn,
        )}
        <div style={{ padding: 14, display: "flex", flexDirection: "column" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(2,1fr)",
              gap: 10,
            }}
          >
            {[
              { l: "Total logs", v: data.retention.total, tone: "neutral" },
              { l: "Due in 30 days", v: data.retention.dueIn30d, tone: "warn" },
              { l: "Past retention", v: data.retention.expired, tone: "danger" },
              { l: "CDE scoped", v: data.retention.cdeScoped, tone: "cyan" },
            ].map((k) => (
              <div
                key={k.l}
                style={{
                  border: `1px solid ${t.border}`,
                  borderRadius: 9,
                  padding: "10px 12px",
                }}
              >
                <div style={{ fontSize: 11, color: t.muted, ...sansFont }}>{k.l}</div>
                <div style={{ fontSize: 20, fontWeight: 600, marginTop: 1, color: toneColor(k.tone), ...monoFont }}>
                  {k.v.toLocaleString()}
                </div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 11.5, color: t.muted, marginTop: 12, ...sansFont }}>
            Retention window {retentionWindowDays} days.{" "}
            {data.retention.expired === 0
              ? "Nothing is overdue for deletion."
              : `${data.retention.expired.toLocaleString()} log${data.retention.expired === 1 ? "" : "s"} past the retention window.`}
          </div>
        </div>
      </Card>
    </div>
  );

  const auditSection = (
    <Card
      style={{
        padding: 0,
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {cardHeader(
        "Audit activity",
        <span style={{ fontSize: 11.5, color: t.muted, ...sansFont }}>
          {auditTotal.toLocaleString()} calls · {from} → {to}
        </span>,
        t.cyan,
      )}
      <div style={{ overflowX: "auto", maxWidth: "100%" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 520 }}>
          <thead>
            <tr>
              <th
                style={headCell(t, {
                  position: "sticky",
                  left: 0,
                  background: t.surface,
                  zIndex: 2,
                  minWidth: 250,
                  maxWidth: 280,
                })}
              >
                Endpoint
              </th>
              {days.map((d) => (
                <th key={d} style={headCell(t, { textAlign: "right", minWidth: 42 })}>
                  {d.slice(5)}
                </th>
              ))}
              <th style={headCell(t, { textAlign: "right", minWidth: 70 })}>Total</th>
              <th style={headCell(t, { textAlign: "right", minWidth: 110 })}>Share</th>
            </tr>
          </thead>
          <tbody>
            {activeAuditRows.length === 0 && inactiveAuditEndpoints === 0 ? (
              <tr>
                <td style={bodyCell(t, { textAlign: "center", color: t.muted })} colSpan={days.length + 3}>
                  No audit activity in this period
                </td>
              </tr>
            ) : (
              <>
                {activeAuditRows.map((r) => {
                  const parsed = parseEndpointAction(r.action);
                  const share = Math.round((r.total / maxAuditTotal) * 100);
                  return (
                    <tr key={r.action}>
                      <td style={bodyCell(t, { position: "sticky", left: 0, background: t.surface, zIndex: 1 })}>
                        {parsed ? (
                          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span
                              style={{
                                display: "inline-block",
                                width: 46,
                                fontSize: 10.5,
                                fontWeight: 600,
                                letterSpacing: "0.3px",
                                color: toneColor(METHOD_TONE[parsed.method] ?? "muted"),
                                ...sansFont,
                              }}
                            >
                              {parsed.method}
                            </span>
                            <span style={{ ...monoFont, fontSize: 11.5, color: t.text }}>{parsed.path}</span>
                          </span>
                        ) : (
                          <span style={{ ...monoFont, fontSize: 11.5 }}>{r.action}</span>
                        )}
                      </td>
                      {r.perDay.map((v, i) => (
                        <td
                          key={days[i]}
                          style={bodyCell(t, {
                            textAlign: "right",
                            ...monoFont,
                            ...(v === 0 ? { color: t.muted, opacity: 0.5 } : {}),
                          })}
                        >
                          {v}
                        </td>
                      ))}
                      <td style={bodyCell(t, { textAlign: "right", fontWeight: 700, ...monoFont })}>
                        {r.total.toLocaleString()}
                      </td>
                      <td style={bodyCell(t, { textAlign: "right" })}>
                        <div
                          style={{
                            width: 60,
                            height: 5,
                            borderRadius: 3,
                            background: t.surface2,
                            overflow: "hidden",
                            marginLeft: "auto",
                          }}
                        >
                          <div style={{ width: `${share}%`, height: "100%", background: t.blue2 }} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {inactiveAuditEndpoints > 0 && (
                  <tr>
                    <td style={bodyCell(t, { color: t.muted, position: "sticky", left: 0, background: t.surface })}>
                      {inactiveAuditEndpoints} endpoint{inactiveAuditEndpoints === 1 ? "" : "s"} with no activity
                    </td>
                    {days.map((d) => (
                      <td key={d} style={bodyCell(t, { color: t.muted, textAlign: "right", ...monoFont })}>
                        —
                      </td>
                    ))}
                    <td style={bodyCell(t, { color: t.muted, textAlign: "right", ...monoFont })}>—</td>
                    <td style={bodyCell(t, { textAlign: "right" })}>
                      <Badge tone="neutral">hidden</Badge>
                    </td>
                  </tr>
                )}
              </>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );

  const erasureSection = (
    <Card
      style={{
        padding: 0,
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {cardHeader("Right-to-erasure log", <Badge tone="blue">PDPA art. 17</Badge>, t.blue)}
      {erasureTotal === 0 ? (
        <div
          style={{
            padding: "18px 14px",
            textAlign: "center",
            color: t.muted,
            ...sansFont,
          }}
        >
          <div style={{ fontSize: 12.5 }}>No erasure requests in this period.</div>
          <div style={{ marginTop: 3, fontSize: 11.5 }}>Records appear here once a subject request is processed.</div>
        </div>
      ) : (
        <div style={{ overflowX: "auto", maxWidth: "100%" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={headCell(t)}>Day</th>
                <th style={headCell(t, { textAlign: "right" })}>Requests</th>
                <th style={headCell(t)}>Subjects erased</th>
              </tr>
            </thead>
            <tbody>
              {data.erasure
                .filter((r) => r.requests > 0)
                .map((r) => (
                  <tr key={r.day}>
                    <td style={bodyCell(t, { ...monoFont })}>{r.day}</td>
                    <td style={bodyCell(t, { textAlign: "right", ...monoFont })}>{r.requests}</td>
                    <td style={bodyCell(t, { color: t.muted, fontSize: 10 })}>
                      {r.records?.map((x) => x.userId).filter(Boolean).join(", ") || "—"}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );

  const footnoteLine = (
    <div
      style={{
        flexShrink: 0,
        fontSize: 11.5,
        color: t.muted,
        textAlign: "center",
        ...sansFont,
      }}
    >
      Zero-value rows are collapsed instead of printed — the report stays one screen tall whether the period has 1 day or
      30.
    </div>
  );

  return (
    <ReportFrame header={headerCard}>
      <>
        {kpiRow}
        {middleRow}
        {auditSection}
        {erasureSection}
        {footnoteLine}
      </>
    </ReportFrame>
  );
}
