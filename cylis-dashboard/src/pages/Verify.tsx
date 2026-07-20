import { Fragment, useState } from "react";
import { Hash, ChevronRight, CircleCheck, CircleX } from "lucide-react";
import { useTheme, monoFont } from "../theme.js";
import { Card, SectionLabel, Button } from "../components/ui.tsx";
import { VERIFIED_HASH, TAMPERED_HASH } from "../data/mockData.js";

export default function Verify() {
  const t = useTheme();
  const [verified, setVerified] = useState(true);
  const onChainHash = verified ? VERIFIED_HASH : TAMPERED_HASH;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Card>
        <SectionLabel>Merkle proof verification</SectionLabel>
        <p style={{ color: t.muted, fontSize: 13, marginTop: 4 }}>
          Compare a log's locally recomputed hash against the on-chain Merkle root to confirm it has not been altered.
        </p>

        <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
          <Button variant={verified ? "primary" : "subtle"} onClick={() => setVerified(true)} small>
            Show verified example
          </Button>
          <Button variant={verified ? "subtle" : "primary"} onClick={() => setVerified(false)} small>
            Show tampered example
          </Button>
        </div>

        <div
          style={{
            marginTop: 18,
            display: "grid",
            gridTemplateColumns: "1fr auto 1fr",
            gap: 14,
            alignItems: "center",
          }}
        >
          {[
            { label: "RECOMPUTED HASH (LOG-88228)", hash: VERIFIED_HASH },
            { label: "ON-CHAIN MERKLE LEAF", hash: onChainHash },
          ].map((item, i) => (
            <Fragment key={item.label}>
              {i === 1 && (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                  <Hash size={16} color={t.muted} />
                  <span style={{ fontSize: 10, color: t.muted }}>vs</span>
                </div>
              )}
              <div style={{ background: t.surface2, border: `1px solid ${t.border}`, borderRadius: 10, padding: 14 }}>
                <div style={{ fontSize: 11, color: t.muted, marginBottom: 6 }}>{item.label}</div>
                <div style={{ fontSize: 12, wordBreak: "break-all", ...monoFont }}>{item.hash}</div>
              </div>
            </Fragment>
          ))}
        </div>

        <div
          style={{
            marginTop: 18,
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "12px 16px",
            borderRadius: 10,
            background: verified ? "rgba(52,211,153,0.08)" : "rgba(244,63,94,0.08)",
            border: `1px solid ${verified ? "rgba(52,211,153,0.35)" : "rgba(244,63,94,0.35)"}`,
          }}
        >
          {verified ? <CircleCheck size={18} color={t.good} /> : <CircleX size={18} color={t.danger} />}
          <div>
            <div style={{ fontWeight: 600, fontSize: 14, color: verified ? t.good : t.danger }}>
              {verified ? "Verified — integrity intact" : "Tampered — hash mismatch detected"}
            </div>
            <div style={{ fontSize: 12, color: t.muted }}>
              {verified
                ? "Recomputed hash matches the committed Merkle leaf. This log has not been modified since ingestion."
                : "Recomputed hash diverges from the committed Merkle leaf. This log may have been altered after ingestion."}
            </div>
          </div>
        </div>
      </Card>

      <Card>
        <SectionLabel dot={t.cyan}>Proof path</SectionLabel>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, flexWrap: "wrap", fontSize: 12, ...monoFont }}>
          {["leaf", "h(L,R)", "h(L,R)", "root"].map((step, i, arr) => (
            <Fragment key={i}>
              <span style={{ padding: "6px 10px", background: t.surface2, border: `1px solid ${t.border}`, borderRadius: 8 }}>
                {step}
              </span>
              {i < arr.length - 1 && <ChevronRight size={14} color={t.muted} />}
            </Fragment>
          ))}
        </div>
      </Card>
    </div>
  );
}
