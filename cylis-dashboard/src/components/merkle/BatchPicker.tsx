"use client";

/**
 * Batch chooser for the Verify tree: pages through GET /batches ("load more"),
 * filters the loaded ones by id, and opens any batch by pasting its full UUID.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useTheme, monoFont, sansFont } from "@/theme";
import BatchStatusBadge from "@/components/BatchStatusBadge";
import { getBatches } from "@/lib/endpoints";
import { fmtTime, shortId } from "@/lib/format";
import type { BatchListItem, BatchStatus } from "@/types/api";

const PAGE = 20;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const logsLabel = (n: number) => `${n.toLocaleString()} ${n === 1 ? "log" : "logs"}`;

export default function BatchPicker({
  value,
  selected,
  onChange,
}: {
  value: string | null;
  /** what to show on the button for the current batch (may be older than the loaded pages) */
  selected: { id: string; status: BatchStatus; logCount: number } | null;
  onChange: (id: string) => void;
}) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<BatchListItem[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  const loadMore = useCallback(() => {
    setLoading(true);
    getBatches({ limit: PAGE, offset: items.length })
      .then((p) => { setItems((cur) => [...cur, ...p.items.filter((b) => !cur.some((c) => c.id === b.id))]); setTotal(p.total); setError(""); })
      .catch(() => setError("โหลดรายการ batch ไม่สำเร็จ"))
      .finally(() => setLoading(false));
  }, [items.length]);

  // first page when the list is opened for the first time
  useEffect(() => {
    if (open && total === null && !loading) loadMore();
  }, [open, total, loading, loadMore]);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setOpen(false); }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, []);

  const needle = q.trim().toLowerCase();
  const shown = needle ? items.filter((b) => b.id.toLowerCase().includes(needle)) : items;
  const pasted = UUID_RE.test(q.trim()) && !items.some((b) => b.id.toLowerCase() === needle) ? q.trim() : null;

  function pick(id: string) {
    onChange(id);
    setOpen(false);
    setQ("");
  }

  return (
    <div ref={ref} style={{ position: "relative", minWidth: 0 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
        style={{
          display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 9, maxWidth: "100%",
          background: t.surface2, border: `1px solid ${t.border}`, color: t.text, cursor: "pointer", fontSize: 12.5, ...sansFont,
        }}
      >
        {selected && selected.id === value ? (
          <>
            <BatchStatusBadge status={selected.status} />
            <span style={monoFont}>{shortId(selected.id)}</span>
            <span style={{ color: t.muted, whiteSpace: "nowrap" }}>{logsLabel(selected.logCount)}</span>
          </>
        ) : value ? (
          <span style={monoFont}>{shortId(value)}</span>
        ) : (
          <span>เลือก batch…</span>
        )}
        <ChevronDown size={13} color={t.muted} />
      </button>

      {open && (
        <div
          role="listbox"
          style={{
            position: "absolute", top: "calc(100% + 6px)", right: 0, width: 380, maxWidth: "calc(100vw - 32px)", boxSizing: "border-box",
            background: t.surface2, border: `1px solid ${t.border}`, borderRadius: 10, boxShadow: "0 10px 28px rgba(0,0,0,0.4)",
            padding: 6, zIndex: 20,
          }}
        >
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && pasted) pick(pasted); }}
            placeholder="ค้นหาด้วย batch id (หรือวาง UUID เต็ม)"
            aria-label="Search batches by id"
            style={{ width: "100%", boxSizing: "border-box", background: t.surface, border: `1px solid ${t.border}`, borderRadius: 7, padding: "6px 8px", color: t.text, fontSize: 12.5, outline: "none", ...monoFont }}
          />
          {/* vertical scroll only — rows wrap instead of widening the list */}
          <div style={{ maxHeight: 300, overflowY: "auto", overflowX: "hidden", marginTop: 6 }}>
            {pasted && (
              <button type="button" onClick={() => pick(pasted)} style={rowStyle(t, false)}>
                <span>เปิด batch</span> <span style={monoFont}>{shortId(pasted)}</span>
              </button>
            )}
            {shown.map((b) => (
              <button key={b.id} type="button" role="option" aria-selected={b.id === value} onClick={() => pick(b.id)} style={{ ...rowStyle(t, b.id === value), display: "block" }}>
                {/* line 1: status · id · count — line 2: seal time, small */}
                <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0 }}>
                  <BatchStatusBadge status={b.status} />
                  <span style={monoFont}>{shortId(b.id)}</span>
                  <span style={{ color: t.muted, whiteSpace: "nowrap" }}>{logsLabel(b.logCount)}</span>
                </span>
                <span style={{ display: "block", marginTop: 3, color: t.muted, fontSize: 11, ...monoFont }}>sealed {fmtTime(b.sealedAt)}</span>
              </button>
            ))}
            {!loading && shown.length === 0 && !pasted && (
              <div style={{ padding: 10, color: t.muted, fontSize: 12.5 }}>
                {needle ? "ไม่พบใน batch ที่โหลดแล้ว — โหลดเพิ่ม หรือวาง UUID เต็ม" : "ยังไม่มี batch"}
              </div>
            )}
            {error && <div style={{ padding: 10, color: t.danger, fontSize: 12.5 }}>{error}</div>}
          </div>
          {total !== null && items.length < total && (
            <button
              type="button"
              disabled={loading}
              onClick={loadMore}
              style={{ marginTop: 6, width: "100%", padding: "6px 10px", borderRadius: 7, background: "transparent", border: `1px solid ${t.border}`, color: t.text, cursor: loading ? "wait" : "pointer", fontSize: 12 }}
            >
              {loading ? "กำลังโหลด…" : `โหลดเพิ่ม (${items.length} / ${total})`}
            </button>
          )}
          {loading && total === null && <div style={{ padding: 10, color: t.muted, fontSize: 12.5 }}>กำลังโหลด…</div>}
        </div>
      )}
    </div>
  );
}

function rowStyle(t: ReturnType<typeof useTheme>, active: boolean) {
  return {
    width: "100%", minWidth: 0, display: "flex", alignItems: "center", gap: 8, padding: "7px 8px", borderRadius: 7, boxSizing: "border-box" as const,
    background: active ? "rgba(59,130,246,0.12)" : "transparent", border: "none", color: t.text,
    fontSize: 12.5, textAlign: "left" as const, cursor: "pointer",
  };
}
