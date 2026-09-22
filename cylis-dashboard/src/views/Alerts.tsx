import { Fragment, useEffect, useMemo, useState } from "react";
import { BellRing, CircleCheck, ChevronDown, ChevronRight, ShieldAlert, Search } from "lucide-react";
import { useTheme, monoFont, sansFont } from "@/theme";
import { Card, SectionLabel, Badge, Button, Th, Td, FilterDropdown } from "@/components/ui";
import { api } from "@/lib/api";

/** Shape of GET /api/v1/alerts */
interface AlertRow {
  id: string;
  logId: string | null;
  batchId: string | null;
  alertType: string;
  severity: string;
  source: string;
  title: string;
  detail: Record<string, unknown> | null;
  status: string;
  /** first occurrence */
  createdAt: string;
  /** times this alert fired while OPEN (1 = once). Optional: older backends don't send it */
  occurrenceCount?: number;
  /** most recent occurrence — the list is ordered by this */
  lastSeenAt?: string;
}

const ALL_STATUSES = "All statuses";
const ALL_SEVERITIES = "All severities";
const ALL_TYPES = "All types";

/** ใช้ชุดสีเดียวกับ severity ของ log (logRows.toTone) ให้ทั้งสองหน้าอ่านเหมือนกัน */
function severityTone(sev: string) {
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

const fmtTime = (v: string) => (v ? new Date(v).toLocaleString("sv-SE") : "—");

export default function Alerts() {
  const t = useTheme();
  const [alerts, setAlerts] = useState<AlertRow[] | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState(ALL_STATUSES);
  const [severity, setSeverity] = useState(ALL_SEVERITIES);
  const [alertType, setAlertType] = useState(ALL_TYPES);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");

  function load() {
    return api
      .get<AlertRow[]>("/alerts")
      .then((r) => { setAlerts(r.data ?? []); setError(""); })
      .catch((e) => {
        console.error("alerts fetch failed", e);
        setAlerts([]);
        setError(
          e.response?.status === 403
            ? "Not authorised — this account needs the analyst, operator or admin role."
            : "Could not load alerts.",
        );
      });
  }

  useEffect(() => { void load(); }, []);

  async function resolveAlert(id: string) {
    setResolving(id);
    setActionError("");
    try {
      await api.patch(`/alerts/${id}/resolve`);
      // อ่านกลับจาก server แทนการแก้ state ในมือ — สถานะจริงมาจาก DB เสมอ
      await load();
    } catch (e: any) {
      const code = e.response?.status;
      setActionError(
        code === 403 ? "Resolving an alert needs the operator or admin role."
        : code === 404 ? "That alert no longer exists — the list has been refreshed."
        : "Could not resolve the alert.",
      );
      if (code === 404) await load();
    } finally {
      setResolving(null);
    }
  }

  const rows = alerts ?? [];
  const severities = useMemo(
    () => [ALL_SEVERITIES, ...Array.from(new Set(rows.map((a) => a.severity)))],
    [rows],
  );
  const types = useMemo(
    () => [ALL_TYPES, ...Array.from(new Set(rows.map((a) => a.alertType)))],
    [rows],
  );

  // กรองฝั่ง client เหมือนหน้า Logs — GET /alerts คืนทั้งชุดและปริมาณยังอยู่หลักสิบ
  const filtered = useMemo(
    () =>
      rows.filter((a) => {
        const haystack = [a.alertType, a.source, a.title, a.severity, a.status].join(" ").toLowerCase();
        return (
          haystack.includes(query.toLowerCase()) &&
          (status === ALL_STATUSES || a.status === status) &&
          (severity === ALL_SEVERITIES || a.severity === severity) &&
          (alertType === ALL_TYPES || a.alertType === alertType)
        );
      }),
    [rows, query, status, severity, alertType],
  );

  const openCount = rows.filter((a) => a.status === "OPEN").length;
  const criticalOpen = rows.filter((a) => a.status === "OPEN" && a.severity === "CRITICAL").length;

  const tiles = [
    { label: "Open", value: openCount, tone: openCount > 0 ? "warn" : "good", icon: BellRing },
    { label: "Critical open", value: criticalOpen, tone: criticalOpen > 0 ? "danger" : "good", icon: ShieldAlert },
    { label: "Resolved", value: rows.length - openCount, tone: "muted", icon: CircleCheck },
  ];

  const placeholder = (text: string) => (
    <div style={{ color: t.muted, padding: 20, textAlign: "center", fontSize: 13 }}>{text}</div>
  );

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 14 }}>
        {tiles.map((k) => (
          <Card key={k.label}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <SectionLabel dot={t[k.tone] ?? t.muted}>{k.label}</SectionLabel>
              <k.icon size={15} color={t.muted} />
            </div>
            <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-0.02em", marginTop: 6, ...monoFont }}>
              {alerts === null ? "—" : k.value.toLocaleString()}
            </div>
          </Card>
        ))}
      </div>

      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <SectionLabel>Alert triage</SectionLabel>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <FilterDropdown value={status} onChange={setStatus} options={[ALL_STATUSES, "OPEN", "RESOLVED"]} />
            <FilterDropdown value={severity} onChange={setSeverity} options={severities} />
            <FilterDropdown value={alertType} onChange={setAlertType} options={types} />
          </div>
        </div>

        <div style={{ position: "relative", marginTop: 10 }}>
          <Search size={15} color={t.muted} style={{ position: "absolute", left: 12, top: 11 }} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by type, source, title…"
            style={{
              width: "100%", background: t.surface2, border: `1px solid ${t.border}`,
              borderRadius: 10, padding: "10px 12px 10px 36px", color: t.text,
              fontSize: 13, outline: "none", ...sansFont,
            }}
          />
        </div>

        {error && <div style={{ marginTop: 12, color: t.danger, fontSize: 13 }}>{error}</div>}
        {actionError && <div style={{ marginTop: 12, color: t.danger, fontSize: 13 }}>{actionError}</div>}

        <div style={{ marginTop: 12, overflowX: "auto" }}>
          {alerts === null ? placeholder("Loading alerts…")
            : rows.length === 0 && !error ? placeholder("No alerts raised yet")
            : filtered.length === 0 ? placeholder("No alerts match these filters")
            : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr>{["", "Severity", "Type", "Title", "Source", "Last seen", "Status", ""].map((h, i) => (
                    <Th key={h + i}>{h}</Th>
                  ))}</tr>
                </thead>
                <tbody>
                  {filtered.map((a) => {
                    const isOpen = expanded === a.id;
                    return (
                      <Fragment key={a.id}>
                        <tr>
                          <Td style={{ width: 24 }}>
                            {/* detail เป็น jsonb — tamper alert เก็บ root ที่คำนวณได้กับที่อยู่บน chain ไว้ตรงนี้ */}
                            <button
                              type="button"
                              onClick={() => setExpanded(isOpen ? null : a.id)}
                              aria-label={isOpen ? "Hide detail" : "Show detail"}
                              style={{ background: "transparent", border: "none", cursor: "pointer", color: t.muted, padding: 0 }}
                            >
                              {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            </button>
                          </Td>
                          <Td><Badge tone={severityTone(a.severity)}>{a.severity}</Badge></Td>
                          <Td style={{ ...monoFont }}>{a.alertType}</Td>
                          <Td style={{ maxWidth: 320 }}>{a.title}</Td>
                          <Td style={{ ...monoFont, color: t.muted }}>{a.source}</Td>
                          <Td
                            style={{ color: t.muted, ...monoFont, whiteSpace: "nowrap" }}
                            title={`First seen ${fmtTime(a.createdAt)}`}
                          >
                            {fmtTime(a.lastSeenAt ?? a.createdAt)}
                            {/* repeats are folded into the OPEN alert — show how many, or they vanish */}
                            {(a.occurrenceCount ?? 1) > 1 && (
                              <span style={{ marginLeft: 6 }}>
                                <Badge tone={severityTone(a.severity)}>×{a.occurrenceCount}</Badge>
                              </span>
                            )}
                          </Td>
                          <Td>
                            <Badge tone={a.status === "OPEN" ? "warn" : "good"}>{a.status}</Badge>
                          </Td>
                          <Td style={{ textAlign: "right" }}>
                            {a.status === "OPEN" && (
                              <Button
                                variant="subtle"
                                small
                                disabled={resolving === a.id}
                                onClick={() => resolveAlert(a.id)}
                              >
                                {resolving === a.id ? "Resolving…" : "Resolve"}
                              </Button>
                            )}
                          </Td>
                        </tr>
                        {isOpen && (
                          <tr>
                            <Td colSpan={8} style={{ background: t.surface2 }}>
                              <div style={{ display: "grid", gap: 6, fontSize: 12, ...monoFont }}>
                                <div style={{ color: t.muted }}>
                                  alert {a.id}
                                  {a.batchId ? ` · batch ${a.batchId}` : ""}
                                  {a.logId ? ` · log ${a.logId}` : ""}
                                  {(a.occurrenceCount ?? 1) > 1
                                    ? ` · fired ${a.occurrenceCount}× · first ${fmtTime(a.createdAt)}`
                                    : ""}
                                </div>
                                <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all", color: t.text }}>
                                  {a.detail ? JSON.stringify(a.detail, null, 2) : "no detail recorded"}
                                </pre>
                              </div>
                            </Td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            )}
        </div>
      </Card>
    </div>
  );
}
