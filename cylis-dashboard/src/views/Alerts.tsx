import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useSearchParams } from "next/navigation";
import { BellRing, CircleCheck, ChevronDown, ChevronRight, ShieldAlert, Search } from "lucide-react";
import { useTheme, monoFont, sansFont } from "@/theme";
import { Card, SectionLabel, Badge, Button, Th, Td, FilterDropdown } from "@/components/ui";
import BatchStatusBadge from "@/components/BatchStatusBadge";
import AlertRoleBadge from "@/components/AlertRoleBadge";
import LogDrawer, { type LogDrawerSeed } from "@/components/LogDrawer";
import { getAlert, getAlerts, resolveAlert as resolveAlertApi } from "@/lib/endpoints";
import { alertTone } from "@/lib/logRows";
import { fmtTime, shortId } from "@/lib/format";
import { QUERY_KEYS, useReplaceQuery } from "@/lib/nav";
import { canDo } from "@/lib/roles";
import type { AlertDetail, AlertItem as AlertRow } from "@/types/api";

const ALL_STATUSES = "All statuses";
const ALL_SEVERITIES = "All severities";
const ALL_TYPES = "All types";

/** Related logs of one alert (GET /alerts/:id), loaded when its row is expanded */
type DetailState = { status: "loading" } | { status: "error"; message: string } | { status: "ok"; data: AlertDetail };

export default function Alerts() {
  const t = useTheme();
  const searchParams = useSearchParams();
  const replaceQuery = useReplaceQuery();
  // hiding is UX only — PATCH /alerts/:id/resolve is @Roles('operator', 'admin')
  const canResolve = canDo("resolveAlert");
  const [alerts, setAlerts] = useState<AlertRow[] | null>(null);
  const [error, setError] = useState("");
  // filters live in the query string like Logs, so F5 keeps them (keys: lib/nav.tsx PAGE_QUERY_KEYS.alerts)
  const [query, setQuery] = useState(() => searchParams.get("a_q") ?? "");
  const [status, setStatus] = useState(() => searchParams.get("a_status") ?? ALL_STATUSES);
  const [severity, setSeverity] = useState(() => searchParams.get("a_sev") ?? ALL_SEVERITIES);
  const [alertType, setAlertType] = useState(() => searchParams.get("a_type") ?? ALL_TYPES);
  const tableBoxRef = useRef<HTMLDivElement>(null);
  const tableBoxWidth = useElementWidth(tableBoxRef);
  // ?alert=<id> (from the log drawer) opens that alert
  const linkedAlert = searchParams.get(QUERY_KEYS.alert);
  const [expanded, setExpanded] = useState<string | null>(() => linkedAlert);
  // row to bring into view once it is rendered (opened from ?alert= or "ล้างตัวกรองและแสดง")
  const [scrollTo, setScrollTo] = useState<string | null>(() => linkedAlert);
  // the user's own expand/collapse also writes ?alert= — that one must not scroll
  const selfToggled = useRef(false);
  const [details, setDetails] = useState<Record<string, DetailState>>({});
  const [openLog, setOpenLog] = useState<{ id: string; seed: LogDrawerSeed } | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");

  function load() {
    return getAlerts()
      .then((data) => { setAlerts(data); setError(""); })
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

  useEffect(() => {
    if (!linkedAlert) return;
    setExpanded(linkedAlert);
    if (selfToggled.current) selfToggled.current = false;
    else setScrollTo(linkedAlert);
  }, [linkedAlert]);

  const loadDetail = useCallback((id: string) => {
    setDetails((d) => ({ ...d, [id]: { status: "loading" } }));
    getAlert(id)
      .then((data) => setDetails((d) => ({ ...d, [id]: { status: "ok", data } })))
      .catch((e) => {
        const code = e.response?.status;
        // 404 is handled on screen ("no longer exists") — not worth a console error
        if (code !== 404) console.error("alert detail fetch failed", e);
        const message = code === 404 ? "This alert no longer exists." : code === 403 ? "Not authorised to read this alert." : "Could not load the related logs.";
        setDetails((d) => ({ ...d, [id]: { status: "error", message } }));
      });
  }, []);

  // fetch the related logs the first time a row is opened
  useEffect(() => {
    if (expanded && !details[expanded]) loadDetail(expanded);
  }, [expanded, details, loadDetail]);

  useEffect(() => {
    replaceQuery({
      a_q: query || null,
      a_status: status !== ALL_STATUSES ? status : null,
      a_sev: severity !== ALL_SEVERITIES ? severity : null,
      a_type: alertType !== ALL_TYPES ? alertType : null,
    });
  }, [query, status, severity, alertType, replaceQuery]);

  function toggleRow(id: string) {
    const next = expanded === id ? null : id;
    if (next) selfToggled.current = true;
    setExpanded(next);
    replaceQuery({ [QUERY_KEYS.alert]: next });
  }

  const closeDrawer = useCallback(() => setOpenLog(null), []);

  async function resolveAlert(id: string) {
    setResolving(id);
    setActionError("");
    try {
      await resolveAlertApi(id);
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

  // กรองฝั่ง client — GET /alerts คืนทั้งชุด (ไม่มี limit/filter ฝั่ง server) และปริมาณยังอยู่หลักสิบ
  const filtered = useMemo(
    () =>
      rows.filter((a) => {
        const haystack = [a.alertType, a.source, a.sourceIp, a.ruleId, a.title, a.severity, a.status].join(" ").toLowerCase();
        return (
          haystack.includes(query.toLowerCase()) &&
          (status === ALL_STATUSES || a.status === status) &&
          (severity === ALL_SEVERITIES || a.severity === severity) &&
          (alertType === ALL_TYPES || a.alertType === alertType)
        );
      }),
    [rows, query, status, severity, alertType],
  );

  // ?alert=<id> that the list cannot show: hidden by the filters, or gone.
  // Say so instead of silently clearing the filters (or silently showing nothing).
  const linkedState =
    !linkedAlert || alerts === null || error ? null
    : !rows.some((a) => a.id === linkedAlert) ? "missing"
    : !filtered.some((a) => a.id === linkedAlert) ? "hidden"
    : null;

  // waits until the row exists (list still loading, or hidden by the filters)
  useEffect(() => {
    if (!scrollTo) return;
    const row = document.getElementById(`alert-row-${scrollTo}`);
    if (!row) return;
    row.scrollIntoView({ block: "start", behavior: "smooth" });
    setScrollTo(null);
  }, [scrollTo, filtered]);

  function clearFiltersAndShow(id: string) {
    setQuery("");
    setStatus(ALL_STATUSES);
    setSeverity(ALL_SEVERITIES);
    setAlertType(ALL_TYPES);
    setExpanded(id);
    setScrollTo(id); // runs after the re-render that brings the row back
  }

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
    // minmax(0,1fr): an `auto` track grows to the widest table and the whole
    // page scrolls sideways; this keeps the scrolling inside each table wrapper
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 16, minWidth: 0 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(180px,100%),1fr))", gap: 14 }}>
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
            placeholder="Search by type, source, IP, rule, title…"
            style={{
              width: "100%", background: t.surface2, border: `1px solid ${t.border}`,
              borderRadius: 10, padding: "10px 12px 10px 36px", color: t.text,
              fontSize: 13, outline: "none", ...sansFont,
            }}
          />
        </div>

        {error && <div style={{ marginTop: 12, color: t.danger, fontSize: 13 }}>{error}</div>}
        {linkedState && (
          <div
            role="status"
            style={{
              marginTop: 12, padding: "8px 12px", borderRadius: 9, fontSize: 13, display: "flex",
              alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap",
              color: t.warn, background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.4)",
            }}
          >
            <span>
              {linkedState === "hidden" ? "alert ที่เลือกถูกตัวกรองซ่อนอยู่" : "ไม่พบ alert นี้"}
              <span style={{ marginLeft: 8, color: t.muted, ...monoFont }}>{shortId(linkedAlert)}</span>
            </span>
            {linkedState === "hidden" && linkedAlert && (
              <Button variant="subtle" small onClick={() => clearFiltersAndShow(linkedAlert)}>ล้างตัวกรองและแสดง</Button>
            )}
          </div>
        )}
        {actionError && <div style={{ marginTop: 12, color: t.danger, fontSize: 13 }}>{actionError}</div>}

        <div ref={tableBoxRef} style={{ marginTop: 12, overflowX: "auto" }}>
          {alerts === null ? placeholder("Loading alerts…")
            : rows.length === 0 && !error ? placeholder("No alerts raised yet")
            : filtered.length === 0 ? placeholder("No alerts match these filters")
            : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr>{["", "Severity", "Type", "Title", "Source", "Source IP", "Last seen", "Status", ""].map((h, i) => (
                    <Th key={h + i}>{h}</Th>
                  ))}</tr>
                </thead>
                <tbody>
                  {filtered.map((a) => {
                    const isOpen = expanded === a.id;
                    return (
                      <Fragment key={a.id}>
                        {/* scroll-margin: leave ~16px above the row so its top edge is not cut off */}
                        <tr id={`alert-row-${a.id}`} style={{ scrollMarginTop: 16 }}>
                          <Td style={{ width: 24 }}>
                            {/* detail เป็น jsonb — tamper alert เก็บ root ที่คำนวณได้กับที่อยู่บน chain ไว้ตรงนี้ */}
                            <button
                              type="button"
                              onClick={() => toggleRow(a.id)}
                              aria-expanded={isOpen}
                              aria-label={isOpen ? "Hide detail" : "Show detail"}
                              style={{ background: "transparent", border: "none", cursor: "pointer", color: t.muted, padding: 0 }}
                            >
                              {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            </button>
                          </Td>
                          <Td><Badge tone={alertTone(a.severity)}>{a.severity}</Badge></Td>
                          <Td style={{ ...monoFont }}>{a.alertType}</Td>
                          <Td style={{ maxWidth: 320 }}>{a.title}</Td>
                          <Td style={{ ...monoFont, color: t.muted }}>{a.source}</Td>
                          <Td style={{ ...monoFont, color: t.muted, whiteSpace: "nowrap" }}>{a.sourceIp ?? "—"}</Td>
                          <Td
                            style={{ color: t.muted, ...monoFont, whiteSpace: "nowrap" }}
                            title={`First seen ${fmtTime(a.createdAt)}`}
                          >
                            {fmtTime(a.lastSeenAt ?? a.createdAt)}
                            {/* repeats are folded into the OPEN alert — show how many, or they vanish */}
                            {(a.occurrenceCount ?? 1) > 1 && (
                              <span style={{ marginLeft: 6 }}>
                                <Badge tone={alertTone(a.severity)}>×{a.occurrenceCount}</Badge>
                              </span>
                            )}
                          </Td>
                          <Td>
                            <Badge tone={a.status === "OPEN" ? "warn" : "good"}>{a.status}</Badge>
                          </Td>
                          <Td style={{ textAlign: "right" }}>
                            {a.status === "OPEN" && canResolve && (
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
                            <Td colSpan={9} style={{ background: t.surface2 }}>
                              {/* as wide as the visible part of the scroll box, pinned to its left edge:
                                  the panel never pushes the table wider and stays in view when the
                                  table is scrolled sideways (20 = the cell's padding) */}
                              <div
                                style={{
                                  display: "grid", gap: 10, fontSize: 12, position: "sticky", left: 10,
                                  ...(tableBoxWidth ? { width: tableBoxWidth - 20 } : { width: 0, minWidth: "100%" }),
                                }}
                              >
                                <div style={{ color: t.muted, overflowWrap: "anywhere", ...monoFont }}>
                                  alert {a.id}
                                  {a.ruleId ? ` · rule ${a.ruleId}` : ""}
                                  {a.sourceIp ? ` · from ${a.sourceIp}` : ""}
                                  {a.batchId ? ` · batch ${a.batchId}` : ""}
                                  {(a.occurrenceCount ?? 1) > 1
                                    ? ` · fired ${a.occurrenceCount}× · first ${fmtTime(a.createdAt)}`
                                    : ""}
                                </div>
                                <RelatedLogs
                                  state={details[a.id]}
                                  onRetry={() => loadDetail(a.id)}
                                  onOpen={(l) => setOpenLog({ id: l.id, seed: { createdAt: l.createdAt, sourceIp: l.sourceIp, message: l.message } })}
                                />
                                {/* detail เป็น jsonb — tamper alert เก็บ root ที่คำนวณได้กับที่อยู่บน chain ไว้ตรงนี้ */}
                                <details>
                                  <summary style={{ cursor: "pointer", color: t.muted, ...sansFont }}>Raw detail</summary>
                                  <pre style={{ margin: "6px 0 0", whiteSpace: "pre-wrap", wordBreak: "break-all", color: t.text, ...monoFont }}>
                                    {a.detail ? JSON.stringify(a.detail, null, 2) : "no detail recorded"}
                                  </pre>
                                </details>
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

      <LogDrawer logId={openLog?.id ?? null} seed={openLog?.seed} onClose={closeDrawer} />
    </div>
  );
}

/** Logs behind one alert, grouped by role order as the API returns them; a click opens the log drawer */
function RelatedLogs({
  state,
  onRetry,
  onOpen,
}: {
  state: DetailState | undefined;
  onRetry: () => void;
  onOpen: (log: AlertDetail["logs"][number]) => void;
}) {
  const t = useTheme();
  // reserve roughly the height of a few rows: the list replacing a one-line
  // placeholder used to push content around right where the user was aiming
  if (!state || state.status === "loading") {
    return <div style={{ color: t.muted, minHeight: 140, ...sansFont }}>Loading related logs…</div>;
  }
  if (state.status === "error") {
    return (
      <div style={{ color: t.danger, display: "flex", gap: 10, alignItems: "center", ...sansFont }}>
        {state.message}
        <Button variant="ghost" small onClick={onRetry}>Retry</Button>
      </div>
    );
  }
  const logs = state.data.logs;
  return (
    <div>
      <div style={{ color: t.muted, marginBottom: 6, ...sansFont }}>Related logs ({logs.length})</div>
      {logs.length === 0 ? (
        <div style={{ color: t.muted, ...sansFont }}>No logs are linked to this alert (e.g. a batch integrity alert).</div>
      ) : (
        <div style={{ display: "grid", gap: 6 }}>
          {logs.map((l) => (
            <button
              key={`${l.role}:${l.id}`}
              type="button"
              onClick={() => onOpen(l)}
              title={`Open log ${l.id}`}
              style={{
                display: "flex", gap: 10, alignItems: "center", minWidth: 0,
                textAlign: "left", width: "100%", padding: "8px 10px", borderRadius: 9, cursor: "pointer",
                background: t.surface, border: `1px solid ${t.border}`, color: t.text, fontSize: 12,
              }}
            >
              {/* role · ID · On-chain · time · message — the message goes last and takes what is left */}
              <span style={{ flexShrink: 0 }}><AlertRoleBadge role={l.role} /></span>
              <span style={{ color: t.blue2, flexShrink: 0, ...monoFont }}>{shortId(l.id)}</span>
              <span style={{ flexShrink: 0 }}><BatchStatusBadge status={l.batchStatus} /></span>
              <span style={{ color: t.muted, whiteSpace: "nowrap", flexShrink: 0, ...monoFont }}>{fmtTime(l.createdAt)}</span>
              <span
                title={l.sourceIp ? `${l.sourceIp} · ${l.message}` : l.message}
                style={{ flex: "1 1 0", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", ...monoFont }}
              >
                {l.sourceIp ? `${l.sourceIp} · ` : ""}{l.message}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Rendered width of an element, kept current with a ResizeObserver (0 until measured) */
function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}
