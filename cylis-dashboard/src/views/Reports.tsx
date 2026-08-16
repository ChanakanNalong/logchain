import { useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
} from "recharts";
import { Download, RefreshCw } from "lucide-react";
import { useTheme, monoFont, sansFont } from "@/theme";
import { Card, SectionLabel, Badge, Button, Th, Td } from "@/components/ui";
import { api } from "@/lib/api";

/** Shape of GET /api/v1/compliance/reports */
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
  erasure: { day: string; requests: number; records: { requester?: string; status?: string }[] }[];
  audit: { day: string; byAction: Record<string, number> }[];
}

// group วันด้วย Asia/Bangkok (UTC+7) ให้ตรงกับ backend — กันช่วงตี 0-7 โมงส่งวันผิด
const fmt = (d: Date) => new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
const daysAgo = (d: Date, n: number) => new Date(d.getTime() - n * 86400000);

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
    r.records?.forEach((x) =>
      lines.push(`erasure,${r.day},requester,${csvCell(x.requester)}`),
    );
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

export default function Reports() {
  const t = useTheme();
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

  const placeholder = (text: string) => (
    <div style={{ color: t.muted, padding: 20, textAlign: "center", fontSize: 13 }}>{text}</div>
  );

  const inputStyle = {
    background: t.surface2,
    border: `1px solid ${t.border}`,
    borderRadius: 8,
    color: t.text,
    padding: "7px 10px",
    fontSize: 13,
    ...monoFont,
  } as const;

  // ---- Header bar (always visible so the range picker stays usable) ----
  const header = (
    <Card>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <div>
          <SectionLabel dot={t.cyan}>Compliance Report</SectionLabel>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
            <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} style={inputStyle} />
            <span style={{ color: t.muted, fontSize: 13 }}>→</span>
            <input type="date" value={to} min={from} max={fmt(today)} onChange={(e) => setTo(e.target.value)} style={inputStyle} />
          </div>
          {data && (
            <div style={{ fontSize: 11, color: t.muted, marginTop: 8, ...sansFont }}>
              Generated at {new Date(data.generatedAt).toLocaleString()}
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <Button icon={RefreshCw} variant="ghost" small onClick={() => setReloadKey((k) => k + 1)}>
            Refresh
          </Button>
          <Button
            icon={Download}
            variant="subtle"
            small
            onClick={() => data && download(`compliance_${from}_${to}.csv`, toCsv(data), "text/csv")}
          >
            Export CSV
          </Button>
        </div>
      </div>
    </Card>
  );

  if (loading) return <div style={{ display: "grid", gap: 16 }}>{header}<Card>{placeholder("Loading report…")}</Card></div>;
  if (forbidden)
    return (
      <div style={{ display: "grid", gap: 16 }}>
        {header}
        <Card><div style={{ color: t.warn, padding: 20, fontSize: 13 }}>Not authorised — this page needs the <b>admin</b> or <b>auditor</b> role.</div></Card>
      </div>
    );
  if (error)
    return (
      <div style={{ display: "grid", gap: 16 }}>
        {header}
        <Card>
          <div style={{ color: t.danger, padding: "20px 20px 0", fontSize: 13 }}>{error}</div>
          <div style={{ padding: 16 }}><Button icon={RefreshCw} small onClick={() => setReloadKey((k) => k + 1)}>Retry</Button></div>
        </Card>
      </div>
    );
  if (!data) return <div style={{ display: "grid", gap: 16 }}>{header}<Card>{placeholder("No data available")}</Card></div>;

  const auditActions: string[] = Array.from(new Set(data.audit.flatMap((r) => Object.keys(r.byAction))));

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {header}

      {/* ① Log Integrity Summary (ISO 27001 A.12.4) */}
      <Card>
        <SectionLabel>① Log Integrity Summary</SectionLabel>
        {data.integrity.length === 0 ? (
          placeholder("No batch activity in this period")
        ) : (
          <>
            <div style={{ height: 200, marginTop: 12 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data.integrity}>
                  <CartesianGrid stroke={t.border} strokeDasharray="3 6" vertical={false} />
                  <XAxis dataKey="day" stroke={t.muted} fontSize={11} tickLine={false} axisLine={{ stroke: t.border }} tick={{ ...monoFont, fill: t.muted }} dy={6} />
                  <YAxis domain={[0, 100]} stroke={t.muted} fontSize={11} tickLine={false} axisLine={false} tick={{ ...monoFont, fill: t.muted }} width={40} unit="%" />
                  <Tooltip contentStyle={{ background: t.surface2, border: `1px solid ${t.border}`, borderRadius: 10, fontSize: 12, ...monoFont }} labelStyle={{ color: t.text }} formatter={(v) => [`${v}%`, "Integrity"]} />
                  <Line type="monotone" dataKey="integrityRate" stroke={t.good} strokeWidth={2} dot={{ r: 3, fill: t.good }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div style={{ overflowX: "auto", marginTop: 12 }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead><tr><Th>Day</Th><Th>Confirmed</Th><Th>Tampered</Th><Th>Unverified</Th><Th>Pending</Th><Th>Total</Th><Th>Integrity</Th></tr></thead>
                <tbody>
                  {data.integrity.map((r) => {
                    const bad = r.tampered > 0;
                    const tone = r.tampered > 0 ? "danger" : r.unverified > 0 ? "warn" : "good";
                    return (
                      <tr key={r.day} style={bad ? { background: "rgba(244,63,94,0.08)" } : undefined}>
                        <Td style={{ ...monoFont }}>{r.day}</Td>
                        <Td>{r.confirmed}</Td>
                        <Td style={bad ? { color: t.danger, fontWeight: 700 } : undefined}>{r.tampered}</Td>
                        <Td style={r.unverified > 0 ? { color: t.warn } : undefined}>{r.unverified}</Td>
                        <Td>{r.pending}</Td>
                        <Td>{r.total}</Td>
                        <Td><Badge tone={tone}>{r.integrityRate}%</Badge></Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>

      {/* ② Data Retention Status (PDPA / PCI-DSS) — snapshot ณ เวลา generate (now), ไม่ผูก date range */}
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <SectionLabel dot={t.warn}>② Data Retention Status</SectionLabel>
          <Badge tone="neutral">snapshot @ {new Date(data.generatedAt).toLocaleDateString()}</Badge>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12, marginTop: 14 }}>
          {[
            { l: "Total logs", v: data.retention.total, tone: t.muted },
            { l: "Due in 30 days", v: data.retention.dueIn30d, tone: t.warn },
            { l: "Past retention", v: data.retention.expired, tone: t.danger },
            { l: "CDE-scoped", v: data.retention.cdeScoped, tone: t.cyan },
          ].map((k) => (
            <div key={k.l}>
              <div style={{ fontSize: 11, color: t.muted, ...sansFont }}>{k.l}</div>
              <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4, color: k.tone, ...monoFont }}>{k.v.toLocaleString()}</div>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 12, color: t.muted, marginTop: 12, ...sansFont }}>
          {data.retention.dueIn30d} logs due for deletion in the next 30 days.
        </div>
      </Card>

      {/* ③ Right-to-Erasure Log (PDPA) — per day */}
      <Card>
        <SectionLabel dot={t.blue}>③ Right-to-Erasure Log</SectionLabel>
        {data.erasure.length === 0 ? (
          placeholder("No erasure requests in this period")
        ) : (
          <div style={{ overflowX: "auto", marginTop: 12 }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr><Th>Day</Th><Th>Requests</Th><Th>Requesters</Th></tr></thead>
              <tbody>
                {data.erasure.map((r) => (
                  <tr key={r.day}>
                    <Td style={{ ...monoFont }}>{r.day}</Td>
                    <Td>{r.requests}</Td>
                    <Td style={{ color: t.muted, fontSize: 12 }}>
                      {r.records?.map((x) => x.requester).filter(Boolean).join(", ") || "—"}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ④ Audit Activity (ISO 27001 A.12.4.3) — per day */}
      <Card>
        <SectionLabel dot={t.cyan}>④ Audit Activity</SectionLabel>
        {data.audit.length === 0 || auditActions.length === 0 ? (
          placeholder("No audit activity in this period")
        ) : (
          <div style={{ overflowX: "auto", marginTop: 12 }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr><Th>Day</Th>{auditActions.map((a) => <Th key={a}>{a}</Th>)}</tr>
              </thead>
              <tbody>
                {data.audit.map((r) => (
                  <tr key={r.day}>
                    <Td style={{ ...monoFont }}>{r.day}</Td>
                    {auditActions.map((a) => <Td key={a}>{r.byAction[a] ?? 0}</Td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
