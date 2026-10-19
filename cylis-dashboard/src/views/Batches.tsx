import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight, PackageCheck, RefreshCw, ShieldCheck } from "lucide-react";
import { useTheme, monoFont, sansFont, type Theme } from "@/theme";
import { Card, SectionLabel, Button, FilterDropdown, Th, Td, Badge } from "@/components/ui";
import BatchStatusBadge from "@/components/BatchStatusBadge";
import BatchDiffDrawer, { type DiffState } from "@/components/BatchDiffDrawer";
import MultiSelectDropdown from "@/components/MultiSelectDropdown";
import { IdCell, PolygonscanLink } from "@/components/LogTable";
import { getBatchDiff, getBatches, sealNow, verifyNow } from "@/lib/endpoints";
import { fmtGwei, fmtInt, fmtTime, polCost, shortId } from "@/lib/format";
import { canDo } from "@/lib/roles";
import { useReplaceQuery } from "@/lib/nav";
import type { BatchListItem, BatchStatus } from "@/types/api";

const STATUSES: BatchStatus[] = ["PENDING", "SEALED", "UNVERIFIED", "CONFIRMED", "TAMPERED", "FAILED"];
/** GET /batches: limit 1–100, default 10 */
const DEFAULT_LIMIT = 10;
const LIMITS = [10, 20, 50, 100];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Numeric columns: header right-aligned over the digits */
const RIGHT_COLS = new Set(["Logs", "Gas used", "POL / batch", "POL / log"]);
// letter-spacing trails the last letter too — take it off the right padding so the
// header's last letter ends where the cell's last digit does (both at 10px)
const thRight = { textAlign: "right" as const, paddingRight: "calc(10px - 0.08em)" };

/** Last column stuck to the right edge of the scroll box, with a shade so rows don't show through */
function stickyRight(t: Theme) {
  return {
    position: "sticky" as const,
    right: 0,
    zIndex: 1,
    background: t.surface,
    boxShadow: `-8px 0 8px -8px rgba(0,0,0,0.45)`,
    textAlign: "right" as const,
  };
}

function splitList(v: string | null): string[] {
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

// เหตุผลที่ batch ถูกปิด (hybrid: count/age · manual: seal-now · cron: รอบเวลา) · NULL = ไม่แสดง
const SEAL_REASON_META: Record<string, { tone: string; title: string }> = {
  count: { tone: "blue", title: "ปิดเพราะ log ค้างครบ batch size" },
  age: { tone: "warn", title: "ปิดเพราะ log เก่าสุดค้างเกินเวลาที่ตั้งไว้" },
  manual: { tone: "cyan", title: "ปิดด้วยปุ่ม Seal ทันที (admin)" },
  cron: { tone: "neutral", title: "ปิดตามรอบเวลา (SEAL_CRON)" },
};

function listError(e: any): string {
  const status = e?.response?.status;
  if (status === 403) return "Not authorised — this page needs the admin or auditor role.";
  if (status === 400) {
    const msg = e.response?.data?.message;
    return `The server rejected the filter: ${Array.isArray(msg) ? msg.join(", ") : msg ?? "bad request"}`;
  }
  return "Could not load batches.";
}

function diffError(e: any): string {
  switch (e?.response?.status) {
    case 400: return "Batch ID ต้องเป็น UUID";
    case 403: return "ตรวจ batch ได้เฉพาะ admin หรือ auditor";
    case 404: return "ไม่พบ batch นี้";
    default: return "ตรวจกับเชนไม่สำเร็จ ลองใหม่อีกครั้ง";
  }
}

export default function Batches() {
  const t = useTheme();
  const searchParams = useSearchParams();
  const replaceQuery = useReplaceQuery();

  // own query keys use the b_ prefix (lib/nav.tsx PAGE_QUERY_KEYS.batches)
  // No b_status in the URL → hide FAILED by default (the cloud carries ~1,161
  // never-anchored FAILED batches that read as NOT_ANCHORED, not tampering).
  // An auditor adds FAILED back from the dropdown to inspect them.
  const [status, setStatus] = useState(() => {
    const raw = searchParams.get("b_status");
    return raw !== null ? splitList(raw) : STATUSES.filter((s) => s !== "FAILED");
  });
  const [limit, setLimit] = useState(() => {
    const n = Number(searchParams.get("b_limit"));
    return Number.isInteger(n) && n >= 1 && n <= 100 ? n : DEFAULT_LIMIT;
  });
  const [offset, setOffset] = useState(() => Math.max(0, Math.floor(Number(searchParams.get("b_offset")) || 0)));
  const [diffBatch, setDiffBatch] = useState<string | null>(() => {
    const id = searchParams.get("b_diff");
    return id && UUID_RE.test(id) ? id : null;
  });

  const [rows, setRows] = useState<BatchListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [diff, setDiff] = useState<DiffState | null>(null);
  const diffSeq = useRef(0);

  const statusKey = status.join(",");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getBatches({ limit, offset, status: splitList(statusKey) })
      .then((page) => {
        if (cancelled) return;
        if (page.items.length === 0 && page.total > 0 && offset > 0) {
          setOffset(Math.floor((page.total - 1) / limit) * limit);
          return;
        }
        setRows(page.items);
        setTotal(page.total);
        setError("");
      })
      .catch((e) => {
        if (cancelled) return;
        console.error("batches fetch failed", e);
        setRows([]);
        setTotal(0);
        setError(listError(e));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [limit, offset, statusKey, reloadKey]);

  useEffect(() => {
    replaceQuery({
      b_status: statusKey || null,
      b_limit: limit !== DEFAULT_LIMIT ? String(limit) : null,
      b_offset: offset > 0 ? String(offset) : null,
      b_diff: diffBatch,
    });
  }, [statusKey, limit, offset, diffBatch, replaceQuery]);

  // Diff loads separately from the list; a later request wins over an older one
  const runDiff = useCallback((id: string) => {
    const seq = ++diffSeq.current;
    setDiffBatch(id);
    setDiff({ status: "loading" });
    getBatchDiff(id)
      .then((data) => { if (seq === diffSeq.current) setDiff({ status: "ok", data }); })
      .catch((e) => {
        if (seq !== diffSeq.current) return;
        if (e?.response?.status !== 404) console.error("batch diff fetch failed", e);
        setDiff({ status: "error", message: diffError(e) });
      });
  }, []);

  // reopened from ?b_diff= (F5 / shared link)
  useEffect(() => {
    if (diffBatch && !diff) runDiff(diffBatch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const closeDiff = useCallback(() => {
    diffSeq.current++;
    setDiffBatch(null);
    setDiff(null);
  }, []);

  // ── admin: สั่ง seal-now / verify-now (endpoint มีอยู่แล้ว, @Roles('admin')) ──
  const canSealNow = canDo("sealNow");
  const canVerifyNow = canDo("verifyNow");
  const showAdminTools = canSealNow || canVerifyNow;
  const [confirmSeal, setConfirmSeal] = useState(false);
  const [actionRunning, setActionRunning] = useState<null | "seal" | "verify">(null);
  const [actionMsg, setActionMsg] = useState("");
  const [actionErr, setActionErr] = useState("");

  const actionErrText = (e: any, verb: string) => {
    const s = e?.response?.status;
    if (s === 403) return `ต้องเป็น admin ถึงจะ${verb}ได้`;
    if (s === 503) return "ยอดเงินในวอลเล็ตต่ำเกินไป ยังไม่ส่ง root ขึ้นเชน (เติม POL แล้วลองใหม่)";
    return `${verb}ไม่สำเร็จ ลองใหม่อีกครั้ง`;
  };

  const doSeal = async () => {
    setActionRunning("seal"); setActionErr(""); setActionMsg("");
    try {
      const r = await sealNow();
      setActionMsg(
        r.message ??
          `Seal แล้ว: batch ${r.id ? shortId(r.id) : "?"} · ${r.status ?? "?"} · ${(r.logCount ?? 0).toLocaleString()} logs`,
      );
      setReloadKey((k) => k + 1);
    } catch (e) {
      setActionErr(actionErrText(e, "Seal"));
    } finally {
      setActionRunning(null);
      setConfirmSeal(false);
    }
  };

  const doVerify = async () => {
    setActionRunning("verify"); setActionErr(""); setActionMsg("");
    try {
      const r = await verifyNow();
      setActionMsg(`ตรวจ integrity แล้ว · ${r.verifiedAt ? fmtTime(r.verifiedAt) : "เรียบร้อย"}`);
      setReloadKey((k) => k + 1);
    } catch (e) {
      setActionErr(actionErrText(e, "Verify"));
    } finally {
      setActionRunning(null);
    }
  };

  const diffLoading = diff?.status === "loading";
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const currentPage = Math.floor(offset / limit) + 1;
  const anyGas = rows.some((r) => r.gasUsed != null);

  return (
    // minmax(0,1fr): the table scrolls inside its own box, never the page
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 16, minWidth: 0 }}>
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <SectionLabel>Sealed batches ({total.toLocaleString()})</SectionLabel>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <MultiSelectDropdown label="statuses" options={STATUSES} value={status} onChange={(v) => { setStatus(v); setOffset(0); }} />
            <FilterDropdown
              value={`${limit} / page`}
              onChange={(v: string) => { setLimit(parseInt(v, 10)); setOffset(0); }}
              options={LIMITS.map((n) => `${n} / page`)}
            />
          </div>
        </div>

        {showAdminTools && (
          <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
            {canSealNow && !confirmSeal && (
              <Button
                variant="subtle"
                small
                icon={PackageCheck}
                disabled={!!actionRunning}
                onClick={() => { setActionErr(""); setActionMsg(""); setConfirmSeal(true); }}
                title="ปิด batch ของ log ที่ค้างทันที แล้ว anchor root ขึ้นบล็อกเชน (เสียค่า gas จริง)"
              >
                {actionRunning === "seal" ? "กำลัง Seal…" : "Seal ทันที"}
              </Button>
            )}
            {canSealNow && confirmSeal && (
              <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12.5, color: t.text, ...sansFont }}>
                จะบันทึก root ลง blockchain ใช้ค่า gas ประมาณ 0.0023 POL ยืนยันไหม
                <Button variant="primary" small disabled={!!actionRunning} onClick={doSeal}>
                  {actionRunning === "seal" ? "กำลัง Seal…" : "ยืนยัน Seal"}
                </Button>
                <Button variant="ghost" small disabled={!!actionRunning} onClick={() => setConfirmSeal(false)}>ยกเลิก</Button>
              </span>
            )}
            {canVerifyNow && (
              <Button
                variant="subtle"
                small
                icon={RefreshCw}
                disabled={!!actionRunning}
                onClick={doVerify}
                title="re-anchor batch ที่ค้าง + ตรวจ integrity ของทุก batch ทันที (ไม่เสียค่า gas)"
              >
                {actionRunning === "verify" ? "กำลัง Verify…" : "Verify ทันที"}
              </Button>
            )}
            {actionMsg && <span style={{ fontSize: 12, color: t.good, ...sansFont }}>{actionMsg}</span>}
            {actionErr && <span style={{ fontSize: 12, color: t.danger, ...sansFont }}>{actionErr}</span>}
          </div>
        )}

        {error ? (
          <div style={{ color: t.danger, padding: 20, textAlign: "center", fontSize: 13 }}>
            {error}{" "}
            <Button variant="ghost" small onClick={() => setReloadKey((k) => k + 1)}>Retry</Button>
          </div>
        ) : loading && rows.length === 0 ? (
          <div style={{ color: t.muted, padding: 20, textAlign: "center" }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ color: t.muted, padding: 20, textAlign: "center" }}>
            {status.length ? "No batches with these statuses" : "No batches sealed yet"}
          </div>
        ) : (
          <>
            <div style={{ marginTop: 12, overflowX: "auto", opacity: loading ? 0.55 : 1, transition: "opacity .15s" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr>
                    {["Batch", "Status", "Sealed at", "Logs", "Gas used", "POL / batch", "POL / log", "Tx"].map((h) => (
                      // คอลัมน์ตัวเลขชิดขวา (RIGHT_COLS) ให้ตรงกับค่าใน Td
                      <Th key={h} style={RIGHT_COLS.has(h) ? thRight : undefined}>{h}</Th>
                    ))}
                    <th style={stickyRight(t)} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((b) => {
                    const cost = polCost(b.gasUsed, b.effectiveGasPriceGwei, b.logCount);
                    const busy = diffLoading && diffBatch === b.id;
                    return (
                      <tr key={b.id}>
                        <Td style={{ ...monoFont }}><IdCell id={b.id} /></Td>
                        <Td>
                          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                            <BatchStatusBadge status={b.status} />
                            {b.sealReason && SEAL_REASON_META[b.sealReason] && (
                              <Badge tone={SEAL_REASON_META[b.sealReason].tone} title={SEAL_REASON_META[b.sealReason].title}>
                                {b.sealReason}
                              </Badge>
                            )}
                          </div>
                        </Td>
                        <Td style={{ color: t.muted, whiteSpace: "nowrap", ...monoFont }}>{fmtTime(b.sealedAt)}</Td>
                        <Td style={{ textAlign: "right", ...monoFont }}>{b.logCount.toLocaleString()}</Td>
                        <Td style={{ textAlign: "right", ...monoFont }}>{fmtInt(b.gasUsed)}</Td>
                        <Td
                          style={{ textAlign: "right", whiteSpace: "nowrap", ...monoFont }}
                          title={cost ? `${fmtInt(b.gasUsed)} gas × ${fmtGwei(b.effectiveGasPriceGwei)} gwei` : undefined}
                        >
                          {cost ? cost.batch : "—"}
                        </Td>
                        <Td
                          style={{ textAlign: "right", whiteSpace: "nowrap", ...monoFont }}
                          title={cost ? `POL / batch ÷ ${b.logCount} logs` : undefined}
                        >
                          {cost?.perLog ?? "—"}
                        </Td>
                        <Td>{b.polygonscanUrl ? <PolygonscanLink url={b.polygonscanUrl} label="Polygonscan" /> : <span style={{ color: t.muted }}>—</span>}</Td>
                        {/* pinned right: the action stays in view while the table scrolls */}
                        <td style={{ ...stickyRight(t), borderTop: `1px solid ${t.border}`, padding: "10px" }}>
                          <Button
                            variant="subtle"
                            small
                            icon={ShieldCheck}
                            disabled={busy}
                            onClick={() => runDiff(b.id)}
                            title="Check against blockchain — เทียบ root บนเชนกับ snapshot และ log ปัจจุบัน"
                            ariaLabel={`Check batch ${b.id} against blockchain`}
                          >
                            {busy ? "Checking…" : "Check"}
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14, gap: 10, flexWrap: "wrap" }}>
              <div style={{ fontSize: 11.5, color: t.muted, ...monoFont }}>
                {offset + 1}–{Math.min(offset + rows.length, total)} of {total.toLocaleString()} · Page {currentPage} of {totalPages}
                {!anyGas && " · gas: — = ยังไม่มีข้อมูล gas ของ batch เหล่านี้"}
                <div style={{ marginTop: 4, ...sansFont }}>
                  Status = สถานะการส่ง root ขึ้นเชน ผลตรวจว่าล็อกถูกแก้หรือไม่ดูจากปุ่ม Check
                </div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <Button icon={ChevronLeft} variant="ghost" small disabled={offset <= 0 || loading} onClick={() => setOffset((o) => Math.max(0, o - limit))}>
                  Prev
                </Button>
                <Button icon={ChevronRight} variant="ghost" small disabled={offset + limit >= total || loading} onClick={() => setOffset((o) => o + limit)}>
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>

      <BatchDiffDrawer
        batchId={diffBatch}
        state={diff}
        onRecheck={() => { if (diffBatch && !diffLoading) runDiff(diffBatch); }}
        onClose={closeDiff}
      />
    </div>
  );
}
