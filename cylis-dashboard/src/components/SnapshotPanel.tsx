"use client";

/**
 * Left panel of the log drawer's "at seal | now" compare: the header of the
 * snapshot side and how its values (and the changed values on the right) are
 * drawn. The rows themselves are laid out by LogDrawer, in one grid with the
 * current log, so each field sits on the same line on both sides.
 */
import type { ReactNode } from "react";
import { ShieldCheck, X } from "lucide-react";
import { useTheme, monoFont } from "@/theme";
import { Badge } from "@/components/ui";
import { fmtTime } from "@/lib/format";
import { toTone } from "@/lib/logRows";
import { charDiff, wordDiff, type Segment } from "@/lib/textDiff";
import { COMPARE_FIELDS, type Compare, type CompareKey, type CompareNote, type SealCell, type Value } from "@/lib/logCompare";

export type DiffLoad =
  | { status: "loading" }
  | { status: "error"; message: string };

/** Row tint of a changed field — green on the snapshot side (the original), red on the current side (the edit) */
export const SEAL_TINT = "rgba(52,211,153,0.10)";
export const NOW_TINT = "rgba(244,63,94,0.10)";

/** A value as the Log section prints it */
export function fmtValue(key: CompareKey, v: Value): ReactNode {
  if (key === "severity" && typeof v === "string") return <Badge tone={toTone(v)}>{v}</Badge>;
  if (v === null || v === "") return "—";
  if (key === "createdAt") return fmtTime(String(v));
  if (key === "cdeScope") return v ? "Yes" : "No";
  if (key === "retentionDays") return `${v} days`;
  return String(v);
}

function Segments({ segs, side }: { segs: Segment[]; side: "seal" | "now" }) {
  const t = useTheme();
  const bg = side === "seal" ? "rgba(52,211,153,0.38)" : "rgba(244,63,94,0.38)";
  return (
    <>
      {segs.map((s, i) =>
        s.changed
          ? <mark key={i} style={{ background: bg, color: t.text, borderRadius: 3, padding: "0 1px" }}>{s.text}</mark>
          : <span key={i}>{s.text}</span>,
      )}
    </>
  );
}

/**
 * A changed field on either side: message by word, raw hash by character;
 * anything else — or text past the diff limit — as the whole value.
 */
export function ChangedValue({ k, before, after, side }: { k: CompareKey; before: Value; after: Value; side: "seal" | "now" }) {
  const kind = COMPARE_FIELDS.find((f) => f.key === k)?.diff;
  const both = typeof before === "string" && typeof after === "string";
  const parts = both && kind === "word" ? wordDiff(before, after) : both && kind === "char" ? charDiff(before, after) : null;
  if (parts) return <Segments segs={side === "seal" ? parts.left : parts.right} side={side} />;
  return <>{fmtValue(k, side === "seal" ? before : after)}</>;
}

/** A snapshot-side cell that is not a changed value */
export function SealValue({ k, cell }: { k: CompareKey; cell: SealCell }) {
  const t = useTheme();
  const muted = { color: t.muted, fontStyle: "italic" as const };
  if (cell.kind === "unrecorded") return <span style={muted}>ไม่ได้บันทึกตอน seal</span>;
  if (cell.kind === "absent") return <span style={muted}>ไม่มีตอน seal</span>;
  return <>{fmtValue(k, cell.v)}</>;
}

function Note({ tone, children }: { tone: CompareNote["tone"]; children: ReactNode }) {
  const t = useTheme();
  const c = tone === "danger"
    ? { fg: t.danger, bg: "rgba(244,63,94,0.12)", bd: "rgba(244,63,94,0.45)" }
    : tone === "warn"
      ? { fg: t.warn, bg: "rgba(245,158,11,0.12)", bd: "rgba(245,158,11,0.45)" }
      : { fg: t.muted, bg: "rgba(124,135,163,0.10)", bd: t.border };
  return (
    <div role={tone === "muted" ? "note" : "alert"} style={{ marginTop: 12, padding: "8px 12px", borderRadius: 10, fontSize: 12.5, color: c.fg, background: c.bg, border: `1px solid ${c.bd}` }}>
      {children}
    </div>
  );
}

const SNAPSHOT_HINT = "จาก snapshot ที่เก็บตอน seal batch";
const titleStyle = { fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase" as const, fontWeight: 600 };

export function CloseButton({ onClose, small }: { onClose: () => void; small?: boolean }) {
  const t = useTheme();
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label="ปิดการเทียบ"
      title="ปิดการเทียบ (Esc)"
      style={{ background: t.surface2, border: `1px solid ${t.border}`, borderRadius: 8, padding: small ? 4 : 6, cursor: "pointer", color: t.text, display: "flex", flexShrink: 0 }}
    >
      <X size={small ? 14 : 16} />
    </button>
  );
}

/** Green counterpart of the drawer's red TAMPERED banner — same box, so both rows match */
export function SealBanner() {
  const t = useTheme();
  return (
    <div
      role="note"
      title={SNAPSHOT_HINT}
      style={{
        marginTop: 16, padding: "10px 12px", borderRadius: 10, display: "flex", gap: 10, alignItems: "center",
        background: "rgba(52,211,153,0.14)", border: `1px solid ${t.good}`, color: t.good, fontSize: 13, fontWeight: 600,
      }}
    >
      <ShieldCheck size={18} style={{ flexShrink: 0 }} />
      ข้อมูล ณ ตอน seal ยังไม่ถูกแก้
    </div>
  );
}

/** Whether SnapshotNotes has anything to show */
export function hasSnapshotNotes(load: DiffLoad | null, compare: Compare | null): boolean {
  return !!load
    || compare?.kind === "untrusted"
    || (compare?.kind === "rows" && (!!compare.note || compare.stale.length > 0));
}

/** What the snapshot side has to say before its rows (loading, why not, how this log changed) */
export function SnapshotNotes({ load, compare }: { load: DiffLoad | null; compare: Compare | null }) {
  const t = useTheme();
  return (
    <>
      {load?.status === "loading" && (
        <div style={{ marginTop: 12, color: t.muted, fontSize: 12.5 }}>กำลังโหลดผลตรวจ batch… (อ่านเชนสด อาจใช้เวลาถึง 5 วินาที)</div>
      )}
      {load?.status === "error" && <Note tone="danger">{load.message}</Note>}
      {compare?.kind === "untrusted" && (
        <Note tone="warn">
          <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4 }}>
            {compare.reasons.map((r) => <li key={r}>{r}</li>)}
          </ul>
        </Note>
      )}
      {compare?.kind === "rows" && compare.note && <Note tone={compare.note.tone}>{compare.note.text}</Note>}
      {compare?.kind === "rows" && compare.stale.length > 0 && (
        <Note tone="warn">
          log เปลี่ยนอีกหลังตรวจ กด Check ใหม่
          <div style={{ marginTop: 2, fontSize: 11, color: t.muted, ...monoFont }}>{compare.stale.join(" · ")}</div>
        </Note>
      )}
    </>
  );
}

/** Full-height panel head (half-screen and tab layouts): title, close button, notes */
export function SnapshotHeader({
  load, compare, onClose, showClose = true,
}: {
  /** diff still loading / failed (opened from Logs) — null once a compare exists */
  load: DiffLoad | null;
  compare: Compare | null;
  onClose: () => void;
  showClose?: boolean;
}) {
  const t = useTheme();
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ ...titleStyle, color: t.good }}>ตอน SEAL (ของเดิม)</div>
          <div style={{ marginTop: 4, fontSize: 12, color: t.muted, ...monoFont }}>{SNAPSHOT_HINT}</div>
        </div>
        {showClose && <CloseButton onClose={onClose} />}
      </div>
      <SnapshotNotes load={load} compare={compare} />
    </div>
  );
}
