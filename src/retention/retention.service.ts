import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Alert } from '../alerts/entities/alert.entity';
import { AuditAccess } from '../audit/entities/audit-access.entity';

const RETENTION_DAYS = Number(process.env.RETENTION_DAYS ?? 90);

@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    @InjectRepository(Alert)
    private alertRepo: Repository<Alert>,
    @InjectRepository(AuditAccess)
    private auditRepo: Repository<AuditAccess>,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async runRetention() {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
    this.logger.log(`Running retention: deleting records before ${cutoff.toISOString()}`);

    const deletedAlerts = await this.alertRepo.delete({
      createdAt: LessThan(cutoff),
    });
    this.logger.log(`Deleted ${deletedAlerts.affected} old alerts`);

    const deletedAudit = await this.auditRepo.delete({
      accessedAt: LessThan(cutoff),
    });
    this.logger.log(`Deleted ${deletedAudit.affected} old audit records`);
  }
}
