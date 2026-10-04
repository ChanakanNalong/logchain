import { useEffect, useState } from "react";
import { Target, TrendingUp, Activity, Brain, ShieldAlert } from "lucide-react";
import { useTheme, monoFont, sansFont } from "@/theme";
import { Card, SectionLabel, Badge, Th, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { DEEPLOG_TOP_G, DEEPLOG_WINDOW_SIZE } from "@/data/referenceData";

/**
 * Offline benchmark result — DeepLog on HDFS_v1 with the 45 Drain log keys the
 * running detector uses. These numbers are baked into the build on purpose: they
 * describe offline evaluation runs, NOT anything the running system has measured.
 * The "Runtime detections" section is the only part of this page that reflects live runtime state.
 *
 * Metric cards = mean ± SD of 5 training seeds (1–5) on the same seed-42 split,
 * g = TOP_K_G = 8 (docs/worklog/2026-09-28.md sections 10–11):
 *   precision 0.9705 ± 0.0058 · recall 0.5791 ± 0.0236 · F1 0.7252 ± 0.0181
 *
 * Confusion matrix = the model file actually deployed (detection/data/deeplog_model.pt,
 * worklog 2026-09-28 section 5), g = 8:
 *      TP 9909  FP 256  FN 6929  TN 446323 | precision 0.9748  recall 0.5885  F1 0.7339
 *   TP+FN = 16,838 abnormal blocks · FP+TN = 446,579 normal blocks
 *
 * Short sequences (< WINDOW_SIZE+1) are flagged without the model: 6,191/16,838
 * abnormal blocks are that short and 0/446,579 normal ones, so the rule adds free
 * true positives. Mean F1 with short = normal is 0.3436; excluding short blocks
 * (model-only, closest to the runtime consumer, which has no such rule) it is
 * 0.4900 ± 0.0397. g=8 is chosen for a low false-positive rate — g=4 scores higher
 * F1 at ~7x the false positives (worklog section 13).
 */
const TRAINING = {
  dataset: "HDFS_v1",
  seeds: 5,
  f1: "0.7252",
  f1Sd: "0.0181",
  precision: "0.9705",
  precisionSd: "0.0058",
  recall: "0.5791",
  recallSd: "0.0236",
  confusion: { tp: 9909, fp: 256, fn: 6929, tn: 446323 },
  topG: DEEPLOG_TOP_G,
  windowSize: DEEPLOG_WINDOW_SIZE,
};

const metricCards = [
  { l: "F1 Score", v: TRAINING.f1, sub: `± ${TRAINING.f1Sd} · mean of ${TRAINING.seeds} seeds`, icon: TrendingUp, tone: "good" },
  { l: "Precision", v: TRAINING.precision, sub: `± ${TRAINING.precisionSd} · TP/(TP+FP)`, icon: Target, tone: "blue" },
  { l: "Recall", v: TRAINING.recall, sub: `± ${TRAINING.recallSd} · TP/(TP+FN)`, icon: Activity, tone: "warn" },
  { l: "Model", v: "DeepLog", sub: `LSTM · window=${DEEPLOG_WINDOW_SIZE} · top-${DEEPLOG_TOP_G}`, icon: Brain, tone: "cyan" },
];

/**
 * Offline evaluation of the batch-level Isolation Forest (detection level 3) —
 * detection/data/isoforest_model.joblib, eval_isoforest.py on the logchain-smoke
 * clone (worklog 2026-09-30, docs/plan/isolation-forest-option.md stage 4):
 *   TP 21  FP 4  TN 176  FN 0 | precision 0.8400 recall 1.0000 F1 0.9130 · FP-rate 4/180
 * Traffic was generated through the real ingest pipeline (gen_traffic.py), so it is a
 * controlled evaluation, not a benchmark dataset. Training batches arrived at a near
 * constant rate (median ~154 logs/s), so slower normal batches are flagged too
 * (worklog 2026-10-03 section 1).
 */
const ISOFOREST = {
  precision: "0.8400",
  recall: "1.0000",
  f1: "0.9130",
  fpRate: "2.22%",
  fp: 4,
  nTrain: 180,
  nNormalEval: 180,
  nAttackEval: 21,
  trainRate: "~154",
};

const isoforestCards = [
  { l: "F1 Score", v: ISOFOREST.f1, sub: "controlled evaluation", icon: TrendingUp, tone: "good" },
  { l: "Precision", v: ISOFOREST.precision, sub: "TP/(TP+FP)", icon: Target, tone: "blue" },
  { l: "Recall", v: ISOFOREST.recall, sub: "brute force · port scan · DoS", icon: Activity, tone: "warn" },
  { l: "False positive rate", v: ISOFOREST.fpRate, sub: `${ISOFOREST.fp}/${ISOFOREST.nNormalEval} normal batches`, icon: ShieldAlert, tone: "cyan" },
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
    rules: [
      {
        id: "DeepLog",
        desc: `Sequence anomaly detection (LSTM, window=${DEEPLOG_WINDOW_SIZE}, next event outside top-${DEEPLOG_TOP_G})`,
        severity: "ML",
      },
      {
        id: "Isolation Forest",
        desc: "Batch-level anomaly (10 features per sealed batch — event mix, source IPs, rate)",
        severity: "ML",
      },
    ],
  },
];

const countRules = (kind: string) =>
  DETECTION_CAPABILITY.filter((g) => g.kind === kind).reduce((n, g) => n + g.rules.length, 0);

const RULE_BASED_COUNT = countRules("rule");
const ML_BASED_COUNT = countRules("ml");

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
    { label: "True Positive", v: TRAINING.confusion.tp, bg: "rgba(52,211,153,0.1)", bd: "rgba(52,211,153,0.3)", fg: t.good, note: "ทายถูกว่าผิดปกติ" },
    { label: "False Positive", v: TRAINING.confusion.fp, bg: "rgba(245,158,11,0.08)", bd: "rgba(245,158,11,0.3)", fg: t.warn, note: "ทายพลาด (จริง ๆ ปกติ)" },
    { label: "False Negative", v: TRAINING.confusion.fn, bg: "rgba(244,63,94,0.08)", bd: "rgba(244,63,94,0.3)", fg: t.danger, note: "ทายพลาด (จริง ๆ ผิดปกติ)" },
    { label: "True Negative", v: TRAINING.confusion.tn, bg: "rgba(59,130,246,0.08)", bd: "rgba(59,130,246,0.3)", fg: t.blue2, note: "ทายถูกว่าปกติ" },
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
          ตัวเลขชุดนี้มาจากการเทรน/ประเมินผล offline บน dataset {TRAINING.dataset} (45 log key · เฉลี่ย {TRAINING.seeds} seed) —{" "}
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
          <SectionLabel dot={t.cyan}>Confusion matrix — deployed model</SectionLabel>
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
              Key insight — นับ sequence ที่สั้นกว่า window (
              <span style={{ color: t.cyan, ...monoFont }}>len &lt; {TRAINING.windowSize + 1}</span>) เป็น anomaly
              ทำให้ F1 เฉลี่ยจาก <span style={{ color: t.danger }}>0.3436</span> →{" "}
              <span style={{ color: t.good }}>{TRAINING.f1}</span>
              <div style={{ marginTop: 4 }}>
                เพราะ block ที่สั้นเป็น anomaly <b>6,191 จาก 16,838</b> ตัว แต่ฝั่ง normal{" "}
                <b>0 จาก 446,579</b> ตัวใน test set — กฎนี้เลยได้ TP ฟรีโดยไม่เพิ่ม FP เลย
              </div>
              <div style={{ marginTop: 4 }}>
                วัดเฉพาะ sequence ที่โมเดลตัดสิน (ตัด block สั้นออก) ได้ F1{" "}
                <span style={{ color: t.warn, ...monoFont }}>0.4900 ± 0.0397</span> — ใกล้กับตอนรันจริงกว่า
                เพราะ consumer ไม่มีกฎนี้
              </div>
            </div>
          </div>
        </div>
      </Card>

      {/* ── 1b. Isolation Forest — static controlled evaluation, not runtime ── */}
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
          <SectionLabel dot={t.cyan}>Isolation Forest — batch-level (ระดับที่ 3)</SectionLabel>
          <Badge tone="neutral">controlled evaluation (static)</Badge>
        </div>
        <div style={{ fontSize: 11.5, color: t.muted, ...sansFont, marginTop: -2, marginBottom: 14 }}>
          จำแนกทั้ง batch ตอนปิดชุด · ประเมินด้วยทราฟฟิกจำลองที่ยิงผ่านช่องทางรับ Log จริง (ฝึก {ISOFOREST.nTrain} batch ปกติ ·
          ประเมิน {ISOFOREST.nNormalEval} ปกติ + {ISOFOREST.nAttackEval} โจมตี) —{" "}
          <span style={{ color: t.warn, fontWeight: 600 }}>ไม่ใช่ชุดข้อมูลมาตรฐาน และไม่ใช่ค่า runtime</span>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 12 }}>
          {isoforestCards.map((m) => (
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

        <div style={{ marginTop: 14, padding: "10px 14px", background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.25)", borderRadius: 9 }}>
          <div style={{ fontSize: 11, color: t.muted, ...sansFont }}>
            ข้อจำกัด — batch ที่ใช้ฝึกมาด้วยอัตราเกือบคงที่ (มัธยฐาน{" "}
            <span style={{ color: t.warn, ...monoFont }}>{ISOFOREST.trainRate} log/วินาที</span>) โมเดลจึงไวต่ออัตราการไหลของ log:
            batch ปกติที่ช้ากว่านี้ก็ถูกแจ้งได้ · FP-rate {ISOFOREST.fpRate} ใช้ได้เฉพาะเงื่อนไขทดสอบที่ควบคุมไว้ ·
            เป็นตัวเสริม ไม่ใช่ตัวจับหลัก (ตรวจจับล่ม batch ยังปิดได้)
          </div>
        </div>
      </Card>

      {/* ── 2. Detection capability — static catalogue of what we can detect ── */}
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
          <SectionLabel dot={t.blue}>Detection capability</SectionLabel>
          <Badge tone="blue">
            {RULE_BASED_COUNT} rule-based + {ML_BASED_COUNT} ML-based
          </Badge>
        </div>
        <div style={{ fontSize: 11.5, color: t.muted, ...sansFont, marginTop: -2, marginBottom: 14 }}>
          ประเภทภัยคุกคามที่ระบบตรวจจับได้ — rule ID และ severity ของกลุ่ม rule ตรงกับ{" "}
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
          จำนวน alert ต่อรายการ จาก{" "}
          <span style={{ ...monoFont, color: t.blue2 }}>GET /api/v1/stats/overview</span>
          {!loading && !error && detections && detections.length > 0 && (
            <> — รวม {totalDetections.toLocaleString()} alert · {detections.length} รายการ (แยกตามแหล่งและระดับ)</>
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
                  <Th>Alert type</Th>
                  <Th>Severity</Th>
                  <Th>Source</Th>
                  <Th>Alerts</Th>
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
