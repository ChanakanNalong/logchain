import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
import { ComplianceService } from './compliance.service';
import { Batch } from '../logs/entities/batch.entity';
import { Log } from '../logs/entities/log.entity';
import { AuditAccess } from '../audit/entities/audit-access.entity';
import { ErasureLog } from '../erasure/entities/erasure-log.entity';

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
    getMany: jest.fn(() => Promise.resolve(qb.rawMany)),
  };
  return qb;
}

/** COUNT(...) comes back from pg as strings — mirror that in fixtures. */
function batchRow(day: string, counts: Partial<Record<string, number>>) {
  const c = {
    confirmed: 0,
    sealed: 0,
    tampered: 0,
    unverified: 0,
    pending: 0,
    ...counts,
  };
  const total = c.confirmed + c.sealed + c.tampered + c.unverified + c.pending;
  return {
    day,
    confirmed: String(c.confirmed),
    sealed: String(c.sealed),
    tampered: String(c.tampered),
    unverified: String(c.unverified),
    pending: String(c.pending),
    total: String(total),
  };
}

const EMPTY_RETENTION = {
  expired: '0',
  due_in_30d: '0',
  cde_scoped: '0',
  total: '0',
};

describe('ComplianceService.getReports', () => {
  let service: ComplianceService;
  let batchQb: any;
  let logQb: any;
  let auditQb: any;
  let erasureQb: any;

  beforeEach(async () => {
    jest.clearAllMocks();

    batchQb = makeQueryBuilder();
    logQb = makeQueryBuilder();
    auditQb = makeQueryBuilder();
    erasureQb = makeQueryBuilder();

    logQb.rawOne = EMPTY_RETENTION;

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
        {
          provide: getRepositoryToken(ErasureLog),
          useValue: { createQueryBuilder: jest.fn(() => erasureQb) },
        },
      ],
    }).compile();

    service = module.get(ComplianceService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /** แถวจากตาราง erasure_log (entity) — กรองช่วงวันทำใน SQL แล้ว เทสต์นี้จึงให้เฉพาะแถวในช่วง */
  function tombstone(userId: string, deletedAt: string) {
    return {
      id: `id-${userId}`,
      userId,
      requestedBy: 'admin-dpo',
      deletedAt: new Date(deletedAt),
      recordsDeleted: 2,
      hash: 'a'.repeat(64),
    };
  }
  /** รูปแบบที่ API คืน = รูปแบบเดียวกับ tombstone ของ ErasureService (Reports.tsx / CSV ใช้) */
  function asRecord(t: ReturnType<typeof tombstone>) {
    return {
      userId: t.userId,
      requestedBy: t.requestedBy,
      deletedAt: t.deletedAt.toISOString(),
      recordsDeleted: t.recordsDeleted,
      hash: t.hash,
    };
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

  it('counts SEALED as intact — same formula as stats (Dashboard)', async () => {
    // deployment ที่ไม่ต่อ blockchain: ทุก batch เป็น SEALED ต้องได้ 100% ไม่ใช่ 0%
    batchQb.rawMany = [batchRow('2026-08-05', { sealed: 3 })];

    const report = await service.getReports('2026-08-05', '2026-08-05');

    expect(report.integrity[0]).toMatchObject({
      confirmed: 0,
      sealed: 3,
      total: 3,
      integrityRate: 100,
    });
  });

  it('breakdown columns add up to total', async () => {
    batchQb.rawMany = [
      batchRow('2026-08-05', {
        confirmed: 1,
        sealed: 2,
        tampered: 1,
        unverified: 1,
        pending: 1,
      }),
    ];

    const report = await service.getReports('2026-08-05', '2026-08-05');
    const d = report.integrity[0];

    expect(d.confirmed + d.sealed + d.tampered + d.unverified + d.pending).toBe(
      d.total,
    );
    expect(d.integrityRate).toBe(50); // (1 + 2) / 6
  });

  it('excludes FAILED from total, matching stats', async () => {
    batchQb.rawMany = [batchRow('2026-08-05', { confirmed: 1 })];

    await service.getReports('2026-08-05', '2026-08-05');

    expect(batchQb.addSelect).toHaveBeenCalledWith(
      `COUNT(*) FILTER (WHERE batch.status<>'FAILED')`,
      'total',
    );
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
    expect(report.integrity.map((d) => d.day)).toEqual([
      '2026-08-04',
      '2026-08-05',
    ]);
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
    // 2026-03-02 12:00 ในไทย — กลางวัน ไม่ติดเรื่องโซนเวลา
    jest.useFakeTimers().setSystemTime(new Date('2026-03-02T05:00:00Z'));

    const report = await service.getReports();

    expect(report.period).toEqual({ from: '2026-02-24', to: '2026-03-02' });
  });

  it('"today" is the Bangkok day — 00:55 in Thailand still counts as the new day', async () => {
    // 2026-09-22 17:55 UTC = 2026-09-23 00:55 ICT — batch ที่ seal ตอนนี้ถูกจัดกลุ่มเป็นวันที่ 23
    // เดิมใช้วันของ UTC ได้ to=2026-09-22 → ข้อมูลของวันนี้หายจาก default (เจอตอน smoke test)
    jest.useFakeTimers().setSystemTime(new Date('2026-09-22T17:55:00Z'));

    const report = await service.getReports();

    expect(report.period).toEqual({ from: '2026-09-17', to: '2026-09-23' });
    expect(batchQb.whereParams[0]).toEqual({
      from: '2026-09-17',
      toExclusive: '2026-09-24',
    });
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
    await expect(
      service.getReports('2026-08-10', '2026-08-01'),
    ).rejects.toThrow(BadRequestException);
    // ต้องพังก่อนแตะ repository
    expect(batchQb.getRawMany).not.toHaveBeenCalled();
  });

  // ---- erasure ----

  it('groups tombstones by Bangkok day in the shape ErasureService writes (deletedAt)', async () => {
    // เวลาเป็น UTC — วันที่คาดหวังคิดตามปฏิทินไทย (UTC+7)
    const ictAug01 = tombstone('utc-jul31-ict-aug01', '2026-07-31T23:00:00Z'); // 1 ส.ค. 06:00 ICT
    const middayAug01 = tombstone('midday-aug01', '2026-08-01T02:00:00Z'); // 1 ส.ค. 09:00 ICT
    const middayAug03 = tombstone('midday-aug03', '2026-08-03T10:00:00Z'); // 3 ส.ค. 17:00 ICT
    erasureQb.rawMany = [ictAug01, middayAug01, middayAug03];

    const report = await service.getReports('2026-08-01', '2026-08-03');

    expect(report.erasure).toEqual([
      {
        day: '2026-08-01',
        requests: 2,
        records: [asRecord(ictAug01), asRecord(middayAug01)],
      },
      { day: '2026-08-03', requests: 1, records: [asRecord(middayAug03)] },
    ]);
  });

  it('filters the erasure range in SQL by Bangkok day (same bounds as integrity/audit)', async () => {
    await service.getReports('2026-08-01', '2026-08-03');

    expect(erasureQb.where).toHaveBeenCalledWith(
      expect.stringContaining("e.deleted_at AT TIME ZONE 'Asia/Bangkok'"),
      { from: '2026-08-01', toExclusive: '2026-08-04' },
    );
  });

  it.each([
    ['2026-07-31T16:59:59Z', '2026-07-31'], // 23:59:59 ICT ของวันก่อนหน้า
    ['2026-07-31T17:00:00Z', '2026-08-01'], // เที่ยงคืน ICT พอดี
    ['2026-07-31T23:59:59Z', '2026-08-01'], // 06:59:59 ICT — ถ้าใช้ UTC จะนับเป็นวันที่ 31
    ['2026-08-01T16:59:59Z', '2026-08-01'], // 23:59:59 ICT
    ['2026-08-01T17:00:00Z', '2026-08-02'], // ข้ามไปวันถัดไปตาม ICT
  ])(
    'buckets a tombstone at %s into Bangkok day %s',
    async (deletedAt, expectedDay) => {
      const t = tombstone('boundary', deletedAt);
      erasureQb.rawMany = [t];

      const report = await service.getReports('2026-07-31', '2026-08-02');

      expect(report.erasure).toEqual([
        { day: expectedDay, requests: 1, records: [asRecord(t)] },
      ]);
    },
  );

  it('returns an empty erasure list when there are no tombstones', async () => {
    const report = await service.getReports('2026-08-01', '2026-08-03');

    expect(report.erasure).toEqual([]);
  });

  // ---- retention ----

  it('maps the retention snapshot to numbers', async () => {
    logQb.rawOne = {
      expired: '3',
      due_in_30d: '7',
      cde_scoped: '2',
      total: '40',
    };

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
