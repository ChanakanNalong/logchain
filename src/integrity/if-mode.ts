/**
 * โหมดของ Isolation Forest (ตรวจจับระดับที่ 3) — อ่านจาก env ครั้งเดียวตอนสร้าง service
 *
 * - `active` (default): พฤติกรรมเดิม — score, เก็บ if_* และรายงานผลจำแนกออก API ตามจริง
 * - `calibrating`: ยัง score + เก็บ if_* ลง batch (ไว้ retrain) แต่ไม่โชว์ผลเป็น "ผิดปกติ"
 *   ออก API (`/batches` ส่ง `ifStatus:"calibrating"` + `ifAnomaly:null`) และลด WARN เป็น debug
 *   ใช้ตอนโมเดลยังฝึกจากข้อมูลจำลอง (batch จริงเล็ก/แคบ จะถูก flag อนุมานผิดเกือบทุกใบ)
 */
export type IfMode = 'active' | 'calibrating';

export function readIfMode(env: NodeJS.ProcessEnv): IfMode {
  const raw = env.IF_MODE?.trim().toLowerCase();
  if (!raw || raw === 'active') return 'active';
  if (raw === 'calibrating') return 'calibrating';
  throw new Error(
    `IF_MODE must be "active" or "calibrating" (got "${env.IF_MODE}")`,
  );
}
