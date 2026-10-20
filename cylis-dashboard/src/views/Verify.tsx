import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, CircleCheck, CircleX, GitBranch, Search, ShieldCheck } from "lucide-react";
import { useTheme, monoFont, sansFont } from "@/theme";
import { Card, SectionLabel, Button, Badge, Th, Td } from "@/components/ui";
import BatchStatusBadge from "@/components/BatchStatusBadge";
import { RootCard, type RootState } from "@/components/BatchDiffDrawer";
import { PolygonscanLink } from "@/components/LogTable";
import MerkleTreeView from "@/components/merkle/MerkleTreeView";
import ProofSteps from "@/components/merkle/ProofSteps";
import CostCard from "@/components/merkle/CostCard";
import BatchPicker, { logsLabel } from "@/components/merkle/BatchPicker";
import { api } from "@/lib/api";
import { getBatches, getBatchTree, getLogDetail, getLogProof, getLogs, sealNow } from "@/lib/endpoints";
import { canDo } from "@/lib/roles";
import { unanchoredRootView } from "@/lib/chainState";
import { fmtTime, isZeroRoot, shortId } from "@/lib/format";
import { mapLog, type LogRow } from "@/lib/logRows";
import { checkProofAgainstPath, proofPath, sameHash } from "@/lib/merkle";
import { QUERY_KEYS, useReplaceQuery } from "@/lib/nav";
import { useElementWidth } from "@/lib/useElementWidth";
import type { BatchListItem, BatchTree, LogProofResult } from "@/types/api";

/**
 * GET /logs/:id/proof ต้องการ UUID เต็ม (log_batch_mapping.log_id เป็น type uuid)
 * ตาราง Logs โชว์แค่ 8 ตัวแรก เลยกันไว้ตั้งแต่ฝั่งนี้ จะได้บอกสาเหตุตรงๆ
 * แทนที่จะปล่อยไปให้ backend ตอบ 400 แล้วขึ้นข้อความกว้างๆ ว่า verify ไม่ผ่าน
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NEEDS_FULL_ID =
  "Log ID must be the full UUID — the Logs table shows only the first 8 characters. Click an ID there to copy the whole one.";

/** เวลาไทย (Asia/Bangkok) — ใช้กับกล่อง "ยังรอ seal" ให้ตรงเวลาไทยไม่ว่าผู้ชมอยู่โซนไหน */
function fmtBkk(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString("sv-SE", { timeZone: "Asia/Bangkok" });
}

/**
 * ผลจำแนก batch ของ Isolation Forest (ตรวจจับระดับที่ 3)
 *   true  = ผิดปกติ (แดง)  ·  false = ปกติ (เขียว)
 *   null/undefined = ยังไม่ได้จำแนก (detection ล่ม / ยังไม่ train) → "—"
 */
function anomalyTone(v: boolean | null | undefined) {
  if (v === true) return "danger";
  if (v === false) return "good";
  return null;
}


function treeError(e: any): string {
  switch (e?.response?.status) {
    case 400: return "Batch ID ต้องเป็น UUID";
    case 403: return "บัญชีนี้ไม่มีสิทธิ์ดู tree ของ batch";
    case 404: return "ไม่พบ batch นี้";
    default: return "โหลด tree ไม่สำเร็จ";
  }
}

/** dbRoot / computedRoot / chainRoot against the reference (chain when anchored, else DB) */
function treeRoots(tree: BatchTree) {
  const anchored = tree.chainRoot !== null && !isZeroRoot(tree.chainRoot);
  const reference = anchored ? tree.chainRoot! : tree.dbRoot;
  const cmp = (v: string | null): RootState => (sameHash(v, reference) ? { kind: "match" } : { kind: "mismatch" });
  const unanchored = unanchoredRootView(tree.status);
  return {
    anchored,
    referenceName: anchored ? "root บนเชน" : "root ใน DB",
    chainValue: anchored ? tree.chainRoot : null,
    chain: (tree.chainRoot === null
      ? { kind: "gray", text: "ติดต่อเชนไม่ได้" }
      : isZeroRoot(tree.chainRoot)
        ? { kind: "gray", text: unanchored.label, tone: unanchored.tone }
        : cmp(tree.chainRoot)) as RootState,
    db: cmp(tree.dbRoot),
    snapshot: (tree.snapshotRoot === null ? { kind: "gray", text: "ไม่มี snapshot" } : cmp(tree.snapshotRoot)) as RootState,
    storedHash: (tree.storedHashRoot ? cmp(tree.storedHashRoot) : { kind: "gray", text: "ไม่มี log ผูกกับ batch นี้" }) as RootState,
    content: (tree.contentRoot ? cmp(tree.contentRoot) : { kind: "gray", text: "ไม่มี log ผูกกับ batch นี้" }) as RootState,
  };
}

export default function Verify() {
  const t = useTheme();
  const searchParams = useSearchParams();
  const replaceQuery = useReplaceQuery();
  const [logId, setLogId] = useState("");
  const [result, setResult] = useState<LogProofResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // log มีอยู่จริงแต่ยังไม่ถูก seal เข้า batch (แยกจาก "ไม่พบ log") — โชว์กล่องเหลือง + ปุ่ม seal (admin)
  const [pending, setPending] = useState<{ id: string; createdAt: string } | null>(null);
  const [confirmSeal, setConfirmSeal] = useState(false);
  const [sealing, setSealing] = useState(false);
  const [sealErr, setSealErr] = useState("");
  const canSealNow = canDo("sealNow");

  // ?proofLog=<id> — sent by "ดู proof บน tree" in the log drawer
  const proofLog = searchParams.get(QUERY_KEYS.proofLog);

  const [overview, setOverview] = useState<any>(null);
  const [batches, setBatches] = useState<BatchListItem[] | null>(null);
  const [recentLogs, setRecentLogs] = useState<LogRow[]>([]);
  // แท็บ "seal แล้ว" ดึงแยก (offset=pending) ไม่ใช้ split จาก recentLogs — กัน pending ≥ 100 แล้วแท็บว่าง
  const [sealedRecent, setSealedRecent] = useState<LogRow[]>([]);
  const [recentTab, setRecentTab] = useState<"sealed" | "pending">("sealed");
  const [chainError, setChainError] = useState("");

  // batch whose tree is on screen (v_batch keeps it across F5)
  const [selectedBatch, setSelectedBatch] = useState<string | null>(() => {
    const id = searchParams.get("v_batch");
    return id && UUID_RE.test(id) ? id : null;
  });
  // the last loaded tree stays on screen (dimmed) while the next one loads,
  // so picking another batch does not collapse the page and jump the scroll
  const [treeData, setTreeData] = useState<BatchTree | null>(null);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeErr, setTreeErr] = useState("");
  const [step, setStep] = useState(0);
  const [focus, setFocus] = useState<{ layer: number; index: number } | null>(null);

  // measured on a box that always exists (the root cards mount only once a tree is loaded)
  const treeBoxRef = useRef<HTMLDivElement>(null);
  const treeBoxWidth = useElementWidth(treeBoxRef);
  // Recent batches + Verify a recent log — side by side or stacked, from the row's own width
  const bottomRef = useRef<HTMLDivElement>(null);
  const bottomWidth = useElementWidth(bottomRef);

  // สรุปสถานะ chain โหลดแยกจากฟอร์ม — ถ้าส่วนนี้ล่ม ฟอร์ม verify ต้องยังใช้ได้อยู่
  // แต่ละส่วนแสดงผลของตัวเอง (Promise.allSettled) · /batches กับ /logs ผ่าน lib/endpoints (สวิตช์ mock)
  useEffect(() => {
    let cancelled = false;

    Promise.allSettled([
      api.get("/stats/overview"),
      getBatches({ limit: 10 }),
      // ดึงมากพอจะแยกเป็น 2 แท็บ (seal แล้ว / รอ seal) ฝั่ง client · จำนวน "รอ seal (N)" ใช้ totalLogs−sealedLogs จาก overview
      getLogs({ limit: 100 }),
    ]).then(([overviewRes, batchesRes, logsRes]) => {
      if (cancelled) return;
      if (overviewRes.status === "fulfilled") setOverview(overviewRes.value.data);
      setBatches(batchesRes.status === "fulfilled" ? batchesRes.value.items : []);
      if (logsRes.status === "fulfilled") setRecentLogs(logsRes.value.items.map(mapLog));

      const failed = [overviewRes, batchesRes, logsRes].find((r) => r.status === "rejected");
      if (failed) {
        const e = (failed as PromiseRejectedResult).reason;
        console.error("verify overview fetch failed", e);
        setChainError(
          e?.response?.status === 403
            ? "Not authorised — this account needs the analyst, operator or admin role."
            : "Could not load the chain status.",
        );
      }
    });

    return () => { cancelled = true; };
  }, []);

  // แท็บ "seal แล้ว": log ถูก seal จากเก่า→ใหม่ ดังนั้นใน /logs (ใหม่→เก่า) log ที่ seal แล้วเริ่มถัดจาก
  // pending ที่ค้างอยู่ → เริ่มอ่านที่ offset = pendingCount แล้วไล่หน้า (×10) จน CONFIRMED ครบ 6
  // ไม่ split จาก recentLogs (limit 100) เพราะถ้า pending ≥ 100 หน้าต้น ๆ จะไม่มี CONFIRMED เลย
  useEffect(() => {
    if (!overview) return;
    let cancelled = false;
    const pend = Math.max(0, (overview.totalLogs ?? 0) - (overview.sealedLogs ?? 0));
    (async () => {
      const out: LogRow[] = [];
      const PAGE = 10;
      const MAX_PAGES = 6; // กันไล่ยาวเกินไปถ้าไม่มี CONFIRMED จริง
      for (let p = 0; p < MAX_PAGES && out.length < 6; p++) {
        let lastPage = false;
        try {
          const page = await getLogs({ limit: PAGE, offset: pend + p * PAGE });
          if (cancelled) return;
          const items = page.items ?? [];
          for (const it of items) {
            const r = mapLog(it);
            if (r.batchStatus === "CONFIRMED") {
              out.push(r);
              if (out.length >= 6) break;
            }
          }
          lastPage = items.length < PAGE; // หมดหน้าแล้ว
        } catch {
          break;
        }
        if (lastPage) break;
      }
      if (!cancelled) setSealedRecent(out);
    })();
    return () => { cancelled = true; };
  }, [overview]);

  // tree of the selected batch — loads on its own, the proof form keeps working meanwhile
  useEffect(() => {
    replaceQuery({ v_batch: selectedBatch });
    if (!selectedBatch) { setTreeData(null); return; }
    let cancelled = false;
    setTreeLoading(true);
    setTreeErr("");
    getBatchTree(selectedBatch)
      .then((data) => { if (!cancelled) setTreeData(data); })
      .catch((e) => {
        if (cancelled) return;
        if (e?.response?.status !== 404) console.error("batch tree fetch failed", e);
        setTreeData(null);
        setTreeErr(treeError(e));
      })
      .finally(() => { if (!cancelled) setTreeLoading(false); });
    return () => { cancelled = true; };
  }, [selectedBatch, replaceQuery]);

  /**
   * proof คืน 404/null = "ไม่พบ log" หรือ "มี log แต่ยังไม่ seal" (proof แยกไม่ออก)
   * เรียก /logs/:id/detail มาแยก: 404 = ไม่มี log จริง · 200 + batch=null = ยังรอ seal
   */
  const classifyUnsealed = useCallback(async (id: string) => {
    try {
      const d = await getLogDetail(id);
      if (!d.batch) {
        setPending({ id, createdAt: d.log.createdAt });
        setError("");
      } else {
        // มี batch แต่ proof ไม่คืน — ไม่ควรเกิด, ตอบกว้าง ๆ ไว้
        setError("Log not found or not yet sealed into a batch");
      }
    } catch (e: any) {
      setError(e?.response?.status === 404 ? "Log not found" : "Verification failed");
    }
  }, []);

  const runVerify = useCallback(async (rawId: string) => {
    const id = rawId.trim();
    // เดิมกดปุ่มตอนช่องว่างแล้วเงียบสนิท ไม่มีทั้งผลและ error — แยกไม่ออกว่าแอปค้าง
    if (!id) {
      setResult(null); setPending(null);
      setError("Paste a log ID first, or pick one from the list below.");
      return;
    }
    if (!UUID_RE.test(id)) {
      setResult(null); setPending(null);
      setError(NEEDS_FULL_ID);
      return;
    }

    setLoading(true); setError(""); setResult(null);
    setPending(null); setConfirmSeal(false); setSealErr("");
    try {
      const r = await getLogProof(id);
      if (!r) { await classifyUnsealed(id); return; }
      setResult(r);
      setSelectedBatch(r.batch.id); // show this log's batch tree
      setStep(0);
      setFocus(null);
    } catch (e: any) {
      const status = e.response?.status;
      if (status === 404) { await classifyUnsealed(id); return; }
      setError(
        status === 400 ? NEEDS_FULL_ID
        : status === 403 ? "Not authorised — this account needs the analyst, operator or admin role."
        : "Verification failed",
      );
    } finally {
      setLoading(false);
    }
  }, [classifyUnsealed]);

  /** admin: seal ทันที (confirm แบบเดียวกับหน้า Batch audit) แล้ว verify log นั้นซ้ำอัตโนมัติ */
  const doSeal = useCallback(async () => {
    if (!pending) return;
    setSealing(true); setSealErr("");
    try {
      await sealNow();
      setConfirmSeal(false);
      await runVerify(pending.id); // seal เสร็จ → log เข้า batch แล้ว ลอง verify ใหม่
    } catch (e: any) {
      setSealErr(
        e?.response?.status === 403 ? "ต้องเป็น admin ถึงจะ Seal ได้" : "Seal ไม่สำเร็จ",
      );
    } finally {
      setSealing(false);
    }
  }, [pending, runVerify]);

  // มาจากปุ่ม "ดู proof บน tree" ใน log drawer — เติม ID แล้วตรวจ proof + เปิด tree ของ batch นั้น
  useEffect(() => {
    if (!proofLog) return;
    setLogId(proofLog);
    void runVerify(proofLog);
  }, [proofLog, runVerify]);

  /**
   * Every way of checking a log (button, Enter, recent list, leaf click) goes
   * through ?proofLog= so F5 brings back the last one; the effect above runs it.
   */
  function verifyFromList(rawId: string) {
    const id = rawId.trim();
    setLogId(id);
    if (!UUID_RE.test(id) || id === proofLog) void runVerify(id); // bad id: just show the error
    else replaceQuery({ [QUERY_KEYS.proofLog]: id });
  }

  /** another batch: a proof from the previous one no longer applies */
  function selectBatch(id: string | null) {
    if (result && result.batch.id !== id) {
      setResult(null);
      setError("");
      setStep(0);
      setFocus(null);
      replaceQuery({ [QUERY_KEYS.proofLog]: null });
    }
    setSelectedBatch(id);
  }

  // the proof belongs to this tree only when it is the same batch
  const proofForTree = result && treeData && result.batch.id === treeData.batchId ? result : null;
  const path = useMemo(
    () => (proofForTree && treeData ? proofPath(treeData, proofForTree.leafIndex) : null),
    [proofForTree, treeData],
  );
  // never highlight a path the backend proof does not back up
  const pathCheck = path && proofForTree ? checkProofAgainstPath(path, proofForTree.proof) : null;
  const pathOk = !!path && path.length > 0 && pathCheck?.ok === true;

  const verified = result?.verify ?? false;
  const placeholder = (text: string) => (
    <div style={{ color: t.muted, padding: 16, textAlign: "center", fontSize: 13 }}>{text}</div>
  );

  // confirmed = anchored on-chain only; SEALED batches are intact but not anchored yet (no blockchain
  // configured). Same split as the Dashboard's "Sealed Batches" tile.
  const confirmed = overview?.batches.confirmed ?? 0;
  const sealedBatches = confirmed + (overview?.batches.byStatus?.SEALED ?? 0);
  const tiles = overview && [
    { label: "Chain integrity", value: `${overview.integrityRate}%`, tone: overview.batches.tampered > 0 ? "danger" : "good" },
    { label: "Sealed", value: sealedBatches.toLocaleString(), tone: "good" },
    { label: "Tampered", value: overview.batches.tampered?.toLocaleString() ?? "0", tone: overview.batches.tampered > 0 ? "danger" : "muted" },
    { label: "Anchored on chain", value: confirmed.toLocaleString(), tone: "blue" },
  ];

  const pickerSelected =
    treeData && treeData.batchId === selectedBatch
      ? { id: treeData.batchId, status: treeData.status, logCount: treeData.logCount }
      : (batches ?? []).find((b) => b.id === selectedBatch) ?? null;

  const roots = treeData ? treeRoots(treeData) : null;
  // 3 across, or 1 column when narrow — never 2 + 1
  // "Verify a recent log" 2 แท็บ · N (รอ seal) ใช้ totalLogs−sealedLogs จาก /stats/overview — แม่นทั้งระบบ
  // แท็บ "รอ seal" split จาก recentLogs ได้ (log ใหม่สุด = ยังไม่ seal) · แท็บ "seal แล้ว" ดึงแยก (effect ด้านล่าง)
  const pendingRecent = useMemo(
    () => recentLogs.filter((l) => l.batchStatus === null).slice(0, 6),
    [recentLogs],
  );
  const pendingCount: number | null = overview
    ? Math.max(0, (overview.totalLogs ?? 0) - (overview.sealedLogs ?? 0))
    : null;

  const rootCols = treeBoxWidth >= 950 ? 5 : treeBoxWidth >= 460 ? 3 : 1;
  // stacked below ~1150px of window (sidebar 220 + main padding 56): only then the table may scroll
  const bottomStacked = bottomWidth < 860;
  const recentLogCol = bottomWidth >= 1100 ? 360 : 320;
  // batches table width (card padding 2×20; side by side also minus gap 16) — stacked never below its 640 min width
  const batchTableWidth = bottomStacked
    ? Math.max(bottomWidth - 40, 640)
    : bottomWidth - 16 - recentLogCol - 40;
  // tight → "Sealed at" on 2 lines
  const compactBatchTable = batchTableWidth < 640;
  // room for the longest status label on one line ("Pending (รอส่งขึ้นเชน)") — otherwise it wraps to 2 lines
  const statusColWidth = batchTableWidth >= 720 ? 176 : 120;
  const clip = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as const;
  const cellPad = { padding: "10px 6px" };
  // header padding left/right = cellPad so each header lines up with its column
  const thPad = { paddingLeft: 6, paddingRight: 6 };
  // Logs is numeric → right; letter-spacing trails the last letter, so trim it off the right padding
  const thPadRight = { textAlign: "right" as const, paddingLeft: 6, paddingRight: "calc(6px - 0.08em)" };

  return (
    // minmax(0,1fr): wide content scrolls inside its own frame, never the page
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 16, minWidth: 0 }}>
      {/* สรุปสถานะ chain — หน้านี้จะได้ไม่ว่างเปล่าตั้งแต่เปิด */}
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <SectionLabel dot={t.good}>Chain status</SectionLabel>
          <ShieldCheck size={15} color={t.muted} />
        </div>
        {chainError ? (
          <div style={{ color: t.danger, fontSize: 13, padding: "6px 0" }}>{chainError}</div>
        ) : !tiles ? (
          placeholder("Loading chain status…")
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(150px,100%),1fr))", gap: 14, marginTop: 6 }}>
            {tiles.map((k) => (
              <div key={k.label}>
                <div style={{ fontSize: 11, color: t.muted, ...sansFont, fontWeight: 500 }}>{k.label}</div>
                <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em", marginTop: 2, color: (t as any)[k.tone] ?? t.text, ...monoFont }}>
                  {k.value}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <SectionLabel>Merkle proof verification</SectionLabel>
        <p style={{ color: t.muted, fontSize: 13, marginTop: 4 }}>
          Enter a log ID to check its Merkle proof against the batch root <strong>stored in the DB</strong>.
          Whether that root matches the chain is shown separately under <span style={monoFont}>chainRoot</span> below.
        </p>

        <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
          <div style={{ position: "relative", flex: "1 1 260px", minWidth: 0 }}>
            <Search size={15} color={t.muted} style={{ position: "absolute", left: 12, top: 11 }} />
            <input
              value={logId}
              onChange={(e) => setLogId(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && verifyFromList(logId)}
              placeholder="Log ID เต็ม (เช่น e0cfd1d3-ee4d-4844-8c98-656fdf03f02b)"
              style={{
                width: "100%", background: t.surface2, border: `1px solid ${t.border}`,
                borderRadius: 10, padding: "10px 12px 10px 36px", color: t.text,
                fontSize: 13, outline: "none", ...monoFont,
              }}
            />
          </div>
          <Button variant="primary" onClick={() => verifyFromList(logId)} small disabled={loading}>
            {loading ? "Verifying…" : "Verify"}
          </Button>
        </div>

        {/* fixed room for the result, so checking a log never pushes the tree down */}
        <div style={{ minHeight: 300 }}>
        {error && (
          <div style={{ marginTop: 14, color: t.danger, fontSize: 13 }}>{error}</div>
        )}
        {/* มี log แต่ยังไม่ seal — กล่องเหลือง (ไม่ใช่แดง) + ปุ่ม Seal ทันที เฉพาะ admin */}
        {pending && (
          <div style={{
            marginTop: 14, padding: "12px 14px", borderRadius: 10, display: "flex", gap: 10, alignItems: "flex-start",
            color: t.warn, background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.4)", fontSize: 13,
          }}>
            <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>ยังรอ seal</div>
              <div style={{ color: t.muted, marginTop: 2 }}>
                log นี้เข้ามาเมื่อ {fmtBkk(pending.createdAt)} · ยังรอ seal — ระบบ seal เมื่อครบ 100 log หรือรอครบ 60 นาที
              </div>
              {canSealNow && (
                <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  {!confirmSeal ? (
                    <Button variant="subtle" small disabled={sealing} onClick={() => { setSealErr(""); setConfirmSeal(true); }}>
                      Seal ทันที
                    </Button>
                  ) : (
                    <>
                      <Button variant="primary" small disabled={sealing} onClick={doSeal}>
                        {sealing ? "กำลัง Seal…" : "ยืนยัน Seal"}
                      </Button>
                      <Button variant="ghost" small disabled={sealing} onClick={() => setConfirmSeal(false)}>ยกเลิก</Button>
                    </>
                  )}
                  {sealErr && <span style={{ color: t.danger, fontSize: 12 }}>{sealErr}</span>}
                </div>
              )}
            </div>
          </div>
        )}
        {!result && !error && !pending && (
          <div style={{ marginTop: 14, padding: 16, borderRadius: 10, border: `1px dashed ${t.border}`, color: t.muted, fontSize: 13, textAlign: "center" }}>
            {loading ? "กำลังตรวจ proof…" : "ยังไม่ได้ตรวจ log — ใส่ log id ด้านบน หรือคลิก leaf ใน tree"}
          </div>
        )}

        {result && (
          <>
            <div style={{ marginTop: 18, display: "grid", gridTemplateColumns: "minmax(0,1fr)", gap: 10 }}>
              <div style={{ background: t.surface2, border: `1px solid ${t.border}`, borderRadius: 10, padding: 14 }}>
                <div style={{ fontSize: 11, color: t.muted, marginBottom: 6 }}>LOG RAW HASH · leaf #{result.leafIndex}</div>
                <div style={{ fontSize: 12, wordBreak: "break-all", ...monoFont }}>{result.rawHash}</div>
              </div>
              <div style={{ background: t.surface2, border: `1px solid ${t.border}`, borderRadius: 10, padding: 14 }}>
                <div style={{ fontSize: 11, color: t.muted, marginBottom: 6 }}>BATCH MERKLE ROOT (stored in the DB)</div>
                <div style={{ fontSize: 12, wordBreak: "break-all", ...monoFont }}>{result.batch.merkleRoot}</div>
                <div style={{ fontSize: 11, color: t.muted, marginTop: 6, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <BatchStatusBadge status={result.batch.status} />
                  <span style={monoFont}>tx {result.batch.txHash ? `${result.batch.txHash.slice(0, 20)}…` : "—"}</span>
                </div>
                {result.batch?.ifStatus === "calibrating" ? (
                  <div
                    style={{ fontSize: 11, marginTop: 6, color: t.muted }}
                    title="โมเดลฝึกจากข้อมูลจำลอง กำลังเก็บ traffic จริงเพื่อ retrain"
                  >
                    ML: calibrating
                  </div>
                ) : result.batch?.ifAnomaly != null && (
                  <div style={{ fontSize: 11, marginTop: 6, color: result.batch.ifAnomaly ? t.danger : t.muted }}>
                    Isolation Forest: {result.batch.ifAnomaly ? "batch flagged anomalous" : "batch normal"}
                    {result.batch.ifReason ? ` — ${result.batch.ifReason}` : ""}
                  </div>
                )}
              </div>
            </div>

            <div style={{
              marginTop: 18, display: "flex", alignItems: "center", gap: 10,
              padding: "12px 16px", borderRadius: 10,
              background: verified ? "rgba(52,211,153,0.08)" : "rgba(244,63,94,0.08)",
              border: `1px solid ${verified ? "rgba(52,211,153,0.35)" : "rgba(244,63,94,0.35)"}`,
            }}>
              {verified ? <CircleCheck size={18} color={t.good} /> : <CircleX size={18} color={t.danger} />}
              <div>
                <div style={{ fontWeight: 600, fontSize: 14, color: verified ? t.good : t.danger }}>
                  {verified ? "Verified — proof valid" : "Invalid — proof mismatch"}
                </div>
                <div style={{ fontSize: 12, color: t.muted }}>
                  {verified
                    ? `The proof (${result.proof.length} hash${result.proof.length === 1 ? "" : "es"}) rebuilds the batch root stored in the DB. Compare with the chain under chainRoot.`
                    : "The proof does not rebuild the batch root stored in the DB — the log or its batch may have been altered after seal."}
                </div>
              </div>
            </div>
          </>
        )}
        </div>
      </Card>

      {/* tree of one batch — picked here, from Recent batches, or by verifying a log */}
      <Card>
        <div ref={treeBoxRef}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <SectionLabel dot={t.blue}>Merkle tree</SectionLabel>
          <BatchPicker value={selectedBatch} selected={pickerSelected} onChange={selectBatch} />
        </div>

        {treeLoading && (
          <div style={{ color: t.muted, fontSize: 12.5, margin: "6px 0" }}>
            กำลังโหลด tree และอ่าน root จากเชน… (อาจใช้เวลาถึง 5 วินาที)
          </div>
        )}
        {!selectedBatch ? (
          placeholder("เลือก batch หรือใส่ log id ด้านบนเพื่อดู tree")
        ) : treeErr ? (
          <div style={{ color: t.danger, padding: 16, fontSize: 13 }}>{treeErr}</div>
        ) : !treeData ? (
          // first load: hold roughly a tree's height so the page below does not jump
          <div style={{ minHeight: 640 }} />
        ) : roots ? (
          <div style={{ opacity: treeLoading ? 0.45 : 1, transition: "opacity .15s", pointerEvents: treeLoading ? "none" : undefined }}>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", margin: "6px 0 10px", fontSize: 12, color: t.muted }}>
              <BatchStatusBadge status={treeData.status} />
              <span style={monoFont}>batch {shortId(treeData.batchId)} · {logsLabel(treeData.logCount)}</span>
              <span style={monoFont}>checked {fmtTime(treeData.checkedAt)}</span>
            </div>

            <div style={{ fontSize: 12.5, color: t.muted, marginBottom: 8 }}>
              เทียบกับ: <strong style={{ color: t.text }}>{roots.referenceName}</strong>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: `repeat(${rootCols}, minmax(0, 1fr))`, gap: 10 }}>
              <RootCard title="chainRoot" origin="บนเชน — อ่านจาก contract ตอนนี้" value={roots.chainValue} state={roots.chain} isReference={roots.anchored} />
              <RootCard title="snapshotRoot" origin="สร้างจาก snapshot ที่เก็บตอน seal" value={treeData.snapshotRoot} state={roots.snapshot} isReference={false} />
              <RootCard title="dbRoot" origin="root ที่เก็บใน DB ตอน seal" value={treeData.dbRoot} state={roots.db} isReference={!roots.anchored} />
              <RootCard title="storedHashRoot" origin="จาก raw_hash ที่เก็บไว้ — แดงเมื่อคอลัมน์ raw_hash ถูกแก้ (tree ด้านล่าง)" value={treeData.storedHashRoot || null} state={roots.storedHash} isReference={false} />
              <RootCard title="contentRoot" origin="คำนวณจากเนื้อหา log ปัจจุบัน (hash ใหม่) — แดงเมื่อเนื้อ log ถูกแก้" value={treeData.contentRoot || null} state={roots.content} isReference={false} />
            </div>
            <div style={{ marginTop: 8, fontSize: 12.5, color: t.muted }}>
              ทุกช่องต้องเขียว ข้อมูลถึงจะสมบูรณ์ — <span style={{ color: t.text }}>storedHashRoot</span> แดง = raw_hash ถูกแก้ · <span style={{ color: t.text }}>contentRoot</span> แดง = เนื้อ log ถูกแก้
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginTop: 8, fontSize: 12, color: t.muted }}>
              {roots.anchored && roots.db.kind === "match" && treeData.polygonscanUrl && (
                <>
                  <Badge tone="good">dbRoot ตรงกับบนเชน</Badge>
                  <PolygonscanLink url={treeData.polygonscanUrl} />
                </>
              )}
              {treeData.chainError && <span style={monoFont}>{treeData.chainError}</span>}
            </div>

            {treeData.layers.length === 0 ? (
              placeholder("batch นี้ยังไม่มี log ผูกอยู่ — ไม่มี tree ให้วาด")
            ) : (
              <div style={{ marginTop: 14 }}>
                {proofForTree && pathCheck && !pathCheck.ok && (
                  <div role="alert" style={{ marginBottom: 10, padding: "8px 12px", borderRadius: 9, display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, color: t.warn, background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.4)" }}>
                    <AlertTriangle size={15} />
                    proof จาก server ไม่ตรงกับ tree ที่วาด ({pathCheck.reason}) — จึงไม่ไฮไลต์เส้นทาง
                  </div>
                )}
                {proofForTree && pathOk && (
                  <div style={{ marginBottom: 8, fontSize: 13 }}>
                    <GitBranch size={14} style={{ verticalAlign: -2, marginRight: 6 }} color={t.blue2} />
                    {treeData.logCount === 1 ? (
                      <>batch มี 1 ล็อก — root คือ leaf hash ของ log นี้เอง ไม่ต้องใช้ hash อื่น</>
                    ) : (
                      <>
                        ใช้ <strong>{proofForTree.proof.length} hash</strong> จาก {treeData.logCount.toLocaleString()} log
                        <span style={{ color: t.muted }}> — ไม่ต้องใช้ log ทั้ง batch เพื่อพิสูจน์ log เดียว</span>
                      </>
                    )}
                  </div>
                )}
                <MerkleTreeView
                  tree={treeData}
                  path={pathOk ? path : null}
                  focus={pathOk ? focus : null}
                  onLeafClick={(i) => {
                    const leaf = treeData.leaves[i];
                    if (leaf) verifyFromList(leaf.logId);
                  }}
                />
                {!proofForTree && (
                  <div style={{ fontSize: 12, color: t.muted, marginTop: 6 }}>คลิก leaf หรือใส่ log id ด้านบนเพื่อดูเส้นทาง proof</div>
                )}
              </div>
            )}
          </div>
        ) : null}
        </div>
      </Card>

      {treeData && proofForTree && path && pathOk && (
        <ProofSteps
          tree={treeData}
          proof={proofForTree}
          path={path}
          step={step}
          onStep={(k, f) => { setStep(k); setFocus(f); }}
        />
      )}

      {treeData && <CostCard tree={treeData} />}

      <div
        ref={bottomRef}
        style={{
          display: "grid",
          gridTemplateColumns: bottomStacked ? "minmax(0, 1fr)" : `minmax(0, 1fr) minmax(0, ${recentLogCol}px)`,
          gap: 16,
          minWidth: 0,
        }}
      >
        {/* batch ล่าสุด — เห็นได้เลยว่ามีอะไรถูกผูกขึ้น chain ไปแล้วบ้าง · กดดู tree ได้ */}
        <Card style={{ minWidth: 0 }}>
          <SectionLabel dot={t.blue}>Recent batches</SectionLabel>
          {batches === null ? placeholder("Loading batches…")
            : batches.length === 0 ? placeholder("No batches sealed yet")
            : (
              // side by side: fixed columns that always fit (Merkle root / Tx shrink with ellipsis, full value in title)
              // stacked: min width + scroll inside this frame only
              <div style={{ overflowX: bottomStacked ? "auto" : "hidden", marginTop: 6 }}>
                <table style={{ width: "100%", minWidth: bottomStacked ? 640 : undefined, tableLayout: "fixed", borderCollapse: "collapse", fontSize: 13 }}>
                  <colgroup>
                    <col style={{ width: statusColWidth }} />
                    <col />
                    <col style={{ width: 56 }} />
                    <col style={{ width: 80 }} />
                    <col style={{ width: compactBatchTable ? 92 : 156 }} />
                    <col />
                    <col style={{ width: 66 }} />
                  </colgroup>
                  <thead>
                    <tr>{["Status", "Merkle root", "Logs", "Anomaly", "Sealed at", "Tx", ""].map((h, i) => <Th key={h + i} style={h === "Logs" ? thPadRight : thPad}>{h}</Th>)}</tr>
                  </thead>
                  <tbody>
                    {batches.map((b) => {
                      const tone = anomalyTone(b.ifAnomaly);
                      return (
                      <tr key={b.id}>
                        {/* overflow hidden + wrap anywhere: a long label wraps inside its cell, never over Merkle root */}
                        <Td style={{ ...cellPad, overflow: "hidden", overflowWrap: "anywhere" }}><BatchStatusBadge status={b.status} /></Td>
                        <Td style={{ ...cellPad, ...clip, fontSize: 12, color: t.blue2, ...monoFont }} title={b.merkleRoot}>
                          {b.merkleRoot}
                        </Td>
                        <Td style={{ ...cellPad, ...clip, fontSize: 12, textAlign: "right", ...monoFont }}>{b.logCount}</Td>
                        {/* Isolation Forest (ระดับที่ 3) — calibrating = ซ่อนผลจำแนก (ฝึกจากข้อมูลจำลอง) */}
                        <Td style={cellPad} title={b.ifStatus === "calibrating"
                          ? "โมเดลฝึกจากข้อมูลจำลอง กำลังเก็บ traffic จริงเพื่อ retrain"
                          : (b.ifReason ?? (tone ? "" : "ยังไม่ได้จำแนก"))}>
                          {b.ifStatus === "calibrating" ? (
                            <Badge tone="neutral">ML: calibrating</Badge>
                          ) : tone ? (
                            <Badge tone={tone}>{b.ifAnomaly ? "Anomaly" : "Normal"}</Badge>
                          ) : (
                            <span style={{ color: t.muted }}>—</span>
                          )}
                        </Td>
                        <Td style={{ ...cellPad, fontSize: 12, color: t.muted, whiteSpace: compactBatchTable ? "normal" : "nowrap", ...monoFont }}>{fmtTime(b.sealedAt)}</Td>
                        <Td style={{ ...cellPad, ...clip, fontSize: 12, color: t.muted, ...monoFont }} title={b.txHash ?? ""}>
                          {b.txHash ?? "—"}
                        </Td>
                        <Td style={{ ...cellPad, textAlign: "right" }}>
                          <Button variant="subtle" small onClick={() => selectBatch(b.id)} title="ดู Merkle tree ของ batch นี้" ariaLabel={`Show tree of batch ${b.id}`}>
                            Tree
                          </Button>
                        </Td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
        </Card>

        {/* ยิง verify ได้จากตรงนี้เลย ไม่ต้องไปคัดลอก id จากหน้า Logs */}
        <Card style={{ minWidth: 0 }}>
          <SectionLabel dot={t.cyan}>Verify a recent log</SectionLabel>
          {/* 2 แท็บ: seal แล้ว (CONFIRMED, verify ได้) · รอ seal (N จาก overview) */}
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            {([
              ["sealed", "seal แล้ว"],
              ["pending", pendingCount !== null ? `รอ seal (${pendingCount.toLocaleString()})` : "รอ seal"],
            ] as const).map(([key, label]) => {
              const active = recentTab === key;
              return (
                <button
                  key={key}
                  onClick={() => setRecentTab(key)}
                  style={{
                    cursor: "pointer", fontSize: 12.5, padding: "5px 12px", borderRadius: 8,
                    border: `1px solid ${active ? t.cyan : t.border}`,
                    background: active ? "rgba(34,211,238,0.12)" : "transparent",
                    color: active ? t.cyan : t.muted, fontWeight: active ? 600 : 400,
                    ...sansFont,
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
            {recentTab === "sealed"
              ? (sealedRecent.length === 0
                  ? placeholder("ยังไม่มี log ที่ seal แล้วในช่วงล่าสุด")
                  : sealedRecent.map((l) => (
                      <div key={l.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 12.5, ...monoFont, color: t.blue2, display: "flex", alignItems: "center", gap: 6 }}>
                            {String(l.id).slice(0, 8)}
                            <Badge tone="good">On-chain ✓</Badge>
                          </div>
                          <div style={{ fontSize: 11, color: t.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {l.source} · {l.ts}
                          </div>
                        </div>
                        <Button variant="subtle" small onClick={() => verifyFromList(l.id)}>Verify</Button>
                      </div>
                    )))
              : (pendingRecent.length === 0
                  ? placeholder("ไม่มี log รอ seal")
                  : pendingRecent.map((l) => (
                      <div key={l.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 12.5, ...monoFont, color: t.blue2, display: "flex", alignItems: "center", gap: 6 }}>
                            {String(l.id).slice(0, 8)}
                            <Badge tone="warn">รอ seal</Badge>
                          </div>
                          <div style={{ fontSize: 11, color: t.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {l.source} · {l.ts}
                          </div>
                        </div>
                        <Button variant="subtle" small disabled title="log นี้ยังไม่ถูก seal เข้า batch — ตรวจ proof ไม่ได้จนกว่าจะ seal">
                          Verify
                        </Button>
                      </div>
                    )))}
          </div>
        </Card>
      </div>
    </div>
  );
}
