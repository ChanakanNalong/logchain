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
    addGroupBy: jest.fn(() => qb),
    orderBy: jest.fn(() => qb),
    limit: jest.fn(() => qb),
    // ตัว service เรียก getRawMany หลายครั้งต่อ repo (traffic แล้วก็ topSources)
    getRawMany: jest.fn(() => Promise.resolve(qb._results.shift() ?? [])),
  };
  return qb;
}

/**
 * mock ของ logs repo เท่าที่ StatsService ใช้จริง
 * เคยปล่อยเป็น `any` ทั้งก้อน แล้ว eslint เตือน unsafe-member-access/unsafe-assignment
 * ทุกบรรทัดที่แตะ .query จนกลบ warning ที่มีความหมายจริงๆ — ระบุชนิดของ query ไว้
 * ยังทำให้ `mock.calls[n]` อ่านออกว่าเป็น [sql, params] ด้วย
 *
 * params ระบุเป็นแบบบังคับ เพราะทุก query ของซีรีส์ส่งมาครบ — ยกเว้น
 * min(created_at) ของ planAllRange ที่ส่ง sql อย่างเดียว ซึ่งไม่มีเทสไหนอ่าน params
 */
interface LogsRepoMock {
  count: jest.Mock<Promise<number>, []>;
  createQueryBuilder: jest.Mock;
  query: jest.Mock<Promise<unknown[]>, [string, unknown[]]>;
}

describe('StatsService', () => {
  let service: StatsService;
  let logsQb: any;
  let batchQb: any;
  let logsRepo: LogsRepoMock;
  let alertsQb: any;
  let alertsRepo: any;

  beforeEach(async () => {
    logsQb = makeQueryBuilder();
    batchQb = makeQueryBuilder();
    alertsQb = makeQueryBuilder();

    logsRepo = {
      count: jest.fn<Promise<number>, []>().mockResolvedValue(0),
      createQueryBuilder: jest.fn(() => logsQb),
      query: jest
        .fn<Promise<unknown[]>, [string, unknown[]]>()
        .mockResolvedValue([]),
    };
    const batchesRepo = { createQueryBuilder: jest.fn(() => batchQb) };
    alertsRepo = {
      count: jest.fn().mockResolvedValue(0),
      createQueryBuilder: jest.fn(() => alertsQb),
    };

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
    logsQb._results = [[]]; // traffic, topSources

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
    logsQb._results = [[]];
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
    expect(alertsRepo.count).toHaveBeenCalledWith({
      where: { status: 'OPEN' },
    });
  });

  it('rounds integrityRate to a whole percent', async () => {
    batchQb._results = [
      [
        { status: 'CONFIRMED', count: '2', log_count: '20' },
        { status: 'PENDING', count: '1', log_count: '10' },
      ],
    ];
    logsQb._results = [[]];

    const result = await service.getOverview();

    expect(result.integrityRate).toBe(67); // 2/3 = 66.67
  });

  it('maps traffic buckets and top sources to numbers', async () => {
    batchQb._results = [[]];
    logsRepo.query.mockResolvedValue([
      { t: '2026-09-17T08:00:00Z', label: '08:00', total: '12' },
      { t: '2026-09-17T09:00:00Z', label: '09:00', total: '30' },
    ]);
    logsQb._results = [
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

  it('excludes FAILED batches from sealedLogs', async () => {
    batchQb._results = [
      [
        { status: 'CONFIRMED', count: '2', log_count: '200' },
        { status: 'FAILED', count: '1', log_count: '100' },
      ],
    ];
    logsQb._results = [[]];

    const result = await service.getOverview();
    expect(result.sealedLogs).toBe(200);
  });

  // batch ที่ anchor ไม่สำเร็จไม่ใช่หลักฐานว่าข้อมูลถูกแก้ ถ้านับใน total
  // dashboard จะขึ้น integrity ต่ำกว่า 100% ทั้งที่ tampered = 0
  it('keeps integrity at 100% when a batch only FAILED to anchor', async () => {
    batchQb._results = [
      [
        { status: 'CONFIRMED', count: '3', log_count: '13' },
        { status: 'FAILED', count: '1', log_count: '1' },
      ],
    ];
    logsQb._results = [[]];

    const result = await service.getOverview();

    expect(result.batches.total).toBe(3); // FAILED ไม่อยู่ในตัวหาร
    expect(result.integrityRate).toBe(100);
    expect(result.batches.tampered).toBe(0);
    expect(result.batches.byStatus.FAILED).toBe(1); // แต่ยังเห็นว่ามี 1 ใบ
  });

  it('returns all 24 hourly buckets including empty hours', async () => {
    batchQb._results = [[]];
    logsRepo.query.mockResolvedValue(
      Array.from({ length: 24 }, (_, i) => ({
        t: `2026-09-17T${String(i).padStart(2, '0')}:00:00Z`,
        label: `${String(i).padStart(2, '0')}:00`,
        total: '0',
      })),
    );
    logsQb._results = [[]];

    const result = await service.getOverview();
    expect(result.traffic).toHaveLength(24);
    expect(result.traffic.every((b) => b.total === 0)).toBe(true);
  });

  // เทสอื่นๆ mock logsRepo.query ให้คืน row ที่มี field `total` อยู่แล้ว จึงไม่เคย
  // แตะ SQL จริง — บั๊กที่ลืม `AS total` เลยหลุดผ่านมาได้ (Postgres ตั้งชื่อคอลัมน์
  // ว่า "count" แล้ว row.total = undefined -> กราฟ 24h เป็นศูนย์ทั้งแถบ)
  // เทสนี้เลยตรวจตัว SQL ตรงๆ ว่ายัง alias เป็น total อยู่
  it('aliases the hourly COUNT as "total" so row.total is not undefined', async () => {
    batchQb._results = [[]];
    logsRepo.query.mockResolvedValue([]);
    logsQb._results = [[]];

    await service.getOverview();

    const sql: string = logsRepo.query.mock.calls[0][0];
    expect(sql).toMatch(/COUNT\(l\.id\)\s+AS\s+total/i);
  });

  it('maps anomaly type to numbers and excludes integrity alert', async () => {
    batchQb._results = [[]];
    logsQb._results = [[]];
    alertsQb._results = [
      [
        {
          type: 'RULE_MATCH',
          severity: 'CRITICAL',
          source: 'web-server-01',
          count: '3',
        },
        {
          type: 'ML_ANOMALY',
          severity: 'INFO',
          source: 'web-server-01',
          count: '1',
        },
      ],
    ];

    const result = await service.getOverview();

    expect(result.anomalyTypes).toEqual([
      {
        type: 'RULE_MATCH',
        severity: 'CRITICAL',
        source: 'web-server-01',
        count: 3,
      },
      {
        type: 'ML_ANOMALY',
        severity: 'INFO',
        source: 'web-server-01',
        count: 1,
      },
    ]);
    // integrity alert ต้องถูกกรองที่ SQL - ยืนยันว่ามี where กันไว้จริง
    expect(alertsQb.where).toHaveBeenCalledWith(
      expect.stringContaining('source'),
      expect.objectContaining({ integritySource: 'INTEGRITY' }),
    );
  });
  // ---- ช่วงเวลาของกราฟ (1H / 6H / 24H / 7D / 30D / 6M / 12M / All) ----

  it('defaults to the 24h range with hourly buckets', async () => {
    logsRepo.query.mockResolvedValue([]);

    const series = await service.getTraffic();

    expect(series.range).toBe('24h');
    expect(series.bucket).toBe('hour');
    const [, params] = logsRepo.query.mock.calls[0];
    expect(params[0]).toBe('1 hour');
    // 25 จุด = ย้อนหลัง 24 ช่วงเต็ม + ชั่วโมงปัจจุบันที่ยังไม่จบ
    // ต้องเป็น 24 ไม่ใช่ 23 ไม่งั้นซีรีส์เริ่มช้าไปหนึ่งชั่วโมงแล้ว log ช่วงนั้นหาย
    expect(params[1]).toBe(`${24 * 3600} seconds`);
  });

  it('bins the 1h range into 5-minute buckets', async () => {
    logsRepo.query.mockResolvedValue([]);

    const series = await service.getTraffic('1h');

    const [sql, params] = logsRepo.query.mock.calls[0];
    expect(sql).toMatch(/date_bin/);
    expect(params[0]).toBe('5 minutes');
    expect(params[1]).toBe(`${12 * 300} seconds`);
    expect(series.bucket).toBe('5 min');
  });

  // date_bin รับ interval ที่มีเดือน/ปีไม่ได้ (Postgres โยน error ทันที)
  // ช่วง 12M จึงต้องตกไปใช้ date_trunc แทน
  it('uses date_trunc, not date_bin, for the 12m range', async () => {
    logsRepo.query.mockResolvedValue([]);

    const series = await service.getTraffic('12m');

    const [sql, params] = logsRepo.query.mock.calls[0];
    expect(sql).toMatch(/date_trunc/);
    expect(sql).not.toMatch(/date_bin/);
    expect(params[0]).toBe('month');
    expect(params[1]).toBe('12 months');
    expect(series.bucket).toBe('month');
  });

  it('returns an empty series for "all" when there are no logs at all', async () => {
    logsRepo.query.mockResolvedValue([{ first: null }]);

    const series = await service.getTraffic('all');

    expect(series.points).toEqual([]);
    // ไม่มีจุดเริ่ม -> ต้องไม่ยิง query ซีรีส์ต่อ (generate_series จะไม่มีขอบเขต)
    expect(logsRepo.query).toHaveBeenCalledTimes(1);
  });

  it('picks a bucket wide enough for the whole history on "all"', async () => {
    const firstLog = new Date(Date.now() - 400 * 24 * 3600 * 1000); // ~13 เดือนก่อน
    logsRepo.query
      .mockResolvedValueOnce([{ first: firstLog.toISOString() }])
      .mockResolvedValueOnce([]);

    const series = await service.getTraffic('all');

    // 400 วันด้วย bucket รายวันจะเกิน MAX_BUCKETS -> ต้องขยับขึ้นไปเป็นราย "สัปดาห์"
    expect(series.bucket).toBe('week');
    expect(series.range).toBe('all');
    const [, params] = logsRepo.query.mock.calls[1];
    expect(params[0]).toBe('7 days');
  });

  // RANGE_SPECS เคยตั้ง points = span/bucket พอดี ทำให้ซีรีส์สั้นกว่าป้ายไปหนึ่ง bucket
  // (7d รวมได้ 23 ขณะที่ DB มี 24 ใน 7 วันจริง) — ล็อกไว้ว่าทุกช่วงต้องถอยหลังเต็ม span
  it.each([
    ['1h', 3_600],
    ['6h', 6 * 3_600],
    ['24h', 24 * 3_600],
    ['7d', 7 * 24 * 3_600],
    ['30d', 30 * 24 * 3_600],
    ['6m', 26 * 7 * 24 * 3_600],
  ] as const)(
    'covers the full %s window, not one bucket short',
    async (range, spanSeconds) => {
      logsRepo.query.mockResolvedValue([]);

      await service.getTraffic(range);

      const [, params] = logsRepo.query.mock.calls[0];
      expect(params[1]).toBe(`${spanSeconds} seconds`);
    },
  );

  // ฝั่งซ้ายของเงื่อนไขต้องเป็น l.created_at เปล่าๆ ถึงจะเข้า idx_logs_created_at ได้
  // ถ้าโดน date_bin/date_trunc ครอบเมื่อไหร่ planner จะกลับไป seq scan ทั้งตาราง
  it.each(['24h', '12m'] as const)(
    'bounds the join on raw created_at so %s can use the index',
    async (range) => {
      logsRepo.query.mockResolvedValue([]);

      await service.getTraffic(range);

      const sql: string = logsRepo.query.mock.calls[0][0];
      expect(sql).toMatch(/AND\s+l\.created_at\s+>=/);
      // ต้องอยู่ใน ON ไม่ใช่ WHERE ไม่งั้น LEFT JOIN กลายเป็น INNER แล้ว bucket ว่างหาย
      expect(sql).not.toMatch(/WHERE/i);
    },
  );

  it('maps traffic points to numbers and keeps the bucket timestamp', async () => {
    logsRepo.query.mockResolvedValue([
      { t: '2026-09-17T08:00:00Z', label: '08:00', total: '12' },
      { t: '2026-09-17T09:00:00Z', label: '09:00', total: null },
    ]);

    const series = await service.getTraffic('24h');

    expect(series.points).toEqual([
      { t: '2026-09-17T08:00:00Z', label: '08:00', total: 12 },
      { t: '2026-09-17T09:00:00Z', label: '09:00', total: 0 },
    ]);
  });
});
