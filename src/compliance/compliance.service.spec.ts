import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import { ComplianceService } from './compliance.service';
import { Batch } from '../logs/entities/batch.entity';
import { Log } from '../logs/entities/log.entity';
import { AuditAccess } from '../audit/entities/audit-access.entity';

jest.mock('fs');
const mockedFs = fs as jest.Mocked<typeof fs>;

/**
 * Query-builder double. Every chained call returns `this`; the terminal
 * getRawMany/getRawOne resolve whatever fixture the test queued.
 * `whereParams` records the bound params so the resolved date range can be
 * asserted without touching a database.
 */
function makeQueryBuilder() {
  const qb: any = {
    rawMany: [] as any[],
    rawOne: {} as any,
    whereParams: [] as any[],
    select: jest.fn(() => qb),
    addSelect: jest.fn(() => qb),
    where: jest.fn((_sql: string, params?: any) => {
      qb.whereParams.push(params);
      return qb;
    }),
    groupBy: jest.fn(() => qb),
    addGroupBy: jest.fn(() => qb),
    orderBy: jest.fn(() => qb),
    getRawMany: jest.fn(() => Promise.resolve(qb.rawMany)),
    getRawOne: jest.fn(() => Promise.resolve(qb.rawOne)),
  };
  return qb;
}

/** COUNT(...) comes back from pg as strings — mirror that in fixtures. */
function batchRow(day: string, counts: Partial<Record<string, number>>) {
  const c = { confirmed: 0, tampered: 0, unverified: 0, pending: 0, ...counts };
  const total = c.confirmed + c.tampered + c.unverified + c.pending;
  return {
    day,
    confirmed: String(c.confirmed),
    tampered: String(c.tampered),
    unverified: String(c.unverified),
    pending: String(c.pending),
    total: String(total),
  };
}

const EMPTY_RETENTION = { expired: '0', due_in_30d: '0', cde_scoped: '0', total: '0' };

describe('ComplianceService.getReports', () => {
  let service: ComplianceService;
  let batchQb: any;
  let logQb: any;
  let auditQb: any;

  beforeEach(async () => {
    jest.clearAllMocks();

    batchQb = makeQueryBuilder();
    logQb = makeQueryBuilder();
    auditQb = makeQueryBuilder();

    logQb.rawOne = EMPTY_RETENTION;

    // ไม่มีไฟล์ erasure-log.json เป็น default — เทสที่ต้องใช้ค่อย override
    mockedFs.existsSync.mockReturnValue(false);

    const module = await Test.createTestingModule({
      providers: [
        ComplianceService,
        {
          provide: getRepositoryToken(Batch),
          useValue: { createQueryBuilder: jest.fn(() => batchQb) },
        },
        {
          provide: getRepositoryToken(Log),
          useValue: { createQueryBuilder: jest.fn(() => logQb) },
        },
        {
          provide: getRepositoryToken(AuditAccess),
          useValue: { createQueryBuilder: jest.fn(() => auditQb) },
        },
      ],
    }).compile();

    service = module.get(ComplianceService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /** เขียน fixture ให้ fs.readFileSync คืน erasure-log.json ตามที่กำหนด */
  function withErasureLog(records: any[]) {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(records) as any);
  }

  // ---- integrity ----

  it('returns integrityRate 0 (not NaN) for a day with no batches', async () => {
    batchQb.rawMany = [batchRow('2026-08-05', {})];

    const report = await service.getReports('2026-08-05', '2026-08-05');

    expect(report.integrity).toHaveLength(1);
    expect(report.integrity[0].total).toBe(0);
    expect(report.integrity[0].integrityRate).toBe(0);
    expect(Number.isNaN(report.integrity[0].integrityRate)).toBe(false);
  });

  it('computes integrityRate from confirmed / total', async () => {
    batchQb.rawMany = [batchRow('2026-08-05', { confirmed: 1, tampered: 1 })];

    const report = await service.getReports('2026-08-05', '2026-08-05');

    expect(report.integrity[0]).toMatchObject({
      day: '2026-08-05',
      confirmed: 1,
      tampered: 1,
      unverified: 0,
      pending: 0,
      total: 2,
      integrityRate: 50,
    });
  });

  it('rounds integrityRate to a whole percent', async () => {
    batchQb.rawMany = [batchRow('2026-08-05', { confirmed: 2, pending: 1 })];

    const report = await service.getReports('2026-08-05', '2026-08-05');

    expect(report.integrity[0].integrityRate).toBe(67); // 2/3 = 66.67
  });

  it('keeps one integrity entry per day — two batches on different days give two entries', async () => {
    batchQb.rawMany = [
      batchRow('2026-08-04', { confirmed: 1 }),
      batchRow('2026-08-05', { tampered: 1 }),
    ];

    const report = await service.getReports('2026-08-04', '2026-08-05');

    expect(report.integrity).toHaveLength(2);
    expect(report.integrity.map((d) => d.day)).toEqual(['2026-08-04', '2026-08-05']);
    expect(report.integrity[0].integrityRate).toBe(100);
    expect(report.integrity[1].integrityRate).toBe(0);
  });

  // ---- date range ----

  it('defaults to a 7-day inclusive window ending today', async () => {
    // จงใจไม่ใช้วันปัจจุบันจริง — ถ้า fake timer ไม่ทำงาน เทสนี้ต้องพัง ไม่ใช่ผ่านฟลุ๊ค
    jest.useFakeTimers().setSystemTime(new Date('2026-03-15T05:00:00Z'));

    const report = await service.getReports();

    expect(report.period).toEqual({ from: '2026-03-09', to: '2026-03-15' });
    // from..to เป็น inclusive ตอนคิว จึงส่ง toExclusive = to + 1 วัน
    expect(batchQb.whereParams[0]).toEqual({
      from: '2026-03-09',
      toExclusive: '2026-03-16',
    });
    expect(auditQb.whereParams[0]).toEqual({
      from: '2026-03-09',
      toExclusive: '2026-03-16',
    });
  });

  it('crosses a month boundary correctly when defaulting the window', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-02T23:59:00Z'));

    const report = await service.getReports();

    expect(report.period).toEqual({ from: '2026-02-24', to: '2026-03-02' });
  });

  it('honours an explicit from/to range', async () => {
    const report = await service.getReports('2026-07-01', '2026-07-03');

    expect(report.period).toEqual({ from: '2026-07-01', to: '2026-07-03' });
    expect(batchQb.whereParams[0]).toEqual({
      from: '2026-07-01',
      toExclusive: '2026-07-04',
    });
  });

  it('throws BadRequestException when from is after to', async () => {
    await expect(service.getReports('2026-08-10', '2026-08-01')).rejects.toThrow(
      BadRequestException,
    );
    // ต้องพังก่อนแตะ repository
    expect(batchQb.getRawMany).not.toHaveBeenCalled();
  });

  // ---- erasure ----

  it('keeps only erasure records inside the range and groups them by Bangkok day', async () => {
    // ทั้ง 6 record เขียนเป็นเวลา UTC — วันที่ที่คาดหวังคิดตามปฏิทินไทย (UTC+7)
    const beforeWindow = { subject: 'before-window', erasedAt: '2026-07-31T10:00:00Z' }; // 31 ก.ค. 17:00 ICT
    const ictAug01 = { subject: 'utc-jul31-ict-aug01', erasedAt: '2026-07-31T23:00:00Z' }; // 1 ส.ค. 06:00 ICT
    const middayAug01 = { subject: 'midday-aug01', erasedAt: '2026-08-01T02:00:00Z' }; // 1 ส.ค. 09:00 ICT
    const middayAug03 = { subject: 'midday-aug03', erasedAt: '2026-08-03T10:00:00Z' }; // 3 ส.ค. 17:00 ICT
    const ictAug04 = { subject: 'utc-aug03-ict-aug04', erasedAt: '2026-08-03T18:30:00Z' }; // 4 ส.ค. 01:30 ICT
    const afterWindow = { subject: 'after-window', erasedAt: '2026-08-04T10:00:00Z' }; // 4 ส.ค. 17:00 ICT

    withErasureLog([beforeWindow, ictAug01, middayAug01, middayAug03, ictAug04, afterWindow]);

    const report = await service.getReports('2026-08-01', '2026-08-03');

    expect(report.erasure).toEqual([
      { day: '2026-08-01', requests: 2, records: [ictAug01, middayAug01] },
      { day: '2026-08-03', requests: 1, records: [middayAug03] },
    ]);

    const subjects = report.erasure.flatMap((d) => d.records.map((r: any) => r.subject));
    expect(subjects).not.toContain('before-window');
    expect(subjects).not.toContain('after-window');
    // ตกช่วง 00:00–07:00 ICT ของวันที่ 4 -> อยู่นอกหน้าต่าง แม้วัน UTC จะยังเป็นวันที่ 3
    expect(subjects).not.toContain('utc-aug03-ict-aug04');
  });

  it.each([
    ['2026-07-31T16:59:59Z', '2026-07-31'], // 23:59:59 ICT ของวันก่อนหน้า
    ['2026-07-31T17:00:00Z', '2026-08-01'], // เที่ยงคืน ICT พอดี
    ['2026-07-31T23:59:59Z', '2026-08-01'], // 06:59:59 ICT — เดิม UTC จะนับเป็นวันที่ 31
    ['2026-08-01T00:00:00Z', '2026-08-01'], // 07:00 ICT
    ['2026-08-01T16:59:59Z', '2026-08-01'], // 23:59:59 ICT
    ['2026-08-01T17:00:00Z', '2026-08-02'], // ข้ามไปวันถัดไปตาม ICT
  ])('buckets an erasure record at %s into Bangkok day %s', async (erasedAt, expectedDay) => {
    withErasureLog([{ subject: 'boundary', erasedAt }]);

    const report = await service.getReports('2026-07-31', '2026-08-02');

    expect(report.erasure).toEqual([
      { day: expectedDay, requests: 1, records: [{ subject: 'boundary', erasedAt }] },
    ]);
  });

  it('returns an empty erasure list when the log file is missing', async () => {
    mockedFs.existsSync.mockReturnValue(false);

    const report = await service.getReports('2026-08-01', '2026-08-03');

    expect(report.erasure).toEqual([]);
    expect(mockedFs.readFileSync).not.toHaveBeenCalled();
  });

  it('survives a corrupt erasure log instead of throwing', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue('{not json' as any);

    const report = await service.getReports('2026-08-01', '2026-08-03');

    expect(report.erasure).toEqual([]);
  });

  // ---- retention ----

  it('maps the retention snapshot to numbers', async () => {
    logQb.rawOne = { expired: '3', due_in_30d: '7', cde_scoped: '2', total: '40' };

    const report = await service.getReports('2026-08-01', '2026-08-03');

    expect(report.retention).toEqual({
      expired: 3,
      dueIn30d: 7,
      cdeScoped: 2,
      total: 40,
    });
    // snapshot คิด ณ ตอนนี้ ไม่ผูกกับ from/to
    expect(logQb.where).not.toHaveBeenCalled();
  });

  // ---- audit ----

  it('folds audit rows into one entry per day keyed by action', async () => {
    auditQb.rawMany = [
      { day: '2026-08-01', action: 'READ', count: '5' },
      { day: '2026-08-01', action: 'EXPORT', count: '2' },
      { day: '2026-08-02', action: 'READ', count: '1' },
    ];

    const report = await service.getReports('2026-08-01', '2026-08-03');

    expect(report.audit).toEqual([
      { day: '2026-08-01', byAction: { READ: 5, EXPORT: 2 } },
      { day: '2026-08-02', byAction: { READ: 1 } },
    ]);
  });

  // ---- envelope ----

  it('returns the period, generatedAt and all four sections', async () => {
    const report = await service.getReports('2026-08-01', '2026-08-03');

    expect(report).toEqual(
      expect.objectContaining({
        period: { from: '2026-08-01', to: '2026-08-03' },
        generatedAt: expect.any(String),
        integrity: expect.any(Array),
        retention: expect.any(Object),
        erasure: expect.any(Array),
        audit: expect.any(Array),
      }),
    );
    expect(new Date(report.generatedAt).toString()).not.toBe('Invalid Date');
  });
});
