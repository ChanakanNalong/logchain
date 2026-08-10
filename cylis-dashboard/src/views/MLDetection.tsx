import { useEffect, useState } from "react";
import { Target, TrendingUp, Activity, Brain } from "lucide-react";
import { useTheme, monoFont, sansFont } from "@/theme";
import { Card, SectionLabel, Badge, Th, Td } from "@/components/ui";
import { api } from "@/lib/api";

/**
 * Offline benchmark result — DeepLog trained on HDFS_v1 (seed=42).
 * These numbers are baked into the build on purpose: they describe the model's
 * evaluation run, NOT anything the running system has measured. Section 3 below
 * is the only part of this page that reflects live runtime state.
 */
const TRAINING = {
  dataset: "HDFS_v1",
  f1: "0.7138",
  precision: "0.9735",
  recall: "0.5635",
  confusion: { tp: 412, fp: 11, fn: 319, tn: 8201 },
};

const metricCards = [
  { l: "F1 Score", v: TRAINING.f1, sub: `seed=42, ${TRAINING.dataset}`, icon: TrendingUp, tone: "good" },
  { l: "Precision", v: TRAINING.precision, sub: "TP/(TP+FP)", icon: Target, tone: "blue" },
  { l: "Recall", v: TRAINING.recall, sub: "TP/(TP+FN)", icon: Activity, tone: "warn" },
  { l: "Model", v: "DeepLog", sub: "LSTM · window=10", icon: Brain, tone: "cyan" },
];

/**
 * What the platform is able to detect, grouped by attack class.
 * Rule IDs and severities mirror logchain-detection/rules/security_rules.yaml —
 * keep the two in sync when a rule is added or its severity changes.
 */
const DETECTION_CAPABILITY = [
  {
    group: "Authentication",
    kind: "rule",
    tone: "blue",
    rules: [
      { id: "5710", desc: "Multiple authentication failures (brute force)", severity: "CRITICAL" },
      { id: "5715", desc: "Successful login after multiple failures", severity: "WARNING" },
    ],
  },
  {
    group: "Privilege escalation",
    kind: "rule",
    tone: "danger",
    rules: [{ id: "5820", desc: "Privilege escalation attempt", severity: "CRITICAL" }],
  },
  {
    group: "Injection",
    kind: "rule",
    tone: "danger",
    rules: [
      { id: "31100", desc: "SQL injection pattern detected", severity: "CRITICAL" },
      { id: "31151", desc: "Command injection attempt", severity: "CRITICAL" },
    ],
  },
  {
    group: "PCI / CDE",
    kind: "rule",
    tone: "warn",
    rules: [
      { id: "90001", desc: "Card data access from non-CDE context", severity: "CRITICAL" },
      { id: "90002", desc: "Cardholder data access logged", severity: "WARNING" },
    ],
  },
  {
    group: "Anomaly indicators",
    kind: "rule",
    tone: "warn",
    rules: [
      { id: "60001", desc: "Suspicious user agent or scanner", severity: "WARNING" },
      { id: "60002", desc: "Path traversal attempt", severity: "CRITICAL" },
    ],
  },
  {
    group: "Machine learning",
    kind: "ml",
    tone: "cyan",
    rules: [{ id: "DeepLog", desc: "Sequence anomaly detection (LSTM)", severity: "ML" }],
  },
];

const countRules = (kind: string) =>
  DETECTION_CAPABILITY.filter((g) => g.kind === kind).reduce((n, g) => n + g.rules.length, 0);

const RULE_BASED_COUNT = countRules("rule");
const ML_BASED_COUNT = countRules("ml");
const TOTAL_COUNT = RULE_BASED_COUNT + ML_BASED_COUNT;

/** One row of GET /api/v1/stats/overview → anomalyTypes */
interface AnomalyType {
  type: string;
  severity: string;
  source: string;
  count: number;
}

const severityTone = (s: string) =>
  s === "CRITICAL" ? "danger" : s === "WARNING" ? "warn" : s === "ML" ? "cyan" : "neutral";

export default function MLDetection() {
  const t = useTheme();

  const [detections, setDetections] = useState<AnomalyType[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    api
      .get("/stats/overview")
      .then((res) => {
        if (cancelled) return;
        setDetections(res.data?.anomalyTypes ?? []);
      })
      .catch((e) => {
        if (cancelled) return;
        console.error("runtime detections fetch failed", e);
        setError(
          e.response?.status === 403
            ? "Not authorised — this account needs the analyst, operator or admin role."
            : "Could not load runtime detections.",
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, []);

  const placeholder = (text: string) => (
    <div style={{ color: t.muted, padding: 20, textAlign: "center", fontSize: 13 }}>{text}</div>
  );

  const confusionCells = [
    { label: "True Positive", v: TRAINING.confusion.tp, bg: "rgba(52,211,153,0.1)", bd: "rgba(52,211,153,0.3)", fg: t.good, note: "Anomaly ตรวจเจอ ✓" },
    { label: "False Positive", v: TRAINING.confusion.fp, bg: "rgba(245,158,11,0.08)", bd: "rgba(245,158,11,0.3)", fg: t.warn, note: "Normal ถูกตีว่า anomaly" },
    { label: "False Negative", v: TRAINING.confusion.fn, bg: "rgba(244,63,94,0.08)", bd: "rgba(244,63,94,0.3)", fg: t.danger, note: "Anomaly ที่พลาดไป" },
    { label: "True Negative", v: TRAINING.confusion.tn, bg: "rgba(59,130,246,0.08)", bd: "rgba(59,130,246,0.3)", fg: t.blue2, note: "Normal ถูกต้อง ✓" },
  ];

  const totalDetections = (detections ?? []).reduce((n, d) => n + d.count, 0);

  return (
    <div style={{ display: "grid", gap: 18 }}>
      {/* ── 1. Training metrics — static benchmark, explicitly not runtime ── */}
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
          <SectionLabel>Model training result</SectionLabel>
          <Badge tone="neutral">{TRAINING.dataset} training result (static)</Badge>
        </div>
        <div style={{ fontSize: 11.5, color: t.muted, ...sansFont, marginTop: -2, marginBottom: 14 }}>
          ตัวเลขชุดนี้มาจากการเทรน/ประเมินผล offline บน dataset {TRAINING.dataset} (seed=42) —{" "}
          <span style={{ color: t.warn, fontWeight: 600 }}>ไม่ใช่ค่า runtime ของระบบ</span> ดูของจริงที่ Runtime detections ด้านล่าง
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 12 }}>
          {metricCards.map((m) => (
            <div
              key={m.l}
              style={{ background: t.surface2, border: `1px solid ${t.border}`, borderRadius: 10, padding: "14px 16px" }}
            >
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <SectionLabel dot={t[m.tone] || t.blue}>{m.l}</SectionLabel>
                <m.icon size={15} color={t.muted} />
              </div>
              <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em", marginTop: 4, ...monoFont }}>{m.v}</div>
              <div style={{ fontSize: 11, color: t.muted, marginTop: 4, ...sansFont }}>{m.sub}</div>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 18 }}>
          <SectionLabel dot={t.cyan}>Confusion matrix</SectionLabel>
          <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 10 }}>
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
        </div>
      </Card>

      {/* ── 2. Detection capability — static catalogue of what we can detect ── */}
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
          <SectionLabel dot={t.blue}>Detection capability</SectionLabel>
          <Badge tone="blue">
            {RULE_BASED_COUNT} rule-based + {ML_BASED_COUNT} ML-based = {TOTAL_COUNT} ประเภท
          </Badge>
        </div>
        <div style={{ fontSize: 11.5, color: t.muted, ...sansFont, marginTop: -2, marginBottom: 14 }}>
          ประเภทภัยคุกคามที่ระบบตรวจจับได้ — rule ID และ severity ตรงกับ{" "}
          <span style={{ ...monoFont, color: t.blue2 }}>rules/security_rules.yaml</span> ของ detection service
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(320px,1fr))", gap: 12 }}>
          {DETECTION_CAPABILITY.map((g) => (
            <div
              key={g.group}
              style={{ background: t.surface2, border: `1px solid ${t.border}`, borderRadius: 10, padding: "14px 16px" }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <SectionLabel dot={t[g.tone] || t.blue}>{g.group}</SectionLabel>
                <Badge tone={g.kind === "ml" ? "cyan" : "neutral"}>{g.kind === "ml" ? "ML" : "rule"}</Badge>
              </div>
              <div style={{ display: "grid", gap: 8, marginTop: 6 }}>
                {g.rules.map((r) => (
                  <div key={r.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                    <div style={{ minWidth: 0 }}>
                      <span style={{ fontSize: 12.5, color: t.blue2, ...monoFont }}>{r.id}</span>
                      <div style={{ fontSize: 11.5, color: t.text, ...sansFont, marginTop: 1 }}>{r.desc}</div>
                    </div>
                    <Badge tone={severityTone(r.severity)}>{r.severity}</Badge>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* ── 3. Runtime detections — the only live section on this page ── */}
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <SectionLabel dot={t.good}>Runtime detections</SectionLabel>
          <Badge tone="good">live</Badge>
        </div>
        <div style={{ fontSize: 11.5, color: t.muted, ...sansFont, marginTop: -2, marginBottom: 12 }}>
          จำนวนครั้งที่ระบบตรวจเจอจริงต่อประเภท จาก{" "}
          <span style={{ ...monoFont, color: t.blue2 }}>GET /api/v1/stats/overview</span>
          {!loading && !error && detections && detections.length > 0 && (
            <> — รวม {totalDetections.toLocaleString()} ครั้ง จาก {detections.length} ประเภท</>
          )}
        </div>

        {loading ? (
          placeholder("Loading runtime detections…")
        ) : error ? (
          <div style={{ color: t.danger, padding: 20, fontSize: 13 }}>{error}</div>
        ) : !detections || detections.length === 0 ? (
          placeholder("No detections recorded yet")
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr>
                  <Th>Type</Th>
                  <Th>Severity</Th>
                  <Th>Source</Th>
                  <Th>Count</Th>
                </tr>
              </thead>
              <tbody>
                {detections.map((d) => (
                  <tr key={`${d.type}-${d.severity}-${d.source}`}>
                    <Td style={{ color: t.blue2, ...monoFont }}>{d.type}</Td>
                    <Td>
                      <Badge tone={severityTone(d.severity)}>{d.severity}</Badge>
                    </Td>
                    <Td style={{ ...monoFont, color: t.muted }}>{d.source}</Td>
                    <Td style={{ ...monoFont, fontWeight: 700 }}>{d.count.toLocaleString()}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
