import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Alert } from '../alerts/entities/alert.entity';
import { AuditAccess } from '../audit/entities/audit-access.entity';

// PCI DSS 10.5.1 — audit trail ต้องเก็บอย่างน้อย 12 เดือน ตั้ง RETENTION_DAYS ต่ำกว่านี้ได้แต่ไม่มีผลกับ audit_access
// (เดิม default 90 และใช้ค่าเดียวกันทั้งสองตาราง — audit ถูกลบตั้งแต่เดือนที่ 3 ขณะที่เอกสารบอก 365 วัน)
const AUDIT_MIN_RETENTION_DAYS = 365;

export function retentionDays(raw = process.env.RETENTION_DAYS) {
  const alerts = Number(raw ?? 365);
  return { alerts, audit: Math.max(alerts, AUDIT_MIN_RETENTION_DAYS) };
}

const RETENTION = retentionDays();

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
    cutoff.setDate(cutoff.getDate() - RETENTION.alerts);
    const auditCutoff = new Date();
    auditCutoff.setDate(auditCutoff.getDate() - RETENTION.audit);
    this.logger.log(
      `Running retention: alerts before ${cutoff.toISOString()} · audit before ${auditCutoff.toISOString()}`,
    );

    const deletedAlerts = await this.alertRepo.delete({
      createdAt: LessThan(cutoff),
    });
    this.logger.log(`Deleted ${deletedAlerts.affected} old alerts`);

    const deletedAudit = await this.auditRepo.delete({
      accessedAt: LessThan(auditCutoff),
    });
    this.logger.log(`Deleted ${deletedAudit.affected} old audit records`);
  }
}
