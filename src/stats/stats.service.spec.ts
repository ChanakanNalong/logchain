import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { StatsService } from './stats.service';
import { Log } from '../logs/entities/log.entity';
import { Batch } from '../logs/entities/batch.entity';
import { Alert } from '../alerts/entities/alert.entity';

/**
 * Minimal query-builder double. getRawMany() resolves whatever the test queued
 * for that repo, so each chained call just returns `this`.
 */
function makeQueryBuilder() {
  const qb: any = {
    _results: [] as any[][],
    select: jest.fn(() => qb),
    addSelect: jest.fn(() => qb),
    where: jest.fn(() => qb),
    groupBy: jest.fn(() => qb),
    orderBy: jest.fn(() => qb),
    limit: jest.fn(() => qb),
    // ตัว service เรียก getRawMany หลายครั้งต่อ repo (traffic แล้วก็ topSources)
    getRawMany: jest.fn(() => Promise.resolve(qb._results.shift() ?? [])),
  };
  return qb;
}

describe('StatsService', () => {
  let service: StatsService;
  let logsQb: any;
  let batchQb: any;
  let logsRepo: any;
  let alertsRepo: any;

  beforeEach(async () => {
    logsQb = makeQueryBuilder();
    batchQb = makeQueryBuilder();

    logsRepo = {
      count: jest.fn().mockResolvedValue(0),
      createQueryBuilder: jest.fn(() => logsQb),
    };
    const batchesRepo = { createQueryBuilder: jest.fn(() => batchQb) };
    alertsRepo = { count: jest.fn().mockResolvedValue(0) };

    const module = await Test.createTestingModule({
      providers: [
        StatsService,
        { provide: getRepositoryToken(Log), useValue: logsRepo },
        { provide: getRepositoryToken(Batch), useValue: batchesRepo },
        { provide: getRepositoryToken(Alert), useValue: alertsRepo },
      ],
    }).compile();

    service = module.get(StatsService);
  });

  it('returns integrityRate 0 when there are no batches at all', async () => {
    batchQb._results = [[]]; // group-by คืนแถวว่าง = ยังไม่มี batch
    logsQb._results = [[], []]; // traffic, topSources

    const result = await service.getOverview();

    expect(result.batches.total).toBe(0);
    expect(result.integrityRate).toBe(0);
    expect(Number.isNaN(result.integrityRate)).toBe(false);
    expect(result.sealedLogs).toBe(0);
    // byStatus ต้องมีครบทุก key เสมอ ฝั่ง frontend จะได้ไม่เจอ undefined
    expect(result.batches.byStatus).toEqual({
      CONFIRMED: 0,
      UNVERIFIED: 0,
      TAMPERED: 0,
      PENDING: 0,
    });
  });

  it('counts batches by status and derives integrityRate + sealedLogs', async () => {
    batchQb._results = [
      [
        { status: 'CONFIRMED', count: '7', log_count: '700' },
        { status: 'TAMPERED', count: '1', log_count: '100' },
        { status: 'PENDING', count: '2', log_count: '150' },
      ],
    ];
    logsQb._results = [[], []];
    logsRepo.count.mockResolvedValue(950);
    alertsRepo.count.mockResolvedValue(4);

    const result = await service.getOverview();

    expect(result.totalLogs).toBe(950);
    expect(result.batches.total).toBe(10);
    expect(result.batches.confirmed).toBe(7);
    expect(result.batches.tampered).toBe(1);
    expect(result.batches.byStatus).toEqual({
      CONFIRMED: 7,
      UNVERIFIED: 0,
      TAMPERED: 1,
      PENDING: 2,
    });
    expect(result.sealedLogs).toBe(950);
    expect(result.integrityRate).toBe(70); // 7/10
    expect(result.openAlerts).toBe(4);
    expect(alertsRepo.count).toHaveBeenCalledWith({ where: { status: 'OPEN' } });
  });

  it('rounds integrityRate to a whole percent', async () => {
    batchQb._results = [
      [
        { status: 'CONFIRMED', count: '2', log_count: '20' },
        { status: 'PENDING', count: '1', log_count: '10' },
      ],
    ];
    logsQb._results = [[], []];

    const result = await service.getOverview();

    expect(result.integrityRate).toBe(67); // 2/3 = 66.67
  });

  it('maps traffic buckets and top sources to numbers', async () => {
    batchQb._results = [[]];
    logsQb._results = [
      [
        { h: '08:00', total: '12' },
        { h: '09:00', total: '30' },
      ],
      [
        { ip: '203.154.12.88', hits: '9' },
        { ip: '10.0.4.2', hits: '3' },
      ],
    ];

    const result = await service.getOverview();

    expect(result.traffic).toEqual([
      { h: '08:00', total: 12 },
      { h: '09:00', total: 30 },
    ]);
    expect(result.topSources).toEqual([
      { ip: '203.154.12.88', hits: 9 },
      { ip: '10.0.4.2', hits: 3 },
    ]);
    // ไม่มีคอลัมน์ประเทศในตาราง logs — ห้ามมี field country หลุดออกไป
    expect(result.topSources[0]).not.toHaveProperty('country');
  });
});
