import {
  ScrollText,
  TriangleAlert,
  ShieldCheck,
  Activity,
} from "lucide-react";

export const kpiCards = [
  { label: "Logs ingested / 24h", value: "1,284,019", delta: "+4.2%", tone: "good", icon: ScrollText },
  { label: "Anomalies flagged", value: "342", delta: "+18 today", tone: "warn", icon: TriangleAlert },
  { label: "Chain integrity", value: "100%", delta: "0 tampered", tone: "good", icon: ShieldCheck },
  { label: "Detection F1 (DeepLog)", value: "0.71", delta: "stable", tone: "blue", icon: Activity },
];

// Any hour with total traffic above this is shown in red on the chart.
export const TRAFFIC_SPIKE_THRESHOLD = 1000;

function buildTrafficByHour() {
  const rows = Array.from({ length: 12 }).map((_, i) => {
    const normal = Math.round(800 + Math.random() * 400);
    const anomaly = Math.round(10 + Math.random() * 40);
    const total = normal + anomaly;
    return {
      h: `${(i * 2).toString().padStart(2, "0")}:00`,
      normal,
      anomaly,
      total,
      isSpike: total > TRAFFIC_SPIKE_THRESHOLD,
    };
  });
  return rows;
}

export const trafficByHour = buildTrafficByHour();

export const topAttackSources = [
  { ip: "203.154.12.88", country: "TH", hits: 1843, risk: "danger" },
  { ip: "45.142.120.5", country: "RU", hits: 1290, risk: "danger" },
  { ip: "185.220.101.4", country: "DE", hits: 904, risk: "warn" },
  { ip: "103.95.96.10", country: "TH", hits: 612, risk: "good" },
  { ip: "172.245.55.91", country: "US", hits: 488, risk: "good" },
];

export const recentLogs = [
  { id: "LG-88231", ts: "2026-06-30 09:14:02", source: "auth-service", ip: "203.154.12.88", event: "Failed login x5", attackType: "Brute Force", sev: "danger" },
  { id: "LG-88230", ts: "2026-06-30 09:12:51", source: "api-gateway", ip: "45.142.120.5", event: "Rate limit exceeded", attackType: "Rate Limit Abuse", sev: "warn" },
  { id: "LG-88229", ts: "2026-06-30 09:11:40", source: "db-proxy", ip: "10.0.4.2", event: "Slow query 4.2s", attackType: "Performance Anomaly", sev: "good" },
  { id: "LG-88228", ts: "2026-06-30 09:10:02", source: "auth-service", ip: "185.220.101.4", event: "Privilege escalation attempt", attackType: "Privilege Escalation", sev: "danger" },
  { id: "LG-88227", ts: "2026-06-30 09:08:55", source: "kafka-consumer", ip: "10.0.2.7", event: "Consumer lag 1200ms", attackType: "Performance Anomaly", sev: "good" },
  { id: "LG-88226", ts: "2026-06-30 09:06:21", source: "api-gateway", ip: "103.95.96.10", event: "Unusual payload size", attackType: "Anomalous Payload", sev: "warn" },
  { id: "LG-88225", ts: "2026-06-30 09:04:09", source: "merkle-service", ip: "10.0.1.1", event: "Batch hash committed", attackType: "Chain Integrity", sev: "good" },
  { id: "LG-88224", ts: "2026-06-30 09:01:18", source: "auth-service", ip: "172.245.55.91", event: "Token replay detected", attackType: "Token Replay", sev: "danger" },
];

export const rbacRoles = [
  { role: "Admin", users: 2, perms: "Full access · log delete · chain config" },
  { role: "Analyst", users: 6, perms: "View logs · verify proofs · export reports" },
  { role: "Auditor", users: 3, perms: "Read-only · verify proofs · export reports" },
  { role: "Viewer", users: 11, perms: "Dashboard view only" },
];

export const confusionMatrix = { tp: 412, fp: 11, fn: 319, tn: 8201 };

export const lossCurve = Array.from({ length: 20 }).map((_, i) => ({
  epoch: i + 1,
  loss: parseFloat((0.85 * Math.exp(-0.18 * i) + 0.05 + Math.random() * 0.02).toFixed(4)),
  val_loss: parseFloat((0.9 * Math.exp(-0.14 * i) + 0.08 + Math.random() * 0.03).toFixed(4)),
}));

export const hdfsSequences = [
  { id: "BLK-8293", seq: ["E5", "E5", "E22", "E5", "E11", "E9", "E11"], label: "normal", score: 0.04 },
  { id: "BLK-8301", seq: ["E5", "E5", "E5", "E27", "E3", "E27", "E27"], label: "anomaly", score: 0.94 },
  { id: "BLK-8310", seq: ["E22", "E11", "E9", "E11", "E9", "E26", "E26"], label: "normal", score: 0.11 },
  { id: "BLK-8318", seq: ["E5", "E22", "E27", "E27", "E3", "E3", "E3"], label: "anomaly", score: 0.89 },
  { id: "BLK-8325", seq: ["E11", "E9", "E11", "E9", "E11", "E9", "E5"], label: "normal", score: 0.07 },
];

export const datasetStats = [
  { l: "Total sequences", v: "575,061" },
  { l: "Anomaly sequences", v: "16,838" },
  { l: "Normal sequences", v: "558,223" },
  { l: "Unique event types", v: "29" },
  { l: "Window size", v: "10" },
  { l: "Source", v: "logpai/loghub" },
];

export const rawHdfsLogs = [
  { ts: "081109 203518", level: "INFO", event: "E5", block: "blk_-160899968...", text: "Receiving block blk_-1608... src: /10.251.123.22" },
  { ts: "081109 203519", level: "INFO", event: "E22", block: "blk_-160899968...", text: "Served block blk_-1608... to /10.251.73.108" },
  { ts: "081109 203519", level: "INFO", event: "E11", block: "blk_-160899968...", text: "PacketResponder 1 for block blk_-1608... terminating" },
  { ts: "081109 203520", level: "WARN", event: "E27", block: "blk_750348333...", text: "Exception in receiveBlock for block blk_7503..." },
  { ts: "081109 203520", level: "ERROR", event: "E3", block: "blk_750348333...", text: "IOException: Broken pipe — connection to node dropped" },
];

export const dataSources = [
  { name: "logpai/loghub", url: "github.com/logpai/loghub", desc: "Repository หลักของ HDFS_v1 และ dataset อีก 16 ชุด" },
  { name: "ait-aecid/anomaly-detection-log-datasets", url: "github.com/ait-aecid", desc: "Dataset สำหรับ anomaly detection หลาย format" },
  { name: "CIC-IDS 2017", url: "unb.ca/cic/datasets", desc: "Network intrusion detection จาก Canadian Institute" },
  { name: "Mordor Project", url: "github.com/OTRF/mordor", desc: "Windows event log จำลองการโจมตีตาม MITRE ATT&CK" },
];

export const incidentTimeline = [
  { t: "09:01:18", e: "Token replay detected — auth-service", tone: "danger" },
  { t: "09:03:44", e: "Anomaly score crossed threshold (0.91)", tone: "warn" },
  { t: "09:04:09", e: "Batch hash committed to Merkle tree", tone: "good" },
  { t: "09:06:02", e: "Alert routed to on-call analyst", tone: "blue" },
  { t: "09:11:30", e: "Source IP auto-blocked", tone: "good" },
];

export const merkleProofSummary = [
  { l: "Batch ID", v: "BATCH-0419" },
  { l: "Logs in batch", v: "256" },
  { l: "Merkle root", v: "8f3c…2c8d1" },
  { l: "Chain tx", v: "0x6a1f…e02b" },
  { l: "Block", v: "#48,221,019" },
  { l: "Status", v: "Confirmed" },
];

export const alertConfig = [
  { label: "Anomaly score threshold", desc: "Trigger an alert when DeepLog confidence exceeds this value.", value: "0.85" },
  { label: "Failed login burst", desc: "Flag when failed logins from one IP exceed this count in 5 minutes.", value: "5 attempts" },
  { label: "Notify channel", desc: "Where alerts are delivered.", value: "#soc-alerts (Slack)" },
];

export const VERIFIED_HASH = "8f3c1a92e0d4b7c6f1a39e02d8c4b1f7e9a6d3c0b2f8e1a4c7d9b3f0e6a2c8d1";
export const TAMPERED_HASH = "8f3c1a92e0d4b7c6f1a39e02d8c4b1f7e9a6d3c0b2f8e1a4c7d9b3f0e6a2c8d5";