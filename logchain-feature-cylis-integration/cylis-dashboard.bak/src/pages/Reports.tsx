import { Download } from "lucide-react";
import { useTheme, monoFont, sansFont } from "../theme.js";
import { Card, SectionLabel, Badge, Button } from "../components/ui.tsx";
import { incidentTimeline, merkleProofSummary } from "../data/mockData.js";

export default function Reports() {
  const t = useTheme();

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <SectionLabel>Incident summary</SectionLabel>
            <h3 style={{ margin: "5px 0 0", fontSize: 19, fontWeight: 700, letterSpacing: "-0.01em", ...sansFont }}>
              INC-2026-0612 · Token replay cluster
            </h3>
            <p style={{ color: t.muted, fontSize: 13, marginTop: 6, maxWidth: 520 }}>
              Repeated token replay attempts originating from 3 IPs flagged by DeepLog within a 40-minute window.
              Auto-blocked after threshold breach.
            </p>
          </div>
          <Badge tone="danger">high severity</Badge>
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
          <Button icon={Download} small>
            Export PDF
          </Button>
          <Button icon={Download} variant="subtle" small>
            Export CSV
          </Button>
        </div>
      </Card>

      <Card>
        <SectionLabel dot={t.cyan}>Timeline</SectionLabel>
        <div style={{ marginTop: 14, display: "grid", gap: 0 }}>
          {incidentTimeline.map((item, i, arr) => (
            <div key={i} style={{ display: "flex", gap: 12 }}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                <div style={{ width: 9, height: 9, borderRadius: 999, background: t[item.tone] || t.blue, marginTop: 4 }} />
                {i < arr.length - 1 && <div style={{ width: 1, flex: 1, background: t.border, minHeight: 28 }} />}
              </div>
              <div style={{ paddingBottom: 18 }}>
                <div style={{ fontSize: 12, color: t.muted, ...monoFont }}>{item.t}</div>
                <div style={{ fontSize: 13 }}>{item.e}</div>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <SectionLabel>Merkle proof summary</SectionLabel>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 12, marginTop: 12 }}>
          {merkleProofSummary.map((item) => (
            <div key={item.l}>
              <div style={{ fontSize: 11, color: t.muted }}>{item.l}</div>
              <div style={{ fontSize: 13, ...monoFont }}>{item.v}</div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
