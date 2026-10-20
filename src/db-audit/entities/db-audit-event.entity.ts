import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

/**
 * แถวที่ event trigger (DbDdlAudit migration) เขียนเมื่อมี DDL บนตารางหลักฐาน
 * backend อ่านเพื่อสร้าง alert แล้ว set processed_at — เขียนโดย DB เท่านั้น (ฝั่งแอปอ่าน/อัปเดต processed)
 */
@Entity('db_audit_events')
export class DbAuditEvent {
  @PrimaryGeneratedColumn({ type: 'bigint' }) id: string;

  @Column({ name: 'occurred_at', type: 'timestamptz' }) occurredAt: Date;
  @Column({ name: 'event_tag', type: 'text' }) eventTag: string;
  @Column({ name: 'command_tag', type: 'text', nullable: true })
  commandTag: string | null;
  @Column({ name: 'object_type', type: 'text', nullable: true })
  objectType: string | null;
  @Column({ name: 'object_identity', type: 'text', nullable: true })
  objectIdentity: string | null;
  @Column({ name: 'on_table', type: 'text', nullable: true })
  onTable: string | null;

  /** DISABLE_TRIGGER | DROP_TRIGGER | ENABLE_TRIGGER | SCHEMA_CHANGE */
  @Column({ type: 'text' }) kind: string;

  @Column({ name: 'session_user_name', type: 'text', nullable: true })
  sessionUserName: string | null;
  @Column({ name: 'current_user_name', type: 'text', nullable: true })
  currentUserName: string | null;
  @Column({ name: 'client_addr', type: 'inet', nullable: true })
  clientAddr: string | null;
  @Column({ name: 'application_name', type: 'text', nullable: true })
  applicationName: string | null;
  @Column({ type: 'text', nullable: true }) query: string | null;

  /** null = ยังไม่ได้สร้าง alert · poll set เมื่อทำเสร็จ */
  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt: Date | null;
}
