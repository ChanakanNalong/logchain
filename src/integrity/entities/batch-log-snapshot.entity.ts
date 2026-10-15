import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import type { RawHashCanonical } from '../../logs/services/log-hash';

/** log ตอน seal (migration BatchLogSnapshot1790812800000) — write-only, log_id ไม่มี FK โดยตั้งใจ */
@Entity('batch_log_snapshot')
export class BatchLogSnapshot {
  @PrimaryColumn({ name: 'batch_id', type: 'uuid' })
  batchId: string;

  @PrimaryColumn({ name: 'log_id', type: 'uuid' })
  logId: string;

  /** ลำดับ leaf ใน Merkle tree (0-based) */
  @Column({ type: 'int' })
  position: number;

  @Column({ type: 'jsonb' })
  snapshot: RawHashCanonical;

  @Column({ name: 'raw_hash', type: 'char', length: 64 })
  rawHash: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
