import { CronExpression } from '@nestjs/schedule';

/**
 * ค่าตั้งของรอบ seal — อ่านจาก env ครั้งเดียวตอนสร้าง service
 *
 * ค่า default = พฤติกรรมเดิม: seal ทุก 1 นาที ทีละไม่เกิน 100 log · guard ยอดเงินปิดอยู่
 * ต่างจากเดิมแค่ 2 อย่าง (ทั้งคู่มีผลเฉพาะตอนผิดปกติ):
 *   - log ค้างเกิน batch size → รอบเดียวปิดหลาย batch จนหมด (เดิมปิดได้นาทีละ 100 แล้วค้างสะสม)
 *   - seal ล้มติดกัน SEAL_FAILURE_BACKOFF_AFTER ครั้ง → ข้ามรอบแบบ exponential
 *     (เดิมสร้าง batch FAILED ใบใหม่ทุกนาที — พายุ 2026-10-08 ราว 1,161 ใบใน 19 ชม.)
 */
export interface SealConfig {
  /** cron expression ของรอบ seal (6 ช่องมีวินาที หรือ 5 ช่องก็ได้) */
  cron: string;
  /** log ต่อ batch — 1 batch = 1 tx storeRoot */
  batchSize: number;
  /** ต้องมียอดพอจ่าย storeRoot อย่างน้อยกี่ครั้งถึงจะสร้าง batch · 0 = ปิด guard */
  minBalanceTx: number;
  /** ล้มติดกันกี่ครั้งถึงเริ่มข้ามรอบ · 0 = ปิด backoff */
  failureBackoffAfter: number;
  /** ข้ามรอบได้มากสุดกี่รอบต่อครั้ง (เพดานของ 2^n) */
  backoffMaxTicks: number;
  /** alert ยอดเงินต่ำซ้ำได้ไม่ถี่กว่านี้ (นาที) */
  lowBalanceAlertMinutes: number;
}

export const DEFAULT_SEAL_CONFIG: SealConfig = {
  cron: CronExpression.EVERY_MINUTE,
  batchSize: 100,
  minBalanceTx: 0,
  failureBackoffAfter: 3,
  backoffMaxTicks: 60,
  lowBalanceAlertMinutes: 60,
};

/** จำนวนเต็ม ≥ min · ว่าง = default · ผิดรูปแบบ = throw (ตั้งผิดแล้วเงียบ = ได้ค่าที่ไม่ได้ตั้งใจ) */
function intEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  min: number,
): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`${key} must be an integer >= ${min} (got "${raw}")`);
  }
  return n;
}

export function readSealConfig(env: NodeJS.ProcessEnv): SealConfig {
  const d = DEFAULT_SEAL_CONFIG;
  return {
    cron: env.SEAL_CRON?.trim() || d.cron,
    batchSize: intEnv(env, 'SEAL_BATCH_SIZE', d.batchSize, 1),
    minBalanceTx: intEnv(env, 'SEAL_MIN_BALANCE_TX', d.minBalanceTx, 0),
    failureBackoffAfter: intEnv(
      env,
      'SEAL_FAILURE_BACKOFF_AFTER',
      d.failureBackoffAfter,
      0,
    ),
    backoffMaxTicks: intEnv(
      env,
      'SEAL_BACKOFF_MAX_TICKS',
      d.backoffMaxTicks,
      1,
    ),
    lowBalanceAlertMinutes: intEnv(
      env,
      'SEAL_LOW_BALANCE_ALERT_MINUTES',
      d.lowBalanceAlertMinutes,
      1,
    ),
  };
}

/** seal รอบนี้ถูกข้ามโดยตั้งใจ (ไม่ใช่ error) — log ยังค้าง pending อยู่ครบ */
export class SealSkippedError extends Error {
  constructor(
    readonly reason: 'LOW_BALANCE',
    message: string,
  ) {
    super(message);
    this.name = 'SealSkippedError';
  }
}
