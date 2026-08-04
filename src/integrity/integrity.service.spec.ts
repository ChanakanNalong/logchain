import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In } from 'typeorm';
import { IntegrityService } from './integrity.service';
import { MerkleService } from './service/merkle.service';
import { BlockchainService } from '../blockchain/blockchain.service';
import { Log } from '../logs/entities/log.entity';
import { Batch } from '../logs/entities/batch.entity';
import { Alert } from '../alerts/entities/alert.entity';
import { LogBatchMapping } from '../logs/entities/log-batch-mapping.entity';

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

  beforeEach(async () => {
    // Same createdAt on every log, so the tie-break decides ordering.
    // Insertion order [a, c, b, d] is deliberately NOT id order, so a stable
    // createdAt-only sort would pair {a,c},{b,d} while the { createdAt, id }
    // sort pairs {a,b},{c,d} — a genuinely different Merkle tree.
    const t = new Date('2026-07-22T00:00:00.000Z');
    logsStore = [
      { id: 'a', rawHash: 'aa'.repeat(32), createdAt: t },
      { id: 'c', rawHash: 'cc'.repeat(32), createdAt: t },
      { id: 'b', rawHash: 'bb'.repeat(32), createdAt: t },
      { id: 'd', rawHash: 'dd'.repeat(32), createdAt: t },
    ];
    mappingStore = [];
    batchStore = [];
    onChain = new Map();

    const logsRepo = {
      find: jest.fn(async (opts: any = {}) => {
        let rows = [...logsStore];
        const idOp = opts.where?.id;
        // getLeavesForBatch queries with In(logIds)
        if (idOp && typeof idOp === 'object' && idOp.type === 'in') {
          const ids: string[] = idOp.value;
          rows = rows.filter((r) => ids.includes(r.id));
        }
        rows = applyOrder(rows, opts.order);
        if (opts.take) rows = rows.slice(0, opts.take);
        return rows;
      }),
      findOneBy: jest.fn(async ({ id }: any) =>
        logsStore.find((l) => l.id === id) ?? null,
      ),
    };

    let mappingSeq = 0;
    const mappingRepo = {
      find: jest.fn(async (opts: any = {}) => {
        let rows = [...mappingStore];
        if (opts.where?.batchId) {
          rows = rows.filter((m) => m.batchId === opts.where.batchId);
        }
        return rows;
      }),
      findOneBy: jest.fn(async ({ logId }: any) =>
        mappingStore.find((m) => m.logId === logId) ?? null,
      ),
      create: jest.fn((dto: any) => ({ ...dto })),
      save: jest.fn(async (val: any) => {
        const arr = Array.isArray(val) ? val : [val];
        for (const m of arr) mappingStore.push({ mappedAt: mappingSeq++, ...m });
        return val;
      }),
    };

    let batchSeq = 0;
    const batchesRepo = {
      create: jest.fn((dto: any) => ({ ...dto })),
      save: jest.fn(async (batch: any) => {
        if (!batch.id) batch.id = `batch-${batchSeq++}`;
        if (!batchStore.includes(batch)) batchStore.push(batch);
        return batch;
      }),
      find: jest.fn(async (opts: any = {}) => {
        const clauses = Array.isArray(opts.where) ? opts.where : [opts.where];
        return batchStore.filter((b) =>
          clauses.some((c: any) => !c?.status || c.status === b.status),
        );
      }),
      findOneBy: jest.fn(async ({ id }: any) =>
        batchStore.find((b) => b.id === id) ?? null,
      ),
    };

    const alertsRepo = {
      findOne: jest.fn(async () => null),
      create: jest.fn((dto: any) => dto),
      save: jest.fn(async (dto: any) => dto),
    };

    checkRootSpy = jest.fn(async (batchId: string, root: string) => {
      const stored = onChain.get(batchId);
      const expected = (root.startsWith('0x') ? root : '0x' + root).toLowerCase();
      if (!stored) return { result: 'MISSING', onChainRoot: '0x0' };
      return {
        result: stored.toLowerCase() === expected ? 'MATCH' : 'MISMATCH',
        onChainRoot: stored,
      };
    });

    const blockchain = {
      ready: true,
      storeRoot: jest.fn(async (batchId: string, root: string) => {
        onChain.set(batchId, root.startsWith('0x') ? root : '0x' + root);
        return { txHash: '0xtx', blockNumber: 1 };
      }),
      checkRoot: checkRootSpy,
    };

    const module = await Test.createTestingModule({
      providers: [
        IntegrityService,
        MerkleService, // real — hashing must not be mocked
        { provide: BlockchainService, useValue: blockchain },
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
});
