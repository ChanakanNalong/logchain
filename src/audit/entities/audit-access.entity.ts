import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity('audit_access')
export class AuditAccess {
    @PrimaryGeneratedColumn('uuid') id: string;
    @Index() @Column({ name: 'user_id', length: 128 }) userId: string;
    @Column({ length: 128, nullable: true, type: 'varchar' }) username: string | null;
    @Column({ length: 64, type: 'varchar' }) action: string;
    @Column({ length: 256, type: 'varchar' }) resource: string;
    @Column({ name: 'status_code', nullable: true, type: 'int' }) statusCode: number | null;
    @Column({ name: 'ip_address', type: 'inet', nullable: true }) ipAddress: string | null;
    @Column({ name: 'duration_ms', nullable: true, type: 'int' }) durationMs: number | null;
    @Index()
    @CreateDateColumn({ name: 'accessed_at', type: 'timestamptz' }) accessedAt: Date;
}
