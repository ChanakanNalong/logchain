import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Search, ChevronDown, Check, ChevronLeft, ChevronRight } from "lucide-react";
import { useTheme, sansFont, monoFont } from "@/theme";
import { Card, SectionLabel, Button } from "@/components/ui";
import LogTable from "@/components/LogTable";
import { api } from "@/lib/api";
import { mapLog, unwrapLogs } from "@/lib/logRows";

const PAGE_SIZE = 10;

/** Button + popup dropdown, reused for both the attack-type and severity filters */
function FilterDropdown({ value, onChange, options }: any) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "7px 12px",
          borderRadius: 9,
          background: t.surface2,
          border: `1px solid ${t.border}`,
          color: t.text,
          fontSize: 12.5,
          fontWeight: 600,
          cursor: "pointer",
          ...sansFont,
        }}
      >
        {value}
        <ChevronDown
          size={13}
          color={t.muted}
          style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform .15s" }}
        />
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            minWidth: 200,
            background: t.surface2,
            border: `1px solid ${t.border}`,
            borderRadius: 10,
            boxShadow: "0 10px 28px rgba(0,0,0,0.4)",
            padding: 6,
            zIndex: 20,
            maxHeight: 260,
            overflowY: "auto",
          }}
        >
          {options.map((opt: string) => (
            <button
              key={opt}
              onClick={() => {
                onChange(opt);
                setOpen(false);
              }}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                padding: "8px 10px",
                borderRadius: 7,
                background: opt === value ? "rgba(59,130,246,0.12)" : "transparent",
                border: "none",
                color: t.text,
                fontSize: 12.5,
                textAlign: "left",
                cursor: "pointer",
                ...sansFont,
              }}
            >
              {opt}
              {opt === value && <Check size={13} color={t.blue2} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const ALL_TYPES = "All types";
const ALL_SEVERITIES = "All severities";

export default function Logs() {
  const t = useTheme();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // URL is the source of truth on mount; state below just mirrors it so
  // typing/paging doesn't round-trip through the router on every keystroke.
  const [query, setQuery] = useState(() => searchParams.get("q") ?? "");
  const [attackType, setAttackType] = useState(() => searchParams.get("type") ?? ALL_TYPES);
  const [severity, setSeverity] = useState(() => searchParams.get("sev") ?? ALL_SEVERITIES);
  const [page, setPage] = useState(() => Math.max(1, Number(searchParams.get("page")) || 1));
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get("/logs")
      .then((r) => setLogs(unwrapLogs(r.data).map(mapLog)))
      .catch((e) => { console.error("logs fetch failed", e); setLogs([]); })
      .finally(() => setLoading(false));
  }, []);

  // Keep the URL query string in sync so filters/page survive a refresh or share.
  useEffect(() => {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (attackType !== ALL_TYPES) params.set("type", attackType);
    if (severity !== ALL_SEVERITIES) params.set("sev", severity);
    if (page > 1) params.set("page", String(page));
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, attackType, severity, page]);

  const attackTypes = useMemo(
    () => [ALL_TYPES, ...Array.from(new Set(logs.map((l) => l.attackType)))],
    [logs]
  );
  const severities = useMemo(
    () => [ALL_SEVERITIES, ...Array.from(new Set(logs.map((l) => l.severity)))],
    [logs]
  );

  // Filtering and pagination happen client-side on purpose: GET /logs returns
  // the full set, and current log volume is in the tens of rows, so slicing
  // in-memory is simpler than a paged/filtered endpoint and costs nothing at
  // this scale. This is a known trade-off, not an oversight — once volume
  // grows enough that shipping the full set becomes expensive, move this to
  // the backend as GET /logs?severity=&page= and drop the in-memory filter.
  const filtered = useMemo(
    () =>
      logs.filter((log) => {
        const matchesQuery = [log.id, log.source, log.ip, log.event, log.attackType]
          .join(" ").toLowerCase().includes(query.toLowerCase());
        const matchesType = attackType === ALL_TYPES || log.attackType === attackType;
        const matchesSeverity = severity === ALL_SEVERITIES || log.severity === severity;
        return matchesQuery && matchesType && matchesSeverity;
      }),
    [logs, query, attackType, severity]
  );

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages);
  const paged = filtered.slice((clampedPage - 1) * PAGE_SIZE, clampedPage * PAGE_SIZE);

  // Any filter/search change invalidates the current page — jump back to page 1.
  function updateQuery(v: string) { setQuery(v); setPage(1); }
  function updateAttackType(v: string) { setAttackType(v); setPage(1); }
  function updateSeverity(v: string) { setSeverity(v); setPage(1); }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Card>
        <SectionLabel>Search logs</SectionLabel>
        <div style={{ position: "relative", marginTop: 8 }}>
          <Search size={15} color={t.muted} style={{ position: "absolute", left: 12, top: 11 }} />
          <input
            value={query}
            onChange={(e) => updateQuery(e.target.value)}
            placeholder="Search by ID, source, IP, event, or type…"
            style={{
              width: "100%", background: t.surface2, border: `1px solid ${t.border}`,
              borderRadius: 10, padding: "10px 12px 10px 36px", color: t.text,
              fontSize: 13, outline: "none",
            }}
          />
        </div>
      </Card>

      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 10 }}>
          <SectionLabel>All logs ({filtered.length})</SectionLabel>
          <div style={{ display: "flex", gap: 8 }}>
            <FilterDropdown value={attackType} onChange={updateAttackType} options={attackTypes} />
            <FilterDropdown value={severity} onChange={updateSeverity} options={severities} />
          </div>
        </div>
        {loading ? (
          <div style={{ color: t.muted, padding: 20, textAlign: "center" }}>Loading…</div>
        ) : logs.length === 0 ? (
          <div style={{ color: t.muted, padding: 20, textAlign: "center" }}>No logs found</div>
        ) : filtered.length === 0 ? (
          <div style={{ color: t.muted, padding: 20, textAlign: "center" }}>No logs match these filters</div>
        ) : (
          <>
            <LogTable logs={paged} />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14 }}>
              <div style={{ fontSize: 11.5, color: t.muted, ...monoFont }}>
                Page {clampedPage} of {totalPages}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <Button
                  icon={ChevronLeft}
                  variant="ghost"
                  small
                  disabled={clampedPage <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Prev
                </Button>
                <Button
                  icon={ChevronRight}
                  variant="ghost"
                  small
                  disabled={clampedPage >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
