import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** tombstone ของคำขอลบข้อมูลตาม PDPA — append-only (trigger ใน migration ErasureLog) */
@Entity('erasure_log')
export class ErasureLog {
  @PrimaryGeneratedColumn('uuid') id: string;

  @Column({ name: 'user_id', length: 128 }) userId: string;

  @Column({ name: 'requested_by', length: 128 }) requestedBy: string;

  @Column({ name: 'deleted_at', type: 'timestamptz' }) deletedAt: Date;

  @Column({ name: 'records_deleted', type: 'int' }) recordsDeleted: number;

  @Column({ type: 'char', length: 64 }) hash: string;
}
