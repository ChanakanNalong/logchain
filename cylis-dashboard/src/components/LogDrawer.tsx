"use client";

/**
 * Side drawer with everything about one log (GET /logs/:id/detail): the log,
 * its batch + tx, the live root check against the chain, the proof and the
 * alerts it belongs to. Shared by Logs and Alerts.
 * Closes on Esc and on a click outside the panel; full screen on narrow screens.
 * "เทียบกับตอน seal" adds the snapshot side (SnapshotPanel) to the left, in the
 * same scroll box and grid as the Log section so every field lines up.
 */
import { Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Check, Columns2, Copy, GitBranch, ShieldAlert, X } from "lucide-react";
import { useTheme, monoFont, sansFont } from "@/theme";
import { Badge, Button, SectionLabel } from "@/components/ui";
import BatchStatusBadge from "@/components/BatchStatusBadge";
import AlertRoleBadge from "@/components/AlertRoleBadge";
import { copyText, PolygonscanLink } from "@/components/LogTable";
import { ChangedValue, CloseButton, hasSnapshotNotes, NOW_TINT, SEAL_TINT, SealBanner, SealValue, SnapshotHeader, SnapshotNotes, type DiffLoad } from "@/components/SnapshotPanel";
import { getBatchDiff, getLogDetail } from "@/lib/endpoints";
import { buildCompare, COMPARE_FIELDS, findChange, type CompareKey } from "@/lib/logCompare";
import { fmtTime, isZeroRoot, shortHash } from "@/lib/format";
import { alertTone, toTone } from "@/lib/logRows";
import { QUERY_KEYS, useNavigate } from "@/lib/nav";
import { unanchoredRootView } from "@/lib/chainState";
import { canAccessPage } from "@/lib/roles";
import type { BatchDiff, ChainCheck, LogDetail } from "@/types/api";

/** Fields already known from the row that was clicked — shown while the detail loads */
export interface LogDrawerSeed {
  createdAt?: string;
  source?: string;
  sourceIp?: string | null;
  eventType?: string;
  severity?: string;
  message?: string;
}

const NARROW_QUERY = "(max-width: 640px)";

function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const update = () => setMatches(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [query]);
  return matches;
}

export function useIsNarrow(): boolean {
  return useMedia(NARROW_QUERY);
}

/** compare: two 560px panels side by side from here up; half the screen each below */
const COMPARE_WIDE_QUERY = "(min-width: 1200px)";
/** compare: tabs in one panel instead of two */
const COMPARE_TABS_QUERY = "(max-width: 768px)";

function diffErrorText(e: any): string {
  switch (e?.response?.status) {
    case 403: return "บัญชีนี้ไม่มีสิทธิ์ดูผลตรวจ batch";
    case 404: return "ไม่พบ batch นี้";
    default: return "โหลดผลตรวจ batch ไม่สำเร็จ ลองปิดแล้วกดเทียบใหม่";
  }
}

function errorText(e: any): string {
  switch (e?.response?.status) {
    case 400: return "Log ID ต้องเป็น UUID เต็ม";
    case 403: return "บัญชีนี้ไม่มีสิทธิ์ดูรายละเอียด log";
    case 404: return "ไม่พบ log นี้";
    default: return "โหลดรายละเอียด log ไม่สำเร็จ";
  }
}

/** The five states of the live root check. `error` is never a tamper verdict. */
function chainCheckView(c: ChainCheck | null, batchStatus: string | undefined): { tone: string; label: string; note: string } {
  if (c === null) return { tone: "neutral", label: "รอ seal รอบถัดไป", note: "log นี้ยังไม่อยู่ใน batch จึงยังไม่มี root ให้เทียบ" };
  if ("error" in c) return { tone: "neutral", label: "ติดต่อเชนไม่ได้ตอนนี้", note: "อ่าน root จากเชนไม่ได้ (RPC ล่มหรือ timeout) — ไม่ได้แปลว่าข้อมูลถูกแก้ ลองใหม่ภายหลัง" };
  // a tampered batch never gets green, even though its stored root still matches (demo: no green on edited logs)
  if (c.match) return { tone: batchStatus === "TAMPERED" ? "blue" : "good", label: "root ใน DB ตรงกับบนเชน", note: "root ที่เก็บใน DB ตรงกับ root ที่ตรึงไว้บนเชน (เทียบ root ไม่ได้เทียบทีละ row)" };
  if (isZeroRoot(c.chainRoot)) return unanchoredRootView(batchStatus);
  return { tone: "danger", label: "root ใน DB ไม่ตรงกับบนเชน", note: "root ใน DB ต่างจาก root บนเชน — ข้อมูลใน batch นี้อาจถูกแก้หลัง anchor" };
}

const NOT_ANCHORED_STATUSES = ["PENDING", "SEALED", "UNVERIFIED", "FAILED"];

/**
 * Where the batch status and the live check tell different stories. Both stay
 * on screen — this only explains the gap.
 *  - TAMPERED + root matches is the normal tamper case: the backend also
 *    marks TAMPERED when a row no longer matches its raw hash, while the
 *    stored root is untouched (integrity.service.ts, `modified.length > 0`).
 *  - the rest are real disagreements, usually a status from an older round.
 */
function statusNote(status: string, c: ChainCheck | null): { tone: "danger" | "warn"; text: string } | null {
  if (!c || "error" in c) return null;
  const state = c.match ? "match" : isZeroRoot(c.chainRoot) ? "zero" : "mismatch";
  if (status === "TAMPERED") {
    return state === "match"
      ? { tone: "danger", text: "root ใน DB ยังตรงกับเชน แต่ row ใน batch ถูกแก้หลัง seal (ตรวจด้วย raw hash ของแต่ละ row)" }
      : null;
  }
  const conflict =
    (status === "CONFIRMED" && state !== "match") ||
    (NOT_ANCHORED_STATUSES.includes(status) && state === "match") ||
    state === "mismatch";
  return conflict ? { tone: "warn", text: "สถานะ batch กับผลตรวจล่าสุดไม่ตรงกัน กดตรวจกับเชนอีกครั้ง" } : null;
}

export function CopyButton({ value }: { value: string }) {
  const t = useTheme();
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 1600);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <button
      type="button"
      onClick={async () => setState((await copyText(value)) ? "ok" : "fail")}
      title={state === "fail" ? "copy failed" : "Copy"}
      aria-label="Copy"
      style={{ background: "transparent", border: "none", padding: 2, cursor: "pointer", color: state === "fail" ? t.danger : state === "ok" ? t.good : t.muted, display: "inline-flex", flexShrink: 0 }}
    >
      {state === "ok" ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

function Field({ label, children, mono, copy, tint }: { label: string; children: ReactNode; mono?: boolean; copy?: string | null; tint?: string }) {
  const t = useTheme();
  // a tinted (changed) row pads its sides but pulls them back, so its text stays in line with the rows around it
  const tinted: CSSProperties = tint ? { background: tint, margin: "0 -6px", padding: "6px 6px", borderRadius: 4 } : {};
  return (
    <div style={{ display: "grid", gridTemplateColumns: "120px minmax(0,1fr)", gap: 10, padding: "6px 0", borderTop: `1px solid ${t.border}`, fontSize: 12.5, ...tinted }}>
      <div style={{ color: t.muted, ...sansFont }}>{label}</div>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 6, minWidth: 0 }}>
        <div style={{ minWidth: 0, overflowWrap: "anywhere", whiteSpace: "pre-wrap", ...(mono ? monoFont : {}) }}>{children}</div>
        {copy && <CopyButton value={copy} />}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ marginTop: 18 }}>
      <SectionLabel>{title}</SectionLabel>
      <div style={{ marginTop: 6 }}>{children}</div>
    </section>
  );
}

export default function LogDrawer({
  logId,
  seed,
  onClose,
  diff: diffProp,
}: {
  /** null = closed */
  logId: string | null;
  seed?: LogDrawerSeed;
  onClose: () => void;
  /**
   * The batch diff already on screen (opened on top of BatchDiffDrawer) — the
   * compare uses it and never fetches again. Left out (Logs, Alerts, Verify): the
   * diff is fetched once, only when the user asks for the compare.
   */
  diff?: BatchDiff | null;
}) {
  const t = useTheme();
  const narrow = useIsNarrow();
  const navigate = useNavigate();
  const panelRef = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState<LogDetail | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // ── compare with the seal-time snapshot ──
  const [compareOpen, setCompareOpen] = useState(false);
  const [ownDiff, setOwnDiff] = useState<(DiffLoad | { status: "ok"; data: BatchDiff }) & { batchId: string } | null>(null);
  const [tab, setTab] = useState<"seal" | "now">("seal");
  const diffSeq = useRef(0);
  const wide = useMedia(COMPARE_WIDE_QUERY);
  const tabbed = useMedia(COMPARE_TABS_QUERY);

  useEffect(() => {
    diffSeq.current++;
    setCompareOpen(false);
    setOwnDiff(null);
    setTab("seal");
  }, [logId]);

  useEffect(() => {
    if (!logId) return;
    let cancelled = false;
    setLoaded(null);
    setError("");
    setLoading(true);
    getLogDetail(logId)
      .then((d) => { if (!cancelled) setLoaded(d); })
      .catch((e) => {
        if (cancelled) return;
        console.error("log detail fetch failed", e);
        setError(errorText(e));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [logId, reloadKey]);

  // focus moves into the panel so Esc works right after opening
  useEffect(() => {
    if (logId) panelRef.current?.focus();
  }, [logId]);

  // Esc closes the compare first, then the drawer
  useEffect(() => {
    if (!logId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (compareOpen) setCompareOpen(false);
      else onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [logId, compareOpen, onClose]);

  if (!logId) return null;

  // the drawer stays mounted between opens — never show the previous log's
  // detail under the new id, not even for the frame before the effect clears it
  const detail = loaded?.log.id === logId ? loaded : null;
  const log = detail?.log;
  const shown = { ...seed, ...log };
  const canSeeAlerts = canAccessPage("alerts");
  const canSeeVerify = canAccessPage("verify");
  const check = detail ? chainCheckView(detail.chainCheck, detail.batch?.status) : null;
  const note = detail?.batch ? statusNote(detail.batch.status, detail.chainCheck) : null;
  const tampered = detail?.batch?.status === "TAMPERED";
  // not known yet (no seed for it and the detail is still on its way) → say so instead of "—"
  const pending = !detail && !error;
  const val = (v: string | null | undefined): ReactNode =>
    v !== undefined && v !== null ? v
    : v === undefined && pending ? <span style={{ color: t.muted, fontStyle: "italic" }}>กำลังโหลด…</span>
    : "—";
  const chainMatch = detail?.chainCheck && !("error" in detail.chainCheck) ? detail.chainCheck : null;

  // compare: inside the batch diff it uses that diff (its status is the batch's); elsewhere
  // only roles that may call GET /batches/:id/diff (admin, auditor) get the button
  const nested = diffProp !== undefined;
  const canCompare = !!log && (nested
    ? !!diffProp && diffProp.status === "TAMPERED" && diffProp.snapshotTrusted === true
    : tampered && canAccessPage("batches") && !!detail?.batch);
  const activeDiff = nested ? diffProp ?? null : ownDiff?.status === "ok" ? ownDiff.data : null;
  const compare = compareOpen && activeDiff && log ? buildCompare(activeDiff, logId, log) : null;
  const rows = compare?.kind === "rows" ? compare.rows : null;
  const diffLoad: DiffLoad | null = compareOpen && !nested && ownDiff && ownDiff.status !== "ok" ? ownDiff : null;
  const split = compareOpen && !tabbed;
  // wide screens: two full panels, every header row, heading and field paired line by line
  const card = split && wide;
  const showSeal = compareOpen && tabbed && tab === "seal";

  const toggleCompare = () => {
    if (compareOpen) { setCompareOpen(false); return; }
    setCompareOpen(true);
    setTab("seal");
    const batchId = detail?.batch?.id;
    // fetched once per open drawer — a failed load is retried by opening the compare again
    if (nested || !batchId || (ownDiff?.batchId === batchId && ownDiff.status !== "error")) return;
    const seq = ++diffSeq.current;
    setOwnDiff({ status: "loading", batchId });
    getBatchDiff(batchId)
      .then((data) => { if (seq === diffSeq.current) setOwnDiff({ status: "ok", data, batchId }); })
      .catch((e) => {
        if (seq !== diffSeq.current) return;
        console.error("batch diff fetch failed", e);
        setOwnDiff({ status: "error", message: diffErrorText(e), batchId });
      });
  };

  // ── the Log section, one field at a time: current side and snapshot side ──
  const nowContent: Record<CompareKey, ReactNode> = {
    createdAt: shown.createdAt !== undefined ? fmtTime(shown.createdAt) : val(undefined),
    source: val(shown.source),
    sourceIp: val(shown.sourceIp),
    eventType: val(shown.eventType),
    severity: shown.severity ? <Badge tone={toTone(shown.severity)}>{shown.severity}</Badge> : val(shown.severity),
    message: val(shown.message),
    classification: log?.classification,
    cdeScope: log ? (log.cdeScope ? "Yes" : "No") : null,
    retentionDays: log ? `${log.retentionDays} days` : null,
    rawHash: log?.rawHash,
  };
  // the last four only exist once the detail is here
  const DETAIL_ONLY: CompareKey[] = ["classification", "cdeScope", "retentionDays", "rawHash"];
  const nowCopy: Partial<Record<CompareKey, string | null | undefined>> = { sourceIp: shown.sourceIp, rawHash: log?.rawHash };

  const nowField = (f: (typeof COMPARE_FIELDS)[number]) => {
    if (!log && DETAIL_ONLY.includes(f.key)) return null;
    const row = rows?.[f.key];
    const changed = row?.changed && row.seal.kind === "value";
    return (
      <Field key={f.key} label={f.label} mono={f.mono} copy={nowCopy[f.key]} tint={changed ? NOW_TINT : undefined}>
        {changed && row.seal.kind === "value" ? <ChangedValue k={f.key} before={row.seal.v} after={row.after ?? null} side="now" /> : nowContent[f.key]}
      </Field>
    );
  };
  const sealField = (f: (typeof COMPARE_FIELDS)[number]) => {
    const row = rows?.[f.key];
    if (!row) return null;
    const v = row.seal.kind === "value" ? row.seal.v : null;
    return (
      <Field
        key={f.key}
        label={f.label}
        mono={f.mono}
        copy={(f.key === "rawHash" || f.key === "sourceIp") && typeof v === "string" ? v : null}
        tint={row.changed ? SEAL_TINT : undefined}
      >
        {row.changed && row.seal.kind === "value"
          ? <ChangedValue k={f.key} before={row.seal.v} after={row.after ?? null} side="seal" />
          : <SealValue k={f.key} cell={row.seal} />}
      </Field>
    );
  };

  const pad = narrow ? 16 : 22;
  const cell = (extra?: CSSProperties): CSSProperties => ({ padding: `0 ${pad}px`, minWidth: 0, ...extra });
  // one grid row per field: the taller side sets the height of both
  const rowCell: CSSProperties = { ...cell(), display: "grid" };
  const sealHeader = (
    <SnapshotHeader load={diffLoad} compare={compare} onClose={() => setCompareOpen(false)} showClose={!tabbed} />
  );
  const anyChanged = !!rows && Object.values(rows).some((r) => r.changed);

  // ── everything under the Log section, as rows with an optional snapshot-side twin ──
  // The snapshot side only gets a value where there is evidence for it: the same batch
  // (it does not change after seal), its sealedAt, or the snapshot itself. Status and
  // Proof are inferred ("the batch was intact at seal") and say so in a tooltip.
  type Pair = { key: string; now: ReactNode; seal?: ReactNode };
  type RestSection = { key: string; title: string; rows: Pair[] };
  const INFERRED = "อนุมานจากตอน seal";
  const change = activeDiff ? findChange(activeDiff, logId) : undefined;
  // a log missing from the snapshot was not in the batch at seal — nothing to infer for it
  const sealKnown = !!rows && change?.type !== "UNMAPPED_OR_INSERTED";
  // only the wide card compares past the Log section — elsewhere these rows keep their usual look
  const tintRest = card && sealKnown;
  const both = (key: string, el: ReactNode): Pair => ({ key, now: el, seal: sealKnown ? el : undefined });
  const restSections: RestSection[] = [];
  if (detail) {
    const b = detail.batch;
    const batchRows: Pair[] = [];
    if (b) {
      const statusChanged = b.status !== "CONFIRMED";
      batchRows.push({
        key: "status",
        now: <Field label="Status" tint={tintRest && statusChanged ? NOW_TINT : undefined}><BatchStatusBadge status={b.status} /></Field>,
        seal: sealKnown ? (
          <Field label="Status" tint={statusChanged ? SEAL_TINT : undefined}>
            <Badge tone="good" title={`${INFERRED} — root อยู่บนเชนและ log ยังไม่ถูกแก้`}>On-chain ✓</Badge>
          </Field>
        ) : undefined,
      });
      batchRows.push(
        both("id", <Field label="Batch ID" mono copy={b.id}>{b.id}</Field>),
        both("root", <Field label="Merkle root" mono copy={b.merkleRoot}>{shortHash(b.merkleRoot, 10, 8)}</Field>),
        both("sealed", <Field label="Sealed at" mono>{fmtTime(b.sealedAt)}</Field>),
        both("confirmed", <Field label="Confirmed at" mono>{fmtTime(b.confirmedAt)}</Field>),
        both("tx", (
          <Field label="Tx hash" mono copy={b.txHash}>
            {b.txHash ? shortHash(b.txHash, 10, 8) : "— (ยังไม่มี tx)"}
          </Field>
        )),
        both("block", <Field label="Block" mono>{b.blockNumber ?? "—"}</Field>),
      );
      if (b.polygonscanUrl) batchRows.push(both("explorer", <Field label="Explorer"><PolygonscanLink url={b.polygonscanUrl} /></Field>));
    } else {
      batchRows.push({ key: "status", now: <Field label="Status"><BatchStatusBadge status={null} /></Field> });
    }
    restSections.push({ key: "batch", title: "Batch · on-chain", rows: batchRows });

    const chainRows: Pair[] = [];
    if (check) {
      const checkView = (tone: string, title?: string) => (
        <div style={{ display: "grid", gap: 6 }}>
          <div><Badge tone={tone} title={title}>{check.label}</Badge></div>
          <div style={{ fontSize: 12.5, color: t.muted }}>{check.note}</div>
        </div>
      );
      chainRows.push({
        key: "check",
        now: checkView(check.tone),
        // the root has not changed since seal, so a live match also held then
        seal: sealKnown && chainMatch?.match ? checkView("good", INFERRED) : undefined,
      });
    }
    if (note) {
      chainRows.push({
        key: "note",
        now: (
          <div
            style={{
              marginTop: 8, padding: "8px 10px", borderRadius: 8, fontSize: 12.5,
              color: note.tone === "danger" ? t.danger : t.warn,
              border: `1px solid ${note.tone === "danger" ? "rgba(244,63,94,0.4)" : "rgba(245,158,11,0.4)"}`,
              background: note.tone === "danger" ? "rgba(244,63,94,0.08)" : "rgba(245,158,11,0.08)",
            }}
          >
            {note.text}
          </div>
        ),
      });
    }
    if (chainMatch) {
      chainRows.push(both("chainRoot", (
        <div style={{ marginTop: 6, display: "grid" }}>
          {isZeroRoot(chainMatch.chainRoot) ? (
            // 0x000… means "no root on chain", not a hash to show
            <Field label="Root on chain">
              <span style={{ color: unanchoredRootView(b?.status).tone === "orange" ? t.orange : t.muted }}>
                — · {unanchoredRootView(b?.status).label}
              </span>
            </Field>
          ) : (
            <Field label="Root on chain" mono copy={chainMatch.chainRoot}>{shortHash(chainMatch.chainRoot, 10, 8)}</Field>
          )}
        </div>
      )));
      chainRows.push(both("dbRoot", <Field label="Root in DB" mono copy={chainMatch.dbRoot}>{shortHash(chainMatch.dbRoot, 10, 8)}</Field>));
    }
    if (detail.chainCheck && "error" in detail.chainCheck) {
      chainRows.push({ key: "error", now: <Field label="Error" mono>{detail.chainCheck.error}</Field> });
    }
    if (detail.chainCheck) {
      chainRows.push({
        key: "checkedAt",
        now: <Field label="Checked at" mono>{fmtTime(detail.chainCheck.checkedAt)}</Field>,
        seal: sealKnown && b ? (
          <Field label="Checked at" mono><span title="ใช้เวลา Sealed at ของ batch">{fmtTime(b.sealedAt)}</span></Field>
        ) : undefined,
      });
      chainRows.push({
        key: "recheck",
        now: (
          <div style={{ marginTop: 8 }}>
            <Button variant="ghost" small onClick={() => setReloadKey((k) => k + 1)}>ตรวจกับเชนอีกครั้ง</Button>
          </div>
        ),
      });
    }
    restSections.push({ key: "chain", title: "Chain check", rows: chainRows });

    const proofRows: Pair[] = [];
    if (detail.proof) {
      const broken = !detail.proof.verified;
      proofRows.push({
        key: "proof",
        now: (
          <Field label="Proof" tint={tintRest && broken ? NOW_TINT : undefined}>
            {detail.proof.verified
              ? <Badge tone="good">ประกอบกลับเป็น root ใน DB ได้</Badge>
              : <Badge tone="danger">ประกอบกลับเป็น root ใน DB ไม่ได้</Badge>}
          </Field>
        ),
        seal: sealKnown ? (
          <Field label="Proof" tint={broken ? SEAL_TINT : undefined}>
            <Badge tone="good" title={`${INFERRED} — root ใน DB สร้างจาก raw hash ตอน seal`}>ประกอบกลับเป็น root ใน DB ได้</Badge>
          </Field>
        ) : undefined,
      });
      proofRows.push(both("path", <Field label="Path length" mono>{detail.proof.path.length}</Field>));
    } else {
      proofRows.push({ key: "none", now: <div style={{ fontSize: 12.5, color: t.muted }}>ยังไม่มี proof — log ยังไม่ถูก seal</div> });
    }
    if (canSeeVerify && b) {
      proofRows.push({
        key: "tree",
        now: (
          <div style={{ marginTop: 10 }}>
            <Button
              variant="subtle"
              small
              icon={GitBranch}
              onClick={() => { onClose(); navigate("verify", { [QUERY_KEYS.proofLog]: logId }); }}
            >
              ดู proof บน tree
            </Button>
          </div>
        ),
      });
    }
    restSections.push({ key: "proof", title: "Merkle proof", rows: proofRows });

    const alertRows: Pair[] = [];
    if (detail.alerts.length === 0) {
      alertRows.push(both("none", <div style={{ fontSize: 12.5, color: t.muted }}>log นี้ไม่ได้ผูกกับ alert ใด</div>));
    } else {
      detail.alerts.forEach((a, i) => {
        const body = (
          <>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
              <AlertRoleBadge role={a.role} />
              <Badge tone={alertTone(a.severity)}>{a.severity}</Badge>
              <Badge tone={a.status === "OPEN" ? "warn" : "good"}>{a.status}</Badge>
              {a.occurrenceCount > 1 && <Badge>×{a.occurrenceCount}</Badge>}
            </div>
            <div style={{ marginTop: 6, fontSize: 13, color: t.text }}>{a.title}</div>
            <div style={{ marginTop: 2, fontSize: 11.5, color: t.muted, ...monoFont }}>
              {a.alertType}{a.ruleId ? ` · rule ${a.ruleId}` : ""}{a.sourceIp ? ` · ${a.sourceIp}` : ""} · last {fmtTime(a.lastSeenAt)}
            </div>
          </>
        );
        const boxStyle = { textAlign: "left" as const, width: "100%", padding: "10px 12px", borderRadius: 10, background: t.surface2, border: `1px solid ${t.border}`, color: t.text, ...sansFont };
        const gap: CSSProperties = { marginTop: i ? 8 : 0, display: "grid" };
        alertRows.push({
          key: a.id,
          now: (
            <div style={gap}>
              {canSeeAlerts ? (
                <button
                  type="button"
                  onClick={() => { onClose(); navigate("alerts", { [QUERY_KEYS.alert]: a.id }); }}
                  title="Open in Alerts"
                  style={{ ...boxStyle, cursor: "pointer" }}
                >
                  {body}
                </button>
              ) : (
                <div style={boxStyle}>{body}</div>
              )}
            </div>
          ),
          // the same alert, not a link — actions stay on the current side
          seal: sealKnown ? <div style={gap}><div style={boxStyle}>{body}</div></div> : undefined,
        });
      });
    }
    restSections.push({ key: "alerts", title: `Alerts (${detail.alerts.length})`, rows: alertRows });
  }

  const loadingNote = loading ? (
    <div style={{ marginTop: 18, color: t.muted, fontSize: 12.5 }}>
      กำลังโหลด batch และตรวจ root กับเชนสด… (อาจใช้เวลาถึง 5 วินาที)
    </div>
  ) : null;

  /** Everything under the Log section, current side only (no card) */
  const restNow = (
    <>
      {loadingNote}
      {restSections.map((s) => (
        <Section key={s.key} title={s.title}>
          {s.rows.map((r) => <Fragment key={r.key}>{r.now}</Fragment>)}
        </Section>
      ))}
    </>
  );

  // the current side's header, one piece per row (the wide layout pairs each with the snapshot side)
  const headTitle = (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div style={{ fontSize: 10.5, color: t.muted, letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 600 }}>Log detail</div>
          {compareOpen && <Badge tone={anyChanged ? "danger" : "neutral"}>ตอนนี้ (DB)</Badge>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4, fontSize: 13, ...monoFont }}>
          <span style={{ overflowWrap: "anywhere" }}>{logId}</span>
          <CopyButton value={logId} />
        </div>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        title={compareOpen ? "Close" : "Close (Esc)"}
        style={{ background: t.surface2, border: `1px solid ${t.border}`, borderRadius: 8, padding: 6, cursor: "pointer", color: t.text, display: "flex" }}
      >
        <X size={16} />
      </button>
    </div>
  );
  const headError = error ? (
    <div style={{ marginTop: 16, color: t.danger, fontSize: 13, display: "flex", alignItems: "center", gap: 10 }}>
      {error}
      <Button variant="ghost" small onClick={() => setReloadKey((k) => k + 1)}>Retry</Button>
    </div>
  ) : null;
  const headBanner = tampered ? (
    // red first: whatever the chain check says below, this batch was judged tampered
    <div
      role="alert"
      style={{
        marginTop: 16, padding: "10px 12px", borderRadius: 10, display: "flex", gap: 10, alignItems: "center",
        background: "rgba(244,63,94,0.14)", border: `1px solid ${t.danger}`, color: t.danger, fontSize: 13, fontWeight: 600,
      }}
    >
      <ShieldAlert size={18} style={{ flexShrink: 0 }} />
      Batch ของ log นี้ถูกตัดสินว่า TAMPERED — ข้อมูลถูกแก้หลัง seal
    </div>
  ) : null;
  const headCompare = canCompare ? (
    <div style={{ marginTop: 12 }}>
      <Button variant="subtle" small icon={Columns2} onClick={toggleCompare} ariaLabel={compareOpen ? "ปิดการเทียบ" : "เทียบกับตอน seal"}>
        {compareOpen ? "ปิดการเทียบ" : "เทียบกับตอน seal"}
      </Button>
    </div>
  ) : null;
  const headTabs = compareOpen && tabbed ? (
    <div role="tablist" style={{ marginTop: 12, display: "flex", gap: 4, padding: 3, borderRadius: 9, background: t.surface2, border: `1px solid ${t.border}` }}>
      {(["seal", "now"] as const).map((k) => (
        <button
          key={k}
          type="button"
          role="tab"
          aria-selected={tab === k}
          onClick={() => setTab(k)}
          style={{
            flex: 1, padding: "6px 8px", borderRadius: 7, border: "none", cursor: "pointer", fontSize: 12.5, fontWeight: 600,
            background: tab === k ? t.surface : "transparent", color: tab === k ? t.text : t.muted,
          }}
        >
          {k === "seal" ? "ตอน seal" : "ตอนนี้"}
        </button>
      ))}
    </div>
  ) : null;
  const rightHeader = <>{headTitle}{headError}{headBanner}{headCompare}{headTabs}</>;

  // ── wide layout: each item on an explicit grid row, snapshot side in column 1 ──
  const sealTitle = (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div style={{ fontSize: 10.5, color: t.muted, letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 600 }}>Log detail</div>
          <Badge tone="good">ตอน SEAL (ของเดิม)</Badge>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4, fontSize: 13, ...monoFont }}>
          <span style={{ overflowWrap: "anywhere" }}>{logId}</span>
          <CopyButton value={logId} />
        </div>
      </div>
      <CloseButton onClose={() => setCompareOpen(false)} />
    </div>
  );
  const sealCell = (row: number, extra?: CSSProperties): CSSProperties => ({ gridColumn: 1, gridRow: row, ...cell(extra) });
  const nowCell = (row: number, extra?: CSSProperties): CSSProperties => ({ gridColumn: 2, gridRow: row, ...cell(extra) });
  const pairs: ReactNode[] = [];
  let pairRow = 1;
  // both cells always exist, so a row keeps its height on the side that has nothing
  const pair = (key: string, seal: ReactNode, now: ReactNode, extra?: CSSProperties) => {
    pairs.push(
      <div key={`${key}:seal`} style={sealCell(pairRow, extra)}>{seal}</div>,
      <div key={`${key}:now`} style={nowCell(pairRow, extra)}>{now}</div>,
    );
    pairRow++;
  };
  if (card) {
    const stretch: CSSProperties = { display: "grid" };
    const heading: CSSProperties = { paddingTop: 18, paddingBottom: 6 };
    pair("title", sealTitle, headTitle, { paddingTop: 20 });
    if (headError) pair("error", null, headError);
    // a note about this log takes the place of the green banner
    pair(
      "banner",
      hasSnapshotNotes(diffLoad, compare) ? <div><SnapshotNotes load={diffLoad} compare={compare} /></div> : rows ? <SealBanner /> : null,
      headBanner,
      stretch,
    );
    if (headCompare) {
      pair(
        "compare",
        <div style={{ marginTop: 12, minHeight: 28, display: "flex", alignItems: "center", fontSize: 12, color: t.muted }}>จาก snapshot ที่เก็บตอน seal</div>,
        headCompare,
      );
    }
    pair("log", rows && <SectionLabel>Log</SectionLabel>, <SectionLabel>Log</SectionLabel>, heading);
    for (const f of COMPARE_FIELDS) pair(`f:${f.key}`, sealField(f), nowField(f), stretch);
    if (loadingNote) pair("loading", null, loadingNote);
    for (const sec of restSections) {
      pair(sec.key, sealKnown && <SectionLabel>{sec.title}</SectionLabel>, <SectionLabel>{sec.title}</SectionLabel>, heading);
      for (const r of sec.rows) pair(`${sec.key}:${r.key}`, r.seal, r.now, stretch);
    }
    pair("end", null, null, { height: 40 });
  }

  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(2,6,23,0.55)", display: "flex", justifyContent: "flex-end" }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={compareOpen ? "Log detail — compare with seal-time snapshot" : "Log detail"}
        tabIndex={-1}
        style={{
          width: split ? (wide ? "min(1120px, 100vw)" : "100vw") : narrow ? "100vw" : "min(560px, 100vw)",
          height: "100%",
          // wide: two solid panels, the current one casting a soft shadow on the snapshot one ·
          // half-screen split: the snapshot half a shade darker, 1px line between
          background: card
            ? `linear-gradient(90deg, transparent calc(50% - 14px), rgba(0,0,0,0.22) 50%, transparent 50%), ${t.surface}`
            : split
              ? `linear-gradient(90deg, ${t.surface2} 0 calc(50% - 1px), ${t.border} calc(50% - 1px) 50%, ${t.surface} 50% 100%)`
              : t.surface,
          borderLeft: narrow ? "none" : `1px solid ${t.border}`,
          boxShadow: "-12px 0 32px rgba(0,0,0,0.35)",
          overflowY: "auto",
          padding: split ? 0 : narrow ? "16px 16px 40px" : "20px 22px 40px",
          color: t.text,
          outline: "none",
          ...sansFont,
        }}
      >
        {card ? (
          // one grid and one scroll box — every header row, heading and field is one grid row on both sides
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }}>{pairs}</div>
        ) : split ? (
          // one grid, one scroll box: each field is one row, so both sides share its height
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }}>
            <div style={cell({ paddingTop: 20 })}>{sealHeader}</div>
            <div style={cell({ paddingTop: 20 })}>{rightHeader}</div>
            <div style={cell({ paddingTop: 18, paddingBottom: 6 })}>{rows && <SectionLabel>Log</SectionLabel>}</div>
            <div style={cell({ paddingTop: 18, paddingBottom: 6 })}><SectionLabel>Log</SectionLabel></div>
            {COMPARE_FIELDS.map((f) => (
              <Fragment key={f.key}>
                <div style={rowCell}>{sealField(f)}</div>
                <div style={rowCell}>{nowField(f)}</div>
              </Fragment>
            ))}
            <div style={{ ...cell({ paddingBottom: 40 }), gridColumn: 2 }}>{restNow}</div>
          </div>
        ) : (
          <>
            {rightHeader}
            {showSeal ? (
              <>
                <div style={{ marginTop: 16 }}>{sealHeader}</div>
                {rows && <Section title="Log">{COMPARE_FIELDS.map(sealField)}</Section>}
              </>
            ) : (
              <>
                <Section title="Log">{COMPARE_FIELDS.map(nowField)}</Section>
                {restNow}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
