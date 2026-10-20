"use client";

/**
 * Step-by-step: log → raw_hash → leaf hash → pair layer by layer → root →
 * storeRoot (1 tx for the whole batch). Values come from the backend; the
 * "compute in the browser" button redoes every hash with WebCrypto so the
 * viewer does not have to trust the server's arithmetic.
 */
import { useEffect, useMemo, useState } from "react";
import { CircleCheck, CircleX, ChevronLeft, ChevronRight, Cpu } from "lucide-react";
import { useTheme, monoFont, sansFont } from "@/theme";
import { Badge, Button, Card, SectionLabel } from "@/components/ui";
import { CopyButton } from "@/components/LogDrawer";
import { PolygonscanLink } from "@/components/LogTable";
import { unanchoredRootView } from "@/lib/chainState";
import { fmtInt, isZeroRoot, shortHash } from "@/lib/format";
import { browserHashAvailable, browserLeafHash, browserParentHash, sameHash, type PathStep } from "@/lib/merkle";
import type { BatchTree, LogProofResult } from "@/types/api";

interface Step {
  title: string;
  explain: string;
  value: string | null;
  /** node of the tree this step lands on */
  focus: { layer: number; index: number } | null;
  /** browser check: what to compute and compare */
  check?: { kind: "leaf" } | { kind: "pair"; sibling: string } | { kind: "promote" } | { kind: "root" };
  /** the storeRoot step shows tx details instead of a hash */
  isTx?: boolean;
}

function buildSteps(tree: BatchTree, proof: LogProofResult, path: PathStep[]): Step[] {
  const steps: Step[] = [
    {
      title: "1. log → content hash (คำนวณจากเนื้อหาปัจจุบัน)",
      explain:
        proof.contentHash === proof.rawHash
          ? "hash เนื้อ log ปัจจุบันตรงกับ raw_hash ที่เก็บไว้ (เนื้อหาไม่ถูกแก้)"
          : proof.integrity === "HASH_MODIFIED"
            ? `เนื้อหาปัจจุบัน hash = ${proof.contentHash.slice(0, 12)}… แต่ raw_hash ที่เก็บไว้ = ${proof.rawHash.slice(0, 12)}… → คอลัมน์ raw_hash ถูกแก้`
            : `เนื้อหาปัจจุบัน hash ≠ raw_hash ตอน seal → เนื้อ log ถูกแก้หลัง seal`,
      value: proof.contentHash,
      focus: null,
    },
    {
      title: "2. content hash → leaf hash",
      explain: "leaf = sha256 ของข้อความ hex ของ content hash (utf8) ไม่ใช่ bytes ของมัน",
      value: path[0]?.hash ?? proof.leafHash,
      focus: { layer: 0, index: proof.leafIndex },
      check: { kind: "leaf" },
    },
  ];
  const last = path.length - 1;
  path.slice(0, -1).forEach((s, k) => {
    const up = path[k + 1];
    steps.push(
      s.sibling === null
        ? {
            title: `${steps.length + 1}. ชั้น ${s.layer} → ${s.layer + 1}: node เศษ`,
            explain: "ชั้นนี้มีจำนวนคี่และ node นี้อยู่ท้าย — ส่งขึ้นชั้นบนโดยไม่ hash (ไม่มี hash ใน proof สำหรับชั้นนี้)",
            value: up.hash,
            focus: { layer: up.layer, index: up.index },
            check: { kind: "promote" },
          }
        : {
            title: `${steps.length + 1}. ชั้น ${s.layer} → ${s.layer + 1}: จับคู่กับ sibling #${s.sibling} (${s.siblingSide})`,
            explain: "เรียงคู่ก่อน hash (sortPairs: ค่าที่น้อยกว่าอยู่หน้า) แล้ว sha256 ของ 2 ค่าต่อกัน",
            value: up.hash,
            focus: { layer: up.layer, index: up.index },
            check: { kind: "pair", sibling: s.siblingHash! },
          },
    );
  });
  steps.push({
    title: `${steps.length + 1}. root`,
    explain: "root ที่ไล่ขึ้นมาได้ — proof ถูกเมื่อเท่ากับ root ที่เก็บใน DB (dbRoot) · การเทียบกับเชนดูที่ chainRoot",
    value: path[last]?.hash ?? null,
    focus: path[last] ? { layer: path[last].layer, index: path[last].index } : null,
    check: { kind: "root" },
  });
  steps.push({
    title: `${steps.length + 1}. storeRoot ขึ้นเชน 1 tx`,
    explain: `ทั้ง batch (${tree.logCount.toLocaleString()} log) ส่งแค่ root ขึ้นเชนด้วย storeRoot ครั้งเดียว`,
    value: tree.txHash,
    focus: null,
    isTx: true,
  });
  return steps;
}

type CheckResult = "ok" | "bad" | "pending";

export default function ProofSteps({
  tree,
  proof,
  path,
  step,
  onStep,
}: {
  tree: BatchTree;
  proof: LogProofResult;
  path: PathStep[];
  step: number;
  onStep: (index: number, focus: Step["focus"]) => void;
}) {
  const t = useTheme();
  const steps = useMemo(() => buildSteps(tree, proof, path), [tree, proof, path]);
  const [checks, setChecks] = useState<Record<number, CheckResult>>({});
  const [running, setRunning] = useState(false);
  const canHash = browserHashAvailable();

  useEffect(() => setChecks({}), [steps]);
  const cur = Math.min(step, steps.length - 1);

  async function computeInBrowser() {
    setRunning(true);
    const out: Record<number, CheckResult> = {};
    try {
      let acc = "";
      for (let k = 0; k < steps.length; k++) {
        const c = steps[k].check;
        if (!c) continue;
        if (c.kind === "leaf") acc = await browserLeafHash(proof.contentHash);
        else if (c.kind === "pair") acc = await browserParentHash(acc, c.sibling);
        // promote: acc moves up unchanged
        const expected = c.kind === "root" ? tree.dbRoot : steps[k].value;
        out[k] = sameHash(acc, expected) ? "ok" : "bad";
        setChecks({ ...out });
      }
    } finally {
      setRunning(false);
    }
  }

  const s = steps[cur];
  const chainZero = tree.chainRoot !== null && isZeroRoot(tree.chainRoot);

  return (
    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <SectionLabel dot={t.warn}>ทีละขั้น: log → root → เชน</SectionLabel>
        <div style={{ display: "flex", gap: 6 }}>
          <Button variant="ghost" small icon={ChevronLeft} disabled={cur === 0} onClick={() => onStep(cur - 1, steps[cur - 1].focus)}>ก่อนหน้า</Button>
          <Button variant="ghost" small icon={ChevronRight} disabled={cur === steps.length - 1} onClick={() => onStep(cur + 1, steps[cur + 1].focus)}>ถัดไป</Button>
        </div>
      </div>

      {proof.integrity && proof.integrity !== "INTACT" && (
        <div style={{ marginTop: 10, padding: "8px 12px", borderRadius: 8, border: `1px solid ${t.danger}`, background: "rgba(244,63,94,0.10)", fontSize: 12.5, color: t.text }}>
          {proof.integrity === "CONTENT_MODIFIED"
            ? "⚠ เนื้อ log ถูกแก้หลัง seal — hash เนื้อหาปัจจุบันไม่ตรงกับตอน anchor → proof = false, contentRoot แดง"
            : proof.integrity === "HASH_MODIFIED"
              ? "⚠ คอลัมน์ raw_hash ถูกแก้ (เนื้อหา log เดิม) → storedHashRoot แดง (proof จากเนื้อหายังผ่านเพราะเนื้อหาไม่เปลี่ยน)"
              : "⚠ log นี้ seal ก่อนมี snapshot — แยกไม่ได้ว่าเนื้อหาหรือ raw_hash ถูกแก้ · เทียบ content hash กับ raw_hash ที่เก็บไว้เอง"}
        </div>
      )}

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "10px 0" }}>
        {steps.map((st, k) => (
          <button
            key={k}
            type="button"
            onClick={() => onStep(k, st.focus)}
            aria-current={k === cur}
            title={st.title}
            style={{
              minWidth: 30, height: 28, borderRadius: 7, cursor: "pointer", fontSize: 12, ...monoFont,
              background: k === cur ? t.blue : t.surface2, color: k === cur ? "#fff" : t.text,
              border: `1px solid ${checks[k] === "bad" ? t.danger : checks[k] === "ok" ? t.good : t.border}`,
            }}
          >
            {k + 1}
          </button>
        ))}
      </div>

      <div style={{ padding: 14, borderRadius: 10, background: t.surface2, border: `1px solid ${t.border}`, minHeight: 130 }}>
        <div style={{ fontWeight: 700, fontSize: 14, ...sansFont }}>{s.title}</div>
        <div style={{ fontSize: 12.5, color: t.muted, marginTop: 4 }}>{s.explain}</div>
        {s.isTx ? (
          <div style={{ marginTop: 10, fontSize: 12.5, display: "grid", gap: 4 }}>
            {tree.txHash ? (
              <>
                <div style={{ display: "flex", gap: 6, alignItems: "center", ...monoFont }}>
                  tx {shortHash(tree.txHash, 10, 8)} <CopyButton value={tree.txHash} />
                  {tree.polygonscanUrl && <PolygonscanLink url={tree.polygonscanUrl} />}
                </div>
                <div style={{ color: t.muted, ...monoFont }}>
                  block {tree.blockNumber ?? "—"} · gas {fmtInt(tree.cost?.gasUsed)}
                </div>
              </>
            ) : (
              <div style={{ color: t.muted }}>ยังไม่มี tx</div>
            )}
            {chainZero && <Badge tone={unanchoredRootView(tree.status).tone}>{unanchoredRootView(tree.status).label}</Badge>}
            {tree.chainRoot === null && <Badge tone="neutral">ติดต่อเชนไม่ได้ — tx / block มาจาก DB</Badge>}
          </div>
        ) : (
          s.value && (
            <div style={{ display: "flex", gap: 6, alignItems: "flex-start", marginTop: 10 }}>
              <span style={{ fontSize: 12.5, overflowWrap: "anywhere", ...monoFont }}>{s.value}</span>
              <CopyButton value={s.value} />
            </div>
          )
        )}
        {s.check?.kind === "root" && (
          <div style={{ marginTop: 8, fontSize: 12.5 }}>
            {sameHash(s.value, tree.dbRoot)
              ? <span style={{ color: t.good }}>= dbRoot (root ที่เก็บใน DB)</span>
              : <span style={{ color: t.danger }}>≠ dbRoot (root ที่เก็บใน DB) — log หรือ batch ถูกแก้หลัง seal</span>}
          </div>
        )}
        {checks[cur] && (
          <div style={{ marginTop: 8, display: "flex", gap: 6, alignItems: "center", fontSize: 12.5, color: checks[cur] === "ok" ? t.good : t.danger }}>
            {checks[cur] === "ok" ? <CircleCheck size={15} /> : <CircleX size={15} />}
            {checks[cur] === "ok" ? "เบราว์เซอร์คำนวณได้ค่าเดียวกัน" : "เบราว์เซอร์คำนวณได้ค่าไม่ตรง"}
          </div>
        )}
      </div>

      <div style={{ marginTop: 12, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        {canHash ? (
          <Button variant="subtle" small icon={Cpu} disabled={running} onClick={computeInBrowser}>
            {running ? "กำลังคำนวณ…" : "คำนวณเองในเบราว์เซอร์"}
          </Button>
        ) : (
          <span style={{ fontSize: 12, color: t.muted }}>
            คำนวณเองในเบราว์เซอร์ใช้ไม่ได้: WebCrypto ต้องเปิดหน้าผ่าน https หรือ localhost
          </span>
        )}
        <span style={{ fontSize: 12, color: t.muted }}>
          leafHash = sha256(ข้อความ hex ของ rawHash แบบ utf8) · จับคู่แบบเรียงก่อน hash (sortPairs) · node เศษส่งขึ้นชั้นบนโดยไม่ hash
        </span>
      </div>
    </Card>
  );
}
