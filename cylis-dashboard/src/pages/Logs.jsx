import { useMemo, useRef, useState, useEffect } from "react";
import { Search, ChevronDown, Check } from "lucide-react";
import { useTheme, sansFont } from "../theme.js";
import { Card, SectionLabel } from "../components/ui.jsx";
import LogTable from "../components/LogTable.jsx";
import { recentLogs } from "../data/mockData.js";

const ALL_ATTACK_TYPES = [
  "All types",
  ...Array.from(new Set(recentLogs.map((log) => log.attackType))),
];

/** Button + popup dropdown for filtering logs by attack type */
function AttackTypeFilter({ value, onChange }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function onClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
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
          {ALL_ATTACK_TYPES.map((opt) => (
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

export default function Logs() {
  const t = useTheme();
  const [query, setQuery] = useState("");
  const [attackType, setAttackType] = useState("All types");

  const filtered = useMemo(
    () =>
      recentLogs.filter((log) => {
        const matchesQuery = [log.id, log.source, log.ip, log.event, log.attackType]
          .join(" ")
          .toLowerCase()
          .includes(query.toLowerCase());
        const matchesType = attackType === "All types" || log.attackType === attackType;
        return matchesQuery && matchesType;
      }),
    [query, attackType]
  );

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Card>
        <SectionLabel>Search logs</SectionLabel>
        <div style={{ position: "relative", marginTop: 8 }}>
          <Search size={15} color={t.muted} style={{ position: "absolute", left: 12, top: 11 }} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by ID, source, IP, event, or attack type…"
            style={{
              width: "100%",
              background: t.surface2,
              border: `1px solid ${t.border}`,
              borderRadius: 10,
              padding: "10px 12px 10px 36px",
              color: t.text,
              fontSize: 13,
              outline: "none",
            }}
          />
        </div>
      </Card>

      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <SectionLabel>All logs ({filtered.length})</SectionLabel>
          <AttackTypeFilter value={attackType} onChange={setAttackType} />
        </div>
        <LogTable logs={filtered} />
      </Card>
    </div>
  );
}