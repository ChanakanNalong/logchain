import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DbAuditEvent } from './entities/db-audit-event.entity';
import { DbAuditService } from './db-audit.service';
import { DbAuditScheduler } from './db-audit.scheduler';
import { AlertsModule } from '../alerts/alerts.module';

/**
 * เฝ้า db_audit_events (เขียนโดย event trigger — DbDdlAudit migration) แล้วแปลงเป็น alert
 * DISABLE/DROP TRIGGER บนตารางหลักฐาน = CRITICAL · DDL อื่น = WARNING
 */
@Module({
  imports: [TypeOrmModule.forFeature([DbAuditEvent]), AlertsModule],
  providers: [DbAuditService, DbAuditScheduler],
  exports: [DbAuditService],
})
export class DbAuditModule {}
