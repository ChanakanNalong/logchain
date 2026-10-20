import { Test } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { IntegrityService } from './integrity.service';
import { MerkleService } from './service/merkle.service';
import { fakeSealManager } from '../../test/helpers/fake-seal-transaction';
import { BlockchainService } from '../blockchain/blockchain.service';
import { Log } from '../logs/entities/log.entity';
import { Batch } from '../logs/entities/batch.entity';
import { Alert } from '../alerts/entities/alert.entity';
import { LogBatchMapping } from '../logs/entities/log-batch-mapping.entity';
import { computeRawHash } from '../logs/services/log-hash';
import { decideSeal, readSealConfig } from './seal-config';

/**
 * hybrid seal: ตัวเช็คทุก 1 นาที ตัดสินจาก count (ครบ batchSize) หรือ age (ค้างเกิน maxWait)
 * - decideSeal() เป็น pure function → ทดสอบตรง ๆ ครบทุกเคส
 * - runHybridSealTick() → drain ตาม trigger (count = เฉพาะ batch เต็ม · age = ทั้งหมด)
 * - สั่ง seal-now แทรกระหว่าง drain ต้องไม่ได้ log ซ้ำ (คิว sealQueue กันไว้)
 */

interface IdOperator {
  type?: string;
  value?: unknown;
}
interface FindOpts {
  where?: { id?: IdOperator; batchId?: string; createdAt?: IdOperator };
  order?: Record<string, 'ASC' | 'DESC'>;
  take?: number;
}

/** cutoff ของ age drain = เวลาที่ตัดสินใจ (หลัง createdAt ทุกตัวใน makeLog ที่เป็น Oct-15) */
const CUTOFF = new Date(Date.UTC(2026, 9, 16, 0, 0, 0));
/** mock return ของ getPendingStats (รวม now = cutoff) */
const stats = (
  pendingCount: number,
  oldestAgeMinutes: number | null,
  now = CUTOFF,
) => ({
  pendingCount,
  oldestAgeMinutes,
  now,
});
type LogRow = ReturnType<typeof makeLog>;
interface MappingRow {
  logId: string;
  batchId: string;
}
interface BatchRow {
  id?: string;
  status: string;
  logCount: number;
  [k: string]: unknown;
}

function makeLog(i: number) {
  const row = {
    id: `log-${String(i).padStart(4, '0')}`,
    source: 'unit-test',
    sourceIp: null,
    eventType: 'AUTH_FAILURE',
    severity: 'INFO',
    message: `log ${i}`,
    classification: 'INTERNAL',
    cdeScope: false,
    // createdAt กลับด้านกับ id — ยืนยันว่าลำดับมาจาก createdAt ก่อน id
    createdAt: new Date(Date.UTC(2026, 9, 15, 0, 0, 0) - i * 1000),
  };
  return { ...row, rawHash: computeRawHash(row) };
}

function applyOrder(rows: LogRow[], order?: FindOpts['order']): LogRow[] {
  if (!order) return rows;
  const keys = Object.keys(order) as (keyof LogRow)[];
  return [...rows].sort((a, b) => {
    for (const k of keys) {
      const dir = order[k] === 'DESC' ? -1 : 1;
      const [x, y] = [a[k] as string | Date, b[k] as string | Date];
      if (x < y) return -1 * dir;
      if (x > y) return 1 * dir;
    }
    return 0;
  });
}

function excludedIds(idOp?: IdOperator): string[] | null {
  if (idOp?.type === 'not' && Array.isArray(idOp.value)) {
    return idOp.value as string[];
  }
  return null;
}

describe('decideSeal (pure)', () => {
  const base = {
    inFlight: false,
    backoffTicksLeft: 0,
    batchSize: 100,
    maxWaitMinutes: 60,
  };

  it('0 log ค้าง → ไม่ seal (idle)', () => {
    expect(
      decideSeal({ ...base, pendingCount: 0, oldestAgeMinutes: null }),
    ).toEqual({ seal: false, skip: 'idle' });
  });

  it('99 log อายุ 10 นาที → ไม่ seal (ยังไม่ครบ count และไม่ถึง age)', () => {
    expect(
      decideSeal({ ...base, pendingCount: 99, oldestAgeMinutes: 10 }),
    ).toEqual({ seal: false, skip: 'idle' });
  });

  it('100 log → count trigger, drain เฉพาะ batch เต็ม', () => {
    expect(
      decideSeal({ ...base, pendingCount: 100, oldestAgeMinutes: 1 }),
    ).toEqual({ seal: true, trigger: 'count', drainAll: false });
  });

  it('250 log → count trigger (drainAll=false → เหลือเศษ)', () => {
    expect(
      decideSeal({ ...base, pendingCount: 250, oldestAgeMinutes: 5 }),
    ).toEqual({ seal: true, trigger: 'count', drainAll: false });
  });

  it('30 log อายุ 61 นาที → age trigger, drain ทั้งหมด', () => {
    expect(
      decideSeal({ ...base, pendingCount: 30, oldestAgeMinutes: 61 }),
    ).toEqual({ seal: true, trigger: 'age', drainAll: true });
  });

  it('อายุถึง maxWait พอดี (60) → age trigger', () => {
    expect(
      decideSeal({ ...base, pendingCount: 1, oldestAgeMinutes: 60 }),
    ).toEqual({ seal: true, trigger: 'age', drainAll: true });
  });

  it('ครบทั้ง count และ age → age มาก่อน (เท batch สุดท้ายด้วย)', () => {
    expect(
      decideSeal({ ...base, pendingCount: 250, oldestAgeMinutes: 90 }),
    ).toEqual({ seal: true, trigger: 'age', drainAll: true });
  });

  it('seal กำลังทำงานอยู่ (inFlight) → ข้าม ไม่ว่าจะเข้า trigger ไหน', () => {
    expect(
      decideSeal({
        ...base,
        inFlight: true,
        pendingCount: 500,
        oldestAgeMinutes: 999,
      }),
    ).toEqual({ seal: false, skip: 'in_flight' });
  });

  it('ติด backoff หลัง FAILED → ข้าม (ไม่ยิงซ้ำทุกนาที)', () => {
    expect(
      decideSeal({
        ...base,
        backoffTicksLeft: 2,
        pendingCount: 500,
        oldestAgeMinutes: 999,
      }),
    ).toEqual({ seal: false, skip: 'backoff' });
  });

  it('inFlight มาก่อน backoff', () => {
    expect(
      decideSeal({
        ...base,
        inFlight: true,
        backoffTicksLeft: 5,
        pendingCount: 10,
        oldestAgeMinutes: 1,
      }),
    ).toEqual({ seal: false, skip: 'in_flight' });
  });
});

describe('readSealConfig — SEAL_MODE', () => {
  it('default = cron', () => {
    expect(readSealConfig({}).mode).toBe('cron');
    expect(readSealConfig({}).maxWaitMinutes).toBe(60);
  });

  it('อ่าน hybrid + SEAL_MAX_WAIT_MINUTES', () => {
    const cfg = readSealConfig({
      SEAL_MODE: 'hybrid',
      SEAL_MAX_WAIT_MINUTES: '15',
    });
    expect(cfg.mode).toBe('hybrid');
    expect(cfg.maxWaitMinutes).toBe(15);
  });

  it('ไม่สนตัวพิมพ์เล็กใหญ่/ช่องว่าง', () => {
    expect(readSealConfig({ SEAL_MODE: ' HYBRID ' }).mode).toBe('hybrid');
  });

  it('ค่าไม่ถูกต้อง → fallback cron + warn (ไม่ throw)', () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    expect(readSealConfig({ SEAL_MODE: 'turbo' }).mode).toBe('cron');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('SEAL_MAX_WAIT_MINUTES ผิดรูปแบบ → throw (เหมือน int อื่น)', () => {
    expect(() => readSealConfig({ SEAL_MAX_WAIT_MINUTES: '0' })).toThrow(
      /SEAL_MAX_WAIT_MINUTES/,
    );
    expect(() => readSealConfig({ SEAL_MAX_WAIT_MINUTES: 'abc' })).toThrow();
  });
});

describe('IntegrityService — runHybridSealTick', () => {
  let logsStore: LogRow[];
  let mappingStore: MappingRow[];
  let batchStore: BatchRow[];

  async function build(env: Record<string, string> = {}) {
    for (const k of ['SEAL_MODE', 'SEAL_MAX_WAIT_MINUTES', 'SEAL_BATCH_SIZE']) {
      delete process.env[k];
    }
    Object.assign(process.env, env);

    const logsRepo = {
      find: jest.fn((opts: FindOpts = {}) => {
        let rows = [...logsStore];
        const excl = excludedIds(opts.where?.id);
        if (excl) rows = rows.filter((r) => !excl.includes(r.id));
        // cutoff (age drain): created_at <= value — จำลอง LessThanOrEqual ของ TypeORM
        const le = opts.where?.createdAt;
        if (le?.type === 'lessThanOrEqual' && le.value instanceof Date) {
          const cut = le.value;
          rows = rows.filter((r) => r.createdAt <= cut);
        }
        rows = applyOrder(rows, opts.order);
        if (opts.take) rows = rows.slice(0, opts.take);
        return Promise.resolve(rows);
      }),
      // getPendingStats ยิง SQL ตรง — unit test ของ drain stub getPendingStats แทน
      query: jest.fn(() => Promise.resolve([])),
    };
    const mappingRepo = {
      find: jest.fn((opts: FindOpts = {}) =>
        Promise.resolve(
          opts.where?.batchId
            ? mappingStore.filter((m) => m.batchId === opts.where?.batchId)
            : [...mappingStore],
        ),
      ),
      create: jest.fn((dto: MappingRow) => ({ ...dto })),
      save: jest.fn((val: MappingRow | MappingRow[]) => {
        for (const m of Array.isArray(val) ? val : [val]) mappingStore.push(m);
        return Promise.resolve(val);
      }),
    };
    let seq = 0;
    const batchesRepo = {
      create: jest.fn((dto: BatchRow) => ({ ...dto })),
      save: jest.fn((b: BatchRow) => {
        if (!b.id) b.id = `batch-${seq++}`;
        if (!batchStore.includes(b)) batchStore.push(b);
        return Promise.resolve(b);
      }),
    };
    Object.assign(mappingRepo, {
      manager: fakeSealManager({
        batches: () => batchesRepo,
        mapping: () => mappingRepo,
      }),
    });
    const alertsRepo = {
      findOne: jest.fn(() => Promise.resolve(null)),
      create: jest.fn((dto: unknown) => dto),
      save: jest.fn((dto: unknown) => Promise.resolve(dto)),
      update: jest.fn(() => Promise.resolve({ affected: 0 })),
    };
    const blockchain = {
      ready: true,
      storeRoot: jest.fn(() =>
        Promise.resolve({ txHash: '0xtx', blockNumber: 1, confirmed: true }),
      ),
      estimateStoreRootCost: jest.fn(),
    };

    const module = await Test.createTestingModule({
      providers: [
        IntegrityService,
        MerkleService,
        { provide: BlockchainService, useValue: blockchain },
        { provide: getRepositoryToken(Log), useValue: logsRepo },
        { provide: getRepositoryToken(Batch), useValue: batchesRepo },
        { provide: getRepositoryToken(Alert), useValue: alertsRepo },
        { provide: getRepositoryToken(LogBatchMapping), useValue: mappingRepo },
      ],
    }).compile();
    return { service: module.get(IntegrityService), blockchain };
  }

  beforeEach(() => {
    logsStore = [];
    mappingStore = [];
    batchStore = [];
  });

  afterAll(() => {
    for (const k of ['SEAL_MODE', 'SEAL_MAX_WAIT_MINUTES', 'SEAL_BATCH_SIZE']) {
      delete process.env[k];
    }
  });

  it('count trigger: 250 log → 2 batch × 100, เหลือ 50 ค้าง', async () => {
    logsStore = Array.from({ length: 250 }, (_, i) => makeLog(i));
    const { service } = await build({ SEAL_MODE: 'hybrid' });
    jest.spyOn(service, 'getPendingStats').mockResolvedValue(stats(250, 5));

    const run = await service.runHybridSealTick();

    expect(run.batches.map((b) => b.logCount)).toEqual([100, 100]);
    expect(run.batches.every((b) => b.status === 'CONFIRMED')).toBe(true);
    // เหลือเศษ 50 ยังไม่ถูก map
    expect(mappingStore).toHaveLength(200);
    expect(new Set(mappingStore.map((m) => m.logId)).size).toBe(200);
  });

  it('age trigger: 30 log ค้างนาน → seal ทั้งหมดใบเดียว (รวมใบที่ไม่เต็ม)', async () => {
    logsStore = Array.from({ length: 30 }, (_, i) => makeLog(i));
    const { service } = await build({ SEAL_MODE: 'hybrid' });
    jest.spyOn(service, 'getPendingStats').mockResolvedValue(stats(30, 61));

    const run = await service.runHybridSealTick();

    expect(run.batches.map((b) => b.logCount)).toEqual([30]);
    expect(mappingStore).toHaveLength(30);
  });

  it('idle: ไม่มี log ค้าง → ไม่ seal', async () => {
    const { service } = await build({ SEAL_MODE: 'hybrid' });
    jest.spyOn(service, 'getPendingStats').mockResolvedValue(stats(0, null));

    const run = await service.runHybridSealTick();
    expect(run.batches).toHaveLength(0);
    expect(batchStore).toHaveLength(0);
  });

  it('เลือก pending เรียง created_at ASC, id ASC (log เก่าสุดเข้า batch ก่อน)', async () => {
    // id เรียง 1..5 แต่ createdAt กลับด้าน (id ใหญ่ = createdAt เก่ากว่า)
    logsStore = [1, 2, 3, 4, 5].map(makeLog);
    const { service } = await build({ SEAL_MODE: 'hybrid' });
    jest.spyOn(service, 'getPendingStats').mockResolvedValue(stats(5, 61));

    await service.runHybridSealTick();

    const oldestFirst = applyOrder(logsStore, { createdAt: 'ASC', id: 'ASC' });
    expect(mappingStore.map((m) => m.logId)).toEqual(
      oldestFirst.map((l) => l.id),
    );
    // log-0005 มี createdAt เก่าสุด → ต้องมาก่อน log-0001
    expect(mappingStore[0].logId).toBe('log-0005');
  });

  it('seal-now แทรกระหว่าง count drain → ไม่มี log_id ซ้ำใน mapping', async () => {
    logsStore = Array.from({ length: 250 }, (_, i) => makeLog(i));
    const { service } = await build({ SEAL_MODE: 'hybrid' });
    jest.spyOn(service, 'getPendingStats').mockResolvedValue(stats(250, 5));

    // ยิง hybrid tick (count drain) พร้อม seal-now แทรก 2 ครั้ง — คิว sealQueue ต้อง serialize
    // ให้ seal ทีละใบ ไม่ซ้อน (ถ้าซ้อน ทั้งคู่จะเห็น pending ชุดเดียวกันแล้ว map log ซ้ำ)
    await Promise.all([
      service.runHybridSealTick(),
      service.sealBatch(),
      service.sealBatch(),
    ]);

    // log ทุกตัวถูก map ได้ครั้งเดียวเท่านั้น — log_batch_mapping ไม่มี log_id ซ้ำ
    const ids = mappingStore.map((m) => m.logId);
    expect(new Set(ids).size).toBe(ids.length);
    // 250 log ถูก drain จนหมดพอดี (100 + 100 + 50) ไม่ขาดไม่เกิน
    expect(mappingStore).toHaveLength(250);
    // ไม่มี batch ไหนได้ log เกิน batchSize
    expect(batchStore.every((b) => b.logCount <= 100)).toBe(true);
  });

  it('age drain: log ที่เข้าระหว่าง drain (created_at > cutoff) ต้องไม่ถูก seal', async () => {
    logsStore = [makeLog(0), makeLog(1)]; // 2 aged (Oct-15 ≤ cutoff Oct-16)
    // log สดที่ "มาถึง" ระหว่าง drain — createdAt หลัง cutoff
    const freshRow = {
      id: 'log-fresh',
      source: 'unit-test',
      sourceIp: null,
      eventType: 'AUTH_FAILURE',
      severity: 'INFO',
      message: 'fresh',
      classification: 'INTERNAL',
      cdeScope: false,
      createdAt: new Date(Date.UTC(2026, 9, 17, 0, 0, 0)),
    };
    const fresh = { ...freshRow, rawHash: computeRawHash(freshRow) };
    // batchSize 1 → drain วนหลายรอบ (เปิดช่องให้กวาด fresh ถ้าไม่มี cutoff)
    const { service, blockchain } = await build({
      SEAL_MODE: 'hybrid',
      SEAL_BATCH_SIZE: '1',
    });
    let first = true;
    blockchain.storeRoot = jest.fn(() => {
      if (first) {
        first = false;
        logsStore.push(fresh); // log เข้ามาระหว่าง storeRoot ใบแรก
      }
      return Promise.resolve({
        txHash: '0xtx',
        blockNumber: 1,
        confirmed: true,
      });
    });
    jest.spyOn(service, 'getPendingStats').mockResolvedValue(stats(2, 61));

    await service.runHybridSealTick();

    const ids = mappingStore.map((m) => m.logId).sort();
    expect(ids).toEqual(['log-0000', 'log-0001']); // seal เฉพาะ 2 aged
    expect(ids).not.toContain('log-fresh'); // fresh (> cutoff) ไม่ถูก seal
    expect(logsStore.some((l) => l.id === 'log-fresh')).toBe(true); // ยังค้าง pending
  });

  it('age backlog 250 (aged ทั้งหมด) → 3 batch ในรอบเดียว (100,100,50)', async () => {
    logsStore = Array.from({ length: 250 }, (_, i) => makeLog(i));
    const { service } = await build({ SEAL_MODE: 'hybrid' });
    jest.spyOn(service, 'getPendingStats').mockResolvedValue(stats(250, 61));

    const run = await service.runHybridSealTick();

    expect(run.batches.map((b) => b.logCount)).toEqual([100, 100, 50]);
    expect(mappingStore).toHaveLength(250);
  });
});
