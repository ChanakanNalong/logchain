import { CronExpression } from '@nestjs/schedule';
import { Logger } from '@nestjs/common';

const logger = new Logger('SealConfig');

/** โหมดของตัวสั่ง seal · cron = ตาม SEAL_CRON เหมือนเดิม · hybrid = เช็คทุก 1 นาที (count|age) */
export type SealMode = 'cron' | 'hybrid';

/**
 * ค่าตั้งของรอบ seal — อ่านจาก env ครั้งเดียวตอนสร้าง service
 *
 * ค่า default = พฤติกรรมเดิม: seal ทุก 1 นาที ทีละไม่เกิน 100 log · guard ยอดเงินปิดอยู่
 * ต่างจากเดิมแค่ 2 อย่าง (ทั้งคู่มีผลเฉพาะตอนผิดปกติ):
 *   - log ค้างเกิน batch size → รอบเดียวปิดหลาย batch จนหมด (เดิมปิดได้นาทีละ 100 แล้วค้างสะสม)
 *   - seal ล้มติดกัน SEAL_FAILURE_BACKOFF_AFTER ครั้ง → ข้ามรอบแบบ exponential
 *     (เดิมสร้าง batch FAILED ใบใหม่ทุกนาที — พายุ 2026-10-08 ราว 1,161 ใบใน 19 ชม.)
 *
 * SEAL_MODE=hybrid เปลี่ยนตัวสั่ง seal จาก cron รายเวลา เป็นตัวเช็คทุก 1 นาที ที่ตัดสินจาก
 * "มี log ค้างครบ batchSize" (count) หรือ "log ที่เก่าสุดค้างนานเกิน maxWaitMinutes" (age)
 * อย่างไหนถึงก่อน · ตรรกะการตัดสินอยู่ใน decideSeal() (pure — unit test ได้)
 */
export interface SealConfig {
  /** โหมดตัวสั่ง seal · default cron (เหมือนเดิม) */
  mode: SealMode;
  /** cron expression ของรอบ seal (6 ช่องมีวินาที หรือ 5 ช่องก็ได้) — ใช้เฉพาะ mode=cron */
  cron: string;
  /** log ค้างเก่าสุดเกินกี่นาที → seal ทั้งหมด (age trigger) — ใช้เฉพาะ mode=hybrid */
  maxWaitMinutes: number;
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
  mode: 'cron',
  cron: CronExpression.EVERY_MINUTE,
  maxWaitMinutes: 60,
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

/** SEAL_MODE · ค่าไม่ถูกต้อง = fallback cron + warn (ห้ามทำ boot ล้ม — ต่างจาก int ที่ throw) */
function modeEnv(env: NodeJS.ProcessEnv, fallback: SealMode): SealMode {
  const raw = env.SEAL_MODE?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'cron' || raw === 'hybrid') return raw;
  logger.warn(
    `SEAL_MODE="${env.SEAL_MODE}" ไม่ถูกต้อง (ต้องเป็น cron|hybrid) — ใช้ "${fallback}" แทน`,
  );
  return fallback;
}

export function readSealConfig(env: NodeJS.ProcessEnv): SealConfig {
  const d = DEFAULT_SEAL_CONFIG;
  return {
    mode: modeEnv(env, d.mode),
    cron: env.SEAL_CRON?.trim() || d.cron,
    maxWaitMinutes: intEnv(env, 'SEAL_MAX_WAIT_MINUTES', d.maxWaitMinutes, 1),
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

/** เหตุผลที่ hybrid สั่ง seal (ใช้ใน log + เก็บลง batches.seal_reason) */
export type SealTrigger = 'count' | 'age';
/** เหตุผลของการ seal ที่เก็บลง batches.seal_reason · null = batch ก่อนมีคอลัมน์นี้ */
export type SealReason = SealTrigger | 'manual' | 'cron';
/** เหตุผลที่ข้ามรอบ hybrid */
export type SealSkipReason = 'idle' | 'in_flight' | 'backoff';

export interface SealDecisionInput {
  /** จำนวน log ที่ยังไม่ถูก map เข้า batch */
  pendingCount: number;
  /** อายุของ log ที่ค้างเก่าสุด (นาที) · null = ไม่มี log ค้าง · มาจาก SQL (นาฬิกา DB) */
  oldestAgeMinutes: number | null;
  /** รอบ drain ก่อนหน้ายังทำงานอยู่ (drainInFlight) */
  inFlight: boolean;
  /** รอบที่ต้องข้ามที่เหลือจาก backoff หลัง seal ล้มติดกัน */
  backoffTicksLeft: number;
  batchSize: number;
  maxWaitMinutes: number;
}

export type SealDecision =
  | { seal: true; trigger: SealTrigger; drainAll: boolean }
  | { seal: false; skip: SealSkipReason };

/**
 * ตัดสินใจของตัวเช็ค hybrid ทุก 1 นาที — pure function ไม่มี I/O (unit test ได้ตรง ๆ)
 *
 * ลำดับการตัดสิน:
 *   1. กำลัง drain อยู่ → ข้าม (in_flight) — คิว seal กันซ้อนอยู่แล้ว แต่ไม่ต้องเริ่มรอบใหม่
 *   2. ติด backoff จาก seal ล้ม → ข้าม (backoff) — ตัวเรียกเป็นคนลด backoffTicksLeft
 *   3. ไม่มี log ค้าง → ข้าม (idle)
 *   4. log เก่าสุดค้าง ≥ maxWaitMinutes → seal "ทั้งหมด" (age) — มาก่อน count เพราะ
 *      ของเก่าถึงกำหนดแล้ว เท batch สุดท้ายที่ไม่เต็มด้วย (ครอบ batch เต็มอยู่ในตัว)
 *   5. ค้าง ≥ batchSize → seal "เฉพาะ batch เต็ม" (count) เหลือเศษ < batchSize ไว้รอ age
 *   6. อื่น ๆ → ข้าม (idle)
 */
export function decideSeal(i: SealDecisionInput): SealDecision {
  if (i.inFlight) return { seal: false, skip: 'in_flight' };
  if (i.backoffTicksLeft > 0) return { seal: false, skip: 'backoff' };
  if (i.pendingCount <= 0) return { seal: false, skip: 'idle' };
  if (i.oldestAgeMinutes != null && i.oldestAgeMinutes >= i.maxWaitMinutes) {
    return { seal: true, trigger: 'age', drainAll: true };
  }
  if (i.pendingCount >= i.batchSize) {
    return { seal: true, trigger: 'count', drainAll: false };
  }
  return { seal: false, skip: 'idle' };
}
