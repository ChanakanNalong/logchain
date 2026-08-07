import { Entity, PrimaryColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity('log_batch_mapping')
export class LogBatchMapping {
    // log_id เป็น primary key - log หนึ่งตัวอยู่ได้แค่ batch เดียว
    @PrimaryColumn({ name: 'log_id', type: 'uuid' })
    logId: string;

    @Index()
    @Column({ name: 'batch_id', type: 'uuid' })
    batchId: string;
    
    @CreateDateColumn({ name: 'mapped_at', type: 'timestamptz' })
    mappedAt: Date;
}