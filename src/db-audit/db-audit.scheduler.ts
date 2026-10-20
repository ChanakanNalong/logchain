import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DbAuditService } from './db-audit.service';

@Injectable()
export class DbAuditScheduler {
  private readonly logger = new Logger(DbAuditScheduler.name);

  constructor(private readonly dbAudit: DbAuditService) {}

  // ตรวจ db_audit_events ทุก 1 นาที → alert DDL บนตารางหลักฐาน (DISABLE/DROP TRIGGER = CRITICAL)
  @Cron(CronExpression.EVERY_MINUTE)
  async handle(): Promise<void> {
    try {
      await this.dbAudit.poll();
    } catch (err) {
      this.logger.error('DB audit poll failed', err);
    }
  }
}
