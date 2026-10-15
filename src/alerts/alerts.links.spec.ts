import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { IsNull, FindOperator } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { AlertsService } from './alerts.service';
import { Alert } from './entities/alert.entity';
import { NotificationService } from '../notification/notification.service';

/**
 * alerts.source_ip ใน dedup key + alert_logs (trigger / window / prior / repeat)
 * repo เป็น store ในหน่วยความจำ — findOne ตอบตาม where จริง (รวม IsNull) และ query() จด SQL ไว้ตรวจ
 */

const LOG = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const IP_A = '203.0.113.5';
const IP_B = '198.51.100.9';

type Where = Record<string, unknown>;

function matches(row: Alert, where: Where): boolean {
  return Object.entries(where).every(([k, v]) => {
    const actual = (row as unknown as Record<string, unknown>)[k];
    if (v instanceof FindOperator) {
      return v.type === 'isNull'
        ? actual === null || actual === undefined
        : false;
    }
    return actual === v;
  });
}

describe('AlertsService — source IP dedup + alert_logs', () => {
  let service: AlertsService;
  let store: Alert[];
  let queries: Array<{ sql: string; params: unknown[] }>;
  let queryImpl: (sql: string, params: unknown[]) => Promise<unknown>;

  beforeEach(async () => {
    store = [];
    queries = [];
    queryImpl = () => Promise.resolve([]);
    let seq = 0;
    const repo = {
      findOne: jest.fn(({ where }: { where: Where }) =>
        Promise.resolve(store.find((a) => matches(a, where)) ?? null),
      ),
      create: jest.fn((dto: Partial<Alert>) => ({ ...dto }) as Alert),
      save: jest.fn((a: Alert) => {
        a.id = a.id ?? `alert-${seq++}`;
        store.push(a);
        return Promise.resolve(a);
      }),
      query: jest.fn((sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        return queryImpl(sql, params);
      }),
      // recordRepeat: UPDATE ... RETURNING
      createQueryBuilder: jest.fn(() => {
        const qb = {
          update: () => qb,
          set: () => qb,
          where: () => qb,
          setParameters: () => qb,
          returning: () => qb,
          execute: () =>
            Promise.resolve({
              raw: [
                {
                  occurrence_count: 2,
                  last_seen_at: new Date().toISOString(),
                  severity: 'CRITICAL',
                  last_notified_at: null,
                  notify_now: false,
                },
              ],
            }),
        };
        return qb;
      }),
    };

    const module = await Test.createTestingModule({
      providers: [
        AlertsService,
        { provide: getRepositoryToken(Alert), useValue: repo },
        {
          provide: NotificationService,
          useValue: { sendAlertEmail: jest.fn(() => Promise.resolve()) },
        },
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    }).compile();
    service = module.get(AlertsService);
  });

  const bruteForce = (ip: string | null, logId: string): Partial<Alert> => ({
    logId,
    alertType: 'RULE_MATCH',
    severity: 'CRITICAL',
    source: 'vps-01',
    sourceIp: ip,
    title: 'Multiple authentication failures (brute force)',
    detail: { rule_id: 5710 },
  });

  /** INSERT alert_logs ที่ยิงไป: [alertId, ids, roles] */
  const linkCalls = () =>
    queries
      .filter((q) => q.sql.includes('INSERT INTO alert_logs'))
      .map((q) => ({
        alertId: q.params[0],
        ids: q.params[1] as string[],
        roles: q.params[2] as string[],
      }));

  it('5710 from two IPs on the same source are two alerts', async () => {
    await service.createOrDedup(bruteForce(IP_A, LOG(1)));
    await service.createOrDedup(bruteForce(IP_B, LOG(2)));
    await service.createOrDedup(bruteForce(IP_A, LOG(3))); // ซ้ำของ A

    expect(store.map((a) => a.sourceIp)).toEqual([IP_A, IP_B]);
  });

  it('dedup key includes sourceIp (IsNull when missing)', async () => {
    const spy = jest.spyOn(
      (service as unknown as { alertRepo: { findOne: jest.Mock } }).alertRepo,
      'findOne',
    );
    await service.createOrDedup(bruteForce(null, LOG(1)));
    await service.createOrDedup(bruteForce(IP_A, LOG(2)));

    const wheres = spy.mock.calls.map((c) => (c[0] as { where: Where }).where);
    expect(wheres[0].sourceIp).toEqual(IsNull());
    expect(wheres[1].sourceIp).toBe(IP_A);
  });

  it('an invalid sourceIp is stored as null instead of failing the insert', async () => {
    const a = await service.createOrDedup(bruteForce('not-an-ip', LOG(1)));
    expect(a.sourceIp).toBeNull();
  });

  it('IPv6 is normalised like Postgres inet', async () => {
    const a = await service.createOrDedup(
      bruteForce('2001:DB8:0:0:0:0:0:1', LOG(1)),
    );
    expect(a.sourceIp).toBe('2001:db8::1');
  });

  it('links trigger, window and prior logs in priority order on create', async () => {
    const a = await service.createOrDedup(
      { ...bruteForce(IP_A, LOG(5)), detail: { rule_id: 5715 } },
      {
        relatedLogIds: [LOG(1), LOG(2), LOG(5)],
        priorLogIds: [LOG(7), 'not-a-uuid', 42],
      },
    );

    const [call] = linkCalls();
    expect(call.alertId).toBe(a.id);
    expect(call.ids).toEqual([LOG(5), LOG(1), LOG(2), LOG(5), LOG(7)]);
    expect(call.roles).toEqual([
      'trigger',
      'window',
      'window',
      'window',
      'prior',
    ]);
    // log ซ้ำ (LOG 5 เป็นทั้ง trigger และ window) → DISTINCT ON เลือก prio ต่ำสุด = trigger
    expect(queries[0].sql).toMatch(
      /DISTINCT ON \(l\.id\)[\s\S]*ORDER BY l\.id, x\.prio/,
    );
    // id ที่ไม่มีใน logs ถูกข้ามด้วย JOIN ไม่ใช่ชน FK
    expect(queries[0].sql).toMatch(/JOIN logs l ON l\.id = x\.log_id/);
    expect(queries[0].sql).toMatch(/ON CONFLICT DO NOTHING/);
  });

  it('links the repeat log (and its window) as repeat on a duplicate', async () => {
    const first = await service.createOrDedup(bruteForce(IP_A, LOG(1)));
    queries = [];
    await service.createOrDedup(bruteForce(IP_A, LOG(6)), {
      relatedLogIds: [LOG(2), LOG(6)],
    });

    const [call] = linkCalls();
    expect(call.alertId).toBe(first.id);
    expect(call.ids).toEqual([LOG(6), LOG(2), LOG(6)]);
    expect(call.roles).toEqual(['repeat', 'repeat', 'repeat']);
  });

  it('a failing alert_logs insert does not lose the alert', async () => {
    queryImpl = () => Promise.reject(new Error('FK violation'));
    const a = await service.createOrDedup(bruteForce(IP_A, LOG(1)), {
      relatedLogIds: [LOG(2)],
    });
    expect(a.id).toBeDefined();
    expect(store).toHaveLength(1);
  });

  it('no logs at all = no INSERT', async () => {
    await service.createOrDedup({ ...bruteForce(IP_A, LOG(1)), logId: null });
    expect(linkCalls()).toHaveLength(0);
  });

  describe('findOneWithLogs', () => {
    it('404 when missing', async () => {
      await expect(
        service.findOneWithLogs('11111111-1111-4111-8111-111111111111'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('maps rows and keeps legacy alerts.log_id as trigger in the SQL', async () => {
      const a = await service.createOrDedup(bruteForce(IP_A, LOG(1)));
      queryImpl = (sql) =>
        Promise.resolve(
          sql.includes('FROM (SELECT DISTINCT ON (log_id)')
            ? [
                {
                  id: LOG(1),
                  role: 'trigger',
                  message: 'Failed password for root',
                  source_ip: IP_A,
                  created_at: '2026-10-15T09:40:01.900Z',
                  batch_status: null,
                },
              ]
            : [],
        );

      const res = await service.findOneWithLogs(a.id);
      expect(res.alert.id).toBe(a.id);
      expect(res.logs).toEqual([
        {
          id: LOG(1),
          role: 'trigger',
          message: 'Failed password for root',
          sourceIp: IP_A,
          createdAt: new Date('2026-10-15T09:40:01.900Z'),
          batchStatus: null,
        },
      ]);
      const sql = queries[queries.length - 1].sql;
      expect(sql).toMatch(
        /SELECT log_id, 'trigger' FROM alerts WHERE id = \$1/,
      );
      expect(sql).toMatch(/LEFT JOIN batches b/);
    });
  });
});
