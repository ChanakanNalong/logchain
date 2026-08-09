import { Fragment, useState } from "react";
import { Hash, ChevronRight, CircleCheck, CircleX, Search } from "lucide-react";
import { useTheme, monoFont } from "@/theme";
import { Card, SectionLabel, Button } from "@/components/ui";
import { api } from "@/lib/api";

export default function Verify() {
  const t = useTheme();
  const [logId, setLogId] = useState("");
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleVerify() {
    if (!logId.trim()) return;
    setLoading(true); setError(""); setResult(null);
    try {
      const r = await api.get(`/logs/${logId.trim()}/proof`);
      if (!r.data) { setError("Log not found or not yet sealed into a batch"); }
      else setResult(r.data);
    } catch (e: any) {
      setError(e.response?.status === 404 ? "Log not found" : "Verification failed");
    } finally {
      setLoading(false);
    }
  }

  // GET /logs/:id/proof returns { logId, rawHash, batch, proof, verify }
  const verified = result?.verify ?? false;

  return (
    <div style={{ display: "grid", gap: 16 }}>
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
              onKeyDown={(e) => e.key === "Enter" && handleVerify()}
              placeholder="Log ID (เช่น c9ce423f-... หรือ paste เต็ม)"
              style={{
                width: "100%", background: t.surface2, border: `1px solid ${t.border}`,
                borderRadius: 10, padding: "10px 12px 10px 36px", color: t.text,
                fontSize: 13, outline: "none", ...monoFont,
              }}
            />
          </div>
          <Button variant="primary" onClick={handleVerify} small>
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
    </div>
  );
}