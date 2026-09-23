import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuditAccess } from '../audit/entities/audit-access.entity';
import { ErasureLog } from './entities/erasure-log.entity';
import * as crypto from 'crypto';

@Injectable()
export class ErasureService {
  private readonly logger = new Logger(ErasureService.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * ลบข้อมูลของ user + บันทึก tombstone ใน transaction เดียว — บันทึกหลักฐานไม่ได้ = ไม่ลบ
   * (เดิมลบก่อนแล้วเขียนไฟล์ทีหลัง ไฟล์เขียนไม่ได้ใน container → ข้อมูลหายแต่ไม่มีหลักฐาน)
   */
  async eraseUser(userId: string, requestedBy: string): Promise<object> {
    return this.dataSource.transaction(async (m) => {
      // ใช้จำนวนที่ลบได้จริง ไม่ใช่ find ก่อนลบ — audit ของ user อาจเพิ่มระหว่างสองคำสั่ง
      const { affected } = await m.delete(AuditAccess, { userId });
      const recordsDeleted = affected ?? 0;
      if (recordsDeleted === 0) {
        throw new NotFoundException(`No records found for userId: ${userId}`);
      }

      // Tombstone = proof of erasure (PDPA compliance evidence)
      const deletedAt = new Date();
      const tombstone = {
        userId,
        requestedBy,
        deletedAt: deletedAt.toISOString(),
        recordsDeleted,
        hash: crypto
          .createHash('sha256')
          .update(userId + deletedAt.toISOString())
          .digest('hex'),
      };
      await m.insert(ErasureLog, { ...tombstone, deletedAt });
      this.logger.log(
        `Deleted ${recordsDeleted} audit records for user ${userId} (tombstone recorded)`,
      );

      return {
        message: 'User data erased successfully',
        tombstone,
      };
    });
  }
}
