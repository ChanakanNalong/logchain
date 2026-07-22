import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { Batch } from '../logs/entities/batch.entity';
import { Log } from '../logs/entities/log.entity';
import { AuditAccess } from '../audit/entities/audit-access.entity';

@Injectable()
export class ComplianceService {
  private readonly erasureLogPath = path.join(process.cwd(), 'erasure-log.json');

  constructor(
    @InjectRepository(Batch) private batchesRepo: Repository<Batch>,
    @InjectRepository(Log) private logsRepo: Repository<Log>,
    @InjectRepository(AuditAccess) private auditRepo: Repository<AuditAccess>,
  ) {}

  async getReports() {
    const [batchIntegrity, erasureLog, auditSummary, retentionStatus] = await Promise.all([
      this.getBatchIntegrity(),
      this.getErasureLog(),
      this.getAuditSummary(),
      this.getRetentionStatus(),
    ]);
    return { batchIntegrity, erasureLog, auditSummary, retentionStatus };
  }

  private async getBatchIntegrity() {
    const rows = await this.batchesRepo
      .createQueryBuilder('batch')
      .select('batch.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('batch.status')
      .getRawMany();

    const result: Record<string, number> = { CONFIRMED: 0, UNVERIFIED: 0, TAMPERED: 0, PENDING: 0 };
    for (const row of rows) {
      result[row.status] = parseInt(row.count, 10);
    }
    return result;
  }

  private getErasureLog() {
    if (!fs.existsSync(this.erasureLogPath)) return [];
    const raw = fs.readFileSync(this.erasureLogPath, 'utf-8');
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  private async getAuditSummary() {
    const total = await this.auditRepo.count();
    const rows = await this.auditRepo
      .createQueryBuilder('audit')
      .select('audit.action', 'action')
      .addSelect('COUNT(*)', 'count')
      .groupBy('audit.action')
      .getRawMany();

    const byAction: Record<string, number> = {};
    for (const row of rows) {
      byAction[row.action] = parseInt(row.count, 10);
    }
    return { totalAccessEvents: total, byAction };
  }

  private async getRetentionStatus() {
    const count = await this.logsRepo
      .createQueryBuilder('log')
      .where("log.created_at + (log.retention_days || ' days')::interval < NOW() + interval '30 days'")
      .getCount();
    return { logsNearingExpiry: count };
  }
}
