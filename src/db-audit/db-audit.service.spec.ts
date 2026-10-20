import { DbAuditService } from './db-audit.service';
import { DbAuditEvent } from './entities/db-audit-event.entity';
import { AlertsService } from '../alerts/alerts.service';
import { Repository } from 'typeorm';

function evt(partial: Partial<DbAuditEvent>): DbAuditEvent {
  return {
    id: '1',
    occurredAt: new Date('2026-10-20T00:00:00Z'),
    eventTag: 'ddl_command_end',
    commandTag: 'ALTER TABLE',
    objectType: 'table',
    objectIdentity: 'public.logs',
    onTable: 'logs',
    kind: 'SCHEMA_CHANGE',
    sessionUserName: 'logchain',
    currentUserName: 'logchain',
    clientAddr: '10.0.0.5',
    applicationName: 'psql',
    query: 'ALTER TABLE logs ...',
    processedAt: null,
    ...partial,
  };
}

describe('DbAuditService.poll', () => {
  let service: DbAuditService;
  let rows: DbAuditEvent[];
  let created: Array<Record<string, unknown>>;
  let saved: DbAuditEvent[];
  let alerts: AlertsService;
  let repo: Repository<DbAuditEvent>;

  function build() {
    created = [];
    saved = [];
    alerts = {
      createOrDedup: jest.fn((input: Record<string, unknown>) => {
        created.push(input);
        return Promise.resolve(input);
      }),
    } as unknown as AlertsService;
    repo = {
      find: jest.fn(() =>
        Promise.resolve(rows.filter((r) => r.processedAt === null)),
      ),
      save: jest.fn((e: DbAuditEvent) => {
        saved.push(e);
        return Promise.resolve(e);
      }),
    } as unknown as Repository<DbAuditEvent>;
    service = new DbAuditService(repo, alerts);
  }

  it('DISABLE_TRIGGER → CRITICAL TRIGGER_DISABLED + mark processed', async () => {
    rows = [evt({ id: '7', kind: 'DISABLE_TRIGGER' })];
    build();
    const n = await service.poll();
    expect(n).toBe(1);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      alertType: 'TRIGGER_DISABLED',
      severity: 'CRITICAL',
      source: 'DB_AUDIT',
      sourceIp: '10.0.0.5',
    });
    expect((created[0].detail as Record<string, unknown>).eventId).toBe('7');
    expect(saved[0].processedAt).toBeInstanceOf(Date);
  });

  it('DROP_TRIGGER → CRITICAL TRIGGER_DISABLED', async () => {
    rows = [evt({ kind: 'DROP_TRIGGER', onTable: 'logs' })];
    build();
    await service.poll();
    expect(created[0]).toMatchObject({
      alertType: 'TRIGGER_DISABLED',
      severity: 'CRITICAL',
    });
    expect(created[0].title).toContain('DROP TRIGGER on logs');
  });

  it('SCHEMA_CHANGE (migration ปกติ) → WARNING SCHEMA_CHANGED', async () => {
    rows = [evt({ kind: 'SCHEMA_CHANGE', commandTag: 'ALTER TABLE' })];
    build();
    await service.poll();
    expect(created[0]).toMatchObject({
      alertType: 'SCHEMA_CHANGED',
      severity: 'WARNING',
    });
  });

  it('ENABLE_TRIGGER → WARNING (ไม่ใช่ CRITICAL)', async () => {
    rows = [evt({ kind: 'ENABLE_TRIGGER' })];
    build();
    await service.poll();
    expect(created[0]).toMatchObject({ severity: 'WARNING' });
  });

  it('null client_addr (unix socket) → sourceIp null, ยังสร้าง alert', async () => {
    rows = [evt({ kind: 'DISABLE_TRIGGER', clientAddr: null })];
    build();
    await service.poll();
    expect(created[0].sourceIp).toBeNull();
    expect(created[0].severity).toBe('CRITICAL');
  });

  it('alert ล้ม → ไม่ mark processed (หยิบใหม่รอบหน้า)', async () => {
    rows = [evt({ kind: 'DISABLE_TRIGGER' })];
    build();
    (alerts.createOrDedup as jest.Mock).mockRejectedValueOnce(
      new Error('smtp down? no — db error'),
    );
    const n = await service.poll();
    expect(n).toBe(0);
    expect(saved).toHaveLength(0);
  });

  it('ไม่มี row ค้าง → ไม่สร้าง alert', async () => {
    rows = [evt({ processedAt: new Date() })];
    build();
    const n = await service.poll();
    expect(n).toBe(0);
    expect(created).toHaveLength(0);
  });
});
