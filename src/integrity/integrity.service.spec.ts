import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { IntegrityService } from './integrity.service';
import { MerkleService } from './service/merkle.service';
import { fakeSealManager } from '../../test/helpers/fake-seal-transaction';
import { BlockchainService } from '../blockchain/blockchain.service';
import { Log } from '../logs/entities/log.entity';
import { Batch } from '../logs/entities/batch.entity';
import { Alert } from '../alerts/entities/alert.entity';
import { LogBatchMapping } from '../logs/entities/log-batch-mapping.entity';
import {
  DetectionService,
  BatchLogInput,
  BatchAnomalyResult,
} from './detection.service';
import { computeRawHash } from '../logs/services/log-hash';

/** log row ที่ rawHash ตรงกับเนื้อของตัวเอง — verify recompute hash จาก row ด้วย */
function makeLog(id: string, createdAt: Date) {
  const row = {
    id,
    source: 'unit-test',
    sourceIp: null,
    eventType: 'AUTH_FAILURE',
    severity: 'INFO',
    message: `log ${id}`,
    classification: 'INTERNAL',
    cdeScope: false,
    createdAt,
  };
  return { ...row, rawHash: computeRawHash(row) };
}

/**
 * Stable multi-key sort that mimics TypeORM's `order` option.
 * Ties fall through to the next key; if a key is missing (e.g. sealBatch
 * ordered by createdAt only), the underlying V8 sort keeps insertion order —
 * exactly the non-deterministic tie-break the { createdAt, id } fix removes.
 */
function applyOrder<T>(rows: T[], order?: Record<string, 'ASC' | 'DESC'>): T[] {
  if (!order) return rows;
  const keys = Object.keys(order);
  return [...rows].sort((a: any, b: any) => {
    for (const k of keys) {
      const dir = order[k] === 'DESC' ? -1 : 1;
      if (a[k] < b[k]) return -1 * dir;
      if (a[k] > b[k]) return 1 * dir;
    }
    return 0;
  });
}

describe('IntegrityService — Merkle determinism', () => {
  let service: IntegrityService;
  let logsStore: any[];
  let mappingStore: any[];
  let batchStore: any[];
  let onChain: Map<string, string>;
  let checkRootSpy: jest.Mock;
  let alertSaves: any[];
  let detectionMock: {
    scoreBatch: jest.Mock<
      Promise<BatchAnomalyResult | null>,
      [string, BatchLogInput[]]
    >;
  };

  beforeEach(async () => {
    // Same createdAt on every log, so the tie-break decides ordering.
    // Insertion order [a, c, b, d] is deliberately NOT id order, so a stable
    // createdAt-only sort would pair {a,c},{b,d} while the { createdAt, id }
    // sort pairs {a,b},{c,d} — a genuinely different Merkle tree.
    const t = new Date('2026-07-22T00:00:00.000Z');
    logsStore = [
      makeLog('a', t),
      makeLog('c', t),
      makeLog('b', t),
      makeLog('d', t),
    ];
    mappingStore = [];
    batchStore = [];
    onChain = new Map();
    alertSaves = [];

    const logsRepo = {
      find: jest.fn((opts: any = {}) => {
        let rows = [...logsStore];
        const idOp = opts.where?.id;
        // getLeavesForBatch queries with In(logIds)
        if (idOp && typeof idOp === 'object' && idOp.type === 'in') {
          const ids: string[] = idOp.value;
          rows = rows.filter((r) => ids.includes(r.id));
        }
        rows = applyOrder(rows, opts.order);
        if (opts.take) rows = rows.slice(0, opts.take);
        return Promise.resolve(rows);
      }),
      findOneBy: jest.fn(({ id }: any) =>
        Promise.resolve(logsStore.find((l) => l.id === id) ?? null),
      ),
    };

    let mappingSeq = 0;
    const mappingRepo = {
      find: jest.fn((opts: any = {}) => {
        let rows = [...mappingStore];
        if (opts.where?.batchId) {
          rows = rows.filter((m) => m.batchId === opts.where.batchId);
        }
        return Promise.resolve(rows);
      }),
      findOneBy: jest.fn(({ logId }: any) =>
        Promise.resolve(mappingStore.find((m) => m.logId === logId) ?? null),
      ),
      create: jest.fn((dto: any) => ({ ...dto })),
      save: jest.fn((val: any) => {
        const arr = Array.isArray(val) ? val : [val];
        for (const m of arr)
          mappingStore.push({ mappedAt: mappingSeq++, ...m });
        return Promise.resolve(val);
      }),
    };

    let batchSeq = 0;
    const batchesRepo = {
      create: jest.fn((dto: any) => ({ ...dto })),
      save: jest.fn((batch: any) => {
        if (!batch.id) batch.id = `batch-${batchSeq++}`;
        if (!batchStore.includes(batch)) batchStore.push(batch);
        return Promise.resolve(batch);
      }),
      find: jest.fn((opts: any = {}) => {
        const clauses = Array.isArray(opts.where) ? opts.where : [opts.where];
        return Promise.resolve(
          batchStore.filter((b) =>
            clauses.some((c: any) => !c?.status || c.status === b.status),
          ),
        );
      }),
      findOneBy: jest.fn(({ id }: any) =>
        Promise.resolve(batchStore.find((b) => b.id === id) ?? null),
      ),
    };
    // writeMappingAndSnapshot: สถานะ + mapping + snapshot ใน transaction เดียว
    Object.assign(mappingRepo, {
      manager: fakeSealManager({
        batches: () => batchesRepo,
        mapping: () => mappingRepo,
      }),
    });

    const alertsRepo = {
      // dedup ต้องเห็น alert ที่เคยบันทึกไว้จริง ไม่ใช่คืน null ตลอด
      findOne: jest.fn(({ where }: any) =>
        Promise.resolve(
          alertSaves.find(
            (a: any) =>
              a.batchId === where.batchId &&
              a.alertType === where.alertType &&
              (where.status === undefined || a.status === where.status),
          ) ?? null,
        ),
      ),
      create: jest.fn((dto: any) => dto),
      save: jest.fn((dto: any) => {
        alertSaves.push(dto);
        return Promise.resolve(dto);
      }),
      update: jest.fn((where: any, patch: any) => {
        const hit = alertSaves.filter(
          (a: any) =>
            a.batchId === where.batchId &&
            a.alertType === where.alertType &&
            (where.status === undefined || a.status === where.status),
        );
        hit.forEach((a: any) => Object.assign(a, patch));
        return Promise.resolve({ affected: hit.length });
      }),
    };

    checkRootSpy = jest.fn((batchId: string, root: string) => {
      const stored = onChain.get(batchId);
      const expected = (
        root.startsWith('0x') ? root : '0x' + root
      ).toLowerCase();
      if (!stored)
        return Promise.resolve({ result: 'MISSING', onChainRoot: '0x0' });
      return Promise.resolve({
        result: stored.toLowerCase() === expected ? 'MATCH' : 'MISMATCH',
        onChainRoot: stored,
      });
    });

    const blockchain = {
      ready: true,
      storeRoot: jest.fn((batchId: string, root: string) => {
        onChain.set(batchId, root.startsWith('0x') ? root : '0x' + root);
        return Promise.resolve({
          txHash: '0xtx',
          blockNumber: 1,
          confirmed: true,
        });
      }),
      checkRoot: checkRootSpy,
    };

    // ค่าเริ่มต้นคืน null (ยังไม่ได้จำแนก) — เทสต์เดิมจึงไม่ได้รับผลกระทบ
    detectionMock = {
      scoreBatch: jest.fn<
        Promise<BatchAnomalyResult | null>,
        [string, BatchLogInput[]]
      >(() => Promise.resolve(null)),
    };

    const module = await Test.createTestingModule({
      providers: [
        IntegrityService,
        MerkleService, // real — hashing must not be mocked
        { provide: BlockchainService, useValue: blockchain },
        { provide: DetectionService, useValue: detectionMock },
        { provide: getRepositoryToken(Log), useValue: logsRepo },
        { provide: getRepositoryToken(Batch), useValue: batchesRepo },
        { provide: getRepositoryToken(Alert), useValue: alertsRepo },
        { provide: getRepositoryToken(LogBatchMapping), useValue: mappingRepo },
      ],
    }).compile();

    service = module.get(IntegrityService);
  });

  it('seals a batch and re-verifies to the same root across repeated queries', async () => {
    const batch = await service.sealBatch();

    expect(batch).not.toBeNull();
    expect(batch!.status).toBe('CONFIRMED');
    const sealedRoot = '0x' + batch!.merkleRoot;

    // Verify several times — leaf ordering must be reproduced every round.
    for (let i = 0; i < 5; i++) {
      await service.verifyAllBatches();
      expect(batch!.status).toBe('CONFIRMED'); // never flips to TAMPERED
    }

    // Every recomputed root handed to the chain check must be identical
    // to the sealed root — deterministic ordering, no MISMATCH.
    const rootsChecked = checkRootSpy.mock.calls.map((c) => c[1]);
    expect(rootsChecked.length).toBe(5);
    for (const r of rootsChecked) expect(r).toBe(sealedRoot);

    // Confirm the chain check actually resolved MATCH every round.
    const results = await Promise.all(
      checkRootSpy.mock.results.map((r) => r.value),
    );
    expect(results.every((r) => r.result === 'MATCH')).toBe(true);
  });

  it('detects a row whose content no longer matches its own rawHash', async () => {
    const batch = await service.sealBatch();
    expect(batch!.status).toBe('CONFIRMED');

    // จำลอง DB ถูกยึด: แก้ severity ทิ้ง raw_hash ไว้เหมือนเดิม
    // root ที่ recompute จาก raw_hash ยังตรง chain — ต้องจับได้จาก rehash ของ row
    const victim = logsStore.find((l) => l.id === 'b');
    victim.severity = 'INFO';
    victim.message = 'nothing happened here';

    await service.verifyAllBatches();

    expect(batch!.status).toBe('TAMPERED');
    expect(alertSaves).toHaveLength(1);
    expect(alertSaves[0].alertType).toBe('INTEGRITY_TAMPERED');
    expect(alertSaves[0].detail.modifiedLogIds).toEqual(['b']);
  });

  it('falls back to a local check when the chain lookup fails, instead of aborting the round', async () => {
    const batch = await service.sealBatch();
    expect(batch!.status).toBe('CONFIRMED');

    // RPC timeout ของ ethers — เดิม throw ออกจาก verifyAllBatches ทั้งรอบ (batch ที่เหลือไม่ถูกตรวจ)
    checkRootSpy.mockRejectedValueOnce(
      Object.assign(new Error('request timeout'), { code: 'TIMEOUT' }),
    );
    const rows = logsStore as { id: string; message: string }[];
    rows.find((l) => l.id === 'b')!.message = 'nothing happened here';

    await expect(service.verifyAllBatches()).resolves.toBeUndefined();

    // การแก้ row ยังถูกจับได้จากการตรวจแบบ local แม้เทียบ chain ไม่ได้
    expect(batch!.status).toBe('TAMPERED');
    const saved = alertSaves as { alertType: string }[];
    expect(saved.map((a) => a.alertType)).toEqual(['INTEGRITY_TAMPERED']);
  });

  it('closes the tamper alert once the batch verifies clean again, and re-alerts on a second tamper', async () => {
    const batch = await service.sealBatch();
    const victim = logsStore.find((l) => l.id === 'b');
    const original = { severity: victim.severity, message: victim.message };

    // 1) แก้ row -> ต้องจับได้ + เปิด alert
    victim.severity = 'INFO';
    victim.message = 'nothing happened here';
    await service.verifyAllBatches();
    expect(batch!.status).toBe('TAMPERED');
    expect(alertSaves).toHaveLength(1);
    expect(alertSaves[0].status).toBe('OPEN');

    // 2) แก้กลับให้ตรง hash เดิม -> batch กลับเป็น CONFIRMED และ alert ต้องถูกปิด
    victim.severity = original.severity;
    victim.message = original.message;
    await service.verifyAllBatches();
    expect(batch!.status).toBe('CONFIRMED');
    expect(alertSaves[0].status).toBe('RESOLVED');

    // รอบถัดไปที่ยัง clean อยู่ ต้องไม่เปิด alert ใหม่
    await service.verifyAllBatches();
    expect(alertSaves).toHaveLength(1);

    // 3) โดนแก้ซ้ำอีกรอบ -> ต้องได้ alert ใบใหม่ ไม่ถูก dedup ของใบเก่าที่ปิดไปแล้วกลืน
    victim.message = 'tampered again';
    await service.verifyAllBatches();
    expect(batch!.status).toBe('TAMPERED');
    expect(alertSaves).toHaveLength(2);
    expect(alertSaves[1].status).toBe('OPEN');
  });

  it('produces a root determined by { createdAt, id } order, not insertion order', async () => {
    const batch = await service.sealBatch();
    const merkle = new MerkleService();

    // Expected: leaves ordered by (createdAt, id) → a, b, c, d
    const byCreatedThenId = [...logsStore]
      .sort((x, y) => (x.id < y.id ? -1 : 1))
      .map((l) => l.rawHash);
    const expectedRoot = merkle.buildTree(byCreatedThenId).root;

    // Insertion order a, c, b, d — different tree under sortPairs.
    const insertionOrder = logsStore.map((l) => l.rawHash);
    const insertionRoot = merkle.buildTree(insertionOrder).root;

    expect('0x' + batch!.merkleRoot).toBe(expectedRoot);
    expect(expectedRoot).not.toBe(insertionRoot); // ordering genuinely matters
  });

  it('stores the Isolation Forest result on the batch when detection flags an anomaly', async () => {
    detectionMock.scoreBatch.mockResolvedValueOnce({
      isAnomaly: true,
      score: -0.31,
      reason: 'batch ผิดปกติ (Isolation Forest): AUTH_FAILURE สูง',
    });

    const batch = await service.sealBatch();

    // detection ถูกเรียกด้วย log ทั้งชุด (map เป็น field ที่ detection ต้องใช้)
    expect(detectionMock.scoreBatch).toHaveBeenCalledTimes(1);
    const [, sentLogs] = detectionMock.scoreBatch.mock.calls[0];
    expect(sentLogs).toHaveLength(logsStore.length);
    expect(sentLogs[0]).toHaveProperty('eventType');
    expect(sentLogs[0]).toHaveProperty('createdAt');

    expect(batch!.status).toBe('CONFIRMED'); // การจำแนกไม่ขวางการปิด/anchor
    expect(batch!.ifAnomaly).toBe(true);
    expect(batch!.ifScore).toBe(-0.31);
    expect(batch!.ifReason).toContain('Isolation Forest');
    expect(batch!.ifScoredAt).toBeInstanceOf(Date);
  });

  it('seals normally when detection throws — scoring must never block sealing', async () => {
    detectionMock.scoreBatch.mockRejectedValueOnce(
      new Error('detection exploded'),
    );

    const batch = await service.sealBatch();

    expect(batch!.status).toBe('CONFIRMED');
    expect(batch!.ifAnomaly).toBeUndefined(); // ไม่มีผลจำแนก แต่ batch ปิดสำเร็จ
  });
});
