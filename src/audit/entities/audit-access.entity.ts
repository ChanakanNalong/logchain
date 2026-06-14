import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity('audit_access')
export class AuditAccess {
    @PrimaryGeneratedColumn('uuid') id: string;
    @Index() @Column({ name: 'user_id', length: 128 }) userId: string;
    @Column({ type: 'varchar', length: 128, nullable: true }) username: string | null;

    @Column({ length: 64 }) action: string;
    @Column({ length: 256 }) resource: string;
    @Column({ type: 'varchar', length: 8, nullable: true }) method: string | null;
    @Column({ name: 'status_code', type: 'int', nullable: true }) statusCode: number | null;
    @Column({ name: 'ip_address', type: 'inet', nullable: true }) ipAddress: string | null;
    @Column({ name: 'duration_ms', type: 'int', nullable: true }) durationMs: number | null;
    @Index()
    @CreateDateColumn({ name: 'accessed_at', type: 'timestamptz' }) accessedAt: Date;
}
