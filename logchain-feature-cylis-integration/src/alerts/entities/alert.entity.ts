import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity('alerts')
export class Alert {
    @PrimaryGeneratedColumn('uuid') id: string;
    @Column({ name: 'log_id', type: 'uuid', nullable: true }) logId: string | null;
    @Column({ name: 'batch_id', type: 'uuid', nullable: true }) batchId: string | null;
    @Column({ name: 'alert_type', length: 64 }) alertType: string;
    @Index() @Column({ length: 16 }) severity: string;

    @Column({ length: 32 }) source: string;
    @Column({ type: 'text' }) title: string;
    @Column({ type: 'jsonb', nullable: true }) detail: object | null;
    @Index() @Column({ default: 'OPEN' }) status: string;
    @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
}