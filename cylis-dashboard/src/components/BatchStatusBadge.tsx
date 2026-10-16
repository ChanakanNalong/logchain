import { Badge } from "@/components/ui";
import type { BatchStatus } from "@/types/api";

/**
 * On-chain status of the batch a log was sealed into.
 * FAILED is orange, never red: red is reserved for TAMPERED so a failed
 * anchor (no tx) is never read as evidence of tampering.
 */
const STATUS: Record<BatchStatus | "NONE", { label: string; tone: string; hint: string }> = {
  NONE: { label: "Pending (รอ seal)", tone: "neutral", hint: "ยังไม่ถูก seal เข้า batch — รอรอบ seal ถัดไป" },
  // not in the spec table: a batch row exists but sealing has not finished
  PENDING: { label: "Pending (รอ seal)", tone: "neutral", hint: "batch ถูกสร้างแล้ว กำลังรอ seal" },
  SEALED: { label: "Sealed (ยังไม่ขึ้นเชน)", tone: "slate", hint: "seal เป็น Merkle root แล้ว แต่ยังไม่ได้ anchor ขึ้นเชน" },
  UNVERIFIED: { label: "Unverified", tone: "warn", hint: "ส่ง tx แล้ว ยังยืนยัน receipt ไม่ได้" },
  CONFIRMED: { label: "On-chain ✓", tone: "good", hint: "root อยู่บนเชนแล้ว" },
  TAMPERED: { label: "Tampered", tone: "danger", hint: "root ใน DB ไม่ตรงกับบนเชน" },
  FAILED: { label: "Anchor failed", tone: "orange", hint: "anchor ขึ้นเชนไม่สำเร็จ — ไม่ได้แปลว่าข้อมูลถูกแก้" },
};

export default function BatchStatusBadge({ status }: { status: BatchStatus | null | undefined }) {
  // a status this build does not know yet: show it raw rather than as "pending"
  const s = !status ? STATUS.NONE : STATUS[status] ?? { label: status, tone: "neutral", hint: "unknown status" };
  return (
    <span style={{ whiteSpace: "nowrap" }}>
      <Badge tone={s.tone} title={status ? `${status} — ${s.hint}` : s.hint}>{s.label}</Badge>
    </span>
  );
}
