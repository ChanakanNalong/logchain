import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditAccess } from '../audit/entities/audit-access.entity';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class ErasureService {
  private readonly logger = new Logger(ErasureService.name);
  private readonly logPath = path.join(process.cwd(), 'erasure-log.json');

  constructor(
    @InjectRepository(AuditAccess)
    private auditRepo: Repository<AuditAccess>,
  ) {}

  async eraseUser(userId: string, requestedBy: string): Promise<object> {
    const auditRecords = await this.auditRepo.find({ where: { userId } });
    if (auditRecords.length === 0) {
      throw new NotFoundException(`No records found for userId: ${userId}`);
    }

    await this.auditRepo.delete({ userId });
    this.logger.log(`Deleted ${auditRecords.length} audit records for user ${userId}`);

    // Tombstone = proof of erasure (PDPA compliance evidence)
    const deletedAt = new Date().toISOString();
    const tombstone = {
      userId,
      requestedBy,
      deletedAt,
      recordsDeleted: auditRecords.length,
      hash: crypto.createHash('sha256').update(userId + deletedAt).digest('hex'),
    };
    this.appendErasureLog(tombstone);

    return {
      message: 'User data erased successfully',
      tombstone,
    };
  }

  private appendErasureLog(entry: object) {
    let logs: object[] = [];
    if (fs.existsSync(this.logPath)) {
      try {
        logs = JSON.parse(fs.readFileSync(this.logPath, 'utf-8'));
      } catch {
        // ไฟล์เสีย — เริ่มใหม่ (ไม่ throw เพราะ erasure สำเร็จแล้ว)
      }
    }
    logs.push(entry);
    fs.writeFileSync(this.logPath, JSON.stringify(logs, null, 2));
  }
}
