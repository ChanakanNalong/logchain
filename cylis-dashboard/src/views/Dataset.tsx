import { Database } from "lucide-react";
import { useTheme, monoFont, sansFont } from "@/theme";
import { Card, SectionLabel, Badge } from "@/components/ui";
import { datasetStats, rawHdfsLogs, dataSources } from "@/data/mockData";

export default function Dataset() {
  const t = useTheme();
  const levelColor = { INFO: t.good, WARN: t.warn, ERROR: t.danger };

  return (
    <div style={{ display: "grid", gap: 18 }}>
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16 }}>
        <Card>
          <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: 12,
                background: `linear-gradient(135deg,${t.blue},${t.cyan})`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <Database size={20} color="#fff" />
            </div>
            <div>
              <SectionLabel>Dataset ที่ใช้</SectionLabel>
              <h3 style={{ margin: "4px 0 0", fontSize: 18, fontWeight: 700, ...sansFont }}>
                HDFS_v1 — Hadoop Distributed File System Log
              </h3>
              <p style={{ color: t.muted, fontSize: 13, marginTop: 6, lineHeight: 1.6 }}>
                Public dataset จาก <span style={{ color: t.blue2, ...monoFont }}>logpai/loghub</span> เป็น log
                การทำงานของ Hadoop cluster ในสภาพแวดล้อมจริง ไม่มีข้อมูลส่วนบุคคล
              </p>
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <Badge tone="good">ฟรี / Open Source</Badge>
                <Badge tone="blue">Research use</Badge>
                <Badge tone="neutral">No PII</Badge>
              </div>
            </div>
          </div>
        </Card>

        <Card>
          <SectionLabel dot={t.cyan}>สถิติ dataset</SectionLabel>
          <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
            {datasetStats.map((s) => (
              <div
                key={s.l}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  borderBottom: `1px solid ${t.border}`,
                  paddingBottom: 6,
                }}
              >
                <span style={{ fontSize: 12, color: t.muted, ...sansFont }}>{s.l}</span>
                <span style={{ fontSize: 13, fontWeight: 600, ...monoFont }}>{s.v}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card>
        <SectionLabel>สัดส่วน Normal vs Anomaly</SectionLabel>
        <div style={{ marginTop: 14 }}>
          <div style={{ display: "flex", borderRadius: 8, overflow: "hidden", height: 28 }}>
            <div
              style={{
                flex: 558223,
                background: `linear-gradient(90deg,${t.blue},${t.blue2})`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <span style={{ fontSize: 12, fontWeight: 600, color: "#fff", ...sansFont }}>Normal 97.1%</span>
            </div>
            <div
              style={{
                flex: 16838,
                background: `linear-gradient(90deg,${t.danger},#fb7185)`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <span style={{ fontSize: 11, fontWeight: 600, color: "#fff", ...sansFont }}>Anomaly 2.9%</span>
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 11, color: t.muted, ...monoFont }}>
            <span>558,223 normal</span>
            <span>16,838 anomaly</span>
          </div>
        </div>
      </Card>

      <Card>
        <SectionLabel>ตัวอย่าง raw log จาก HDFS_v1</SectionLabel>
        <div style={{ display: "grid", gap: 8, marginTop: 14 }}>
          {rawHdfsLogs.map((r, i) => (
            <div
              key={i}
              style={{
                background: t.surface2,
                border: `1px solid ${t.border}`,
                borderRadius: 9,
                padding: "10px 14px",
                borderLeft: `3px solid ${levelColor[r.level] || t.muted}`,
              }}
            >
              <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ fontSize: 11, color: t.muted, ...monoFont }}>{r.ts}</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: levelColor[r.level], ...monoFont }}>{r.level}</span>
                <span style={{ fontSize: 11, color: t.cyan, ...monoFont }}>{r.event}</span>
                <span style={{ fontSize: 11, color: t.blue2, ...monoFont }}>{r.block}</span>
              </div>
              <div style={{ fontSize: 12, color: t.muted, marginTop: 5, ...monoFont }}>{r.text}</div>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <SectionLabel>แหล่งข้อมูล</SectionLabel>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
          {dataSources.map((r) => (
            <div key={r.name} style={{ background: t.surface2, border: `1px solid ${t.border}`, borderRadius: 10, padding: "12px 14px" }}>
              <div style={{ fontSize: 12, color: t.blue2, fontWeight: 600, ...monoFont }}>{r.name}</div>
              <div style={{ fontSize: 11, color: t.muted, marginTop: 4, ...sansFont }}>{r.desc}</div>
              <div style={{ fontSize: 10, color: t.border, marginTop: 6, ...monoFont }}>{r.url}</div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
