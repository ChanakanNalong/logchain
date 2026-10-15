import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CronExpression } from '@nestjs/schedule';
import { IntegrityService, LOW_BALANCE_ALERT_TYPE } from './integrity.service';
import { MerkleService } from './service/merkle.service';
import { fakeSealManager } from './fake-seal-transaction';
import { BlockchainService } from '../blockchain/blockchain.service';
import { Log } from '../logs/entities/log.entity';
import { Batch } from '../logs/entities/batch.entity';
import { Alert } from '../alerts/entities/alert.entity';
import { LogBatchMapping } from '../logs/entities/log-batch-mapping.entity';
import { computeRawHash } from '../logs/services/log-hash';
import { DEFAULT_SEAL_CONFIG, readSealConfig } from './seal-config';

/**
 * รอบ seal: SEAL_CRON / SEAL_BATCH_SIZE · drain log ค้างจนหมด · guard ยอดเงินต่ำ ·
 * backoff เมื่อ seal ล้มติดกัน (พายุ FAILED ทุกนาที 2026-10-08)
 *
 * mock ของ logsRepo ต้องเข้าใจ Not(In(mapped)) — harness ของ spec อื่นไม่ได้กรอง
 * log ที่ map แล้วออก ซึ่งพอสำหรับ batch เดียว แต่ drain หลายใบจะหยิบ log ซ้ำ
 */

const SEAL_ENV = [
  'SEAL_CRON',
  'SEAL_BATCH_SIZE',
  'SEAL_MIN_BALANCE_TX',
  'SEAL_FAILURE_BACKOFF_AFTER',
  'SEAL_BACKOFF_MAX_TICKS',
  'SEAL_LOW_BALANCE_ALERT_MINUTES',
];

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
interface AlertRow {
  alertType: string;
  status: string;
  [k: string]: unknown;
}
interface IdOperator {
  type?: string;
  value?: unknown;
}
interface FindOpts {
  where?: { id?: IdOperator; batchId?: string };
  order?: Record<string, 'ASC' | 'DESC'>;
  take?: number;
}
interface AlertWhere {
  where: { alertType: string; status: string };
}
type CostEstimate = Awaited<
  ReturnType<BlockchainService['estimateStoreRootCost']>
>;
interface FakeChain {
  ready: boolean;
  storeRoot: jest.Mock;
  estimateStoreRootCost: jest.Mock<Promise<CostEstimate>, []>;
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
    // เวลากลับด้านกับ id — ลำดับต้องมาจาก createdAt ก่อน id
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

/** Not(In(ids)) ของ TypeORM — FindOperator.value ของ 'not' คืน array ของตัวใน (In) ให้เลย */
function excludedIds(idOp?: IdOperator): string[] | null {
  if (idOp?.type === 'not' && Array.isArray(idOp.value)) {
    return idOp.value as string[];
  }
  return null;
}

const POL = 10n ** 18n;

const cost = (balanceWei: bigint): CostEstimate => ({
  address: '0xWallet',
  balanceWei,
  gas: 78_156n,
  feePerGasWei: 10n ** 11n, // 100 gwei
  costWei: 78_156n * 10n ** 11n, // ~0.0078 POL
});

describe('IntegrityService — seal cadence / drain / guards', () => {
  let logsStore: LogRow[];
  let mappingStore: MappingRow[];
  let batchStore: BatchRow[];
  let alertSaves: AlertRow[];
  let blockchain: FakeChain;

  async function build(env: Record<string, string> = {}) {
    for (const k of SEAL_ENV) delete process.env[k];
    Object.assign(process.env, env);

    const logsRepo = {
      find: jest.fn((opts: FindOpts = {}) => {
        let rows = [...logsStore];
        const excl = excludedIds(opts.where?.id);
        if (excl) rows = rows.filter((r) => !excl.includes(r.id));
        rows = applyOrder(rows, opts.order);
        if (opts.take) rows = rows.slice(0, opts.take);
        return Promise.resolve(rows);
      }),
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
    // writeMappingAndSnapshot: สถานะ + mapping + snapshot ใน transaction เดียว
    Object.assign(mappingRepo, {
      manager: fakeSealManager({
        batches: () => batchesRepo,
        mapping: () => mappingRepo,
      }),
    });
    const sameAlert = (a: AlertRow, w: AlertWhere['where']) =>
      a.alertType === w.alertType && a.status === w.status;
    const alertsRepo = {
      findOne: jest.fn(({ where }: AlertWhere) =>
        Promise.resolve(alertSaves.find((a) => sameAlert(a, where)) ?? null),
      ),
      create: jest.fn((dto: AlertRow) => dto),
      save: jest.fn((dto: AlertRow) => {
        alertSaves.push(dto);
        return Promise.resolve(dto);
      }),
      update: jest.fn(
        (where: AlertWhere['where'], patch: Partial<AlertRow>) => {
          const hit = alertSaves.filter((a) => sameAlert(a, where));
          hit.forEach((a) => Object.assign(a, patch));
          return Promise.resolve({ affected: hit.length });
        },
      ),
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
    return module.get(IntegrityService);
  }

  const confirmed = () =>
    Promise.resolve({ txHash: '0xtx', blockNumber: 1, confirmed: true });
  const rpcDown = () => Promise.reject(new Error('rpc down'));

  beforeEach(() => {
    logsStore = [];
    mappingStore = [];
    batchStore = [];
    alertSaves = [];
    blockchain = {
      ready: true,
      storeRoot: jest.fn(confirmed),
      estimateStoreRootCost: jest.fn(() => Promise.resolve(cost(10n * POL))),
    };
  });

  afterAll(() => {
    for (const k of SEAL_ENV) delete process.env[k];
  });

  describe('config', () => {
    it('defaults to the previous behaviour: every minute, 100 per batch, balance guard off', () => {
      expect(readSealConfig({})).toEqual(DEFAULT_SEAL_CONFIG);
      expect(DEFAULT_SEAL_CONFIG.cron).toBe(CronExpression.EVERY_MINUTE);
      expect(DEFAULT_SEAL_CONFIG.batchSize).toBe(100);
      expect(DEFAULT_SEAL_CONFIG.minBalanceTx).toBe(0);
    });

    it('reads SEAL_* from env and rejects malformed numbers', () => {
      const cfg = readSealConfig({
        SEAL_CRON: '0 */30 * * * *',
        SEAL_BATCH_SIZE: '250',
        SEAL_MIN_BALANCE_TX: '20',
      });
      expect(cfg.cron).toBe('0 */30 * * * *');
      expect(cfg.batchSize).toBe(250);
      expect(cfg.minBalanceTx).toBe(20);
      expect(() => readSealConfig({ SEAL_BATCH_SIZE: '0' })).toThrow(
        /SEAL_BATCH_SIZE/,
      );
      expect(() => readSealConfig({ SEAL_BATCH_SIZE: 'abc' })).toThrow();
    });
  });

  it('default config: a normal tick seals one batch of the pending logs, oldest first', async () => {
    logsStore = [3, 1, 2].map(makeLog);
    const service = await build();

    const run = await service.runScheduledSeal();

    expect(run.skipped).toBeUndefined();
    expect(run.batches).toHaveLength(1);
    expect(run.batches[0]).toMatchObject({ status: 'CONFIRMED', logCount: 3 });
    expect(blockchain.storeRoot).toHaveBeenCalledTimes(1);
    // createdAt ASC: log-0003 เก่าสุด
    expect(mappingStore.map((m) => m.logId)).toEqual([
      'log-0003',
      'log-0002',
      'log-0001',
    ]);
    // guard ปิดอยู่ = ไม่มี RPC เพิ่ม
    expect(blockchain.estimateStoreRootCost).not.toHaveBeenCalled();
    // ไม่มีอะไรค้าง = รอบถัดไปไม่สร้าง batch
    expect((await service.runScheduledSeal()).batches).toHaveLength(0);
  });

  it('drains a backlog larger than SEAL_BATCH_SIZE in one tick, in order', async () => {
    logsStore = Array.from({ length: 23 }, (_, i) => makeLog(i));
    const service = await build({ SEAL_BATCH_SIZE: '10' });

    const run = await service.runScheduledSeal();

    expect(run.batches.map((b) => b.logCount)).toEqual([10, 10, 3]);
    expect(run.batches.every((b) => b.status === 'CONFIRMED')).toBe(true);
    expect(mappingStore).toHaveLength(23);
    // ทุก log ถูก map ครั้งเดียว และ batch แรกได้ log ที่เก่าที่สุด
    expect(new Set(mappingStore.map((m) => m.logId)).size).toBe(23);
    const oldestFirst = applyOrder(logsStore, { createdAt: 'ASC', id: 'ASC' });
    expect(
      mappingStore
        .filter((m) => m.batchId === run.batches[0].id)
        .map((m) => m.logId),
    ).toEqual(oldestFirst.slice(0, 10).map((l) => l.id));
  });

  it('long interval: 250 logs with the default batch size → 3 batches in one tick', async () => {
    logsStore = Array.from({ length: 250 }, (_, i) => makeLog(i));
    const service = await build({ SEAL_CRON: '0 */30 * * * *' });

    const run = await service.runScheduledSeal();

    expect(run.batches.map((b) => b.logCount)).toEqual([100, 100, 50]);
    expect(mappingStore).toHaveLength(250);
  });

  it('stops draining at a FAILED batch instead of re-sealing the same logs', async () => {
    logsStore = Array.from({ length: 25 }, (_, i) => makeLog(i));
    blockchain.storeRoot = jest
      .fn()
      .mockResolvedValueOnce({ txHash: '0x1', blockNumber: 1, confirmed: true })
      .mockRejectedValue(new Error('rpc down'));
    const service = await build({ SEAL_BATCH_SIZE: '10' });

    const run = await service.runScheduledSeal();

    expect(run.batches.map((b) => b.status)).toEqual(['CONFIRMED', 'FAILED']);
    expect(mappingStore).toHaveLength(10);
  });

  describe('low-balance guard', () => {
    // 0.001 POL < 5 × ~0.0078
    const lowBalance = () => jest.fn(() => Promise.resolve(cost(10n ** 15n)));

    it('creates no batch and sends no tx when balance < SEAL_MIN_BALANCE_TX × cost', async () => {
      logsStore = [1, 2].map(makeLog);
      blockchain.estimateStoreRootCost = lowBalance();
      const service = await build({ SEAL_MIN_BALANCE_TX: '5' });

      const run = await service.runScheduledSeal();

      expect(run).toEqual({ batches: [], skipped: 'LOW_BALANCE' });
      expect(batchStore).toHaveLength(0);
      expect(mappingStore).toHaveLength(0);
      expect(blockchain.storeRoot).not.toHaveBeenCalled();
      expect(alertSaves).toHaveLength(1);
      expect(alertSaves[0]).toMatchObject({
        alertType: LOW_BALANCE_ALERT_TYPE,
        status: 'OPEN',
      });
      expect(alertSaves[0].batchId).toBeUndefined();
    });

    it('raises the alert once, not every tick, and does not count as a seal failure', async () => {
      logsStore = [1].map(makeLog);
      blockchain.estimateStoreRootCost = lowBalance();
      const service = await build({
        SEAL_MIN_BALANCE_TX: '5',
        SEAL_FAILURE_BACKOFF_AFTER: '1',
      });

      for (let i = 0; i < 5; i++) {
        expect((await service.runScheduledSeal()).skipped).toBe('LOW_BALANCE');
      }
      expect(alertSaves).toHaveLength(1);
      // ไม่เข้า backoff — ทุกรอบยังเช็คยอดใหม่ (ฟื้นเมื่อไรก็ seal ต่อทันที)
      expect(blockchain.estimateStoreRootCost).toHaveBeenCalledTimes(5);
    });

    it('resumes and resolves the alert once the balance is enough again', async () => {
      logsStore = [1].map(makeLog);
      blockchain.estimateStoreRootCost = lowBalance();
      const service = await build({ SEAL_MIN_BALANCE_TX: '5' });
      await service.runScheduledSeal();

      blockchain.estimateStoreRootCost.mockResolvedValue(cost(POL));
      const run = await service.runScheduledSeal();

      expect(run.batches).toHaveLength(1);
      expect(alertSaves[0].status).toBe('RESOLVED');
    });

    it('resolves an OPEN alert left by a previous process on the first healthy check', async () => {
      logsStore = [1].map(makeLog);
      alertSaves.push({ alertType: LOW_BALANCE_ALERT_TYPE, status: 'OPEN' });
      const service = await build({ SEAL_MIN_BALANCE_TX: '5' });

      expect((await service.runScheduledSeal()).batches).toHaveLength(1);
      expect(alertSaves[0].status).toBe('RESOLVED');
    });

    it('seals anyway when the balance cannot be read (RPC error)', async () => {
      logsStore = [1].map(makeLog);
      blockchain.estimateStoreRootCost = jest.fn(() =>
        Promise.reject(new Error('rpc timeout')),
      );
      const service = await build({ SEAL_MIN_BALANCE_TX: '5' });

      const run = await service.runScheduledSeal();
      expect(run.batches).toHaveLength(1);
    });

    it('is not consulted when there is no chain (batch is SEALED, no tx)', async () => {
      logsStore = [1].map(makeLog);
      blockchain.ready = false;
      blockchain.estimateStoreRootCost = lowBalance();
      const service = await build({ SEAL_MIN_BALANCE_TX: '5' });

      const run = await service.runScheduledSeal();
      expect(run.batches[0].status).toBe('SEALED');
      expect(blockchain.estimateStoreRootCost).not.toHaveBeenCalled();
    });
  });

  describe('failure backoff', () => {
    it('after N consecutive FAILED seals skips 1, 2, 4… ticks instead of a FAILED batch per tick', async () => {
      logsStore = [1].map(makeLog);
      blockchain.storeRoot = jest.fn(rpcDown);
      const service = await build({ SEAL_FAILURE_BACKOFF_AFTER: '3' });

      const ticks: string[] = [];
      for (let i = 0; i < 12; i++) {
        const r = await service.runScheduledSeal();
        ticks.push(r.skipped ?? r.batches[0]?.status ?? 'none');
      }

      // F F F (ครบ 3 → ข้าม 1) F (4 → ข้าม 2) F (5 → ข้าม 4) …
      expect(ticks).toEqual([
        'FAILED',
        'FAILED',
        'FAILED',
        'BACKOFF',
        'FAILED',
        'BACKOFF',
        'BACKOFF',
        'FAILED',
        'BACKOFF',
        'BACKOFF',
        'BACKOFF',
        'BACKOFF',
      ]);
      expect(batchStore).toHaveLength(5); // เดิม = 12
    });

    it('caps the skip at SEAL_BACKOFF_MAX_TICKS', async () => {
      logsStore = [1].map(makeLog);
      blockchain.storeRoot = jest.fn(rpcDown);
      const service = await build({
        SEAL_FAILURE_BACKOFF_AFTER: '1',
        SEAL_BACKOFF_MAX_TICKS: '2',
      });

      const ticks: string[] = [];
      for (let i = 0; i < 10; i++) {
        const r = await service.runScheduledSeal();
        ticks.push(r.skipped ?? r.batches[0]?.status ?? 'none');
      }
      // F(1→1) B F(2→2) B B F(3→cap 2) B B F B
      expect(ticks).toEqual([
        'FAILED',
        'BACKOFF',
        'FAILED',
        'BACKOFF',
        'BACKOFF',
        'FAILED',
        'BACKOFF',
        'BACKOFF',
        'FAILED',
        'BACKOFF',
      ]);
    });

    it('resets on success', async () => {
      logsStore = [1].map(makeLog);
      let fail = true;
      blockchain.storeRoot = jest.fn(() => (fail ? rpcDown() : confirmed()));
      const service = await build({ SEAL_FAILURE_BACKOFF_AFTER: '2' });

      await service.runScheduledSeal(); // F
      await service.runScheduledSeal(); // F → ข้าม 1
      expect((await service.runScheduledSeal()).skipped).toBe('BACKOFF');
      fail = false;
      expect((await service.runScheduledSeal()).batches[0].status).toBe(
        'CONFIRMED',
      );

      // ล้มใหม่ 1 ครั้งหลัง reset ยังไม่ถึง N=2 → รอบถัดไปไม่ข้าม
      fail = true;
      logsStore.push(makeLog(2));
      await service.runScheduledSeal(); // F (1)
      const next = await service.runScheduledSeal();
      expect(next.skipped).toBeUndefined();
      expect(next.batches[0].status).toBe('FAILED');
    });

    it('SEAL_FAILURE_BACKOFF_AFTER=0 disables backoff (previous behaviour)', async () => {
      logsStore = [1].map(makeLog);
      blockchain.storeRoot = jest.fn(rpcDown);
      const service = await build({ SEAL_FAILURE_BACKOFF_AFTER: '0' });

      for (let i = 0; i < 6; i++) {
        expect((await service.runScheduledSeal()).skipped).toBeUndefined();
      }
      expect(batchStore).toHaveLength(6);
    });
  });

  it('skips a tick while the previous round is still draining', async () => {
    logsStore = [1].map(makeLog);
    let release!: () => void;
    blockchain.storeRoot = jest.fn(
      () =>
        new Promise((resolve) => {
          release = () => void confirmed().then(resolve);
        }),
    );
    const service = await build();

    const first = service.runScheduledSeal();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(await service.runScheduledSeal()).toEqual({
      batches: [],
      skipped: 'IN_FLIGHT',
    });
    release();
    expect((await first).batches).toHaveLength(1);
  });
});
