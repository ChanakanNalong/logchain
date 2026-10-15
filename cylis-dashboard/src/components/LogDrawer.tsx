"use client";

/**
 * Side drawer with everything about one log (GET /logs/:id/detail): the log,
 * its batch + tx, the live root check against the chain, the proof and the
 * alerts it belongs to. Shared by Logs and Alerts.
 * Closes on Esc and on a click outside the panel; full screen on narrow screens.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy, GitBranch, X } from "lucide-react";
import { useTheme, monoFont, sansFont } from "@/theme";
import { Badge, Button, SectionLabel } from "@/components/ui";
import BatchStatusBadge from "@/components/BatchStatusBadge";
import AlertRoleBadge from "@/components/AlertRoleBadge";
import { copyText, PolygonscanLink } from "@/components/LogTable";
import { getLogDetail } from "@/lib/endpoints";
import { fmtTime, isZeroRoot, shortHash } from "@/lib/format";
import { alertTone, toTone } from "@/lib/logRows";
import { QUERY_KEYS, useNavigate } from "@/lib/nav";
import { canAccessPage } from "@/lib/roles";
import type { ChainCheck, LogDetail } from "@/types/api";

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

export function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY);
    const update = () => setNarrow(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return narrow;
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
function chainCheckView(c: ChainCheck | null): { tone: string; label: string; note: string } {
  if (c === null) return { tone: "neutral", label: "รอ seal รอบถัดไป", note: "log นี้ยังไม่อยู่ใน batch จึงยังไม่มี root ให้เทียบ" };
  if ("error" in c) return { tone: "neutral", label: "ติดต่อเชนไม่ได้ตอนนี้", note: "อ่าน root จากเชนไม่ได้ (RPC ล่มหรือ timeout) — ไม่ได้แปลว่าข้อมูลถูกแก้ ลองใหม่ภายหลัง" };
  if (c.match) return { tone: "good", label: "ตรงกับบนเชน", note: "root ใน DB ตรงกับ root ที่ตรึงไว้บนเชน" };
  if (isZeroRoot(c.chainRoot)) return { tone: "orange", label: "ยังไม่ถูกตรึงบนเชน", note: "บนเชนยังไม่มี root ของ batch นี้ (seal แล้วแต่ยังไม่ได้ anchor หรือ anchor ไม่สำเร็จ)" };
  return { tone: "danger", label: "ไม่ตรงกับบนเชน", note: "root ใน DB ต่างจาก root บนเชน — ข้อมูลใน batch นี้อาจถูกแก้หลัง anchor" };
}

function CopyButton({ value }: { value: string }) {
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

function Field({ label, children, mono, copy }: { label: string; children: ReactNode; mono?: boolean; copy?: string | null }) {
  const t = useTheme();
  return (
    <div style={{ display: "grid", gridTemplateColumns: "120px minmax(0,1fr)", gap: 10, padding: "6px 0", borderTop: `1px solid ${t.border}`, fontSize: 12.5 }}>
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
}: {
  /** null = closed */
  logId: string | null;
  seed?: LogDrawerSeed;
  onClose: () => void;
}) {
  const t = useTheme();
  const narrow = useIsNarrow();
  const navigate = useNavigate();
  const panelRef = useRef<HTMLDivElement>(null);
  const [detail, setDetail] = useState<LogDetail | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!logId) return;
    let cancelled = false;
    setDetail(null);
    setError("");
    setLoading(true);
    getLogDetail(logId)
      .then((d) => { if (!cancelled) setDetail(d); })
      .catch((e) => {
        if (cancelled) return;
        console.error("log detail fetch failed", e);
        setError(errorText(e));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [logId, reloadKey]);

  // Esc closes; focus moves into the panel so the key works right after opening
  useEffect(() => {
    if (!logId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    panelRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [logId, onClose]);

  if (!logId) return null;

  const log = detail?.log;
  const shown = { ...seed, ...log };
  const canSeeAlerts = canAccessPage("alerts");
  const canSeeVerify = canAccessPage("verify");
  const check = detail ? chainCheckView(detail.chainCheck) : null;
  const chainMatch = detail?.chainCheck && !("error" in detail.chainCheck) ? detail.chainCheck : null;

  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(2,6,23,0.55)", display: "flex", justifyContent: "flex-end" }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Log detail"
        tabIndex={-1}
        style={{
          width: narrow ? "100vw" : "min(560px, 100vw)",
          height: "100%",
          background: t.surface,
          borderLeft: narrow ? "none" : `1px solid ${t.border}`,
          boxShadow: "-12px 0 32px rgba(0,0,0,0.35)",
          overflowY: "auto",
          padding: narrow ? "16px 16px 40px" : "20px 22px 40px",
          color: t.text,
          outline: "none",
          ...sansFont,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 10.5, color: t.muted, letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 600 }}>Log detail</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4, fontSize: 13, ...monoFont }}>
              <span style={{ overflowWrap: "anywhere" }}>{logId}</span>
              <CopyButton value={logId} />
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            title="Close (Esc)"
            style={{ background: t.surface2, border: `1px solid ${t.border}`, borderRadius: 8, padding: 6, cursor: "pointer", color: t.text, display: "flex" }}
          >
            <X size={16} />
          </button>
        </div>

        {error && (
          <div style={{ marginTop: 16, color: t.danger, fontSize: 13, display: "flex", alignItems: "center", gap: 10 }}>
            {error}
            <Button variant="ghost" small onClick={() => setReloadKey((k) => k + 1)}>Retry</Button>
          </div>
        )}

        <Section title="Log">
          <Field label="Time" mono>{fmtTime(shown.createdAt)}</Field>
          <Field label="Source">{shown.source ?? "—"}</Field>
          <Field label="Source IP" mono copy={shown.sourceIp}>{shown.sourceIp ?? "—"}</Field>
          <Field label="Event type" mono>{shown.eventType ?? "—"}</Field>
          <Field label="Severity">
            {shown.severity ? <Badge tone={toTone(shown.severity)}>{shown.severity}</Badge> : "—"}
          </Field>
          <Field label="Message" mono>{shown.message ?? "—"}</Field>
          {log && (
            <>
              <Field label="Classification">{log.classification}</Field>
              <Field label="CDE scope">{log.cdeScope ? "Yes" : "No"}</Field>
              <Field label="Retention">{log.retentionDays} days</Field>
              <Field label="Raw hash" mono copy={log.rawHash}>{log.rawHash}</Field>
            </>
          )}
        </Section>

        {loading && (
          <div style={{ marginTop: 18, color: t.muted, fontSize: 12.5 }}>
            กำลังโหลด batch และตรวจ root กับเชนสด… (อาจใช้เวลาถึง 5 วินาที)
          </div>
        )}

        {detail && (
          <>
            <Section title="Batch · on-chain">
              {detail.batch ? (
                <>
                  <Field label="Status"><BatchStatusBadge status={detail.batch.status} /></Field>
                  <Field label="Batch ID" mono copy={detail.batch.id}>{detail.batch.id}</Field>
                  <Field label="Merkle root" mono copy={detail.batch.merkleRoot}>{shortHash(detail.batch.merkleRoot, 10, 8)}</Field>
                  <Field label="Sealed at" mono>{fmtTime(detail.batch.sealedAt)}</Field>
                  <Field label="Confirmed at" mono>{fmtTime(detail.batch.confirmedAt)}</Field>
                  <Field label="Tx hash" mono copy={detail.batch.txHash}>
                    {detail.batch.txHash ? shortHash(detail.batch.txHash, 10, 8) : "— (ยังไม่มี tx)"}
                  </Field>
                  <Field label="Block" mono>{detail.batch.blockNumber ?? "—"}</Field>
                  {detail.batch.polygonscanUrl && (
                    <Field label="Explorer"><PolygonscanLink url={detail.batch.polygonscanUrl} /></Field>
                  )}
                </>
              ) : (
                <Field label="Status"><BatchStatusBadge status={null} /></Field>
              )}
            </Section>

            <Section title="Chain check">
              {check && (
                <div style={{ display: "grid", gap: 6 }}>
                  <div><Badge tone={check.tone}>{check.label}</Badge></div>
                  <div style={{ fontSize: 12.5, color: t.muted }}>{check.note}</div>
                </div>
              )}
              {chainMatch && (
                <div style={{ marginTop: 6 }}>
                  <Field label="Root on chain" mono copy={chainMatch.chainRoot}>{shortHash(chainMatch.chainRoot, 10, 8)}</Field>
                  <Field label="Root in DB" mono copy={chainMatch.dbRoot}>{shortHash(chainMatch.dbRoot, 10, 8)}</Field>
                </div>
              )}
              {detail.chainCheck && "error" in detail.chainCheck && (
                <Field label="Error" mono>{detail.chainCheck.error}</Field>
              )}
              {detail.chainCheck && <Field label="Checked at" mono>{fmtTime(detail.chainCheck.checkedAt)}</Field>}
              {detail.chainCheck && (
                <div style={{ marginTop: 8 }}>
                  <Button variant="ghost" small onClick={() => setReloadKey((k) => k + 1)}>ตรวจกับเชนอีกครั้ง</Button>
                </div>
              )}
            </Section>

            <Section title="Merkle proof">
              {detail.proof ? (
                <>
                  <Field label="Proof">
                    {detail.proof.verified
                      ? <Badge tone="good">ประกอบกลับเป็น root ใน DB ได้</Badge>
                      : <Badge tone="danger">ประกอบกลับเป็น root ใน DB ไม่ได้</Badge>}
                  </Field>
                  <Field label="Path length" mono>{detail.proof.path.length}</Field>
                </>
              ) : (
                <div style={{ fontSize: 12.5, color: t.muted }}>ยังไม่มี proof — log ยังไม่ถูก seal</div>
              )}
              {canSeeVerify && detail.batch && (
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
              )}
            </Section>

            <Section title={`Alerts (${detail.alerts.length})`}>
              {detail.alerts.length === 0 ? (
                <div style={{ fontSize: 12.5, color: t.muted }}>log นี้ไม่ได้ผูกกับ alert ใด</div>
              ) : (
                <div style={{ display: "grid", gap: 8 }}>
                  {detail.alerts.map((a) => {
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
                    return canSeeAlerts ? (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() => { onClose(); navigate("alerts", { [QUERY_KEYS.alert]: a.id }); }}
                        title="Open in Alerts"
                        style={{ ...boxStyle, cursor: "pointer" }}
                      >
                        {body}
                      </button>
                    ) : (
                      <div key={a.id} style={boxStyle}>{body}</div>
                    );
                  })}
                </div>
              )}
            </Section>
          </>
        )}
      </div>
    </div>
  );
}
