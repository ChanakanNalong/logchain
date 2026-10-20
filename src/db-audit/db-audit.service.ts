import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { DbAuditEvent } from './entities/db-audit-event.entity';
import { AlertsService } from '../alerts/alerts.service';

/** kind ที่ถือเป็นการพยายามปิดการป้องกัน → CRITICAL */
const CRITICAL_KINDS = new Set(['DISABLE_TRIGGER', 'DROP_TRIGGER']);

@Injectable()
export class DbAuditService {
  private readonly logger = new Logger(DbAuditService.name);

  constructor(
    @InjectRepository(DbAuditEvent)
    private readonly repo: Repository<DbAuditEvent>,
    private readonly alerts: AlertsService,
  ) {}

  /**
   * อ่าน db_audit_events ที่ยังไม่ได้ทำ alert → สร้าง alert แล้ว set processed_at
   * - DISABLE_TRIGGER / DROP_TRIGGER → CRITICAL TRIGGER_DISABLED
   * - อื่น ๆ (ENABLE_TRIGGER / SCHEMA_CHANGE เช่น migration ปกติ) → WARNING SCHEMA_CHANGED
   *
   * dedup ของ AlertsService รวม event ซ้ำจาก source/IP เดียวกันเป็น alert OPEN เดียว (occurrenceCount++)
   * mark processed หลังสร้าง alert สำเร็จเท่านั้น — ถ้าพลาดจะถูกหยิบใหม่รอบหน้า
   */
  async poll(): Promise<number> {
    const rows = await this.repo.find({
      where: { processedAt: IsNull() },
      order: { id: 'ASC' },
      take: 200,
    });
    let done = 0;
    for (const e of rows) {
      try {
        const critical = CRITICAL_KINDS.has(e.kind);
        await this.alerts.createOrDedup({
          alertType: critical ? 'TRIGGER_DISABLED' : 'SCHEMA_CHANGED',
          severity: critical ? 'CRITICAL' : 'WARNING',
          source: 'DB_AUDIT',
          sourceIp: e.clientAddr ?? null,
          title: critical
            ? `${e.kind === 'DROP_TRIGGER' ? 'DROP' : 'DISABLE'} TRIGGER on ${e.onTable}`
            : `Schema change on ${e.onTable} (${e.commandTag ?? e.kind})`,
          detail: {
            eventId: e.id,
            kind: e.kind,
            onTable: e.onTable,
            commandTag: e.commandTag,
            objectIdentity: e.objectIdentity,
            sessionUser: e.sessionUserName,
            currentUser: e.currentUserName,
            clientAddr: e.clientAddr,
            applicationName: e.applicationName,
            occurredAt: e.occurredAt,
            query: e.query,
          },
        });
        e.processedAt = new Date();
        await this.repo.save(e);
        done += 1;
        if (critical) {
          this.logger.error(
            `DDL audit: ${e.kind} on ${e.onTable} by ${e.sessionUserName}` +
              `${e.clientAddr ? ` from ${e.clientAddr}` : ''}`,
          );
        }
      } catch (err) {
        this.logger.error(`Failed to raise alert for audit event ${e.id}`, err);
      }
    }
    return done;
  }
}
