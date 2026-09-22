import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

@Entity('batches')
export class Batch {
  @PrimaryGeneratedColumn('uuid') id: string;

  @Column({ name: 'merkle_root', type: 'char', length: 64 })
  merkleRoot: string;

  @Column({ name: 'log_count' })
  logCount: number;

  @Column({ name: 'tx_hash', length: 128, nullable: true })
  txHash: string;

  @Column({ name: 'block_number', type: 'bigint', nullable: true })
  blockNumber: number | null;

  @Column({ default: 'PENDING' })
  status: string;

  @CreateDateColumn({ name: 'sealed_at', type: 'timestamptz' })
  sealedAt: Date;

  @Column({ name: 'confirmed_at', type: 'timestamptz', nullable: true })
  confirmedAt: Date | null;
}

/**
 * สถานะที่ถือว่า "ข้อมูลยังไม่ถูกแก้" สำหรับคิด integrityRate — ใช้ร่วมกันทั้ง
 * stats (Dashboard) และ compliance (Reports) เพื่อให้สองหน้าคิดสูตรเดียวกันเสมอ
 * เพิ่มสถานะใหม่เมื่อไหร่ต้องแก้ที่นี่ที่เดียว
 *
 * SEALED = ปิด batch แล้วแต่ยังไม่ได้ anchor (ไม่ได้ตั้ง blockchain) ซึ่งผ่านการตรวจ
 * แบบ local ทุกนาทีอยู่แล้ว — ถ้ามีอะไรถูกแก้จะกลายเป็น TAMPERED ไปก่อน
 * ไม่นับรวมจะทำให้ deployment ที่ไม่ได้ต่อ chain ขึ้น "integrity 0%" คู่กับ
 * "0 tampered" ซึ่งขัดกันเอง
 *
 * อย่าเอา SEALED ไปรวมใน `confirmed` — confirmed แปลว่า "anchor ขึ้น chain แล้ว" เท่านั้น
 */
export const INTACT_STATUSES = ['CONFIRMED', 'SEALED'] as const;
