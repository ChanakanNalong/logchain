import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';
import { SOURCE_MAX_LENGTH } from '../../logs/dto/create-log.dto';

/**
 * ความยาวของคอลัมน์ varchar ที่รับค่าจากภายนอก (detection ผ่าน Kafka / POST /alerts)
 * AlertsService ตัดค่าที่ยาวเกินตามนี้ก่อน INSERT — ต้องตรงกับ DB
 * (infra/postgres/init/02-schema.sql + migrations)
 */
export const ALERT_COLUMN_LENGTH = {
  alertType: 64,
  severity: 16,
  source: SOURCE_MAX_LENGTH,
  ruleId: 32,
} as const;

@Entity('alerts')
export class Alert {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ name: 'log_id', type: 'uuid', nullable: true }) logId:
    | string
    | null;
  @Column({ name: 'batch_id', type: 'uuid', nullable: true }) batchId:
    | string
    | null;
  @Column({ name: 'alert_type', length: ALERT_COLUMN_LENGTH.alertType })
  alertType: string;
  @Index() @Column({ length: ALERT_COLUMN_LENGTH.severity }) severity: string;

  @Column({ length: ALERT_COLUMN_LENGTH.source }) source: string;
  @Column({ type: 'text' }) title: string;
  @Column({ type: 'jsonb', nullable: true }) detail: object | null;
  @Index() @Column({ default: 'OPEN' }) status: string;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  /**
   * rule ที่จับได้ (RULE_MATCH) — ส่วนหนึ่งของ dedup key ไม่งั้น alert ที่ค้าง OPEN
   * ของ host หนึ่งจะกลืนทุก rule อื่นบน host เดียวกัน (ดู AlertsRuleDedup migration)
   * null = alert ที่ไม่มี rule (ML_ANOMALY, INTEGRITY_TAMPERED)
   */
  @Column({
    name: 'rule_id',
    type: 'varchar',
    length: ALERT_COLUMN_LENGTH.ruleId,
    nullable: true,
  })
  ruleId: string | null;

  /** เกิดซ้ำกี่ครั้งระหว่างที่ alert นี้ยัง OPEN (รวมครั้งแรก) */
  @Column({ name: 'occurrence_count', type: 'int', default: 1 })
  occurrenceCount: number;

  /** ครั้งล่าสุดที่เกิด — createdAt คือครั้งแรก */
  @Column({ name: 'last_seen_at', type: 'timestamptz', default: () => 'now()' })
  lastSeenAt: Date;

  /** ส่ง email ครั้งล่าสุดเมื่อไร — null = ยังไม่เคย (severity ไม่ถึงเกณฑ์) */
  @Column({ name: 'last_notified_at', type: 'timestamptz', nullable: true })
  lastNotifiedAt: Date | null;
}
