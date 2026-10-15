import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

/** log นี้เกี่ยวกับ alert ยังไง — ลำดับนี้คือลำดับความสำคัญด้วย (ตัวแรกที่ผูกชนะ) */
export const ALERT_LOG_ROLES = [
  'trigger',
  'window',
  'prior',
  'repeat',
] as const;
export type AlertLogRole = (typeof ALERT_LOG_ROLES)[number];

/** alert ↔ log หลายตัว (migration AlertLogs1790726400000) — ไม่มี append-only trigger โดยตั้งใจ */
@Entity('alert_logs')
export class AlertLog {
  @PrimaryColumn({ name: 'alert_id', type: 'uuid' })
  alertId: string;

  @Index()
  @PrimaryColumn({ name: 'log_id', type: 'uuid' })
  logId: string;

  @Column({ type: 'varchar', length: 16 })
  role: AlertLogRole;

  @CreateDateColumn({ name: 'added_at', type: 'timestamptz' })
  addedAt: Date;
}
