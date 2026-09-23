import { Entity, PrimaryColumn, Column, CreateDateColumn } from 'typeorm';
import type { LogEvent } from '../kafka-producer.service';

/**
 * คิวของ log ที่ยังไม่ได้ส่งขึ้น `logs.raw` (outbox)
 *
 * ทำไมต้องมีตารางแยก: ตาราง `logs` ถูก trigger `trg_logs_no_update` ล็อกไว้ห้าม UPDATE
 * จึงทำ flag "ส่งแล้ว/ยังไม่ส่ง" บนแถว log เองไม่ได้
 *
 * เก็บ payload ทั้งก้อนไว้เลย ไม่ใช่แค่ log_id — ตอน replay จะได้ event ที่เหมือนตอนแรกเป๊ะ
 * (โดยเฉพาะ createdAt ซึ่ง rule แบบ threshold ฝั่ง detection ใช้ตัดสินหน้าต่างเวลา)
 */
@Entity('kafka_pending_logs')
export class PendingLog {
  @PrimaryColumn({ name: 'log_id', type: 'uuid' })
  logId: string;

  @Column({ type: 'jsonb' })
  payload: LogEvent;

  /** เข้าคิวเมื่อไร — replay เรียงตามนี้เพื่อคงลำดับเดิมของ log */
  @CreateDateColumn({ name: 'queued_at', type: 'timestamptz' })
  queuedAt: Date;
}
