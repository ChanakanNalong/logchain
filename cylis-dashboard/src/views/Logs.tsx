import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Search, ChevronLeft, ChevronRight, Server, ShieldAlert, X } from "lucide-react";
import { useTheme, monoFont } from "@/theme";
import { Card, SectionLabel, Button, FilterDropdown, Badge } from "@/components/ui";
import LogTable from "@/components/LogTable";
import LogDrawer, { type LogDrawerSeed } from "@/components/LogDrawer";
import MultiSelectDropdown from "@/components/MultiSelectDropdown";
import { getLogs } from "@/lib/endpoints";
import { mapLog, type LogRow } from "@/lib/logRows";
import { useReplaceQuery } from "@/lib/nav";
import { ATTACK_SEVERITIES, LOG_EVENT_TYPES, LOG_SEVERITIES, LOG_SOURCES, VPS_SOURCES } from "@/lib/filterOptions";
import type { LogItem } from "@/types/api";

const DEFAULT_LIMIT = 25;
const LIMITS = [10, 25, 50, 100];
const SEARCH_DEBOUNCE_MS = 400;
/** GET /logs rejects a longer `q` */
const Q_MAX = 200;

function splitList(v: string | null): string[] {
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

function sameSet(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((v) => b.includes(v));
}

function errorText(e: any): string {
  const status = e?.response?.status;
  if (status === 403) return "Not authorised — this account needs the analyst, operator or admin role.";
  if (status === 400) {
    const msg = e.response?.data?.message;
    return `The server rejected the filter: ${Array.isArray(msg) ? msg.join(", ") : msg ?? "bad request"}`;
  }
  return "Could not load logs.";
}

export default function Logs() {
  const t = useTheme();
  const searchParams = useSearchParams();
  const replaceQuery = useReplaceQuery();

  // URL is the source of truth on mount; state mirrors it from then on.
  const [qInput, setQInput] = useState(() => searchParams.get("q") ?? "");
  const [q, setQ] = useState(() => (searchParams.get("q") ?? "").trim());
  const [source, setSource] = useState(() => splitList(searchParams.get("source")));
  const [severity, setSeverity] = useState(() => splitList(searchParams.get("severity")));
  const [eventType, setEventType] = useState(() => splitList(searchParams.get("eventType")));
  const [limit, setLimit] = useState(() => {
    const n = Number(searchParams.get("limit"));
    return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : DEFAULT_LIMIT;
  });
  const [offset, setOffset] = useState(() => Math.max(0, Math.floor(Number(searchParams.get("offset")) || 0)));

  const [rows, setRows] = useState<LogRow[]>([]);
  const [items, setItems] = useState<LogItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [openLog, setOpenLog] = useState<{ id: string; seed: LogDrawerSeed } | null>(null);

  // Debounce the search box; a new term starts again from the first page.
  useEffect(() => {
    const next = qInput.trim();
    if (next === q) return;
    const timer = setTimeout(() => { setQ(next); setOffset(0); }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [qInput, q]);

  const sourceKey = source.join(",");
  const severityKey = severity.join(",");
  const eventTypeKey = eventType.join(",");

  // Filtering and paging are done by the server (GET /logs limit/offset/source/
  // severity/eventType/q) — this page only ever holds the current page.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getLogs({ limit, offset, q, source: splitList(sourceKey), severity: splitList(severityKey), eventType: splitList(eventTypeKey) })
      .then((page) => {
        if (cancelled) return;
        // the filters shrank the set under the current offset → go to the last real page
        if (page.items.length === 0 && page.total > 0 && offset > 0) {
          setOffset(Math.floor((page.total - 1) / limit) * limit);
          return;
        }
        setItems(page.items);
        setRows(page.items.map(mapLog));
        setTotal(page.total);
        setError("");
      })
      .catch((e) => {
        if (cancelled) return;
        console.error("logs fetch failed", e);
        setItems([]);
        setRows([]);
        setTotal(0);
        setError(errorText(e));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [limit, offset, q, sourceKey, severityKey, eventTypeKey, reloadKey]);

  // Keep the query string in sync so filters/page survive a refresh or a share.
  // Merge only this page's keys — other pages keep theirs (lib/nav.tsx).
  useEffect(() => {
    replaceQuery({
      q: q || null,
      source: sourceKey || null,
      severity: severityKey || null,
      eventType: eventTypeKey || null,
      limit: limit !== DEFAULT_LIMIT ? String(limit) : null,
      offset: offset > 0 ? String(offset) : null,
      // keys of the old client-side filter
      type: null,
      sev: null,
      page: null,
    });
  }, [q, sourceKey, severityKey, eventTypeKey, limit, offset, replaceQuery]);

  // Any filter change invalidates the current page — back to the first one.
  function updateSource(v: string[]) { setSource(v); setOffset(0); }
  function updateSeverity(v: string[]) { setSeverity(v); setOffset(0); }
  function updateEventType(v: string[]) { setEventType(v); setOffset(0); }
  function updateLimit(label: string) { setLimit(parseInt(label, 10)); setOffset(0); }
  function clearAll() {
    setQInput(""); setQ(""); setSource([]); setSeverity([]); setEventType([]); setOffset(0);
  }

  const realLogsOn = sameSet(source, VPS_SOURCES);
  function toggleRealLogs() { updateSource(realLogsOn ? [] : [...VPS_SOURCES]); }
  // "Attacks" shortcut = severity WARNING/ERROR/CRITICAL; independent of Real logs (source) so both stack
  const attacksOn = sameSet(severity, ATTACK_SEVERITIES);
  function toggleAttacks() { updateSeverity(attacksOn ? [] : [...ATTACK_SEVERITIES]); }

  const openRow = useCallback(
    (row: LogRow) => {
      const it = items.find((i) => i.id === row.id);
      setOpenLog({
        id: row.id,
        seed: it ? { createdAt: it.createdAt, source: it.source, sourceIp: it.sourceIp, eventType: it.eventType, severity: it.severity, message: it.message } : {},
      });
    },
    [items],
  );
  const closeDrawer = useCallback(() => setOpenLog(null), []);

  const anyFilter = Boolean(q || source.length || severity.length || eventType.length);
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const currentPage = Math.floor(offset / limit) + 1;
  const firstShown = total === 0 ? 0 : offset + 1;
  const lastShown = Math.min(offset + rows.length, total);

  return (
    // minmax(0,1fr): an `auto` track grows to the widest table and the whole
    // page scrolls sideways; this keeps the scrolling inside each table wrapper
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 16, minWidth: 0 }}>
      <Card>
        <SectionLabel>Search logs</SectionLabel>
        <div style={{ position: "relative", marginTop: 8 }}>
          <Search size={15} color={t.muted} style={{ position: "absolute", left: 12, top: 11 }} />
          <input
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            maxLength={Q_MAX}
            placeholder="Search the log message…"
            aria-label="Search the log message"
            style={{
              width: "100%", background: t.surface2, border: `1px solid ${t.border}`,
              borderRadius: 10, padding: "10px 12px 10px 36px", color: t.text,
              fontSize: 13, outline: "none",
            }}
          />
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 12 }}>
          <button
            type="button"
            onClick={toggleRealLogs}
            aria-pressed={realLogsOn}
            title={realLogsOn ? "Showing only the VPS forwarder logs — click to clear" : `Show only ${VPS_SOURCES.join(" + ")}`}
            style={{
              display: "inline-flex", alignItems: "center", gap: 7, padding: "7px 12px", borderRadius: 9,
              background: realLogsOn ? "rgba(52,211,153,0.14)" : t.surface2,
              border: `1px solid ${realLogsOn ? "rgba(52,211,153,0.45)" : t.border}`,
              color: realLogsOn ? t.good : t.text, fontSize: 12.5, fontWeight: 600, cursor: "pointer",
            }}
          >
            <Server size={13} />
            Real logs
            {realLogsOn && <X size={12} />}
          </button>
          <button
            type="button"
            onClick={toggleAttacks}
            aria-pressed={attacksOn}
            title={attacksOn ? "Showing only WARNING/ERROR/CRITICAL — click to clear" : `Show only ${ATTACK_SEVERITIES.join(" + ")}`}
            style={{
              display: "inline-flex", alignItems: "center", gap: 7, padding: "7px 12px", borderRadius: 9,
              background: attacksOn ? "rgba(244,63,94,0.14)" : t.surface2,
              border: `1px solid ${attacksOn ? "rgba(244,63,94,0.45)" : t.border}`,
              color: attacksOn ? t.danger : t.text, fontSize: 12.5, fontWeight: 600, cursor: "pointer",
            }}
          >
            <ShieldAlert size={13} />
            Attacks
            {attacksOn && <X size={12} />}
          </button>
          <MultiSelectDropdown label="sources" options={LOG_SOURCES} value={source} onChange={updateSource} allowCustom />
          <MultiSelectDropdown label="severities" options={LOG_SEVERITIES} value={severity} onChange={updateSeverity} />
          <MultiSelectDropdown label="event types" options={LOG_EVENT_TYPES} value={eventType} onChange={updateEventType} allowCustom />
          {anyFilter && (
            <Button variant="ghost" small onClick={clearAll}>Clear filters</Button>
          )}
        </div>
      </Card>

      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <SectionLabel>{anyFilter ? "Matching logs" : "All logs"} ({total.toLocaleString()})</SectionLabel>
            {realLogsOn && <Badge tone="good">กำลังกรอง: Real logs</Badge>}
            {attacksOn && <Badge tone="danger">กำลังกรอง: Attacks</Badge>}
          </div>
          <FilterDropdown value={`${limit} / page`} onChange={updateLimit} options={LIMITS.map((n) => `${n} / page`)} />
        </div>
        {error ? (
          <div style={{ color: t.danger, padding: 20, textAlign: "center", fontSize: 13 }}>
            {error}{" "}
            <Button variant="ghost" small onClick={() => setReloadKey((k) => k + 1)}>Retry</Button>
          </div>
        ) : loading && rows.length === 0 ? (
          <div style={{ color: t.muted, padding: 20, textAlign: "center" }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ color: t.muted, padding: 20, textAlign: "center" }}>
            {anyFilter ? "No logs match these filters" : "No logs found"}
          </div>
        ) : (
          <>
            <div style={{ opacity: loading ? 0.55 : 1, transition: "opacity .15s" }}>
              <LogTable logs={rows} showChain onRowClick={openRow} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14, gap: 10, flexWrap: "wrap" }}>
              <div style={{ fontSize: 11.5, color: t.muted, ...monoFont }}>
                {firstShown}–{lastShown} of {total.toLocaleString()} · Page {currentPage} of {totalPages}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <Button
                  icon={ChevronLeft}
                  variant="ghost"
                  small
                  disabled={offset <= 0 || loading}
                  onClick={() => setOffset((o) => Math.max(0, o - limit))}
                >
                  Prev
                </Button>
                <Button
                  icon={ChevronRight}
                  variant="ghost"
                  small
                  disabled={offset + limit >= total || loading}
                  onClick={() => setOffset((o) => o + limit)}
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>

      <LogDrawer logId={openLog?.id ?? null} seed={openLog?.seed} onClose={closeDrawer} />
    </div>
  );
}
