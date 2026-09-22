import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('alerts')
export class Alert {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ name: 'log_id', type: 'uuid', nullable: true }) logId:
    | string
    | null;
  @Column({ name: 'batch_id', type: 'uuid', nullable: true }) batchId:
    | string
    | null;
  @Column({ name: 'alert_type', length: 64 }) alertType: string;
  @Index() @Column({ length: 16 }) severity: string;

  @Column({ length: 32 }) source: string;
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
  @Column({ name: 'rule_id', type: 'varchar', length: 32, nullable: true })
  ruleId: string | null;

  /** เกิดซ้ำกี่ครั้งระหว่างที่ alert นี้ยัง OPEN (รวมครั้งแรก) */
  @Column({ name: 'occurrence_count', type: 'int', default: 1 })
  occurrenceCount: number;

  /** ครั้งล่าสุดที่เกิด — createdAt คือครั้งแรก */
  @Column({ name: 'last_seen_at', type: 'timestamptz', default: () => 'now()' })
  lastSeenAt: Date;
}
