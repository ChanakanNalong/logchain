"use client";

/**
 * Result of GET /batches/:id/diff — which leaf positions of a batch were
 * edited, re-hashed, deleted or inserted since seal, and whether the
 * seal-time snapshot itself can be trusted. Contract: docs/api/batches-diff.md §2.
 * Closes on Esc / outside click (unless a log drawer is open on top of it).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Info, RefreshCw, ShieldAlert, X } from "lucide-react";
import { useTheme, monoFont, sansFont } from "@/theme";
import { Badge, Button, SectionLabel } from "@/components/ui";
import BatchStatusBadge from "@/components/BatchStatusBadge";
import LogDrawer, { CopyButton, useIsNarrow } from "@/components/LogDrawer";
import { PolygonscanLink } from "@/components/LogTable";
import { fmtTime, isZeroRoot, shortHash, shortId } from "@/lib/format";
import { unanchoredRootView } from "@/lib/chainState";
import type { BatchChange, BatchDiff, DiffVerdict, FieldChange, SnapshotLog } from "@/types/api";

export type DiffState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; data: BatchDiff };

const VERDICT: Record<DiffVerdict, { tone: "good" | "danger" | "slate"; label: string; hint: string }> = {
  INTACT: { tone: "good", label: "INTACT", hint: "ไม่มี log ตำแหน่งไหนเปลี่ยน และ root ตรงกับค่าอ้างอิง" },
  TAMPERED: { tone: "danger", label: "TAMPERED", hint: "ข้อมูลใน batch นี้ถูกแก้ ลบ หรือแทรกหลัง seal" },
  UNVERIFIABLE: { tone: "slate", label: "UNVERIFIABLE", hint: "ส่ง root ขึ้นเชนแล้วแต่อ่านเชนไม่ได้ตอนนี้ — ยืนยันไม่ได้ ไม่ได้แปลว่าถูกแก้" },
};

const CHANGE_TYPE: Record<BatchChange["type"], { tone: string; label: string }> = {
  CONTENT_MODIFIED: { tone: "danger", label: "CONTENT_MODIFIED" },
  HASH_MODIFIED: { tone: "orange", label: "HASH_MODIFIED" },
  DELETED: { tone: "danger", label: "DELETED" },
  UNMAPPED_OR_INSERTED: { tone: "warn", label: "UNMAPPED_OR_INSERTED" },
};

/** One line per reason — each says only what that check found */
function untrustedReasonText(reason: string, referenceName: string): string {
  switch (reason) {
    case "SNAPSHOT_ROOT_MISMATCH":
      return `root ที่สร้างจาก raw hash ใน snapshot ไม่ตรงกับ ${referenceName} — ชุด hash ใน snapshot ไม่ใช่ชุดที่ถูก seal`;
    case "SNAPSHOT_CONTENT_MISMATCH":
      return "บางแถวใน snapshot ถูกแก้เนื้อ — hash เนื้อแล้วไม่ได้ raw hash ที่เก็บไว้ในแถวนั้น";
    case "NOT_ANCHORED":
      return "batch นี้ไม่เคยถูก anchor ขึ้น chain (ไม่มี root อ้างอิงบนเชน) — ยืนยันกับเชนไม่ได้ ไม่ได้แปลว่าข้อมูลถูกแก้";
    default:
      return "snapshot ไม่ผ่านการตรวจ";
  }
}

const LONG_TEXT = 120;

function Banner({ tone, icon: Icon, children }: { tone: "danger" | "info"; icon: typeof Info; children: ReactNode }) {
  const t = useTheme();
  const c = tone === "danger"
    ? { fg: t.danger, bg: "rgba(244,63,94,0.12)", bd: t.danger }
    : { fg: t.blue2, bg: "rgba(59,130,246,0.10)", bd: "rgba(59,130,246,0.45)" };
  return (
    <div role={tone === "danger" ? "alert" : "note"} style={{ marginTop: 12, padding: "10px 12px", borderRadius: 10, display: "flex", gap: 10, alignItems: "flex-start", color: c.fg, background: c.bg, border: `1px solid ${c.bd}`, fontSize: 13 }}>
      <Icon size={17} style={{ flexShrink: 0, marginTop: 1 }} />
      <div>{children}</div>
    </div>
  );
}

export type RootState =
  | { kind: "match" }
  | { kind: "mismatch" }
  /** not comparable — tone neutral (default), slate or orange like the chain check */
  | { kind: "gray"; text: string; tone?: "neutral" | "slateMuted" | "orange" };

/** One of the four roots, coloured against the reference root */
export function RootCard({
  title, origin, value, state, isReference,
}: {
  title: string;
  origin: string;
  value: string | null;
  /** match / mismatch against the reference; gray states carry their own text */
  state: RootState;
  isReference: boolean;
}) {
  const t = useTheme();
  const gray = state.kind === "gray" ? state.tone ?? "neutral" : null;
  const color =
    state.kind === "match" ? t.good : state.kind === "mismatch" ? t.danger
    : gray === "orange" ? t.orange : t.muted;
  const border =
    state.kind === "match" ? "rgba(52,211,153,0.45)" : state.kind === "mismatch" ? "rgba(244,63,94,0.55)"
    : gray === "orange" ? "rgba(249,115,22,0.45)" : gray === "slateMuted" ? "rgba(100,116,139,0.6)" : t.border;
  return (
    <div style={{ padding: 12, borderRadius: 10, border: `1px solid ${border}`, background: t.surface2, minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <div style={{ fontWeight: 700, fontSize: 13 }}>{title}</div>
        {isReference && <span style={{ fontSize: 11, color: t.muted }}>ค่าอ้างอิง</span>}
      </div>
      <div style={{ fontSize: 11.5, color: t.muted, marginTop: 2 }}>{origin}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, minWidth: 0 }}>
        <span title={value ?? undefined} style={{ fontSize: 12.5, color, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", ...monoFont }}>
          {value ? shortHash(value, 8, 6) : "—"}
        </span>
        {value && <CopyButton value={value} />}
      </div>
      <div style={{ marginTop: 6, fontSize: 12, fontWeight: 600, color }}>
        {state.kind === "match" ? "ตรงกับค่าอ้างอิง" : state.kind === "mismatch" ? "ไม่ตรงกับค่าอ้างอิง" : state.text}
      </div>
    </div>
  );
}

/** Long values fold to one line with a toggle */
function FoldText({ value, color }: { value: string; color: string }) {
  const [open, setOpen] = useState(false);
  const t = useTheme();
  const long = value.length > LONG_TEXT;
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ color, overflowWrap: "anywhere", whiteSpace: open || !long ? "pre-wrap" : "nowrap", overflow: "hidden", textOverflow: "ellipsis", ...monoFont }}>
        {value}
      </div>
      {long && (
        <button type="button" onClick={() => setOpen((o) => !o)} style={{ background: "none", border: "none", padding: 0, marginTop: 2, color: t.blue2, cursor: "pointer", fontSize: 11.5 }}>
          {open ? "ย่อ" : "แสดงทั้งหมด"}
        </button>
      )}
    </div>
  );
}

function fieldText(field: string, v: FieldChange["before"]): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  return field === "rawHash" ? v : String(v);
}

function FieldDiff({ f }: { f: FieldChange }) {
  const t = useTheme();
  return (
    <div style={{ display: "grid", gridTemplateColumns: "110px minmax(0,1fr)", gap: 8, padding: "6px 0", borderTop: `1px solid ${t.border}`, fontSize: 12.5 }}>
      <div style={{ color: t.muted, ...monoFont }}>{f.field}</div>
      <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
        <div style={{ display: "flex", gap: 6, padding: "4px 8px", borderRadius: 6, background: "rgba(244,63,94,0.10)", minWidth: 0 }}>
          <span style={{ color: t.danger, flexShrink: 0, fontWeight: 700 }}>−</span>
          <FoldText value={fieldText(f.field, f.before)} color={t.danger} />
        </div>
        <div style={{ display: "flex", gap: 6, padding: "4px 8px", borderRadius: 6, background: "rgba(52,211,153,0.10)", minWidth: 0 }}>
          <span style={{ color: t.good, flexShrink: 0, fontWeight: 700 }}>+</span>
          <FoldText value={fieldText(f.field, f.after)} color={t.good} />
        </div>
      </div>
    </div>
  );
}

function LogContent({ log, label }: { log: SnapshotLog; label: string }) {
  const t = useTheme();
  const rows: [string, string][] = [
    ["createdAt", fmtTime(log.createdAt)], ["source", log.source], ["sourceIp", log.sourceIp ?? "—"],
    ["eventType", log.eventType], ["severity", log.severity], ["message", log.message],
    ["classification", log.classification], ["cdeScope", log.cdeScope ? "true" : "false"], ["rawHash", log.rawHash],
  ];
  return (
    <details style={{ marginTop: 6 }}>
      <summary style={{ cursor: "pointer", color: t.muted, fontSize: 12 }}>{label}</summary>
      <div style={{ marginTop: 4 }}>
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: "grid", gridTemplateColumns: "110px minmax(0,1fr)", gap: 8, padding: "4px 0", borderTop: `1px solid ${t.border}`, fontSize: 12 }}>
            <div style={{ color: t.muted, ...monoFont }}>{k}</div>
            <FoldText value={v} color={t.text} />
          </div>
        ))}
      </div>
    </details>
  );
}

function ChangeRow({ c, onOpenLog, noOriginal }: { c: BatchChange; onOpenLog: (id: string) => void; noOriginal?: boolean }) {
  const t = useTheme();
  const meta = CHANGE_TYPE[c.type];
  // a ROW_MISSING log has no row left to open
  const openable = !(c.type === "DELETED" && c.reason === "ROW_MISSING");
  return (
    <div style={{ padding: "10px 12px", borderRadius: 10, border: `1px solid ${t.border}`, background: t.surface2 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {c.type === "UNMAPPED_OR_INSERTED" ? (
          // its position counts in the set mapped now, not in the snapshot — a number here would collide
          <span title={`ไม่อยู่ใน snapshot — ลำดับในชุดที่ผูกอยู่ตอนนี้ #${c.position + 1}`} style={{ fontSize: 12, color: t.warn, fontWeight: 600 }}>ใหม่</span>
        ) : (
          <span title="ลำดับ leaf ใน Merkle tree ตอน seal (position 0-based ในสัญญา · แสดงเริ่มที่ 1)" style={{ fontSize: 12, color: t.muted, ...monoFont }}>#{c.position + 1}</span>
        )}
        {openable ? (
          <button type="button" onClick={() => onOpenLog(c.logId)} title={`Open log ${c.logId}`} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: t.blue2, fontSize: 12.5, ...monoFont }}>
            {shortId(c.logId)}
          </button>
        ) : (
          <span title={`${c.logId} — row no longer exists`} style={{ color: t.muted, fontSize: 12.5, ...monoFont }}>{shortId(c.logId)}</span>
        )}
        <Badge tone={meta.tone}>{meta.label}</Badge>
        {c.reason && <Badge tone="neutral">{c.reason}</Badge>}
      </div>
      {c.fields && c.fields.length > 0 && (
        noOriginal ? (
          <div style={{ marginTop: 8, fontSize: 12.5 }}>
            <div style={{ color: t.muted, marginBottom: 4 }}>ไม่ทราบค่าเดิม (snapshot ถูกแก้) — raw_hash (ยืนยันกับเชน) ≠ hash เนื้อหาปัจจุบัน:</div>
            {c.fields?.map((f) => (
              <div key={f.field} style={{ display: "grid", gap: 4, minWidth: 0 }}>
                <div style={{ display: "flex", gap: 6, padding: "4px 8px", borderRadius: 6, background: t.surface2, minWidth: 0 }}>
                  <span style={{ color: t.muted, flexShrink: 0, ...monoFont }}>raw_hash</span>
                  <FoldText value={String(f.before)} color={t.muted} />
                </div>
                <div style={{ display: "flex", gap: 6, padding: "4px 8px", borderRadius: 6, background: "rgba(244,63,94,0.10)", minWidth: 0 }}>
                  <span style={{ color: t.danger, flexShrink: 0, fontWeight: 700, ...monoFont }}>content</span>
                  <FoldText value={String(f.after)} color={t.danger} />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ marginTop: 8 }}>{c.fields.map((f) => <FieldDiff key={f.field} f={f} />)}</div>
        )
      )}
      {c.snapshot && <LogContent log={c.snapshot} label="เนื้อ log ตอน seal (จาก snapshot)" />}
      {c.current && <LogContent log={c.current} label="เนื้อ log ตอนนี้ (ไม่อยู่ใน snapshot)" />}
    </div>
  );
}

function rootStates(d: BatchDiff) {
  const anchored = d.chainRoot !== null && !isZeroRoot(d.chainRoot);
  const reference = anchored ? d.chainRoot! : d.dbRoot;
  const cmp = (v: string | null) => (v?.toLowerCase() === reference.toLowerCase() ? { kind: "match" as const } : { kind: "mismatch" as const });
  return {
    referenceName: anchored ? "root บนเชน" : "root ใน DB",
    anchored,
    // 0x000… is "no root on chain", not a hash to show — the card prints "—" (chainValue)
    chainValue: anchored ? d.chainRoot : null,
    chain: (
      d.chainRoot === null ? { kind: "gray", text: "ติดต่อเชนไม่ได้" }
      : isZeroRoot(d.chainRoot) ? { kind: "gray", text: unanchoredRootView(d.status).label, tone: unanchoredRootView(d.status).tone }
      : cmp(d.chainRoot)
    ) as RootState,
    snapshot: (d.snapshotRoot === null ? { kind: "gray", text: "ไม่มี snapshot" } : cmp(d.snapshotRoot)) as RootState,
    db: cmp(d.dbRoot) as RootState,
    storedHash: (d.storedHashRoot === null ? { kind: "gray", text: "ไม่มี log ผูกกับ batch นี้แล้ว" } : cmp(d.storedHashRoot)) as RootState,
    content: (d.contentRoot === null ? { kind: "gray", text: "ไม่มี log ผูกกับ batch นี้แล้ว" } : cmp(d.contentRoot)) as RootState,
  };
}

const SUMMARY_KEYS: [keyof BatchDiff["summary"], string, string][] = [
  ["unchanged", "UNCHANGED", "good"],
  ["contentModified", "CONTENT_MODIFIED", "danger"],
  ["hashModified", "HASH_MODIFIED", "orange"],
  ["deleted", "DELETED", "danger"],
  ["unmappedOrInserted", "UNMAPPED_OR_INSERTED", "warn"],
];

export default function BatchDiffDrawer({
  batchId, state, onRecheck, onClose,
}: {
  /** null = closed */
  batchId: string | null;
  state: DiffState | null;
  onRecheck: () => void;
  onClose: () => void;
}) {
  const t = useTheme();
  const narrow = useIsNarrow();
  const panelRef = useRef<HTMLDivElement>(null);
  const [openLog, setOpenLog] = useState<string | null>(null);
  // the panel is min(880px, 100vw) wide, so the viewport decides the room for the roots
  // (the roots block only exists once the diff is loaded — too late for a ResizeObserver here)
  const [viewport, setViewport] = useState(1440);
  useEffect(() => {
    const update = () => setViewport(window.innerWidth);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  const rootsRoom = Math.min(viewport, 880) - 44; // panel side padding
  const rootCols = narrow ? 1 : rootsRoom >= 950 ? 5 : rootsRoom >= 460 ? 3 : 2;
  const closeLog = useCallback(() => setOpenLog(null), []);

  // Esc belongs to the log drawer while it is open on top
  useEffect(() => {
    if (!batchId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !openLog) onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [batchId, openLog, onClose]);

  useEffect(() => { if (batchId) panelRef.current?.focus(); }, [batchId]);
  useEffect(() => { setOpenLog(null); }, [batchId]);

  if (!batchId) return null;
  const loading = state?.status === "loading";
  const d = state?.status === "ok" && state.data.batchId === batchId ? state.data : null;
  const roots = d ? rootStates(d) : null;
  const verdict = d ? VERDICT[d.summary.verdict] : null;
  // The backend answers TAMPERED whenever the snapshot is untrusted (someone touched
  // the DB). Keep that verdict, but say what was actually found: the snapshot may be
  // the only thing edited while the current logs still rebuild the reference root.
  const verdictHint =
    d && verdict && d.snapshotTrusted === false
      ? roots?.content.kind === "match"
        ? "snapshot ถูกแก้ · root ของ log ปัจจุบันยังตรงกับค่าอ้างอิง"
        : "snapshot ถูกแก้ และ root ของ log ปัจจุบันไม่ตรงกับค่าอ้างอิง"
      : verdict?.hint;

  const verdictColors = verdict && {
    good: { fg: t.good, bg: "rgba(52,211,153,0.12)", bd: "rgba(52,211,153,0.5)" },
    danger: { fg: t.danger, bg: "rgba(244,63,94,0.14)", bd: t.danger },
    slate: { fg: t.text, bg: "rgba(71,85,105,0.30)", bd: "rgba(100,116,139,0.6)" },
  }[verdict.tone];

  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(2,6,23,0.55)", display: "flex", justifyContent: "flex-end" }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Batch diff"
        tabIndex={-1}
        style={{
          width: narrow ? "100vw" : "min(880px, 100vw)", height: "100%", background: t.surface,
          borderLeft: narrow ? "none" : `1px solid ${t.border}`, boxShadow: "-12px 0 32px rgba(0,0,0,0.35)",
          overflowY: "auto", overflowX: "hidden", padding: narrow ? "16px 16px 40px" : "20px 22px 40px", color: t.text, outline: "none", ...sansFont,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 10.5, color: t.muted, letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 600 }}>Check against blockchain</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4, fontSize: 13, ...monoFont }}>
              <span style={{ overflowWrap: "anywhere" }}>batch {batchId}</span>
              <CopyButton value={batchId} />
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            <Button variant="ghost" small icon={RefreshCw} disabled={loading} onClick={onRecheck}>{loading ? "Checking…" : "ตรวจอีกครั้ง"}</Button>
            <button type="button" onClick={onClose} aria-label="Close" title="Close (Esc)" style={{ background: t.surface2, border: `1px solid ${t.border}`, borderRadius: 8, padding: 6, cursor: "pointer", color: t.text, display: "flex" }}>
              <X size={16} />
            </button>
          </div>
        </div>

        {loading && (
          <div style={{ marginTop: 24, color: t.muted, fontSize: 13, minHeight: 200 }}>
            กำลังอ่าน root จากเชนและเทียบ snapshot… (อาจใช้เวลาถึง 5 วินาที)
          </div>
        )}
        {state?.status === "error" && (
          <div style={{ marginTop: 20, color: t.danger, fontSize: 13 }}>{state.message}</div>
        )}

        {d && verdict && verdictColors && roots && (
          <>
            {/* verdict first — the one thing to read before anything else */}
            <div style={{ marginTop: 16, padding: "14px 16px", borderRadius: 12, background: verdictColors.bg, border: `2px solid ${verdictColors.bd}`, color: verdictColors.fg }}>
              <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: "0.02em", ...monoFont }}>{verdict.label}</div>
              <div style={{ fontSize: 13, marginTop: 4 }}>{verdictHint}</div>
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginTop: 10, fontSize: 12, color: t.muted }}>
              <BatchStatusBadge status={d.status} />
              <span style={monoFont}>checked {fmtTime(d.checkedAt)}</span>
              {d.blockNumber != null && <span style={monoFont}>block {d.blockNumber}</span>}
              {d.polygonscanUrl && <PolygonscanLink url={d.polygonscanUrl} />}
              {/* chain unreadable: block/tx are what the DB recorded, not confirmed on chain now */}
              {!roots.anchored && (d.blockNumber != null || d.polygonscanUrl) && (
                <span style={{ fontSize: 11, color: t.muted }} title="อ่านเชนไม่ได้ตอนตรวจ — block และ tx มาจากที่บันทึกไว้ใน DB">(ข้อมูลจาก DB)</span>
              )}
            </div>

            {d.snapshotTrusted === false && d.baseline === "raw_hash" && (
              <Banner tone="info" icon={Info}>
                <strong>snapshot ไม่น่าเชื่อถือ — ใช้ raw_hash (ยังตรงกับเชน) เป็นตัวเทียบแทน</strong>
                <div style={{ marginTop: 6 }}>
                  สมาชิก batch ครบตามตอน seal (storedHashRoot == เชน) จึงชี้รายตัวได้ว่าตัวไหนเนื้อหาถูกแก้ —
                  แต่ไม่ทราบค่าเดิมของแต่ละตัว (snapshot ถูกแก้)
                </div>
                <div style={{ marginTop: 4, fontSize: 11, color: t.muted, ...monoFont }}>{d.untrustedReasons.join(" · ")}</div>
              </Banner>
            )}
            {d.snapshotTrusted === false && d.baseline !== "raw_hash" && (
              <Banner tone="danger" icon={ShieldAlert}>
                <strong>snapshot ไม่น่าเชื่อถือ ตรวจได้แค่ระดับ batch</strong>
                <ul style={{ margin: "6px 0 0", paddingLeft: 18, display: "grid", gap: 4 }}>
                  {d.untrustedReasons.map((r) => <li key={r}>{untrustedReasonText(r, roots.referenceName)}</li>)}
                </ul>
                <div style={{ marginTop: 6 }}>จึงไม่แสดงรายละเอียดรายตำแหน่ง</div>
                <div style={{ marginTop: 4, fontSize: 11, color: t.muted, ...monoFont }}>{d.untrustedReasons.join(" · ")}</div>
              </Banner>
            )}
            {/* NOT_ANCHORED อยู่ใน untrustedReasons เสมอเมื่อ batch ยังไม่ขึ้น chain แต่ list
                ด้านบนโชว์เฉพาะตอน snapshotTrusted===false — legacy/no-snapshot (snapshotTrusted
                null) จึงต้องมีบรรทัดนี้แยก ไม่งั้น FAILED ที่เป็น legacy จะไม่บอกว่า "ไม่เคย anchor" */}
            {d.untrustedReasons.includes("NOT_ANCHORED") && d.snapshotTrusted !== false && (
              <Banner tone="info" icon={Info}>
                {untrustedReasonText("NOT_ANCHORED", roots.referenceName)}
              </Banner>
            )}
            {d.legacy && (
              <Banner tone="info" icon={Info}>
                batch นี้เกิดก่อนมีระบบ snapshot — ตรวจได้แค่ระดับ batch (เทียบ root) ไม่มีรายละเอียดรายตำแหน่ง
              </Banner>
            )}
            {d.trustBasis === "db" && (
              <Banner tone="info" icon={Info}>
                ไม่มี root บนเชนให้เทียบ ({d.chainRoot === null ? "ติดต่อเชนไม่ได้" : unanchoredRootView(d.status).label}) — เทียบ snapshot กับ root ใน DB แทน ซึ่งเชื่อได้น้อยกว่า
              </Banner>
            )}

            <section style={{ marginTop: 18 }}>
              <SectionLabel>Merkle roots</SectionLabel>
              <div style={{ fontSize: 12.5, color: t.muted, margin: "4px 0 10px" }}>
                เทียบกับ: <strong style={{ color: t.text }}>{roots.referenceName}</strong>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: `repeat(${rootCols}, minmax(0, 1fr))`, gap: 10 }}>
                <RootCard title="chainRoot" origin="บนเชน — อ่านจาก contract ตอนนี้" value={roots.chainValue} state={roots.chain} isReference={roots.anchored} />
                <RootCard title="snapshotRoot" origin="สร้างจาก snapshot ที่เก็บตอน seal" value={d.snapshotRoot} state={roots.snapshot} isReference={false} />
                <RootCard title="dbRoot" origin="root ที่เก็บใน DB ตอน seal" value={d.dbRoot} state={roots.db} isReference={!roots.anchored} />
                <RootCard title="storedHashRoot" origin="จาก raw_hash ที่เก็บไว้ — แดงเมื่อคอลัมน์ raw_hash ถูกแก้" value={d.storedHashRoot} state={roots.storedHash} isReference={false} />
                <RootCard title="contentRoot" origin="คำนวณจากเนื้อหา log ปัจจุบัน (hash ใหม่) — แดงเมื่อเนื้อ log ถูกแก้" value={d.contentRoot} state={roots.content} isReference={false} />
              </div>
              <div style={{ marginTop: 10, fontSize: 12.5, color: t.muted }}>
                ทุกช่องต้องเขียว ข้อมูลถึงจะสมบูรณ์ — <span style={{ color: t.text }}>storedHashRoot</span> แดง = raw_hash ถูกแก้ · <span style={{ color: t.text }}>contentRoot</span> แดง = เนื้อ log ถูกแก้
              </div>
              {d.chainError && <div style={{ marginTop: 8, fontSize: 12, color: t.muted, ...monoFont }}>{d.chainError}</div>}
            </section>

            <section style={{ marginTop: 18 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <SectionLabel>Summary</SectionLabel>
                {d.baseline === "raw_hash" && <Badge tone="warn">เทียบกับ raw_hash</Badge>}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(150px, 100%), 1fr))", gap: 8, marginTop: 6 }}>
                {SUMMARY_KEYS.map(([key, label, tone]) => {
                  const v = d.summary[key] as number | null;
                  return (
                    <div key={key} style={{ padding: "8px 10px", borderRadius: 9, background: t.surface2, border: `1px solid ${t.border}` }}>
                      <div style={{ fontSize: 10.5, color: t.muted, ...monoFont }}>{label}</div>
                      <div style={{ fontSize: 20, fontWeight: 700, color: v ? (t as any)[tone] ?? t.text : t.text, ...monoFont }} title={v === null ? "ไม่ทราบ — ไม่มี snapshot ที่เชื่อได้" : undefined}>
                        {v === null ? "—" : v}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div style={{ marginTop: 6, fontSize: 12, color: t.muted, ...monoFont }}>
                snapshot {d.summary.snapshotLogs} logs · mapped now {d.summary.mappedLogs} logs
              </div>
            </section>

            <section style={{ marginTop: 18 }}>
              <SectionLabel>Changed logs</SectionLabel>
              {d.baseline === "none" ? (
                // untrusted (raw_hash ก็ไม่ตรงเชน) หรือ legacy: ตัดสินได้แค่ระดับ batch
                <div style={{ fontSize: 12.5, color: t.muted, marginTop: 6 }}>
                  ไม่มีรายละเอียดรายตำแหน่ง — {d.legacy ? "batch นี้ไม่มี snapshot" : "snapshot ใช้อ้างอิงไม่ได้ และ raw_hash ก็ไม่ตรงเชน"}
                </div>
              ) : d.changes.length === 0 ? (
                <div style={{ fontSize: 12.5, color: t.muted, marginTop: 6 }}>ไม่มี log ตำแหน่งไหนเปลี่ยน</div>
              ) : (
                <div style={{ display: "grid", gap: 8, marginTop: 6 }}>
                  {d.changes.map((c) => (
                    <ChangeRow key={`${c.type}:${c.position}:${c.logId}`} c={c} onOpenLog={setOpenLog} noOriginal={d.baseline === "raw_hash"} />
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>

      {/* rendered last so it stacks above this drawer */}
      <LogDrawer logId={openLog} onClose={closeLog} diff={d} />
    </div>
  );
}
