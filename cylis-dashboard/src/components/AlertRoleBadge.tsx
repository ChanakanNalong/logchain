import { Badge } from "@/components/ui";
import type { AlertLogRole } from "@/types/api";

/** How a log relates to an alert — docs/api/logs-alerts.md §4 */
export const ALERT_ROLE_META: Record<AlertLogRole, { tone: string; hint: string }> = {
  trigger: { tone: "blue", hint: "log ที่ทำให้ alert ถูกสร้าง" },
  window: { tone: "cyan", hint: "log อื่นในหน้าต่างเวลาของ threshold rule" },
  prior: { tone: "slate", hint: "log ของ rule ก่อนหน้าในกฎแบบ chain" },
  repeat: { tone: "neutral", hint: "เกิดซ้ำหลังจากนั้นระหว่างที่ alert ยัง OPEN" },
};

export default function AlertRoleBadge({ role }: { role: AlertLogRole }) {
  const meta = ALERT_ROLE_META[role] ?? { tone: "neutral", hint: "" };
  return <Badge tone={meta.tone} title={meta.hint}>{role}</Badge>;
}
