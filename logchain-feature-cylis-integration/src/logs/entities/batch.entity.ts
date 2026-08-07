import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('batches')
export class Batch {
    @PrimaryGeneratedColumn('uuid') id: string;

    @Column({ name: 'merkle_root', type: 'char', length: 64 })
    merkleRoot: string;

    @Column({ name: 'log_count' })
    logCount: number;

    @Column({ name: 'tx_hash', length: 128, nullable: true })
    txHash: string;

    @Column({ name : 'block_number', type: 'bigint', nullable: true })
    blockNumber: number | null;

    @Column({ default: 'PENDING' })
    status: string;

    @CreateDateColumn({ name: 'sealed_at', type: 'timestamptz' })
    sealedAt: Date;

    @Column({ name: 'confirmed_at', type: 'timestamptz', nullable: true })
    confirmedAt: Date | null;
}