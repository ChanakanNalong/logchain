import { Fragment, useEffect, useState } from "react";
import { ChevronRight, CircleCheck, CircleX, Search, ShieldCheck } from "lucide-react";
import { useTheme, monoFont, sansFont } from "@/theme";
import { Card, SectionLabel, Button, Badge, Th, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { mapLog, unwrapLogs } from "@/lib/logRows";

/**
 * GET /logs/:id/proof ต้องการ UUID เต็ม (log_batch_mapping.log_id เป็น type uuid)
 * ตาราง Logs โชว์แค่ 8 ตัวแรก เลยกันไว้ตั้งแต่ฝั่งนี้ จะได้บอกสาเหตุตรงๆ
 * แทนที่จะปล่อยไปให้ backend ตอบ 400 แล้วขึ้นข้อความกว้างๆ ว่า verify ไม่ผ่าน
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NEEDS_FULL_ID =
  "Log ID must be the full UUID — the Logs table shows only the first 8 characters. Click an ID there to copy the whole one.";

/** สถานะ batch -> สีของ Badge */
function statusTone(status: string) {
  switch (status) {
    case "CONFIRMED": return "good";
    case "TAMPERED": return "danger";
    // anchor ไม่ผ่าน (RPC ล่ม / gas ไม่พอ) ไม่ใช่หลักฐานว่าข้อมูลถูกแก้ — เตือน ไม่ใช่แดง
    case "FAILED":
    case "PENDING": return "warn";
    // SEALED = ปิด batch แล้วและผ่านการตรวจแบบ local ทุกนาที แต่ยังไม่ได้ anchor
    // ขึ้น chain (ยังไม่ได้ตั้ง blockchain) — ไม่ใช่ปัญหา แต่ก็ยังไม่ใช่ "good"
    // เท่า CONFIRMED เพราะ root ยังอยู่ใน DB ก้อนเดียวกับ log
    case "SEALED": return "neutral";
    default: return "neutral";
  }
}

const fmtTime = (v: string | null) => (v ? new Date(v).toLocaleString("sv-SE") : "—");

export default function Verify() {
  const t = useTheme();
  const [logId, setLogId] = useState("");
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [overview, setOverview] = useState<any>(null);
  const [batches, setBatches] = useState<any[] | null>(null);
  const [recentLogs, setRecentLogs] = useState<any[]>([]);
  const [chainError, setChainError] = useState("");

  // สรุปสถานะ chain โหลดแยกจากฟอร์ม — ถ้าส่วนนี้ล่ม ฟอร์ม verify ต้องยังใช้ได้อยู่
  useEffect(() => {
    let cancelled = false;

    Promise.all([
      api.get("/stats/overview"),
      api.get("/batches", { params: { limit: 8 } }),
      api.get("/logs", { params: { limit: 6 } }),
    ])
      .then(([overviewRes, batchesRes, logsRes]) => {
        if (cancelled) return;
        setOverview(overviewRes.data);
        setBatches(batchesRes.data ?? []);
        setRecentLogs(unwrapLogs(logsRes.data).slice(0, 6).map(mapLog));
      })
      .catch((e) => {
        if (cancelled) return;
        console.error("verify overview fetch failed", e);
        setBatches([]);
        setChainError(
          e.response?.status === 403
            ? "Not authorised — this account needs the analyst, operator or admin role."
            : "Could not load the chain status.",
        );
      });

    return () => { cancelled = true; };
  }, []);

  async function runVerify(rawId: string) {
    const id = rawId.trim();
    // เดิมกดปุ่มตอนช่องว่างแล้วเงียบสนิท ไม่มีทั้งผลและ error — แยกไม่ออกว่าแอปค้าง
    // หรือไม่ได้ทำอะไร (เจอบ่อยเวลา copy ID ไม่ติดแล้ววางไม่ลง)
    if (!id) {
      setResult(null);
      setError("Paste a log ID first, or pick one from the list below.");
      return;
    }
    if (!UUID_RE.test(id)) {
      setResult(null);
      setError(NEEDS_FULL_ID);
      return;
    }

    setLoading(true); setError(""); setResult(null);
    try {
      const r = await api.get(`/logs/${id}/proof`);
      if (!r.data) { setError("Log not found or not yet sealed into a batch"); }
      else setResult(r.data);
    } catch (e: any) {
      const status = e.response?.status;
      setError(
        status === 400 ? NEEDS_FULL_ID
        : status === 404 ? "Log not found, or not yet sealed into a batch"
        : status === 403 ? "Not authorised — this account needs the analyst, operator or admin role."
        : "Verification failed",
      );
    } finally {
      setLoading(false);
    }
  }

  /** กดจากลิสต์ log — เติมช่องให้เห็นว่าตรวจตัวไหน แล้วยิงด้วย id ตรงๆ ไม่รอ state */
  function verifyFromList(id: string) {
    setLogId(id);
    void runVerify(id);
  }

  const verified = result?.verify ?? false;
  const placeholder = (text: string) => (
    <div style={{ color: t.muted, padding: 16, textAlign: "center", fontSize: 13 }}>{text}</div>
  );

  const tiles = overview && [
    { label: "Chain integrity", value: `${overview.integrityRate}%`, tone: overview.batches.tampered > 0 ? "danger" : "good" },
    { label: "Confirmed", value: overview.batches.confirmed?.toLocaleString() ?? "0", tone: "good" },
    { label: "Tampered", value: overview.batches.tampered?.toLocaleString() ?? "0", tone: overview.batches.tampered > 0 ? "danger" : "muted" },
    { label: "Batches on chain", value: overview.batches.total?.toLocaleString() ?? "0", tone: "blue" },
  ];

  return (
    <div style={{ display: "grid", gap: 16 }}>
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
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 14, marginTop: 6 }}>
            {tiles.map((k) => (
              <div key={k.label}>
                <div style={{ fontSize: 11, color: t.muted, ...sansFont, fontWeight: 500 }}>{k.label}</div>
                <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em", marginTop: 2, color: t[k.tone] ?? t.text, ...monoFont }}>
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
          Enter a log ID to recompute its hash and verify the Merkle proof against the batch root committed on-chain.
        </p>

        <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
          <div style={{ position: "relative", flex: 1 }}>
            <Search size={15} color={t.muted} style={{ position: "absolute", left: 12, top: 11 }} />
            <input
              value={logId}
              onChange={(e) => setLogId(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && runVerify(logId)}
              placeholder="Log ID เต็ม (เช่น e0cfd1d3-ee4d-4844-8c98-656fdf03f02b)"
              style={{
                width: "100%", background: t.surface2, border: `1px solid ${t.border}`,
                borderRadius: 10, padding: "10px 12px 10px 36px", color: t.text,
                fontSize: 13, outline: "none", ...monoFont,
              }}
            />
          </div>
          <Button variant="primary" onClick={() => runVerify(logId)} small>
            {loading ? "Verifying…" : "Verify"}
          </Button>
        </div>

        {error && (
          <div style={{ marginTop: 14, color: t.danger, fontSize: 13 }}>{error}</div>
        )}

        {result && (
          <>
            <div style={{ marginTop: 18, display: "grid", gridTemplateColumns: "1fr", gap: 10 }}>
              <div style={{ background: t.surface2, border: `1px solid ${t.border}`, borderRadius: 10, padding: 14 }}>
                <div style={{ fontSize: 11, color: t.muted, marginBottom: 6 }}>LOG HASH (recomputed)</div>
                <div style={{ fontSize: 12, wordBreak: "break-all", ...monoFont }}>{result.rawHash}</div>
              </div>
              <div style={{ background: t.surface2, border: `1px solid ${t.border}`, borderRadius: 10, padding: 14 }}>
                <div style={{ fontSize: 11, color: t.muted, marginBottom: 6 }}>BATCH MERKLE ROOT</div>
                <div style={{ fontSize: 12, wordBreak: "break-all", ...monoFont }}>{result.batch?.merkleRoot}</div>
                <div style={{ fontSize: 11, color: t.muted, marginTop: 6 }}>
                  tx: {result.batch?.txHash?.slice(0, 20) ?? "—"}… · status: {result.batch?.status}
                </div>
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
                    ? "Recomputed hash matches the Merkle proof path to the committed batch root."
                    : "Recomputed hash does not match the committed root — log may have been altered."}
                </div>
              </div>
            </div>
          </>
        )}
      </Card>

      {result?.proof && (
        <Card>
          <SectionLabel dot={t.cyan}>Proof path ({result.proof.length} steps)</SectionLabel>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, flexWrap: "wrap", fontSize: 12, ...monoFont }}>
            <span style={{ padding: "6px 10px", background: t.surface2, border: `1px solid ${t.border}`, borderRadius: 8 }}>leaf</span>
            <ChevronRight size={14} color={t.muted} />
            {result.proof.map((_: any, i: number) => (
              <Fragment key={i}>
                <span style={{ padding: "6px 10px", background: t.surface2, border: `1px solid ${t.border}`, borderRadius: 8 }}>h{i + 1}</span>
                <ChevronRight size={14} color={t.muted} />
              </Fragment>
            ))}
            <span style={{ padding: "6px 10px", background: t.surface2, border: `1px solid ${t.border}`, borderRadius: 8 }}>root</span>
          </div>
        </Card>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16 }}>
        {/* batch ล่าสุด — เห็นได้เลยว่ามีอะไรถูกผูกขึ้น chain ไปแล้วบ้าง */}
        <Card>
          <SectionLabel dot={t.blue}>Recent batches</SectionLabel>
          {batches === null ? placeholder("Loading batches…")
            : batches.length === 0 ? placeholder("No batches sealed yet")
            : (
              <div style={{ overflowX: "auto", marginTop: 6 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr>{["Status", "Merkle root", "Logs", "Sealed at", "Tx"].map((h) => <Th key={h}>{h}</Th>)}</tr>
                  </thead>
                  <tbody>
                    {batches.map((b) => (
                      <tr key={b.id}>
                        <Td><Badge tone={statusTone(b.status)}>{b.status}</Badge></Td>
                        <Td style={{ color: t.blue2, ...monoFont }} title={b.merkleRoot}>
                          {b.merkleRoot?.slice(0, 12)}…
                        </Td>
                        <Td style={{ ...monoFont }}>{b.logCount}</Td>
                        <Td style={{ color: t.muted, ...monoFont }}>{fmtTime(b.sealedAt)}</Td>
                        <Td style={{ color: t.muted, ...monoFont }} title={b.txHash ?? ""}>
                          {b.txHash ? `${b.txHash.slice(0, 10)}…` : "—"}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </Card>

        {/* ยิง verify ได้จากตรงนี้เลย ไม่ต้องไปคัดลอก id จากหน้า Logs */}
        <Card>
          <SectionLabel dot={t.cyan}>Verify a recent log</SectionLabel>
          <div style={{ marginTop: 8, display: "grid", gap: 8 }}>
            {recentLogs.length === 0
              ? placeholder("No logs yet")
              : recentLogs.map((l) => (
                  <div key={l.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, ...monoFont, color: t.blue2 }}>{String(l.id).slice(0, 8)}</div>
                      <div style={{ fontSize: 11, color: t.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {l.source} · {l.ts}
                      </div>
                    </div>
                    <Button variant="subtle" small onClick={() => verifyFromList(l.id)}>Verify</Button>
                  </div>
                ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
