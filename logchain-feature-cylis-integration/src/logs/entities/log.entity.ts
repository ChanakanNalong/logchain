import {
    Entity, PrimaryGeneratedColumn, Column,
    CreateDateColumn, Index,
} from 'typeorm';

@Entity('logs')
export class Log {
    @PrimaryGeneratedColumn('uuid')
    id: string;
    
    @Index()
    @Column({ length: 128 })
    source: string;

    @Column({ name: 'source_id', type: 'inet', nullable: true })
    sourceIp: string | null;

    @Column({ name: 'event_type', length: 64 })
    eventType: string;

    @Index()
    @Column({ length:16, default: 'INFO' })
    severity: string;

    @Column({ type: 'text' })
    message: string;

    @Column({ name: 'raw_hash', type: 'char', length: 64 })
    rawHash: string;

    @Column({ length: 16, default: 'INTERNAL' })
    classification: string;

    @Column({ name: 'retention_days', default: 365 })
    retentionDays: number;

    @Index()
    @Column({ name: 'cde_scope', default: false })
    cdeScope: boolean;

    @Index()
    @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
    createdAt: Date;
}