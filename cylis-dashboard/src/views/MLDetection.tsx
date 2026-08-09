import { ResponsiveContainer, LineChart, Line, CartesianGrid, XAxis, YAxis, Tooltip } from "recharts";
import { Target, TrendingUp, Activity, Brain } from "lucide-react";
import { useTheme, monoFont, sansFont } from "@/theme";
import { Card, SectionLabel, Badge, Th, Td } from "@/components/ui";
import { lossCurve, confusionMatrix, hdfsSequences } from "@/data/mockData";

const metricCards = [
  { l: "F1 Score", v: "0.7138", sub: "seed=42, HDFS_v1", icon: TrendingUp, tone: "good" },
  { l: "Precision", v: "0.9735", sub: "TP/(TP+FP)", icon: Target, tone: "blue" },
  { l: "Recall", v: "0.5635", sub: "TP/(TP+FN)", icon: Activity, tone: "warn" },
  { l: "Model", v: "DeepLog", sub: "LSTM · window=10", icon: Brain, tone: "cyan" },
];

export default function MLDetection() {
  const t = useTheme();

  const confusionCells = [
    { label: "True Positive", v: confusionMatrix.tp, bg: "rgba(52,211,153,0.1)", bd: "rgba(52,211,153,0.3)", fg: t.good, note: "Anomaly ตรวจเจอ ✓" },
    { label: "False Positive", v: confusionMatrix.fp, bg: "rgba(245,158,11,0.08)", bd: "rgba(245,158,11,0.3)", fg: t.warn, note: "Normal ถูกตีว่า anomaly" },
    { label: "False Negative", v: confusionMatrix.fn, bg: "rgba(244,63,94,0.08)", bd: "rgba(244,63,94,0.3)", fg: t.danger, note: "Anomaly ที่พลาดไป" },
    { label: "True Negative", v: confusionMatrix.tn, bg: "rgba(59,130,246,0.08)", bd: "rgba(59,130,246,0.3)", fg: t.blue2, note: "Normal ถูกต้อง ✓" },
  ];

  return (
    <div style={{ display: "grid", gap: 18 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14 }}>
        {metricCards.map((m) => (
          <Card key={m.l}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <SectionLabel dot={t[m.tone] || t.blue}>{m.l}</SectionLabel>
              <m.icon size={15} color={t.muted} />
            </div>
            <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.02em", marginTop: 6, ...monoFont }}>{m.v}</div>
            <div style={{ fontSize: 11, color: t.muted, marginTop: 4, ...sansFont }}>{m.sub}</div>
          </Card>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 16 }}>
        <Card>
          <SectionLabel>Training loss curve</SectionLabel>
          <div style={{ height: 220, marginTop: 14 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={lossCurve}>
                <CartesianGrid stroke={t.border} strokeDasharray="3 6" vertical={false} />
                <XAxis dataKey="epoch" stroke={t.muted} fontSize={11} tickLine={false} axisLine={false} tick={{ ...monoFont, fill: t.muted }} />
                <YAxis stroke={t.muted} fontSize={11} tickLine={false} axisLine={false} tick={{ ...monoFont, fill: t.muted }} width={42} />
                <Tooltip
                  contentStyle={{ background: t.surface2, border: `1px solid ${t.border}`, borderRadius: 10, fontSize: 12, ...monoFont }}
                  labelStyle={{ color: t.text, ...sansFont, fontWeight: 600 }}
                />
                <Line type="monotone" dataKey="loss" stroke={t.blue2} strokeWidth={2} dot={false} name="Train loss" />
                <Line type="monotone" dataKey="val_loss" stroke={t.cyan} strokeWidth={2} dot={false} strokeDasharray="5 3" name="Val loss" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card>
          <SectionLabel dot={t.cyan}>Confusion matrix</SectionLabel>
          <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {confusionCells.map((c) => (
              <div key={c.label} style={{ background: c.bg, border: `1px solid ${c.bd}`, borderRadius: 10, padding: "14px 16px" }}>
                <div style={{ fontSize: 10, color: t.muted, textTransform: "uppercase", letterSpacing: "0.1em", ...sansFont, fontWeight: 600 }}>
                  {c.label}
                </div>
                <div style={{ fontSize: 24, fontWeight: 700, color: c.fg, letterSpacing: "-0.02em", marginTop: 4, ...monoFont }}>
                  {c.v.toLocaleString()}
                </div>
                <div style={{ fontSize: 11, color: t.muted, marginTop: 3, ...sansFont }}>{c.note}</div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 14, padding: "10px 14px", background: "rgba(59,130,246,0.06)", border: "1px solid rgba(59,130,246,0.2)", borderRadius: 9 }}>
            <div style={{ fontSize: 11, color: t.muted, ...sansFont }}>
              Key insight — เปลี่ยน <span style={{ color: t.cyan, ...monoFont }}>short_sequence=True</span> ทำให้ F1 จาก{" "}
              <span style={{ color: t.danger }}>0.35</span> → <span style={{ color: t.good }}>0.71</span>
            </div>
          </div>
        </Card>
      </div>

      <Card>
        <SectionLabel>HDFS test sequences — ตัวอย่างผลการตรวจจับ</SectionLabel>
        <div style={{ overflowX: "auto", marginTop: 12 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr>
                <Th>Block ID</Th>
                <Th>Event Sequence</Th>
                <Th>True Label</Th>
                <Th>Anomaly Score</Th>
                <Th>Result</Th>
              </tr>
            </thead>
            <tbody>
              {hdfsSequences.map((s) => (
                <tr key={s.id}>
                  <Td style={{ color: t.blue2, ...monoFont }}>{s.id}</Td>
                  <Td>
                    <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                      {s.seq.map((ev, i) => (
                        <span
                          key={i}
                          style={{ padding: "2px 8px", borderRadius: 5, background: t.surface2, border: `1px solid ${t.border}`, fontSize: 11, ...monoFont }}
                        >
                          {ev}
                        </span>
                      ))}
                    </div>
                  </Td>
                  <Td>
                    <Badge tone={s.label === "anomaly" ? "danger" : "good"}>{s.label}</Badge>
                  </Td>
                  <Td style={{ ...monoFont, color: s.score > 0.5 ? t.danger : t.good }}>{s.score.toFixed(2)}</Td>
                  <Td style={{ color: s.label === "anomaly" ? t.good : t.muted, fontSize: 12 }}>
                    {s.label === "anomaly" ? "✓ detected" : "✓ normal"}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
