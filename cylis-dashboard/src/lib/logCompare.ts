/**
 * Model of the "at seal | now" compare in the log drawer: what the left
 * (snapshot) panel shows for each LOG field, and which rows changed.
 * Source: GET /batches/:id/diff (docs/api/batches-diff.md §2).
 *  - changes[].fields lists only the changed fields, before / after in the
 *    canonical form the raw hash is built from (createdAt ISO, sourceIp normalised)
 *  - every other field is in the raw hash too, so it equals the current value
 *  - retentionDays is neither in the raw hash nor in the snapshot — never compared
 */
import type { BatchChange, BatchDiff, LogRecord, SnapshotLog } from "@/types/api";

export type CompareKey =
  | "createdAt" | "source" | "sourceIp" | "eventType" | "severity"
  | "message" | "classification" | "cdeScope" | "retentionDays" | "rawHash";

/** Same order and labels as the Log section of the drawer */
export const COMPARE_FIELDS: { key: CompareKey; label: string; mono?: boolean; diff?: "word" | "char" }[] = [
  { key: "createdAt", label: "Time", mono: true },
  { key: "source", label: "Source" },
  { key: "sourceIp", label: "Source IP", mono: true },
  { key: "eventType", label: "Event type", mono: true },
  { key: "severity", label: "Severity" },
  { key: "message", label: "Message", mono: true, diff: "word" },
  { key: "classification", label: "Classification" },
  { key: "cdeScope", label: "CDE scope" },
  { key: "retentionDays", label: "Retention" },
  { key: "rawHash", label: "Raw hash", mono: true, diff: "char" },
];

export type Value = string | number | boolean | null;

export type SealCell =
  | { kind: "value"; v: Value }
  /** retentionDays — not kept in the snapshot */
  | { kind: "unrecorded" }
  /** the log is not in the snapshot at all */
  | { kind: "absent" };

export interface CompareRow {
  seal: SealCell;
  changed: boolean;
  /** changed rows: the diff's `after`, shown on the right */
  after?: Value;
}

export type CompareNote = { tone: "muted" | "warn" | "danger"; text: string };

export type Compare =
  | { kind: "untrusted"; reasons: string[] }
  | { kind: "rows"; note: CompareNote | null; rows: Record<CompareKey, CompareRow>; stale: string[] };

/** Same as normalizeIp in the backend's log-hash.ts — IPv6 shortened per RFC 5952 */
function normalizeIp(ip: string | null): string | null {
  if (ip === null || ip === "") return null;
  if (!ip.includes(":")) return ip;
  try {
    return new URL(`http://[${ip}]`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return ip.toLowerCase();
  }
}

/** A field of the current log in the diff's canonical form */
export function canonical(key: CompareKey, log: LogRecord): Value {
  if (key === "createdAt") {
    const d = new Date(log.createdAt);
    return Number.isNaN(d.getTime()) ? log.createdAt : d.toISOString();
  }
  if (key === "sourceIp") return normalizeIp(log.sourceIp);
  return log[key];
}

const UNTRUSTED_TEXT: Record<string, string> = {
  SNAPSHOT_ROOT_MISMATCH: "root ที่สร้างจาก snapshot ไม่ตรงกับค่าอ้างอิง — ชุด hash ใน snapshot ไม่ใช่ชุดที่ถูก seal",
  SNAPSHOT_CONTENT_MISMATCH: "บางแถวใน snapshot ถูกแก้เนื้อ — hash แล้วไม่ได้ raw hash ที่เก็บไว้",
};

function rowsFrom(seal: (key: CompareKey) => SealCell): Record<CompareKey, CompareRow> {
  const rows = {} as Record<CompareKey, CompareRow>;
  for (const { key } of COMPARE_FIELDS) {
    rows[key] = { seal: key === "retentionDays" ? { kind: "unrecorded" } : seal(key), changed: false };
  }
  return rows;
}

export function findChange(diff: BatchDiff, logId: string): BatchChange | undefined {
  return diff.changes.find((c) => c.logId === logId);
}

export function buildCompare(diff: BatchDiff, logId: string, log: LogRecord): Compare {
  if (diff.snapshotTrusted !== true) {
    return {
      kind: "untrusted",
      reasons: diff.legacy || diff.snapshotTrusted === null
        ? ["batch นี้เกิดก่อนมีระบบ snapshot — ไม่มีข้อมูลตอน seal ให้เทียบ"]
        : ["snapshot ของ batch นี้ไม่น่าเชื่อถือ — เทียบรายตำแหน่งไม่ได้",
           ...diff.untrustedReasons.filter((r) => r in UNTRUSTED_TEXT).map((r) => UNTRUSTED_TEXT[r])],
    };
  }
  const c = findChange(diff, logId);
  const now = (key: CompareKey): SealCell => ({ kind: "value", v: canonical(key, log) });

  if (!c) {
    return { kind: "rows", note: { tone: "muted", text: "log นี้ไม่เปลี่ยนจากตอน seal" }, rows: rowsFrom(now), stale: [] };
  }
  if (c.type === "UNMAPPED_OR_INSERTED") {
    const rows = rowsFrom(() => ({ kind: "absent" }));
    rows.retentionDays.seal = { kind: "absent" };
    return { kind: "rows", note: { tone: "muted", text: "log นี้ไม่อยู่ใน snapshot — ถูกผูกกับ batch หลัง seal" }, rows, stale: [] };
  }
  if (c.type === "DELETED") {
    const snap = c.snapshot;
    const rows = rowsFrom((key) => (snap ? { kind: "value", v: snap[key as keyof SnapshotLog] } : { kind: "absent" }));
    const note: CompareNote = c.reason === "MAPPING_MISSING"
      ? { tone: "warn", text: "row ยังอยู่แต่ไม่ได้ผูกกับ batch นี้แล้ว" }
      : { tone: "danger", text: "row นี้ถูกลบแล้ว" };
    return { kind: "rows", note, rows, stale: [] };
  }

  // CONTENT_MODIFIED / HASH_MODIFIED
  const rows = rowsFrom(now);
  const stale: string[] = [];
  for (const f of c.fields ?? []) {
    const key = f.field as CompareKey;
    if (!(key in rows) || key === "retentionDays") continue;
    rows[key] = { seal: { kind: "value", v: f.before }, changed: true, after: f.after };
    if (canonical(key, log) !== f.after) stale.push(key);
  }
  return { kind: "rows", note: null, rows, stale };
}
