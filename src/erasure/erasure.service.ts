import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditAccess } from '../audit/entities/audit-access.entity';
import { Alert } from '../alerts/entities/alert.entity';
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
    @InjectRepository(Alert)
    private alertRepo: Repository<Alert>,
  ) {}

  async eraseUser(userId: string, requestedBy: string): Promise<object> {
    const auditRecords = await this.auditRepo.find({ where: { userId } });
    if (auditRecords.length === 0) {
      throw new NotFoundException('No records found for userId: ' + userId);
    }

    await this.auditRepo.delete({ userId });
    this.logger.log('Deleted ' + auditRecords.length + ' audit records for user ' + userId);

    const tombstone = {
      userId,
      requestedBy,
      deletedAt: new Date().toISOString(),
      recordsDeleted: auditRecords.length,
      hash: crypto.createHash('sha256').update(userId + new Date().toISOString()).digest('hex'),
    };

    this.appendErasureLog(tombstone);

    return {
      message: 'User data erased successfully',
      tombstone,
    };
  }

  private appendErasureLog(entry: object) {
    let logs = [];
    if (fs.existsSync(this.logPath)) {
      try { logs = JSON.parse(fs.readFileSync(this.logPath, 'utf-8')); } catch {}
    }
    logs.push(entry);
    fs.writeFileSync(this.logPath, JSON.stringify(logs, null, 2));
  }
}